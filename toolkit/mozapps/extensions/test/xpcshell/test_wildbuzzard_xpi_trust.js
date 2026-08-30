/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

gUseRealCertChecks = true;

const EXTENSIONS = [
  {
    artifact: "wildbuzzard-torrent-search-0.1.0.xpi",
    id: "torrent-search@extensions.wildbuzzard",
  },
  {
    artifact: "wildbuzzard-web-search-0.1.0.xpi",
    id: "web-search@extensions.wildbuzzard",
  },
];

const { isPinnedWildBuzzardXPI } = ChromeUtils.importESModule(
  "resource://gre/modules/addons/WildBuzzardXPITrust.sys.mjs"
);

async function fixtureXPI(artifact) {
  const encoded = await IOUtils.readUTF8(
    do_get_file(`data/${artifact}.base64url`).path
  );
  const bytes = new Uint8Array(
    ChromeUtils.base64URLDecode(encoded.replace(/\s/gu, ""), {
      padding: "ignore",
    })
  );
  const file = AddonTestUtils.tempDir.clone();
  file.append(artifact);
  await IOUtils.write(file.path, bytes);
  return file;
}

async function modifiedCopy(file) {
  const bytes = await IOUtils.read(file.path);
  const modified = new Uint8Array(bytes.length + 1);
  modified.set(bytes);
  modified[bytes.length] = 1;
  const destination = AddonTestUtils.tempDir.clone();
  destination.append(`modified-${file.leafName}`);
  await IOUtils.write(destination.path, modified);
  return destination;
}

async function assertRejected(file) {
  const install = await AddonManager.getInstallForFile(file);
  await Assert.rejects(install.install(), /Install failed/);
  Assert.equal(install.error, AddonManager.ERROR_SIGNEDSTATE_REQUIRED);
  Assert.equal(install.addon, null);
}

createAppInfo("xpcshell@tests.mozilla.org", "XPCShell", "128", "128");

add_setup(async function () {
  do_get_profile();
  Services.prefs.setBoolPref(PREF_XPI_SIGNATURES_REQUIRED, true);
  Services.prefs.setIntPref(
    "extensions.enabledScopes",
    AddonManager.SCOPE_PROFILE | AddonManager.SCOPE_APPLICATION
  );
  const config = await fetch(
    "chrome://browser/content/built_in_addons.json"
  ).then(response => response.json());
  const ids = new Set(EXTENSIONS.map(extension => extension.id));
  const builtins = config.builtins.filter(entry => ids.has(entry.addon_id));
  Assert.deepEqual(
    builtins.map(entry => entry.addon_id).sort(),
    [...ids].sort(),
    "both WildBuzzard extensions are packaged as built-ins"
  );
  await overrideBuiltIns({ builtins, system: [] });
  await promiseStartupManager();
  registerCleanupFunction(async () => {
    await promiseShutdownManager();
  });
});

add_task(async function test_exact_pinned_xpis_replace_builtins() {
  for (const { artifact, id } of EXTENSIONS) {
    const builtin = await AddonManager.getAddonByID(id);
    Assert.ok(builtin?.isBuiltin, `${id} starts as a built-in`);
    Assert.equal(builtin.locationName, "app-builtin-addons");

    const file = await fixtureXPI(artifact);
    Assert.ok(
      await isPinnedWildBuzzardXPI({
        addonId: id,
        addonType: "extension",
        installLocationName: "app-profile",
        file,
      }),
      `${artifact} matches the production whole-XPI pin`
    );
    Assert.ok(
      !(await isPinnedWildBuzzardXPI({
        addonId: id,
        addonType: "extension",
        installLocationName: "app-temporary",
        file,
      })),
      "the same artifact is not trusted as a temporary install"
    );
    Assert.ok(
      !(await isPinnedWildBuzzardXPI({
        addonId: id,
        addonType: "theme",
        installLocationName: "app-profile",
        file,
      })),
      "the pin cannot authorize another add-on type"
    );
    const install = await AddonManager.getInstallForFile(file);
    await install.install();
    Assert.equal(install.state, AddonManager.STATE_INSTALLED);

    const installed = await AddonManager.getAddonByID(id);
    Assert.ok(!installed.isBuiltin, `${id} is now the profile copy`);
    Assert.equal(installed.locationName, "app-profile");
    Assert.equal(installed.signedState, AddonManager.SIGNEDSTATE_SIGNED);
    await installed.uninstall();

    const restored = await AddonManager.getAddonByID(id);
    Assert.ok(
      restored?.isBuiltin,
      `${id} reveals its built-in after uninstall`
    );
    Assert.equal(restored.locationName, "app-builtin-addons");
  }
});

add_task(async function test_modified_same_id_xpis_are_rejected() {
  for (const { artifact, id } of EXTENSIONS) {
    const modified = await modifiedCopy(await fixtureXPI(artifact));
    Assert.ok(
      !(await isPinnedWildBuzzardXPI({
        addonId: id,
        addonType: "extension",
        installLocationName: "app-profile",
        file: modified,
      }))
    );
    await assertRejected(modified);
    Assert.ok((await AddonManager.getAddonByID(id)).isBuiltin);
  }
});

add_task(async function test_arbitrary_unsigned_xpi_is_rejected() {
  const file = createTempWebExtensionFile({
    manifest: {
      browser_specific_settings: {
        gecko: { id: "untrusted-external@extensions.example" },
      },
      manifest_version: 2,
      name: "Untrusted external extension",
      version: "1.0",
    },
  });
  await assertRejected(file);
});
