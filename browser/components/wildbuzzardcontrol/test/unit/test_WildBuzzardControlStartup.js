/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const CONTROL_SOCKET_ENV = "WILDBUZZARD_CONTROL_SOCKET";
const LocalFile = Components.Constructor(
  "@mozilla.org/file/local;1",
  "nsIFile",
  "initWithPath"
);
const { WildBuzzardControlStartupTestUtils, wildBuzzardControlSocketPath } =
  ChromeUtils.importESModule(
    "resource:///modules/WildBuzzardControlStartup.sys.mjs"
  );

const originalOverride = Services.env.get(CONTROL_SOCKET_ENV);
const originalRuntimeDirectory = Services.env.get("XDG_RUNTIME_DIR");
const originalStateDirectory = Services.env.get("XDG_STATE_HOME");

add_setup(function () {
  Services.env.set(CONTROL_SOCKET_ENV, "");
  Services.env.set("XDG_RUNTIME_DIR", do_get_tempdir().path);
  registerCleanupFunction(() => {
    Services.env.set(CONTROL_SOCKET_ENV, originalOverride);
    Services.env.set("XDG_RUNTIME_DIR", originalRuntimeDirectory);
    Services.env.set("XDG_STATE_HOME", originalStateDirectory);
  });
});

add_task(function test_fallback_path_uses_product_state_directory() {
  const stateDirectory = PathUtils.join(do_get_tempdir().path, "state");
  Services.env.set("XDG_RUNTIME_DIR", "");
  Services.env.set("XDG_STATE_HOME", stateDirectory);
  try {
    Assert.equal(
      WildBuzzardControlStartupTestUtils.defaultSocketDirectory(),
      PathUtils.join(stateDirectory, "wildbuzzard", "run", "profiles")
    );
  } finally {
    Services.env.set("XDG_RUNTIME_DIR", do_get_tempdir().path);
    Services.env.set("XDG_STATE_HOME", originalStateDirectory);
  }
});

add_task(function test_default_paths_are_profile_and_process_specific() {
  const first = wildBuzzardControlSocketPath({
    instanceId: "AAAAAAAAAAAA",
    profilePath: "/profiles/first",
  });
  const second = wildBuzzardControlSocketPath({
    instanceId: "AAAAAAAAAAAA",
    profilePath: "/profiles/second",
  });
  const restarted = wildBuzzardControlSocketPath({
    instanceId: "BBBBBBBBBBBB",
    profilePath: "/profiles/first",
  });

  Assert.notEqual(first, second, "different profiles use different sockets");
  Assert.notEqual(
    first,
    restarted,
    "restarts cannot collide with stale sockets"
  );
  Assert.equal(
    PathUtils.parent(first),
    WildBuzzardControlStartupTestUtils.defaultSocketDirectory()
  );
  Assert.ok(
    /^control-[0-9a-f]{24}-[A-Za-z0-9_-]{12}\.sock$/.test(
      PathUtils.filename(first)
    ),
    "the default socket name contains only a profile digest and random ID"
  );
});

add_task(function test_override_must_be_a_safe_absolute_path() {
  const socketPath = PathUtils.join(
    do_get_tempdir().path,
    "wildbuzzard-control.sock"
  );
  Services.env.set(CONTROL_SOCKET_ENV, socketPath);
  Assert.equal(wildBuzzardControlSocketPath(), socketPath);

  for (const invalid of [
    "relative.sock",
    `${do_get_tempdir().path}/directory/../control.sock`,
  ]) {
    Services.env.set(CONTROL_SOCKET_ENV, invalid);
    Assert.throws(
      () => wildBuzzardControlSocketPath(),
      /normalized absolute path/,
      `${invalid} is rejected`
    );
  }
  Services.env.set(CONTROL_SOCKET_ENV, "");
});

add_task(async function test_custom_parent_must_already_be_private() {
  const root = PathUtils.join(
    do_get_tempdir().path,
    `wb-control-${Date.now()}`
  );
  const privateDirectory = PathUtils.join(root, "private");
  const sharedDirectory = PathUtils.join(root, "shared");
  await IOUtils.makeDirectory(privateDirectory, {
    createAncestors: true,
    permissions: 0o700,
  });
  await IOUtils.makeDirectory(sharedDirectory, { permissions: 0o755 });
  await IOUtils.setPermissions(privateDirectory, 0o700, false);
  await IOUtils.setPermissions(sharedDirectory, 0o755, false);
  registerCleanupFunction(() =>
    IOUtils.remove(root, { recursive: true, ignoreAbsent: true })
  );

  await WildBuzzardControlStartupTestUtils.prepareDirectory(
    privateDirectory,
    false
  );
  await Assert.rejects(
    WildBuzzardControlStartupTestUtils.prepareDirectory(sharedDirectory, false),
    /runtime directory permissions/,
    "the override cannot chmod and use a shared directory"
  );
  Assert.equal(
    new LocalFile(sharedDirectory).permissions & 0o777,
    0o755,
    "a rejected override leaves its parent permissions unchanged"
  );
});

add_task(async function test_existing_socket_target_is_never_deleted() {
  const path = PathUtils.join(
    do_get_tempdir().path,
    `wb-control-existing-${Date.now()}`
  );
  await IOUtils.writeUTF8(path, "keep");
  registerCleanupFunction(() => IOUtils.remove(path, { ignoreAbsent: true }));

  await Assert.rejects(
    WildBuzzardControlStartupTestUtils.ensureSocketPathUnused(path),
    /already exists/,
    "startup refuses to replace an existing path"
  );
  Assert.equal(await IOUtils.readUTF8(path), "keep");
});
