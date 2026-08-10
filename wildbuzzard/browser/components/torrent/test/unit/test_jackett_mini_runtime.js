/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const {
  JackettMiniRuntime,
  JackettMiniRuntimeTestUtils,
  jackettMiniProfileNamespace,
} = ChromeUtils.importESModule(
  "resource:///modules/JackettMiniRuntime.sys.mjs"
);

function sha256(bytes) {
  const hash = Cc["@mozilla.org/security/hash;1"].createInstance(
    Ci.nsICryptoHash
  );
  hash.initWithString("sha256");
  hash.update(bytes, bytes.length);
  return Array.from(hash.finish(false), character =>
    character.charCodeAt(0).toString(16).padStart(2, "0")
  ).join("");
}

function childDirectory(parent, name) {
  const directory = parent.clone();
  directory.append(name);
  directory.create(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
  return directory;
}

add_setup(function setup() {
  do_get_profile();
});

add_task(function test_profile_namespace_is_canonical_and_non_secret() {
  const root = do_get_tempdir().clone();
  root.append("jackett-mini-profile-namespace");
  root.createUnique(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
  registerCleanupFunction(() => root.remove(true));
  const profile = childDirectory(root, "profile-path-must-not-leak");

  const direct = jackettMiniProfileNamespace(profile.path);
  const canonicalAlias = jackettMiniProfileNamespace(`${profile.path}/.`);

  Assert.equal(
    direct,
    canonicalAlias,
    "Canonical aliases identify one profile"
  );
  Assert.ok(
    /^profile-[a-f0-9]{64}$/.test(direct),
    "The namespace uses a full domain-separated SHA-256 digest"
  );
  Assert.ok(
    !direct.includes(profile.leafName),
    "The namespace does not disclose the profile path"
  );
});

add_task(function test_unicode_distinct_profile_namespaces_do_not_collide() {
  const root = do_get_tempdir().clone();
  root.append("jackett-mini-unicode-profile-paths");
  root.createUnique(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
  registerCleanupFunction(() => root.remove(true));
  const nfcProfile = childDirectory(root, "profile-\u00e9");
  const nfdProfile = root.clone();
  nfdProfile.append("profile-e\u0301");
  if (nfdProfile.exists()) {
    info("The filesystem aliases NFC and NFD profile names");
    return;
  }
  nfdProfile.create(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
  const dataHome = childDirectory(root, "xdg-data");
  const runtimeHome = childDirectory(root, "xdg-runtime");
  const options = { dataHome: dataHome.path, runtimeHome: runtimeHome.path };
  const nfcRuntime = new JackettMiniRuntime({
    ...options,
    profilePath: nfcProfile.path,
  });
  const nfdRuntime = new JackettMiniRuntime({
    ...options,
    profilePath: nfdProfile.path,
  });

  Assert.notEqual(
    jackettMiniProfileNamespace(nfcProfile.path),
    jackettMiniProfileNamespace(nfdProfile.path),
    "Distinct profile paths use distinct namespaces"
  );
  Assert.notEqual(
    nfcRuntime.connectionPath,
    nfdRuntime.connectionPath,
    "Distinct Unicode profile paths cannot share capabilities"
  );
  Assert.notEqual(
    nfcRuntime.dataDirectory,
    nfdRuntime.dataDirectory,
    "Distinct Unicode profile paths cannot share data"
  );
  Assert.notEqual(
    nfcRuntime.stateDirectory,
    nfdRuntime.stateDirectory,
    "Distinct Unicode profile paths cannot share process state"
  );
});

add_task(function test_profile_runtime_paths_isolate_capabilities_and_data() {
  const root = do_get_tempdir().clone();
  root.append("jackett-mini-profile-paths");
  root.createUnique(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
  registerCleanupFunction(() => root.remove(true));
  const profileA = childDirectory(root, "firefox-profile-a");
  const profileB = childDirectory(root, "firefox-profile-b");
  const dataHome = childDirectory(root, "xdg-data");
  const runtimeHome = childDirectory(root, "xdg-runtime");
  const options = { dataHome: dataHome.path, runtimeHome: runtimeHome.path };

  const firstWindow = new JackettMiniRuntime({
    ...options,
    profilePath: profileA.path,
  });
  const reopenedBrowser = new JackettMiniRuntime({
    ...options,
    profilePath: `${profileA.path}/.`,
  });
  const otherProfile = new JackettMiniRuntime({
    ...options,
    profilePath: profileB.path,
  });

  Assert.equal(
    firstWindow.connectionPath,
    reopenedBrowser.connectionPath,
    "One profile reuses its capability-bearing connection record"
  );
  Assert.equal(
    firstWindow.dataDirectory,
    reopenedBrowser.dataDirectory,
    "One profile keeps persistent data across browser reopen"
  );
  Assert.notEqual(
    firstWindow.connectionPath,
    otherProfile.connectionPath,
    "Distinct profiles cannot reuse capabilities"
  );
  Assert.notEqual(
    firstWindow.dataDirectory,
    otherProfile.dataDirectory,
    "Distinct profiles cannot reuse result or provider data"
  );
  Assert.notEqual(
    firstWindow.stateDirectory,
    otherProfile.stateDirectory,
    "Distinct profiles cannot reuse process state or launch locks"
  );
  for (const path of [
    firstWindow.rootDirectory,
    firstWindow.stateDirectory,
    firstWindow.connectionPath,
  ]) {
    Assert.ok(
      !path.includes(profileA.path),
      "No external state path leaks ProfD"
    );
  }
});

add_task(
  async function test_extracted_runtime_revalidates_complete_inventory() {
    const root = do_get_tempdir().clone();
    root.append("jackett-mini-extracted-runtime");
    root.createUnique(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
    registerCleanupFunction(() => root.remove(true));
    const executable = PathUtils.join(root.path, "jackett-mini");
    const catalog = PathUtils.join(root.path, "catalog.json");
    const manifest = PathUtils.join(root.path, "jackett-mini-runtime.json");
    const executableBytes = new TextEncoder().encode("runtime");
    const catalogBytes = new TextEncoder().encode('{"immutable":true}\n');
    const manifestBytes = new TextEncoder().encode('{"schemaVersion":1}\n');
    await IOUtils.write(executable, executableBytes, { mode: "create" });
    await IOUtils.setPermissions(executable, 0o755);
    await IOUtils.write(catalog, catalogBytes, { mode: "create" });
    await IOUtils.setPermissions(catalog, 0o644);
    await IOUtils.write(manifest, manifestBytes, { mode: "create" });
    await IOUtils.setPermissions(manifest, 0o644);
    const bundle = {
      files: new Map([
        [
          "jackett-mini",
          {
            executable: true,
            sha256: sha256(executableBytes),
            size: executableBytes.length,
          },
        ],
        [
          "catalog.json",
          {
            executable: false,
            sha256: sha256(catalogBytes),
            size: catalogBytes.length,
          },
        ],
      ]),
      manifestSha256: sha256(manifestBytes),
      manifestSize: manifestBytes.length,
    };

    await JackettMiniRuntimeTestUtils.verifyExtractedRuntime(root.path, bundle);
    await IOUtils.writeUTF8(catalog, "tampered", { mode: "overwrite" });
    await Assert.rejects(
      JackettMiniRuntimeTestUtils.verifyExtractedRuntime(root.path, bundle),
      /Invalid extracted Jackett Mini file/,
      "A changed catalog invalidates a reused runtime"
    );
    await IOUtils.write(catalog, catalogBytes, { mode: "overwrite" });
    await IOUtils.writeUTF8(PathUtils.join(root.path, "extra.dll"), "extra", {
      mode: "create",
    });
    await Assert.rejects(
      JackettMiniRuntimeTestUtils.verifyExtractedRuntime(root.path, bundle),
      /Unexpected extracted Jackett Mini path/,
      "An unmanifested runtime file invalidates a reused runtime"
    );
    await IOUtils.remove(PathUtils.join(root.path, "extra.dll"));
    await IOUtils.makeDirectory(PathUtils.join(root.path, "empty"));
    await Assert.rejects(
      JackettMiniRuntimeTestUtils.verifyExtractedRuntime(root.path, bundle),
      /Unexpected extracted Jackett Mini directory/,
      "An unmanifested empty directory invalidates a reused runtime"
    );
    await IOUtils.remove(PathUtils.join(root.path, "empty"));
    await IOUtils.setPermissions(catalog, 0o755);
    await Assert.rejects(
      JackettMiniRuntimeTestUtils.verifyExtractedRuntime(root.path, bundle),
      /Invalid extracted Jackett Mini file/,
      "Changed executable permissions invalidate a reused runtime"
    );
    await IOUtils.setPermissions(catalog, 0o644);
    await IOUtils.remove(catalog);
    await Assert.rejects(
      JackettMiniRuntimeTestUtils.verifyExtractedRuntime(root.path, bundle),
      /Incomplete extracted Jackett Mini runtime/,
      "A missing runtime file invalidates a reused runtime"
    );
  }
);
