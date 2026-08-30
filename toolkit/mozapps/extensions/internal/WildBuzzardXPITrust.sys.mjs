/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getHashStringForCrypto } from "resource://gre/modules/addons/crypto-utils.sys.mjs";

const FileInputStream = Components.Constructor(
  "@mozilla.org/network/file-input-stream;1",
  "nsIFileInputStream",
  "init"
);
const CryptoHash = Components.Constructor(
  "@mozilla.org/security/hash;1",
  "nsICryptoHash",
  "initWithString"
);

const PIN_URI = "resource://gre/modules/addons/WildBuzzardXPIPins.json";
const PROFILE_LOCATION = "app-profile";
const MAX_XPI_BYTES = 4 * 1024 * 1024;
const EXPECTED_EXTENSION_IDS = new Set([
  "torrent-search@extensions.wildbuzzard",
  "web-search@extensions.wildbuzzard",
]);
const SHA256 = /^[0-9a-f]{64}$/;
const VERSION = /^[0-9]+(?:\.[0-9]+){1,3}$/;

let productionPins;

function exactKeys(value, keys) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
  );
}

function validatePins(value) {
  if (
    !exactKeys(value, ["extensions", "hashAlgorithm", "schema"]) ||
    value.schema !== 1 ||
    value.hashAlgorithm !== "sha256" ||
    !Array.isArray(value.extensions) ||
    !value.extensions.length
  ) {
    throw new Error("Invalid WildBuzzard XPI pin set");
  }
  const pins = new Map();
  for (const entry of value.extensions) {
    if (
      !exactKeys(entry, ["extensionId", "sha256", "version"]) ||
      typeof entry.extensionId !== "string" ||
      !SHA256.test(entry.sha256) ||
      !VERSION.test(entry.version) ||
      pins.has(entry.extensionId)
    ) {
      throw new Error("Invalid WildBuzzard XPI pin");
    }
    pins.set(entry.extensionId, Object.freeze({ ...entry }));
  }
  if (
    pins.size !== EXPECTED_EXTENSION_IDS.size ||
    [...EXPECTED_EXTENSION_IDS].some(id => !pins.has(id))
  ) {
    throw new Error("Unexpected WildBuzzard XPI identity");
  }
  return pins;
}

async function getPins() {
  productionPins ??= (async () => {
    const response = await fetch(PIN_URI);
    if (!response.ok) {
      throw new Error("Could not load WildBuzzard XPI pins");
    }
    return validatePins(await response.json());
  })();
  return productionPins;
}

function fileSha256(file) {
  const hash = new CryptoHash("sha256");
  const stream = new FileInputStream(file, -1, -1, false);
  try {
    hash.updateFromStream(stream, file.fileSize);
  } finally {
    stream.close();
  }
  return getHashStringForCrypto(hash);
}

export async function isPinnedWildBuzzardXPI({
  addonId,
  addonType,
  installLocationName,
  file,
}) {
  if (
    addonType !== "extension" ||
    installLocationName !== PROFILE_LOCATION ||
    !file?.isFile() ||
    file.isSymlink() ||
    file.fileSize <= 0 ||
    file.fileSize > MAX_XPI_BYTES
  ) {
    return false;
  }
  try {
    const pin = (await getPins()).get(addonId);
    return !!pin && fileSha256(file) === pin.sha256;
  } catch {
    return false;
  }
}
