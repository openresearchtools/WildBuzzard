/* SPDX-License-Identifier: AGPL-3.0-or-later */

const { Subprocess } = ChromeUtils.importESModule(
  "resource://gre/modules/Subprocess.sys.mjs"
);
const { QBittorrentRuntimeTestUtils } = ChromeUtils.importESModule(
  "resource:///modules/QBittorrentRuntime.sys.mjs"
);

add_task(async function test_process_identity_survives_package_replacement() {
  const executable = PathUtils.join(do_get_tempdir().path, "torrent-process");
  await IOUtils.copy("/bin/sleep", executable);
  await IOUtils.setPermissions(executable, 0o700);
  const process = await Subprocess.call({
    command: executable,
    arguments: ["60"],
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    const stat = new TextDecoder().decode(
      await IOUtils.read(`/proc/${process.pid}/stat`, { maxBytes: 16 * 1024 })
    );
    const startTime = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/)[19];
    const matches = (path = executable, started = startTime) =>
      QBittorrentRuntimeTestUtils.processMatches(process.pid, started, path);
    Assert.ok(await matches(), "the running packaged executable is recognized");
    await IOUtils.remove(executable);
    await IOUtils.copy("/bin/sleep", executable);
    Assert.ok(
      await matches(),
      "package replacement preserves process identity"
    );
    Assert.ok(
      !(await matches(`${executable}-other`)),
      "another path is rejected"
    );
    Assert.ok(
      !(await matches(executable, "0")),
      "another start time is rejected"
    );
  } finally {
    process.kill();
    await process.wait();
    await IOUtils.remove(executable, { ignoreAbsent: true });
  }
});

add_task(async function test_runtime_is_a_child_and_stops_before_shutdown() {
  const { QBittorrentRuntime: runtime } = ChromeUtils.importESModule(
    "resource:///modules/QBittorrentRuntime.sys.mjs"
  );
  try {
    runtime.validateRuntime();
  } catch {
    info("Build the bundled runtime to test browser-owned process shutdown");
    return;
  }
  const root = PathUtils.join(PathUtils.tempDir, `wbqr-${Date.now()}`);
  QBittorrentRuntimeTestUtils.configurePaths({
    dataHome: root,
    runtimeHome: root,
  });
  try {
    const connection = await runtime.ensure();
    const stat = new TextDecoder().decode(
      await IOUtils.read(`/proc/${connection.pid}/stat`, {
        maxBytes: 16 * 1024,
      })
    );
    Assert.equal(
      Number(
        stat
          .slice(stat.lastIndexOf(")") + 2)
          .trim()
          .split(/\s+/)[1]
      ),
      Services.appinfo.processID,
      "the browser parent owns the foreground engine"
    );
    await runtime.stop();
    Assert.ok(
      !(await QBittorrentRuntimeTestUtils.processMatches(
        connection.pid,
        connection.pidStartTime,
        connection.executable
      )),
      "shutdown waits for the torrent engine to exit"
    );
    await Assert.rejects(
      runtime.ensure(),
      /shutting down/,
      "shutdown cannot restart the engine"
    );
  } finally {
    await runtime.stopForTests();
    await IOUtils.remove(root, { recursive: true, ignoreAbsent: true });
  }
});
