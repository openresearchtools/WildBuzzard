/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { CryptoUtils } from "moz-src:///services/crypto/modules/utils.sys.mjs";

const LocalFile = Components.Constructor(
  "@mozilla.org/file/local;1",
  "nsIFile",
  "initWithPath"
);

function bytesToHex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function privateDirectory(path) {
  await IOUtils.makeDirectory(path, {
    createAncestors: true,
    ignoreExisting: true,
    permissions: 0o700,
  });
  const file = new LocalFile(path);
  if (!file.isDirectory() || file.isSymlink()) {
    throw new Error("Unsafe Buzzard Agent Web state directory");
  }
  await IOUtils.setPermissions(path, 0o700);
  if ((file.permissions & 0o777) !== 0o700) {
    throw new Error("Insecure Buzzard Agent Web state directory permissions");
  }
}

export async function writePrivateJSON(path, value) {
  const parent = new LocalFile(PathUtils.parent(path));
  if (
    !parent.isDirectory() ||
    parent.isSymlink() ||
    (parent.permissions & 0o777) !== 0o700
  ) {
    throw new Error("Unsafe Buzzard Agent Web state directory");
  }
  const nonce = bytesToHex(CryptoUtils.generateRandomBytes(24));
  const temporary = `${path}.new-${Services.appinfo.processID}-${nonce}`;
  try {
    await IOUtils.writeJSON(temporary, value, {
      flush: true,
      mode: "create",
    });
    await IOUtils.setPermissions(temporary, 0o600);
    const temporaryFile = new LocalFile(temporary);
    if (
      !temporaryFile.isFile() ||
      temporaryFile.isSymlink() ||
      (temporaryFile.permissions & 0o777) !== 0o600
    ) {
      throw new Error("Unsafe temporary Buzzard Agent Web state file");
    }
    await IOUtils.move(temporary, path, { noOverwrite: false });
    const destination = new LocalFile(path);
    if (
      !destination.isFile() ||
      destination.isSymlink() ||
      (destination.permissions & 0o777) !== 0o600
    ) {
      throw new Error("Unsafe Buzzard Agent Web state file");
    }
  } finally {
    await IOUtils.remove(temporary, { ignoreAbsent: true });
  }
}

export async function readPrivateJSON(path) {
  try {
    const file = new LocalFile(path);
    if (
      !file.isFile() ||
      file.isSymlink() ||
      (file.permissions & 0o777) !== 0o600
    ) {
      return null;
    }
    const before = await IOUtils.stat(path);
    const contents = await IOUtils.readUTF8(path);
    const afterFile = new LocalFile(path);
    const after = await IOUtils.stat(path);
    if (
      !afterFile.isFile() ||
      afterFile.isSymlink() ||
      (afterFile.permissions & 0o777) !== 0o600 ||
      before.type !== "regular" ||
      after.type !== "regular" ||
      before.size !== after.size ||
      before.lastModified !== after.lastModified ||
      before.creationTime !== after.creationTime ||
      new TextEncoder().encode(contents).length !== after.size
    ) {
      return null;
    }
    return JSON.parse(contents);
  } catch {
    return null;
  }
}
