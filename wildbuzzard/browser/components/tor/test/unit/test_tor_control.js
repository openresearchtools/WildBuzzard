/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

do_get_profile();
const { Subprocess } = ChromeUtils.importESModule(
  "resource://gre/modules/Subprocess.sys.mjs"
);
const { TorControl } = ChromeUtils.importESModule(
  "resource:///modules/TorControl.sys.mjs"
);
const { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);
const binary = Services.env.get("WILDBUZZARD_TEST_TOR_RUNTIME");

add_task(
  { skip_if: () => !binary },
  async function test_real_tor_ephemeral_keys_and_controller_lifetime() {
    const root = PathUtils.join(PathUtils.profileDir, "tor-control-test");
    await IOUtils.makeDirectory(root, { permissions: 0o700 });
    const portFile = PathUtils.join(root, "port");
    const cookieFile = PathUtils.join(root, "cookie");
    const process = await Subprocess.call({
      command: binary,
      arguments: [
        "--DataDirectory",
        root,
        "--DisableNetwork",
        "1",
        "--SocksPort",
        "0",
        "--ControlPort",
        "127.0.0.1:auto",
        "--ControlPortWriteToFile",
        portFile,
        "--CookieAuthentication",
        "1",
        "--CookieAuthFile",
        cookieFile,
        "--__OwningControllerProcess",
        String(Services.appinfo.processID),
      ],
      stderr: "stdout",
    });
    let control;
    try {
      let port;
      await TestUtils.waitForCondition(
        async () => {
          if (
            (await IOUtils.exists(portFile)) &&
            (await IOUtils.exists(cookieFile))
          ) {
            const match = /^PORT=127\.0\.0\.1:(\d+)\s*$/.exec(
              await IOUtils.readUTF8(portFile)
            );
            if (match) {
              port = Number(match[1]);
              return true;
            }
          }
          return false;
        },
        "Tor wrote its control port and cookie",
        50,
        100
      );
      Assert.ok(port, "Tor opened its private control listener");
      control = new TorControl(port);
      const cookie = await IOUtils.read(cookieFile);
      await control.send(
        "AUTHENTICATE " +
          Array.from(cookie, byte => byte.toString(16).padStart(2, "0")).join(
            ""
          )
      );
      await control.send("TAKEOWNERSHIP");
      await control.send("RESETCONF __OwningControllerProcess");
      const address =
        "2gzyxa5ihm7nsggfxnu52rck2vv4rvmdlkiu3zzui5du4xyclen53wid";
      const key = btoa("t".repeat(32));
      await control.send(`ONION_CLIENT_AUTH_ADD ${address} x25519:${key}`);
      const view = await control.send("ONION_CLIENT_AUTH_VIEW");
      Assert.ok(
        view.some(line => line.includes(address)),
        "Tor accepted the in-memory authorization"
      );
      Assert.ok(
        view.every(line => !line.includes("Permanent")),
        "Tor was not asked to store plaintext keys"
      );
      await control.send(`ONION_CLIENT_AUTH_REMOVE ${address}`);
      const removed = await control.send("ONION_CLIENT_AUTH_VIEW");
      Assert.ok(
        removed.every(line => !line.includes(address)),
        "Tor removed the authorization"
      );
      await Assert.rejects(
        control.send("ONION_CLIENT_AUTH_ADD invalid x25519:secret"),
        /^Error: Tor control request failed$/,
        "Errors never echo credentials"
      );
      control.close();
      let exit;
      process.wait().then(result => {
        exit = result;
      });
      await TestUtils.waitForCondition(
        () => exit,
        "Tor exits when its owner disconnects",
        100,
        100
      );
      Assert.ok(exit, "Losing the owner connection terminates Tor");
      Assert.equal(
        exit.exitCode,
        0,
        "Tor exits normally after losing its browser owner"
      );
    } finally {
      control?.close();
      await process.kill();
      await process.wait();
    }
  }
);
