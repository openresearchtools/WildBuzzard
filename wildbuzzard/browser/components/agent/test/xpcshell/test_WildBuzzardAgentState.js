/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { Subprocess } = ChromeUtils.importESModule(
  "resource://gre/modules/Subprocess.sys.mjs"
);
const { FileUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/FileUtils.sys.mjs"
);
const {
  privateDirectory,
  readPrivateJSON,
  writePrivateJSON,
} = ChromeUtils.importESModule(
  "resource:///modules/WildBuzzardAgentState.sys.mjs"
);

let testDirectory;

async function symlink(target, path) {
  const process = await Subprocess.call({
    command: "/bin/ln",
    arguments: ["-s", target, path],
  });
  const result = await process.wait();
  Assert.equal(result.exitCode, 0, `created symlink ${path}`);
}

add_setup(async function () {
  const suffix = Services.uuid.generateUUID().toString().slice(1, -1);
  testDirectory = PathUtils.join(
    Services.dirsvc.get("TmpD", Ci.nsIFile).path,
    `wildbuzzard-agent-state-${suffix}`
  );
  await privateDirectory(testDirectory);
  registerCleanupFunction(() =>
    IOUtils.remove(testDirectory, { recursive: true, ignoreAbsent: true })
  );
});

add_task(async function test_private_json_is_atomic_and_replaces_symlink() {
  const path = PathUtils.join(testDirectory, "state.json");
  const victim = PathUtils.join(testDirectory, "victim.json");
  const predictable = `${path}.new-${Services.appinfo.processID}-predictable`;
  await IOUtils.writeUTF8(victim, '{"victim":true}');
  await symlink(victim, path);
  await symlink(victim, predictable);

  await writePrivateJSON(path, { safe: true });

  Assert.deepEqual(await readPrivateJSON(path), { safe: true });
  Assert.equal(await IOUtils.readUTF8(victim), '{"victim":true}');
  Assert.ok(new FileUtils.File(predictable).isSymlink());
  Assert.equal((await IOUtils.stat(path)).permissions & 0o777, 0o600);
  Assert.deepEqual(
    (await IOUtils.getChildren(testDirectory)).filter(child =>
      child.startsWith(`${path}.new-`)
    ),
    [predictable],
    "the random temporary file is removed without touching a guessed path"
  );
});

add_task(async function test_private_json_rejects_unsafe_files() {
  const path = PathUtils.join(testDirectory, "unsafe.json");
  const target = PathUtils.join(testDirectory, "target.json");
  await IOUtils.writeUTF8(path, '{"unsafe":true}');
  await IOUtils.setPermissions(path, 0o644);
  Assert.equal(await readPrivateJSON(path), null, "0644 is rejected");
  await IOUtils.setPermissions(path, 0o400);
  Assert.equal(await readPrivateJSON(path), null, "0400 is rejected");
  await IOUtils.remove(path);
  await IOUtils.writeUTF8(target, '{"target":true}');
  await IOUtils.setPermissions(target, 0o600);
  await symlink(target, path);
  Assert.equal(await readPrivateJSON(path), null, "a symlink is rejected");
});

add_task(async function test_private_directory_does_not_follow_symlink() {
  const target = PathUtils.join(testDirectory, "directory-target");
  const path = PathUtils.join(testDirectory, "directory-link");
  await IOUtils.makeDirectory(target, { permissions: 0o755 });
  await IOUtils.setPermissions(target, 0o755);
  await symlink(target, path);
  await Assert.rejects(
    privateDirectory(path),
    /Unsafe Buzzard Agent Web state directory|exists/,
    "a state-directory symlink is rejected"
  );
  Assert.equal(
    (await IOUtils.stat(target)).permissions & 0o777,
    0o755,
    "the symlink target permissions are not changed"
  );
});
