"use strict";

/* import-globals-from ../../../../../../toolkit/components/extensions/test/xpcshell/head.js */

const { NativeManifests } = ChromeUtils.importESModule(
  "resource://gre/modules/NativeManifests.sys.mjs"
);
const { FileUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/FileUtils.sys.mjs"
);
const { Schemas } = ChromeUtils.importESModule(
  "resource://gre/modules/Schemas.sys.mjs"
);

const TYPE_SLUG =
  AppConstants.platform === "linux"
    ? "native-messaging-hosts"
    : "NativeMessagingHosts";

let dir = FileUtils.getDir("TmpD", ["NativeManifestsWildBuzzard"]);
dir.createUnique(Ci.nsIFile.DIRECTORY_TYPE, FileUtils.PERMS_DIRECTORY);

function makeDirectory(parent, name) {
  let result = parent.clone();
  result.append(name);
  result.create(Ci.nsIFile.DIRECTORY_TYPE, FileUtils.PERMS_DIRECTORY);
  return result;
}

let userRoot = makeDirectory(dir, "user");
let globalRoot = makeDirectory(dir, "global");
let userDir = makeDirectory(userRoot, "wildbuzzard");
let userMozillaDir = makeDirectory(userRoot, ".mozilla");
let globalDir = makeDirectory(globalRoot, "wildbuzzard");
let globalMozillaDir = makeDirectory(globalRoot, "mozilla");

add_setup(async function setup() {
  await Schemas.load("chrome://extensions/content/schemas/manifest.json");
  for (let manifestDir of [
    userDir,
    userMozillaDir,
    globalDir,
    globalMozillaDir,
  ]) {
    await IOUtils.makeDirectory(PathUtils.join(manifestDir.path, TYPE_SLUG));
  }
});

let dirProvider = {
  getFile(property) {
    if (property == "XREUserNativeManifests") {
      return userDir.clone();
    }
    if (property == "XRESysNativeManifests") {
      return globalDir.clone();
    }
    return null;
  },
};

Services.dirsvc.registerProvider(dirProvider);

registerCleanupFunction(() => {
  Services.dirsvc.unregisterProvider(dirProvider);
  dir.remove(true);
});

let global = this;

let context = {
  extension: {
    id: "extension@tests.wildbuzzard.org",
  },
  manifestVersion: 2,
  envType: "addon_parent",
  url: null,
  jsonStringify(...args) {
    return JSON.stringify(...args);
  },
  cloneScope: global,
  logError() {},
  preprocessors: {},
  callOnClose: () => {},
  forgetOnClose: () => {},
};

async function writeApplicationManifest(rootDir, name, description) {
  let manifest = {
    name,
    description,
    path: "/bin/cat",
    type: "stdio",
    allowed_extensions: ["extension@tests.wildbuzzard.org"],
  };
  let path = PathUtils.join(rootDir.path, TYPE_SLUG, `${name}.json`);
  await IOUtils.writeUTF8(path, JSON.stringify(manifest));
  return { manifest, path };
}

function lookupApplication(app) {
  return NativeManifests.lookupManifest("stdio", app, context);
}

add_task(async function test_mozilla_manifest_dirs_are_ignored() {
  await writeApplicationManifest(userMozillaDir, "mozilla_user", "ignored");
  await writeApplicationManifest(globalMozillaDir, "mozilla_system", "ignored");

  equal(await lookupApplication("mozilla_user"), null);
  equal(await lookupApplication("mozilla_system"), null);
});

add_task(async function test_wildbuzzard_manifest_dirs() {
  let user = await writeApplicationManifest(
    userDir,
    "precedence",
    "WildBuzzard user manifest"
  );
  await writeApplicationManifest(
    globalDir,
    "precedence",
    "WildBuzzard system manifest"
  );
  let system = await writeApplicationManifest(
    globalDir,
    "system_only",
    "WildBuzzard system manifest"
  );

  let result = await lookupApplication("precedence");
  equal(result.path, user.path);
  deepEqual(result.manifest, user.manifest);

  result = await lookupApplication("system_only");
  equal(result.path, system.path);
  deepEqual(result.manifest, system.manifest);
});
