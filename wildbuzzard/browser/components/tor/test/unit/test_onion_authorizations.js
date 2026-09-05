/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

do_get_profile();
const { OnionAuthStorage, onionAddress, onionPrivateKey } =
  ChromeUtils.importESModule("resource:///modules/OnionAuthStore.sys.mjs");
const ADDRESS = "2gzyxa5ihm7nsggfxnu52rck2vv4rvmdlkiu3zzui5du4xyclen53wid";
const KEY = btoa("k".repeat(32));

add_task(
  function test_native_authorization_errors_are_available_to_javascript() {
    for (const name of [
      "NS_ERROR_ONION_AUTH_REQUIRED",
      "NS_ERROR_ONION_AUTH_FAILED",
    ]) {
      Assert.equal(
        typeof Cr[name],
        "number",
        `${name} is exposed to browser UI`
      );
      Assert.equal(Components.Exception("", Cr[name]).name, name);
    }
  }
);

add_task(function test_key_formats_and_command_injection() {
  Assert.equal(onionAddress(ADDRESS.toUpperCase() + ".onion"), ADDRESS);
  Assert.equal(onionPrivateKey("A".repeat(52)), btoa("\0".repeat(32)));
  Assert.equal(onionPrivateKey(KEY.replace(/=$/, "")), KEY);
  for (const value of [
    "A".repeat(51) + "B",
    "x25519:key\r\nSIGNAL SHUTDOWN",
    "wrong",
    "A".repeat(43) + "B",
  ]) {
    Assert.throws(() => onionPrivateKey(value), /private key|padding/);
  }
  Assert.throws(
    () => onionAddress(ADDRESS + "\r\nSIGNAL SHUTDOWN"),
    /onion address/
  );
  Assert.throws(() => onionAddress("shortaddress.onion"), /onion address/);
});

add_task(async function test_encrypted_persistence_and_session_keys() {
  const path = PathUtils.join(PathUtils.profileDir, "authorization-test.json");
  const store = new OnionAuthStorage(path);
  await store.update(ADDRESS, {
    key: KEY,
    name: "private identity",
    remember: false,
  });
  Assert.ok(
    !(await IOUtils.exists(path)),
    "Session-only authorization creates no file"
  );
  await store.update(ADDRESS, {
    key: KEY,
    name: "private identity",
    remember: true,
  });
  const disk = await IOUtils.readUTF8(path);
  for (const secret of [ADDRESS, KEY, "private identity"]) {
    Assert.ok(
      !disk.includes(secret),
      "Address, identity and private key are encrypted"
    );
  }
  Assert.equal((await IOUtils.stat(path)).permissions, 0o600);
  const restarted = new OnionAuthStorage(path);
  Assert.equal(
    (await restarted.load()).get(ADDRESS).key,
    KEY,
    "NSS decrypts the saved key after restart"
  );
  const listed = await restarted.list();
  Assert.equal(listed[0].name, "private identity");
  Assert.ok(
    !Object.hasOwn(listed[0], "key"),
    "Listing does not expose private keys"
  );
  await restarted.update(ADDRESS, null);
  Assert.ok(
    !(await IOUtils.exists(path)),
    "Removing the last saved key removes the encrypted file"
  );
  Assert.equal((await new OnionAuthStorage(path).list()).length, 0);
});

add_task(
  async function test_trusted_site_remembers_its_key_and_privacy_choice() {
    const path = PathUtils.join(
      PathUtils.profileDir,
      "domain-privacy-test.json"
    );
    const store = new OnionAuthStorage(path);
    await store.update(ADDRESS, {
      key: KEY,
      remember: false,
      privateMode: false,
    });
    Assert.ok(!store.usesPrivateMode(ADDRESS));
    const disk = await IOUtils.readUTF8(path);
    Assert.ok(!disk.includes(KEY) && !disk.includes(ADDRESS));
    const restarted = new OnionAuthStorage(path);
    const entry = (await restarted.load()).get(ADDRESS);
    Assert.equal(
      entry.key,
      KEY,
      "A trusted site's key survives restart without asking again"
    );
    Assert.equal(entry.remember, true);
    Assert.equal(
      entry.privateMode,
      false,
      "The trusted site's storage choice survives restart"
    );
    Assert.equal(
      restarted.usesPrivateMode("a".repeat(56)),
      true,
      "Other domains remain private"
    );
    await restarted.update(ADDRESS, { ...entry, privateMode: true });
    const privateEntry = (await new OnionAuthStorage(path).load()).get(ADDRESS);
    Assert.equal(
      privateEntry.key,
      KEY,
      "Restoring private mode retains the saved key"
    );
    Assert.equal(privateEntry.privateMode, true);
    await restarted.update(ADDRESS, null);
    Assert.ok(
      !(await IOUtils.exists(path)),
      "Removing the authorization forgets the key and site choice"
    );
  }
);
