/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { Subprocess } = ChromeUtils.importESModule(
  "resource://gre/modules/Subprocess.sys.mjs"
);
const {
  SearXNGRuntimeSupervisor,
  SearXNGRuntimeTestUtils,
  searXNGProfileIdentity,
} = ChromeUtils.importESModule("resource:///modules/SearXNGRuntime.sys.mjs");

const CryptoHash = Components.Constructor(
  "@mozilla.org/security/hash;1",
  "nsICryptoHash",
  "initWithString"
);

function sha256(bytes) {
  const hash = new CryptoHash("sha256");
  hash.update(bytes, bytes.length);
  return Array.from(hash.finish(false), character =>
    character.charCodeAt(0).toString(16).padStart(2, "0")
  ).join("");
}

function childDirectory(parent, name, permissions = 0o700) {
  const directory = parent.clone();
  directory.append(name);
  directory.create(Ci.nsIFile.DIRECTORY_TYPE, permissions);
  return directory;
}

function testRoot(name) {
  const root = do_get_tempdir().clone();
  root.append(name);
  root.createUnique(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
  registerCleanupFunction(() => root.remove(true));
  return root;
}

function createSupervisor(root, profile, synchronizeEngine) {
  const dataHome = childDirectory(root, "data-home");
  const cacheHome = childDirectory(root, "cache-home");
  const runtimeHome = childDirectory(root, "runtime-home");
  return new SearXNGRuntimeSupervisor({
    cacheHome: cacheHome.path,
    dataHome: dataHome.path,
    profilePath: profile.path,
    runtimeHome: runtimeHome.path,
    synchronizeEngine,
  });
}

function fakeRuntime(root) {
  const directory = childDirectory(root, "fake-runtime");
  return {
    archivePath: PathUtils.join(root.path, "runtime.zip"),
    archiveSha256: "a".repeat(64),
    bundleId: `1-test-${"a".repeat(64)}`,
    centralEntries: new Map(),
    directory: directory.path,
    files: new Map(),
  };
}

function lifecycle(record) {
  return {
    component: "searxng",
    pid: record.pid,
    processStartTime: record.processStartTime,
    protocolVersion: 1,
    running: true,
    runtimeVersion: "2026.8.6+b023a28ba",
  };
}

add_setup(function setup() {
  do_get_profile();
});

add_task(function test_profile_identity_is_stable_and_path_private() {
  const root = testRoot("searxng-profile-identity");
  const profile = childDirectory(root, "profile-path-must-not-leak");
  const first = searXNGProfileIdentity(profile.path);
  const alias = searXNGProfileIdentity(`${profile.path}/.`);

  Assert.deepEqual(first, alias, "Canonical profile aliases keep one owner");
  Assert.ok(
    /^profile-[a-f0-9]{64}$/.test(first.ownerInstanceId),
    "The service owner is a domain-separated profile digest"
  );
  Assert.ok(
    !JSON.stringify(first).includes(profile.leafName),
    "The owner identity does not disclose the profile path"
  );
});

add_task(async function test_startup_and_reconnect_keep_pid_and_identity() {
  const root = testRoot("searxng-reconnect");
  const profile = childDirectory(root, "profile");
  const synchronized = [];
  const first = createSupervisor(root, profile, endpoint => {
    synchronized.push(endpoint);
  });
  const reopened = new SearXNGRuntimeSupervisor({
    cacheHome: PathUtils.join(root.path, "cache-home"),
    dataHome: PathUtils.join(root.path, "data-home"),
    profilePath: `${profile.path}/.`,
    runtimeHome: PathUtils.join(root.path, "runtime-home"),
    synchronizeEngine: endpoint => synchronized.push(endpoint),
  });
  const runtime = fakeRuntime(root);
  const record = {
    address: "127.0.0.1",
    ownerInstanceId: first.ownerInstanceId,
    pid: 7001,
    port: 53201,
    processStartTime: "812345",
    runtimeVersion: "2026.8.6+b023a28ba",
  };
  const commands = [];
  for (const supervisor of [first, reopened]) {
    supervisor.extractRuntime = async () => runtime;
    supervisor.runLifecycle = async (_runtime, command) => {
      commands.push(command);
      return lifecycle(record);
    };
    supervisor.readConnection = async () => record;
    supervisor.authenticateConnection = async () => {};
  }

  const started = await first.initialize();
  const reconnected = await reopened.initialize();
  Assert.deepEqual(commands, ["start", "start"], "Both launches use the CLI");
  Assert.equal(
    reconnected.pid,
    started.pid,
    "Reopen reconnects to the same PID"
  );
  Assert.equal(
    reopened.ownerInstanceId,
    first.ownerInstanceId,
    "Reopen presents the same profile-derived owner identity"
  );
  Assert.deepEqual(
    synchronized,
    [
      { address: "127.0.0.1", port: 53201 },
      { address: "127.0.0.1", port: 53201 },
    ],
    "Every authenticated startup synchronizes the search engine"
  );
});

add_task(async function test_port_churn_resynchronizes_the_engine() {
  const root = testRoot("searxng-port-churn");
  const profile = childDirectory(root, "profile");
  const ports = [];
  const supervisor = createSupervisor(root, profile, endpoint => {
    ports.push(endpoint.port);
  });
  const runtime = fakeRuntime(root);
  const record = {
    address: "127.0.0.1",
    ownerInstanceId: supervisor.ownerInstanceId,
    pid: 7010,
    port: 54001,
    processStartTime: "900001",
    runtimeVersion: "2026.8.6+b023a28ba",
  };
  supervisor.extractRuntime = async () => runtime;
  supervisor.runLifecycle = async () => lifecycle(record);
  supervisor.readConnection = async () => record;
  supervisor.authenticateConnection = async () => {};

  await supervisor.initialize();
  record.pid = 7011;
  record.port = 54002;
  record.processStartTime = "900002";
  await supervisor.initialize();
  Assert.deepEqual(
    ports,
    [54001, 54002],
    "A new live port replaces the old template"
  );
});

add_task(async function test_failed_identity_never_requests_a_stop() {
  const root = testRoot("searxng-failed-identity");
  const profile = childDirectory(root, "profile");
  const supervisor = createSupervisor(root, profile, () => {});
  const runtime = fakeRuntime(root);
  const record = {
    address: "127.0.0.1",
    ownerInstanceId: supervisor.ownerInstanceId,
    pid: 7020,
    port: 54100,
    processStartTime: "910000",
    runtimeVersion: "2026.8.6+b023a28ba",
  };
  const commands = [];
  supervisor.extractRuntime = async () => runtime;
  supervisor.runLifecycle = async (_runtime, command) => {
    commands.push(command);
    return lifecycle(record);
  };
  supervisor.readConnection = async () => record;
  supervisor.authenticateConnection = async () => {
    throw new Error("authenticated identity mismatch");
  };

  await Assert.rejects(supervisor.initialize(), /identity mismatch/);
  Assert.deepEqual(
    commands,
    ["start"],
    "An identity failure does not issue stop, restart, or a PID signal"
  );
});

add_task(async function test_extraction_rejects_tamper_and_symlinks() {
  const root = testRoot("searxng-extracted-runtime");
  const extracted = childDirectory(root, "extracted");
  const bin = childDirectory(extracted, "bin", 0o755);
  const executable = PathUtils.join(bin.path, "service");
  const manifestPath = PathUtils.join(
    extracted.path,
    "wildbuzzard-runtime.json"
  );
  const markerPath = PathUtils.join(extracted.path, ".extraction-complete");
  const executableBytes = new TextEncoder().encode("service-runtime\n");
  const manifestBytes = new TextEncoder().encode('{"component":"test"}\n');
  await IOUtils.write(executable, executableBytes, { mode: "create" });
  await IOUtils.setPermissions(executable, 0o755);
  await IOUtils.write(manifestPath, manifestBytes, { mode: "create" });
  await IOUtils.setPermissions(manifestPath, 0o644);
  const bundle = {
    archiveSha256: "b".repeat(64),
    bundleId: "test-bundle",
    centralEntries: new Map([
      ["bin/service", { executable: true, realSize: executableBytes.length }],
      [
        "wildbuzzard-runtime.json",
        { executable: false, realSize: manifestBytes.length },
      ],
    ]),
    files: new Map([
      [
        "bin/service",
        { sha256: sha256(executableBytes), size: executableBytes.length },
      ],
    ]),
    manifestSha256: sha256(manifestBytes),
    manifestSize: manifestBytes.length,
  };
  await IOUtils.writeJSON(markerPath, {
    archiveSha256: bundle.archiveSha256,
    bundleId: bundle.bundleId,
    manifestSha256: bundle.manifestSha256,
    schema: 1,
  });
  await IOUtils.setPermissions(markerPath, 0o600);

  await SearXNGRuntimeTestUtils.verifyExtractedRuntime(extracted.path, bundle);
  await IOUtils.writeUTF8(executable, "tampered", { mode: "overwrite" });
  await Assert.rejects(
    SearXNGRuntimeTestUtils.verifyExtractedRuntime(extracted.path, bundle),
    /Invalid extracted SearXNG file/,
    "A changed runtime file invalidates reuse"
  );

  await IOUtils.remove(executable);
  const target = PathUtils.join(root.path, "outside");
  await IOUtils.writeUTF8(target, "outside", { mode: "create" });
  const link = await Subprocess.call({
    command: "/bin/ln",
    arguments: ["-s", target, executable],
    stderr: "pipe",
  });
  const result = await link.wait();
  Assert.equal(result.exitCode, 0, "The symlink fixture was created");
  await Assert.rejects(
    SearXNGRuntimeTestUtils.verifyExtractedRuntime(extracted.path, bundle),
    /Link in extracted SearXNG runtime/,
    "A symlink cannot replace an inventoried runtime file"
  );
});

add_task(function test_archive_paths_reject_traversal_and_aliases() {
  for (const path of [
    "../escape",
    "root/../escape",
    "/absolute",
    "root\\windows",
    "root//empty",
    "root/./alias",
    "root/e\u0301",
    "root/control\u0001",
  ]) {
    Assert.equal(
      SearXNGRuntimeTestUtils.safeArchivePath(path),
      false,
      `${JSON.stringify(path)} is not an extractable archive path`
    );
  }
  Assert.equal(
    SearXNGRuntimeTestUtils.safeArchivePath("python/bin/python3"),
    true,
    "A canonical relative runtime path is accepted"
  );
});
