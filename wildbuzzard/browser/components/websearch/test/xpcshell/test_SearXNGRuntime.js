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
const { SearXNGPrivateTransportTestUtils } = ChromeUtils.importESModule(
  "resource:///modules/SearXNGPrivateTransport.sys.mjs"
);

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

function fakeRuntime(root, name = "fake-runtime", archive = "a") {
  const directory = childDirectory(root, name);
  return {
    archivePath: PathUtils.join(root.path, `${name}.zip`),
    archiveSha256: archive.repeat(64),
    bundleId: `1-test-${archive.repeat(64)}`,
    centralEntries: new Map(),
    directory: directory.path,
    files: new Map(),
    manifest: {
      protocolVersion: 1,
      runtimeVersion: "2026.8.6+b023a28ba",
    },
    manifestSha256: archive === "a" ? "b".repeat(64) : "c".repeat(64),
    sourcePath: PathUtils.join(root.path, "source.tar.xz"),
    sourceSha256:
      "c4d07e484d9e88a6deef78e02701bc6bdc100dbccb432d8492bbaa689e499f57",
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
    dataRootId: "test-data-root",
    ownerInstanceId: first.ownerInstanceId,
    pid: 7001,
    port: 53201,
    processStartTime: "812345",
    runtimeVersion: "2026.8.6+b023a28ba",
  };
  const commands = [];
  for (const supervisor of [first, reopened]) {
    supervisor.extractRuntime = async () => runtime;
    supervisor.readActiveRuntime = async () => null;
    supervisor.readStagedActivation = async () => null;
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
    dataRootId: "test-data-root",
    ownerInstanceId: supervisor.ownerInstanceId,
    pid: 7010,
    port: 54001,
    processStartTime: "900001",
    runtimeVersion: "2026.8.6+b023a28ba",
  };
  supervisor.extractRuntime = async () => runtime;
  supervisor.readActiveRuntime = async () => null;
  supervisor.readStagedActivation = async () => null;
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
    dataRootId: "test-data-root",
    ownerInstanceId: supervisor.ownerInstanceId,
    pid: 7020,
    port: 54100,
    processStartTime: "910000",
    runtimeVersion: "2026.8.6+b023a28ba",
  };
  const commands = [];
  supervisor.extractRuntime = async () => runtime;
  supervisor.readActiveRuntime = async () => null;
  supervisor.readStagedActivation = async () => null;
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

add_task(async function test_failed_upgrade_restores_verified_active_runtime() {
  const root = testRoot("searxng-upgrade-rollback");
  const profile = childDirectory(root, "profile");
  let synchronizeCalls = 0;
  const supervisor = createSupervisor(root, profile, () => {
    synchronizeCalls++;
    if (synchronizeCalls === 1) {
      throw new Error("engine synchronization failed");
    }
  });
  const previous = {
    ...fakeRuntime(root, "previous-runtime", "a"),
    activatedAt: 1775990400000,
    dataRootId: "preserved-data-root",
  };
  const candidate = fakeRuntime(root, "candidate-runtime", "d");
  const previousRecord = {
    address: "127.0.0.1",
    dataRootId: previous.dataRootId,
    ownerInstanceId: supervisor.ownerInstanceId,
    pid: 7101,
    port: 55101,
    processStartTime: "920001",
    runtimeVersion: "2026.8.6+b023a28ba",
  };
  const candidateRecord = {
    ...previousRecord,
    pid: 7102,
    port: 55102,
    processStartTime: "920002",
  };
  const commands = [];
  supervisor.extractRuntime = async () => {
    await IOUtils.writeUTF8(supervisor.connectionPath, "owned", {
      mode: "create",
    });
    await IOUtils.setPermissions(supervisor.connectionPath, 0o600);
    return candidate;
  };
  supervisor.readActiveRuntime = async () => previous;
  supervisor.readStagedActivation = async () => null;
  supervisor.readConnection = async runtime =>
    runtime.bundleId === candidate.bundleId ? candidateRecord : previousRecord;
  supervisor.authenticateConnection = async () => {};
  supervisor.runLifecycle = async (runtime, command) => {
    commands.push(`${runtime.bundleId}:${command}`);
    if (command === "stop") {
      return { component: "searxng", running: false };
    }
    return lifecycle(
      runtime.bundleId === candidate.bundleId ? candidateRecord : previousRecord
    );
  };

  await Assert.rejects(
    supervisor.initialize(),
    /engine synchronization failed/
  );
  Assert.deepEqual(
    commands.map(value => value.slice(value.lastIndexOf(":") + 1)),
    ["status", "stop", "start", "status", "stop", "start"],
    "The verified prior runtime is stopped, then restored after candidate failure"
  );
  const active = await IOUtils.readJSON(supervisor.activeRuntimePath);
  Assert.equal(active.bundleId, previous.bundleId);
  Assert.equal(active.dataRootId, previous.dataRootId);
  Assert.ok(
    !(await IOUtils.exists(supervisor.stagedActivationPath)),
    "The rollback commits and removes staged activation metadata"
  );
});

add_task(
  async function test_interrupted_first_activation_syncs_before_commit() {
    const root = testRoot("searxng-first-activation-recovery");
    const profile = childDirectory(root, "profile");
    let synchronized = null;
    let supervisor;
    supervisor = createSupervisor(root, profile, async endpoint => {
      Assert.ok(
        !(await IOUtils.exists(supervisor.activeRuntimePath)),
        "Recovery does not commit before engine synchronization"
      );
      synchronized = endpoint;
    });
    await supervisor.ensureDirectories();
    const candidate = fakeRuntime(root, "interrupted-candidate", "d");
    const record = {
      address: "127.0.0.1",
      dataRootId: "first-data-root",
      ownerInstanceId: supervisor.ownerInstanceId,
      pid: 7150,
      port: 55150,
      processStartTime: "925000",
      runtimeVersion: "2026.8.6+b023a28ba",
    };
    await IOUtils.writeJSON(
      supervisor.stagedActivationPath,
      {},
      {
        mode: "create",
      }
    );
    await IOUtils.setPermissions(supervisor.stagedActivationPath, 0o600);
    await IOUtils.writeJSON(supervisor.connectionPath, {}, { mode: "create" });
    await IOUtils.setPermissions(supervisor.connectionPath, 0o600);
    supervisor.readConnection = async runtime => {
      Assert.equal(runtime.bundleId, candidate.bundleId);
      return record;
    };
    supervisor.authenticateConnection = async value => {
      Assert.equal(value, record);
    };

    const recovered = await supervisor.recoverStagedActivation(
      {
        candidate,
        dataRootId: record.dataRootId,
        previous: null,
      },
      null
    );
    Assert.deepEqual(synchronized, {
      address: record.address,
      port: record.port,
    });
    Assert.equal(recovered.record, record);
    Assert.equal(
      (await IOUtils.readJSON(supervisor.activeRuntimePath)).dataRootId,
      record.dataRootId
    );
    Assert.ok(!(await IOUtils.exists(supervisor.stagedActivationPath)));
  }
);

add_task(async function test_first_activation_recovers_created_data_identity() {
  const root = testRoot("searxng-first-activation-data-root");
  const profile = childDirectory(root, "profile");
  const supervisor = createSupervisor(root, profile, () => {});
  await supervisor.ensureDirectories();
  const candidate = fakeRuntime(root, "staged-first-candidate", "d");
  const dataRootId = "created-first-data-root";
  const identityPath = PathUtils.join(supervisor.dataDirectory, "data-root-id");
  await IOUtils.writeUTF8(identityPath, `${dataRootId}\n`, { mode: "create" });
  await IOUtils.setPermissions(identityPath, 0o600);
  await IOUtils.writeJSON(supervisor.stagedActivationPath, {
    candidate: supervisor.runtimeDescriptor(candidate),
    dataRootId: null,
    ownerInstanceId: supervisor.ownerInstanceId,
    preparedAt: Date.now(),
    previous: null,
    schema: 1,
  });
  await IOUtils.setPermissions(supervisor.stagedActivationPath, 0o600);
  supervisor.validateRuntimeDescriptor = async (descriptor, options) => {
    Assert.equal(descriptor.bundleId, candidate.bundleId);
    Assert.ok(options.repairExtraction);
    return candidate;
  };

  const staged = await supervisor.readStagedActivation({
    repairExtraction: true,
  });
  Assert.equal(
    staged.dataRootId,
    dataRootId,
    "The service-created first data identity is retained across recovery"
  );
});

add_task(
  async function test_active_runtime_metadata_is_read_and_identity_bound() {
    const root = testRoot("searxng-active-runtime");
    const profile = childDirectory(root, "profile");
    const supervisor = createSupervisor(root, profile, () => {});
    for (const path of [
      supervisor.bundleRoot,
      supervisor.dataDirectory,
      supervisor.stateDirectory,
    ]) {
      await IOUtils.makeDirectory(path, {
        createAncestors: true,
        ignoreExisting: true,
        permissions: 0o700,
      });
    }
    const dataRootId = "active-data-root";
    const identityPath = PathUtils.join(
      supervisor.dataDirectory,
      "data-root-id"
    );
    await IOUtils.writeUTF8(identityPath, `${dataRootId}\n`, {
      mode: "create",
    });
    await IOUtils.setPermissions(identityPath, 0o600);
    const runtime = fakeRuntime(root, "active-runtime", "a");
    await IOUtils.writeJSON(
      supervisor.activeRuntimePath,
      supervisor.activeRuntimeRecord(runtime, dataRootId, 1775990400000)
    );
    await IOUtils.setPermissions(supervisor.activeRuntimePath, 0o600);
    let validated = false;
    supervisor.validateRuntimeDescriptor = async (descriptor, options) => {
      validated = true;
      Assert.equal(descriptor.bundleId, runtime.bundleId);
      Assert.ok(
        options.repairExtraction,
        "Startup may repair a corrupted retained active extraction"
      );
      return runtime;
    };
    const active = await supervisor.readActiveRuntime({
      repairExtraction: true,
    });
    Assert.ok(validated, "Active metadata is verified rather than write-only");
    Assert.equal(active.dataRootId, dataRootId);

    const tampered = await IOUtils.readJSON(supervisor.activeRuntimePath);
    tampered.dataRootId = "swapped-data-root";
    await IOUtils.writeJSON(supervisor.activeRuntimePath, tampered, {
      mode: "overwrite",
    });
    await IOUtils.setPermissions(supervisor.activeRuntimePath, 0o600);
    await Assert.rejects(
      supervisor.readActiveRuntime(),
      /data identity mismatch/,
      "Tampered active metadata fails closed"
    );
  }
);

add_task(async function test_status_is_read_only_and_identity_authenticated() {
  const root = testRoot("searxng-runtime-status");
  const profile = childDirectory(root, "profile");
  const supervisor = createSupervisor(root, profile, () => {});
  await supervisor.ensureDirectories();
  await IOUtils.writeJSON(supervisor.activeRuntimePath, {}, { mode: "create" });
  await IOUtils.setPermissions(supervisor.activeRuntimePath, 0o600);
  await IOUtils.writeJSON(supervisor.connectionPath, {}, { mode: "create" });
  await IOUtils.setPermissions(supervisor.connectionPath, 0o600);
  const active = {
    ...fakeRuntime(root, "status-runtime"),
    dataRootId: "status-data-root",
  };
  const record = {
    address: "127.0.0.1",
    pid: 7201,
    port: 55201,
  };
  let authenticated = false;
  supervisor.readActiveRuntime = async () => active;
  supervisor.readConnection = async runtime => {
    Assert.equal(runtime.bundleId, active.bundleId);
    return record;
  };
  supervisor.authenticateConnection = async value => {
    Assert.equal(value, record);
    authenticated = true;
  };
  supervisor.runLifecycle = async () => {
    throw new Error("Status must not mutate lifecycle state");
  };

  const status = await supervisor.status();
  Assert.ok(authenticated);
  Assert.deepEqual(status, {
    address: "127.0.0.1",
    available: true,
    component: "searxng",
    dataRootId: "status-data-root",
    pid: 7201,
    port: 55201,
    running: true,
    runtimeVersion: "2026.8.6+b023a28ba",
    state: "running",
  });
});

add_task(async function test_repair_quarantines_runtime_and_preserves_data() {
  const root = testRoot("searxng-runtime-repair");
  const profile = childDirectory(root, "profile");
  const supervisor = createSupervisor(root, profile, () => {});
  await supervisor.ensureDirectories();
  const dataMarker = PathUtils.join(supervisor.dataDirectory, "preserved");
  await IOUtils.writeUTF8(dataMarker, "persistent data", { mode: "create" });
  const active = {
    ...fakeRuntime(root, "repair-active", "a"),
    dataRootId: "repair-data-root",
  };
  const candidate = fakeRuntime(root, "repair-candidate", "d");
  await IOUtils.writeJSON(supervisor.activeRuntimePath, {}, { mode: "create" });
  await IOUtils.setPermissions(supervisor.activeRuntimePath, 0o600);
  supervisor.readActiveRuntime = async () => active;
  supervisor.extractRuntime = async () => candidate;
  supervisor.activateRuntime = async (runtime, previous) => {
    Assert.equal(runtime.bundleId, candidate.bundleId);
    Assert.equal(previous, null);
    return {
      address: "127.0.0.1",
      ownerInstanceId: supervisor.ownerInstanceId,
      pid: 7301,
      port: 55301,
      protocolVersion: 1,
      runtimeVersion: "2026.8.6+b023a28ba",
    };
  };

  const result = await supervisor.repair();
  Assert.equal(result.pid, 7301);
  Assert.ok(!(await IOUtils.exists(active.directory)));
  Assert.equal(await IOUtils.readUTF8(dataMarker), "persistent data");
  Assert.equal(supervisor.initializationTask, null);
});

add_task(
  async function test_extraction_lock_release_never_removes_a_peer_lock() {
    const root = testRoot("searxng-extraction-lock-race");
    const state = childDirectory(root, "state");
    const release = await SearXNGRuntimeTestUtils.acquireExtractionLock(
      state.path
    );
    const lock = PathUtils.join(state.path, "browser-extraction.lock");
    const original = PathUtils.join(state.path, "original-lock");
    await IOUtils.move(lock, original, { noOverwrite: true });
    await IOUtils.makeDirectory(lock, { permissions: 0o700 });
    await IOUtils.writeJSON(PathUtils.join(lock, "owner.json"), {
      createdAt: Date.now(),
      pid: Services.appinfo.processID,
      processStartTime: "1",
      schema: 1,
      token: "peer-lock-token-1234567890",
    });
    await IOUtils.setPermissions(PathUtils.join(lock, "owner.json"), 0o600);
    await Assert.rejects(release(), /ownership changed/);
    Assert.ok(await IOUtils.exists(lock), "The replacement peer lock remains");
    Assert.equal(
      (await IOUtils.readJSON(PathUtils.join(lock, "owner.json"))).token,
      "peer-lock-token-1234567890"
    );
  }
);

add_task(async function test_source_digest_is_checked_before_retention() {
  const root = testRoot("searxng-source-digest");
  const profile = childDirectory(root, "profile");
  const supervisor = createSupervisor(root, profile, () => {});
  await IOUtils.makeDirectory(supervisor.sourcesDirectory, {
    createAncestors: true,
    permissions: 0o700,
  });
  const source = PathUtils.join(root.path, "source.tar.xz");
  await IOUtils.writeUTF8(source, "tampered source", { mode: "create" });
  const manifest = {
    correspondingSource: "wildbuzzard-searxng-2026.8.6+b023a28ba-source.tar.xz",
    correspondingSourceSha256:
      "c4d07e484d9e88a6deef78e02701bc6bdc100dbccb432d8492bbaa689e499f57",
  };
  await Assert.rejects(
    supervisor.retainSourceArchive(source, {
      manifest,
      release: { manifest },
    }),
    /digest mismatch/,
    "Startup cannot retain or execute beside mismatched corresponding source"
  );
});

add_task(async function test_private_transport_auth_vectors_match_service() {
  const body = new TextEncoder().encode("q=test&format=json");
  const request = await SearXNGPrivateTransportTestUtils.requestAuthentication(
    "test-capability",
    "POST",
    "/search",
    body,
    "nonce-abcdefghijklmnopqrstuvwxyz1234"
  );
  Assert.equal(
    request,
    "da86986e0409ca59e8490538e9f79924b51595b8082d2cb6eebd8b7666f2abed"
  );
  const response =
    await SearXNGPrivateTransportTestUtils.responseAuthentication(
      "test-capability",
      "nonce-abcdefghijklmnopqrstuvwxyz1234",
      200,
      "application/json",
      new TextEncoder().encode('{"ok":true}')
    );
  Assert.equal(
    response,
    "28b2a82e549e4a64bba6e70d9cbe91a78d9576acb9cdc558c651a47af5751393"
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
