/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { JackettMiniRuntime, jackettMiniProfileNamespace } =
  ChromeUtils.importESModule("resource:///modules/JackettMiniRuntime.sys.mjs");

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
    "Canonical aliases identify one profile",
  );
  Assert.ok(
    /^profile-[a-f0-9]{64}$/.test(direct),
    "The namespace uses a full domain-separated SHA-256 digest",
  );
  Assert.ok(
    !direct.includes(profile.leafName),
    "The namespace does not disclose the profile path",
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
    "Distinct profile paths use distinct namespaces",
  );
  Assert.notEqual(
    nfcRuntime.connectionPath,
    nfdRuntime.connectionPath,
    "Distinct Unicode profile paths cannot share capabilities",
  );
  Assert.notEqual(
    nfcRuntime.dataDirectory,
    nfdRuntime.dataDirectory,
    "Distinct Unicode profile paths cannot share data",
  );
  Assert.notEqual(
    nfcRuntime.stateDirectory,
    nfdRuntime.stateDirectory,
    "Distinct Unicode profile paths cannot share process state",
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
    "One profile reuses its capability-bearing connection record",
  );
  Assert.equal(
    firstWindow.dataDirectory,
    reopenedBrowser.dataDirectory,
    "One profile keeps persistent data across browser reopen",
  );
  Assert.notEqual(
    firstWindow.connectionPath,
    otherProfile.connectionPath,
    "Distinct profiles cannot reuse capabilities",
  );
  Assert.notEqual(
    firstWindow.dataDirectory,
    otherProfile.dataDirectory,
    "Distinct profiles cannot reuse result or provider data",
  );
  Assert.notEqual(
    firstWindow.stateDirectory,
    otherProfile.stateDirectory,
    "Distinct profiles cannot reuse process state or launch locks",
  );
  for (const path of [
    firstWindow.rootDirectory,
    firstWindow.stateDirectory,
    firstWindow.connectionPath,
  ]) {
    Assert.ok(
      !path.includes(profileA.path),
      "No external state path leaks ProfD",
    );
  }
});
