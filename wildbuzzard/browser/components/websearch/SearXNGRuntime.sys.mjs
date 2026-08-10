/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { NetUtil } from "resource://gre/modules/NetUtil.sys.mjs";
import { Subprocess } from "resource://gre/modules/Subprocess.sys.mjs";
import { setTimeout } from "resource://gre/modules/Timer.sys.mjs";
import { synchronizeManagedSearXNGEngine } from "resource:///modules/ManagedSearXNGEngine.sys.mjs";
import { requestSearXNGPrivateJSON } from "resource:///modules/SearXNGPrivateTransport.sys.mjs";

const LocalFile = Components.Constructor(
  "@mozilla.org/file/local;1",
  "nsIFile",
  "initWithPath"
);
const ZipReader = Components.Constructor(
  "@mozilla.org/libjar/zip-reader;1",
  "nsIZipReader",
  "open"
);
const CryptoHash = Components.Constructor(
  "@mozilla.org/security/hash;1",
  "nsICryptoHash",
  "initWithString"
);

const ADDRESS = "127.0.0.1";
const MANIFEST = "wildbuzzard-runtime.json";
const SERVICE_PATH = "libexec/searxng_service.py";
const LAUNCHER_PATH = "bin/searxng-service";
const POLICY_PATH = "share/wildbuzzard/searxng/engine-policy.json";
// Retain prior entries so rollback trusts only release-pinned archives.
const TRUSTED_RUNTIME_RELEASES = Object.freeze([
  Object.freeze({
    archiveSha256:
      "db683529031080cc1d35f5cfbe119b0d92f5985c4ecb996fc44e7c50838646f7",
    expectedFileCount: 7042,
    launcherSha256:
      "366af1e28c0fc029760f360896ce12d99ae22df58049fdc29584e3fc5f3a0fc7",
    manifest: Object.freeze({
      architecture: "x86_64",
      buildToolSourcesLockSha256:
        "16c8eec18c59089a46f6b6d23940906057d66892d8e1c9dcc5f29c0d2db9a348",
      buildToolsLockSha256:
        "d4a00f1257791193f703d09ead618ecc10dc11dffcf60c2d928594622a709ee2",
      compiler: "Zig 0.15.2",
      compilerTarget: "x86_64-linux-gnu.2.28",
      component: "searxng",
      correspondingSource:
        "wildbuzzard-searxng-2026.8.6+b023a28ba-source.tar.xz",
      correspondingSourceSha256:
        "c4d07e484d9e88a6deef78e02701bc6bdc100dbccb432d8492bbaa689e499f57",
      dependencyLockSha256:
        "3532d6386c8fae458945006efae16a07ed10d327f66ceccae7a34140f753cf8e",
      granianCargoComponentsLockSha256:
        "8ad3c33d6967c2fcf0d2b71889b230df0df46a4a1b63a4f3af04b2d94b6e0c30",
      granianCargoVendorLockSha256:
        "6fbd1c743108c9484ec7995d4ff90f2effa1796dc2c3568c7210a0c14c2f8550",
      license: "AGPL-3.0-or-later",
      nativeSourcesLockSha256:
        "3eb661da5692f7934d1b39a61b8e64e9c36112883ea2aa3051dfde13fbdfb34c",
      platform: "linux",
      protocolVersion: 1,
      providerPolicySha256:
        "098eb8820fa6744b174cbb5d4afb643bafc30d5859c79aa766ef787797894f82",
      pythonSourceSha256:
        "143b1dddefaec3bd2e21e3b839b34a2b7fb9842272883c576420d605e9f30c63",
      pythonVersion: "3.14.6",
      runtimeVersion: "2026.8.6+b023a28ba",
      rustToolchain: "Rust 1.96.0 (ac68faa20)",
      schema: 1,
      toolchainLockSha256:
        "bf9152e611653dd8ce4c5808a15fcc61ab19bc0fbdea80d461bba044f4e37d98",
      upstreamCommit: "b023a28bab8839dba9eac96e9a51cc91bbd0a267",
      upstreamSourceArchiveSha256:
        "f5ab68baa420f26ac0d6b3fed1a8e5754bbe1fd31357c41271449980d3df779e",
      upstreamTree: "d2dc5354fe2281abd59f6734851bd586e6806631",
    }),
    serviceSha256:
      "4606ccd2c8d2123f42155f2567f1a71a2bf8a11fe225a153bad34cbb94d88cbe",
  }),
]);
const CURRENT_RELEASE = TRUSTED_RUNTIME_RELEASES.at(-1);
const SOURCE_ARCHIVE = CURRENT_RELEASE.manifest.correspondingSource;
const RUNTIME_ARCHIVE_SHA256 = CURRENT_RELEASE.archiveSha256;
const MAX_ARCHIVE_SIZE = 512 * 1024 * 1024;
const MAX_SOURCE_ARCHIVE_SIZE = 2 * 1024 * 1024 * 1024;
const MAX_MANIFEST_SIZE = 2 * 1024 * 1024;
const MAX_FILE_SIZE = 64 * 1024 * 1024;
const MAX_EXPANDED_SIZE = 512 * 1024 * 1024;
const MAX_ENTRIES = 20000;
const MAX_OUTPUT_SIZE = 64 * 1024;
const PROFILE_NAMESPACE_DOMAIN = "wildbuzzard-searxng-profile-v1\0";
const OWNER_ID_DOMAIN = "wildbuzzard-searxng-owner-v1\0";
const CONNECTION_FIELDS = new Set([
  "address",
  "createdAt",
  "dataRootId",
  "executablePath",
  "executableSha256",
  "lastHealthAt",
  "ownerInstanceId",
  "pid",
  "port",
  "processStartTime",
  "protocolVersion",
  "privateSocket",
  "privateSocketDevice",
  "privateSocketInode",
  "runtimeVersion",
  "token",
  "version",
]);
const ACTIVE_RUNTIME_FIELDS = new Set([
  "activatedAt",
  "archivePath",
  "archiveSha256",
  "bundleId",
  "dataRootId",
  "directory",
  "manifestSha256",
  "runtimeVersion",
  "schema",
  "sourcePath",
  "sourceSha256",
]);
const LEGACY_ACTIVE_RUNTIME_FIELDS = new Set([
  "activatedAt",
  "archivePath",
  "archiveSha256",
  "bundleId",
  "directory",
]);
const RUNTIME_DESCRIPTOR_FIELDS = new Set([
  "archivePath",
  "archiveSha256",
  "bundleId",
  "directory",
  "manifestSha256",
  "runtimeVersion",
  "sourcePath",
  "sourceSha256",
]);
const STAGED_ACTIVATION_FIELDS = new Set([
  "candidate",
  "dataRootId",
  "ownerInstanceId",
  "preparedAt",
  "previous",
  "schema",
]);
const EXTRACTION_LOCK_OWNER_FIELDS = new Set([
  "createdAt",
  "pid",
  "processStartTime",
  "schema",
  "token",
]);
const FILE_FIELDS = new Set(["path", "sha256", "size"]);
const MANIFEST_FIELDS = new Set([
  "architecture",
  "buildToolSourcesLockSha256",
  "buildToolsLockSha256",
  "compiler",
  "compilerTarget",
  "component",
  "correspondingSource",
  "correspondingSourceSha256",
  "dependencyLockSha256",
  "files",
  "granianCargoComponentsLockSha256",
  "granianCargoVendorLockSha256",
  "license",
  "nativeSourcesLockSha256",
  "platform",
  "protocolVersion",
  "providerPolicySha256",
  "pythonSourceSha256",
  "pythonVersion",
  "runtimeVersion",
  "rustToolchain",
  "schema",
  "toolchainLockSha256",
  "upstreamCommit",
  "upstreamSourceArchiveSha256",
  "upstreamTree",
]);

function hexDigest(bytes) {
  const hash = new CryptoHash("sha256");
  hash.update(bytes, bytes.length);
  return Array.from(hash.finish(false), byte =>
    byte.charCodeAt(0).toString(16).padStart(2, "0")
  ).join("");
}

async function fileDigest(path) {
  return IOUtils.computeHexDigest(path, "sha256");
}

function randomToken(bytes = 24) {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return ChromeUtils.base64URLEncode(value, { pad: false });
}

function canonicalProfilePath(profilePath) {
  if (typeof profilePath !== "string" || !profilePath) {
    throw new Error("The Firefox profile path is unavailable");
  }
  const directory = new LocalFile(profilePath);
  directory.normalize();
  if (!directory.isDirectory() || directory.isSymlink()) {
    throw new Error("The Firefox profile directory is unavailable");
  }
  return directory.path;
}

function profileDigest(domain, profilePath) {
  return hexDigest(
    new TextEncoder().encode(domain + canonicalProfilePath(profilePath))
  );
}

export function searXNGProfileIdentity(profilePath) {
  return {
    ownerInstanceId: `profile-${profileDigest(OWNER_ID_DOMAIN, profilePath)}`,
    profileNamespace: `profile-${profileDigest(
      PROFILE_NAMESPACE_DOMAIN,
      profilePath
    )}`,
  };
}

export function searXNGProfilePaths({
  profilePath,
  dataHome,
  cacheHome,
  runtimeHome,
}) {
  const identity = searXNGProfileIdentity(profilePath);
  const rootDirectory = PathUtils.join(
    dataHome,
    "wildbuzzard",
    "search",
    "profiles",
    identity.profileNamespace
  );
  const cacheDirectory = PathUtils.join(
    cacheHome,
    "wildbuzzard",
    "search",
    "profiles",
    identity.profileNamespace
  );
  const stateDirectory = runtimeHome
    ? PathUtils.join(
        runtimeHome,
        "wildbuzzard-search",
        "profiles",
        identity.profileNamespace
      )
    : PathUtils.join(rootDirectory, "run");
  return { ...identity, cacheDirectory, rootDirectory, stateDirectory };
}

function safeArchivePath(path) {
  if (typeof path !== "string") {
    return false;
  }
  const parts = path.split("/");
  return (
    path.length &&
    path.length <= 4096 &&
    path.normalize("NFC") === path &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    ![...path].some(character => {
      const code = character.codePointAt(0);
      return code < 32 || code === 127;
    }) &&
    parts.every(part => part && part !== "." && part !== "..")
  );
}

function exactFields(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const fields = Object.keys(value);
  return (
    fields.length === expected.size &&
    fields.every(field => expected.has(field))
  );
}

function isDigest(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function parseCentralDirectory(bytes, entryCount) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const result = new Map();
  let expandedSize = 0;
  let offset = 0;
  for (let index = 0; index < entryCount; index++) {
    if (
      offset + 46 > bytes.length ||
      view.getUint32(offset, true) !== 0x02014b50
    ) {
      throw new Error("Invalid SearXNG runtime central directory");
    }
    const host = bytes[offset + 5];
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const realSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const disk = view.getUint16(offset + 34, true);
    const attributes = view.getUint32(offset + 38, true);
    const recordLength = 46 + nameLength + extraLength + commentLength;
    if (
      host !== 3 ||
      flags !== 0 ||
      method !== 0 ||
      disk !== 0 ||
      extraLength !== 0 ||
      commentLength !== 0 ||
      compressedSize !== realSize ||
      offset + recordLength > bytes.length
    ) {
      throw new Error("Unsupported SearXNG runtime ZIP entry");
    }
    const name = decoder.decode(
      bytes.subarray(offset + 46, offset + 46 + nameLength)
    );
    const mode = attributes >>> 16;
    if (
      !safeArchivePath(name) ||
      result.has(name) ||
      (mode & 0xf000) !== 0x8000 ||
      ![0o644, 0o755].includes(mode & 0o777)
    ) {
      throw new Error(`Unsafe SearXNG runtime ZIP entry: ${name}`);
    }
    expandedSize += realSize;
    if (realSize > MAX_FILE_SIZE || expandedSize > MAX_EXPANDED_SIZE) {
      throw new Error("SearXNG runtime exceeds extraction limits");
    }
    result.set(name, {
      executable: Boolean(mode & 0o111),
      realSize,
    });
    offset += recordLength;
  }
  if (offset !== bytes.length) {
    throw new Error("Invalid SearXNG runtime central directory size");
  }
  return result;
}

async function centralDirectoryEntries(archivePath, archiveSize) {
  const tailSize = Math.min(archiveSize, 65557);
  const tailOffset = archiveSize - tailSize;
  const tail = await IOUtils.read(archivePath, {
    maxBytes: tailSize,
    offset: tailOffset,
  });
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let end = -1;
  for (let offset = tail.length - 22; offset >= 0; offset--) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      end = offset;
      break;
    }
  }
  if (
    end < 0 ||
    view.getUint16(end + 20, true) !== 0 ||
    end + 22 !== tail.length
  ) {
    throw new Error("SearXNG runtime has no valid ZIP central directory");
  }
  const entries = view.getUint16(end + 10, true);
  const centralSize = view.getUint32(end + 12, true);
  const centralOffset = view.getUint32(end + 16, true);
  if (
    view.getUint16(end + 4, true) !== 0 ||
    view.getUint16(end + 6, true) !== 0 ||
    view.getUint16(end + 8, true) !== entries ||
    entries === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff ||
    entries < 1 ||
    entries > MAX_ENTRIES ||
    centralSize > entries * (46 + 4096) ||
    centralOffset + centralSize !== tailOffset + end
  ) {
    throw new Error("Unsupported SearXNG runtime ZIP layout");
  }
  const central = await IOUtils.read(archivePath, {
    maxBytes: centralSize,
    offset: centralOffset,
  });
  if (central.length !== centralSize) {
    throw new Error("Truncated SearXNG runtime central directory");
  }
  return parseCentralDirectory(central, entries);
}

function trustedReleaseForArchive(archiveSha256) {
  return TRUSTED_RUNTIME_RELEASES.find(
    release => release.archiveSha256 === archiveSha256
  );
}

// eslint-disable-next-line complexity
function validateManifest(manifest, centralEntries, release) {
  if (
    !exactFields(manifest, MANIFEST_FIELDS) ||
    Object.entries(release.manifest).some(
      ([field, expected]) => manifest[field] !== expected
    ) ||
    !Array.isArray(manifest.files) ||
    manifest.files.length !== release.expectedFileCount
  ) {
    throw new Error("Invalid SearXNG runtime manifest");
  }

  const files = new Map();
  for (const entry of manifest.files) {
    if (
      !exactFields(entry, FILE_FIELDS) ||
      !safeArchivePath(entry.path) ||
      entry.path === MANIFEST ||
      files.has(entry.path) ||
      !isDigest(entry.sha256) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      entry.size > MAX_FILE_SIZE ||
      centralEntries.get(entry.path)?.realSize !== entry.size
    ) {
      throw new Error("Invalid SearXNG runtime file inventory");
    }
    files.set(entry.path, entry);
  }
  if (
    centralEntries.size !== files.size + 1 ||
    !centralEntries.has(MANIFEST) ||
    centralEntries.get(MANIFEST).executable ||
    [...centralEntries.keys()].some(
      path => path !== MANIFEST && !files.has(path)
    ) ||
    files.get(SERVICE_PATH)?.sha256 !== release.serviceSha256 ||
    files.get(LAUNCHER_PATH)?.sha256 !== release.launcherSha256 ||
    files.get(POLICY_PATH)?.sha256 !== release.manifest.providerPolicySha256 ||
    !centralEntries.get(LAUNCHER_PATH)?.executable ||
    !centralEntries.get("python/bin/python3")?.executable ||
    !centralEntries.get("python/bin/python3.14")?.executable
  ) {
    throw new Error("SearXNG runtime file inventory mismatch");
  }
  return files;
}

async function runtimeBundleInfo(archivePath) {
  const archiveFile = new LocalFile(archivePath);
  if (!archiveFile.isFile() || archiveFile.isSymlink()) {
    throw new Error("Unsafe SearXNG runtime archive");
  }
  const archiveInfo = await IOUtils.stat(archivePath);
  if (archiveInfo.size < 22 || archiveInfo.size > MAX_ARCHIVE_SIZE) {
    throw new Error("SearXNG runtime archive size is invalid");
  }
  const [archiveSha256, centralEntries] = await Promise.all([
    fileDigest(archivePath),
    centralDirectoryEntries(archivePath, archiveInfo.size),
  ]);
  const release = trustedReleaseForArchive(archiveSha256);
  if (!release) {
    throw new Error("SearXNG runtime archive digest mismatch");
  }
  const zip = new ZipReader(archiveFile);
  try {
    const zipEntries = new Set(zip.findEntries(null));
    if (
      zipEntries.size !== centralEntries.size ||
      [...zipEntries].some(path => !centralEntries.has(path)) ||
      !zip.hasEntry(MANIFEST)
    ) {
      throw new Error("SearXNG runtime ZIP inventory mismatch");
    }
    const manifestEntry = zip.getEntry(MANIFEST);
    if (
      manifestEntry.realSize < 2 ||
      manifestEntry.realSize > MAX_MANIFEST_SIZE ||
      manifestEntry.realSize !== centralEntries.get(MANIFEST).realSize
    ) {
      throw new Error("SearXNG runtime manifest size is invalid");
    }
    const stream = zip.getInputStream(MANIFEST);
    let manifestText;
    try {
      manifestText = NetUtil.readInputStreamToString(
        stream,
        manifestEntry.realSize,
        { charset: "utf-8" }
      );
    } finally {
      stream.close();
    }
    const manifestBytes = new TextEncoder().encode(manifestText);
    const manifest = JSON.parse(manifestText);
    const files = validateManifest(manifest, centralEntries, release);
    return {
      archivePath,
      archiveSha256,
      bundleId: `1-${manifest.runtimeVersion.replaceAll("+", "_")}-${archiveSha256}`,
      centralEntries,
      files,
      manifest,
      manifestSha256: hexDigest(manifestBytes),
      manifestSize: manifestBytes.length,
      release,
    };
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("Invalid SearXNG runtime manifest JSON");
    }
    throw error;
  } finally {
    zip.close();
  }
}

async function privateDirectory(path) {
  let file = new LocalFile(path);
  if (file.exists() && (!file.isDirectory() || file.isSymlink())) {
    throw new Error(`Unsafe SearXNG state directory: ${path}`);
  }
  await IOUtils.makeDirectory(path, {
    createAncestors: true,
    ignoreExisting: true,
    permissions: 0o700,
  });
  file = new LocalFile(path);
  if (!file.isDirectory() || file.isSymlink()) {
    throw new Error(`Unsafe SearXNG state directory: ${path}`);
  }
  await IOUtils.setPermissions(path, 0o700);
  return file.path;
}

async function writePrivateJSON(path, value) {
  const temporary = `${path}.new-${randomToken(18)}`;
  try {
    await IOUtils.writeJSON(temporary, value, { mode: "create" });
    await IOUtils.setPermissions(temporary, 0o600);
    await IOUtils.move(temporary, path, { noOverwrite: false });
  } finally {
    await IOUtils.remove(temporary, { ignoreAbsent: true }).catch(() => {});
  }
}

async function readPrivateJSON(path) {
  try {
    const file = new LocalFile(path);
    if (!file.isFile() || file.isSymlink() || file.permissions & 0o077) {
      return null;
    }
    const info = await IOUtils.stat(path);
    if (info.size < 2 || info.size > 16384) {
      return null;
    }
    return await IOUtils.readJSON(path);
  } catch {
    return null;
  }
}

async function readPrivateText(path, maximum) {
  const file = new LocalFile(path);
  if (!file.isFile() || file.isSymlink() || file.permissions & 0o077) {
    throw new Error("Unsafe SearXNG identity file");
  }
  const info = await IOUtils.stat(path);
  if (info.size < 1 || info.size > maximum) {
    throw new Error("Invalid SearXNG identity file");
  }
  return (await IOUtils.readUTF8(path)).trim();
}

async function processStartTime(pid) {
  const value = await IOUtils.readUTF8(`/proc/${pid}/stat`);
  const closingParenthesis = value.lastIndexOf(")");
  const fields = value
    .slice(closingParenthesis + 2)
    .trim()
    .split(/\s+/);
  if (
    closingParenthesis < 0 ||
    fields.length < 20 ||
    !/^\d+$/.test(fields[19])
  ) {
    throw new Error("Linux process start time is unavailable");
  }
  return fields[19];
}

function validExtractionLockOwner(owner) {
  return (
    exactFields(owner, EXTRACTION_LOCK_OWNER_FIELDS) &&
    owner.schema === 1 &&
    Number.isSafeInteger(owner.pid) &&
    owner.pid > 0 &&
    typeof owner.processStartTime === "string" &&
    /^\d+$/.test(owner.processStartTime) &&
    typeof owner.token === "string" &&
    /^[A-Za-z0-9_-]{24,128}$/.test(owner.token) &&
    Number.isSafeInteger(owner.createdAt) &&
    owner.createdAt > 0
  );
}

async function extractionLockOwnerIsStale(owner) {
  if (!validExtractionLockOwner(owner)) {
    return true;
  }
  try {
    return (await processStartTime(owner.pid)) !== owner.processStartTime;
  } catch {
    return true;
  }
}

async function restoreClaimedLock(claim, lockDirectory) {
  try {
    await IOUtils.move(claim, lockDirectory, { noOverwrite: true });
  } catch {
    throw new Error("SearXNG extraction lock ownership changed");
  }
}

async function acquireExtractionLock(stateDirectory) {
  const lockDirectory = PathUtils.join(
    stateDirectory,
    "browser-extraction.lock"
  );
  const token = randomToken(18);
  const pid = Services.appinfo.processID;
  const processIdentity = await processStartTime(pid);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const candidate = `${lockDirectory}.candidate-${pid}-${token}`;
    try {
      await IOUtils.makeDirectory(candidate, {
        ignoreExisting: false,
        permissions: 0o700,
      });
      await writePrivateJSON(PathUtils.join(candidate, "owner.json"), {
        createdAt: Date.now(),
        pid,
        processStartTime: processIdentity,
        schema: 1,
        token,
      });
      await IOUtils.move(candidate, lockDirectory, { noOverwrite: true });
      return async () => {
        const claim = `${lockDirectory}.release-${pid}-${token}`;
        await IOUtils.move(lockDirectory, claim, { noOverwrite: true });
        const owner = await readPrivateJSON(
          PathUtils.join(claim, "owner.json")
        );
        if (!validExtractionLockOwner(owner) || owner.token !== token) {
          await restoreClaimedLock(claim, lockDirectory);
          throw new Error("SearXNG extraction lock ownership changed");
        }
        await IOUtils.remove(claim, { recursive: true });
      };
    } catch {
      await IOUtils.remove(candidate, {
        recursive: true,
        ignoreAbsent: true,
      }).catch(() => {});
    }
    const lockFile = new LocalFile(lockDirectory);
    if (!lockFile.exists()) {
      continue;
    }
    if (!lockFile.isDirectory() || lockFile.isSymlink()) {
      throw new Error("Unsafe SearXNG extraction lock");
    }
    const owner = await readPrivateJSON(
      PathUtils.join(lockDirectory, "owner.json")
    );
    if (await extractionLockOwnerIsStale(owner)) {
      const claim = `${lockDirectory}.stale-${pid}-${randomToken(12)}`;
      try {
        await IOUtils.move(lockDirectory, claim, { noOverwrite: true });
      } catch {
        continue;
      }
      const claimedOwner = await readPrivateJSON(
        PathUtils.join(claim, "owner.json")
      );
      if (await extractionLockOwnerIsStale(claimedOwner)) {
        await IOUtils.remove(claim, { recursive: true });
        continue;
      }
      await restoreClaimedLock(claim, lockDirectory);
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for the SearXNG extraction lock");
}

async function verifyExtractedRuntime(directory, bundle) {
  const root = new LocalFile(directory);
  if (
    !root.isDirectory() ||
    root.isSymlink() ||
    (root.permissions & 0o777) !== 0o700
  ) {
    throw new Error("Invalid extracted SearXNG runtime root");
  }
  const expected = new Map();
  for (const [path, metadata] of bundle.files) {
    expected.set(path, {
      executable: bundle.centralEntries.get(path).executable,
      sha256: metadata.sha256,
      size: metadata.size,
    });
  }
  expected.set(MANIFEST, {
    executable: false,
    sha256: bundle.manifestSha256,
    size: bundle.manifestSize,
  });
  const expectedDirectories = new Set();
  for (const path of expected.keys()) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index++) {
      expectedDirectories.add(parts.slice(0, index).join("/"));
    }
  }
  const actual = new Set();
  const directories = new Set();
  const pending = [directory];
  while (pending.length) {
    const parent = pending.pop();
    for (const path of await IOUtils.getChildren(parent)) {
      const relative = path.slice(directory.length + 1).replaceAll("\\", "/");
      const file = new LocalFile(path);
      if (file.isSymlink()) {
        throw new Error(`Link in extracted SearXNG runtime: ${relative}`);
      }
      if (relative === ".extraction-complete") {
        if (!file.isFile() || (file.permissions & 0o777) !== 0o600) {
          throw new Error("Invalid SearXNG extraction marker");
        }
        continue;
      }
      if (file.isDirectory()) {
        if (
          !expectedDirectories.has(relative) ||
          directories.has(relative) ||
          (file.permissions & 0o777) !== 0o755
        ) {
          throw new Error(
            `Unexpected extracted SearXNG directory: ${relative}`
          );
        }
        directories.add(relative);
        pending.push(path);
        continue;
      }
      const metadata = expected.get(relative);
      const info = await IOUtils.stat(path);
      if (
        !file.isFile() ||
        actual.has(relative) ||
        !metadata ||
        info.size !== metadata.size ||
        (file.permissions & 0o777) !== (metadata.executable ? 0o755 : 0o644) ||
        (await fileDigest(path)) !== metadata.sha256
      ) {
        throw new Error(`Invalid extracted SearXNG file: ${relative}`);
      }
      actual.add(relative);
    }
  }
  if (
    actual.size !== expected.size ||
    directories.size !== expectedDirectories.size ||
    [...expected.keys()].some(path => !actual.has(path))
  ) {
    throw new Error("Incomplete extracted SearXNG runtime");
  }
  const marker = await readPrivateJSON(
    PathUtils.join(directory, ".extraction-complete")
  );
  if (
    marker?.schema !== 1 ||
    marker.bundleId !== bundle.bundleId ||
    marker.archiveSha256 !== bundle.archiveSha256 ||
    marker.manifestSha256 !== bundle.manifestSha256
  ) {
    throw new Error("Invalid SearXNG extraction marker");
  }
}

// eslint-disable-next-line complexity
function validateConnectionRecord(
  record,
  runtime,
  ownerInstanceId,
  dataRootId
) {
  const createdAt = record?.createdAt;
  const lastHealthAt = record?.lastHealthAt;
  if (
    !exactFields(record, CONNECTION_FIELDS) ||
    record.version !== 1 ||
    record.protocolVersion !== runtime.manifest.protocolVersion ||
    record.runtimeVersion !== runtime.manifest.runtimeVersion ||
    record.address !== ADDRESS ||
    !Number.isSafeInteger(record.port) ||
    record.port < 1024 ||
    record.port > 65535 ||
    typeof record.token !== "string" ||
    !/^[A-Za-z0-9_-]{32,512}$/.test(record.token) ||
    typeof record.privateSocket !== "string" ||
    !/^\/tmp\/wb-sx-g-\d+-[a-f0-9]{24}-[a-f0-9]{32}\/s$/.test(
      record.privateSocket
    ) ||
    !Number.isSafeInteger(record.privateSocketDevice) ||
    record.privateSocketDevice < 0 ||
    !Number.isSafeInteger(record.privateSocketInode) ||
    record.privateSocketInode < 1 ||
    !Number.isSafeInteger(record.pid) ||
    record.pid < 1 ||
    typeof record.processStartTime !== "string" ||
    !/^\d+$/.test(record.processStartTime) ||
    typeof record.executablePath !== "string" ||
    !isDigest(record.executableSha256) ||
    record.dataRootId !== dataRootId ||
    record.ownerInstanceId !== ownerInstanceId ||
    !Number.isSafeInteger(createdAt) ||
    createdAt < 1 ||
    createdAt > 8_640_000_000_000_000 ||
    !Number.isSafeInteger(lastHealthAt) ||
    lastHealthAt < createdAt ||
    lastHealthAt > 8_640_000_000_000_000
  ) {
    throw new Error("SearXNG connection identity mismatch");
  }
  const executable = new LocalFile(record.executablePath);
  executable.normalize();
  const prefix = `${runtime.directory}/`;
  if (
    executable.path !== record.executablePath ||
    !record.executablePath.startsWith(prefix)
  ) {
    throw new Error("SearXNG executable path is outside the runtime");
  }
  const relative = record.executablePath
    .slice(prefix.length)
    .replaceAll("\\", "/");
  if (
    !safeArchivePath(relative) ||
    runtime.files.get(relative)?.sha256 !== record.executableSha256 ||
    !runtime.centralEntries.get(relative)?.executable
  ) {
    throw new Error("SearXNG executable identity mismatch");
  }
  return record;
}

function requestHealth(record, timeout = 3000) {
  return requestSearXNGPrivateJSON(record, "/v1/health", timeout);
}

async function readPipe(pipe) {
  let output = "";
  for (let chunk; (chunk = await pipe.readString()); ) {
    output += chunk;
    if (output.length > MAX_OUTPUT_SIZE) {
      throw new Error("SearXNG lifecycle output exceeded its limit");
    }
  }
  return output;
}

/** Extracts and reconnects the persistent, profile-owned SearXNG service. */
export class SearXNGRuntimeSupervisor {
  constructor({
    profilePath,
    dataHome,
    cacheHome,
    runtimeHome,
    archivePath,
    sourcePath,
    synchronizeEngine = synchronizeManagedSearXNGEngine,
  } = {}) {
    const home = Services.dirsvc.get("Home", Ci.nsIFile).path;
    dataHome ??=
      Services.env.get("XDG_DATA_HOME") ||
      PathUtils.join(home, ".local", "share");
    cacheHome ??=
      Services.env.get("XDG_CACHE_HOME") || PathUtils.join(home, ".cache");
    runtimeHome ??= Services.env.get("XDG_RUNTIME_DIR") || null;
    profilePath ??= Services.dirsvc.get("ProfD", Ci.nsIFile).path;
    const paths = searXNGProfilePaths({
      cacheHome,
      dataHome,
      profilePath,
      runtimeHome,
    });
    this.profileNamespace = paths.profileNamespace;
    this.ownerInstanceId = paths.ownerInstanceId;
    this.rootDirectory = paths.rootDirectory;
    this.cacheDirectory = paths.cacheDirectory;
    this.stateDirectory = paths.stateDirectory;
    this.bundleRoot = PathUtils.join(this.rootDirectory, "runtime");
    this.archivesDirectory = PathUtils.join(this.bundleRoot, "archives");
    this.sourcesDirectory = PathUtils.join(this.bundleRoot, "sources");
    this.dataDirectory = PathUtils.join(this.rootDirectory, "data");
    this.connectionPath = PathUtils.join(
      this.stateDirectory,
      "connection.json"
    );
    this.activeRuntimePath = PathUtils.join(
      this.bundleRoot,
      "active-runtime.json"
    );
    this.stagedActivationPath = PathUtils.join(
      this.bundleRoot,
      "active-runtime.staged.json"
    );
    this.configuredArchivePath = archivePath;
    this.configuredSourcePath = sourcePath;
    this.synchronizeEngine = synchronizeEngine;
    this.initializationTask = null;
  }

  archivePath() {
    const configured =
      this.configuredArchivePath ||
      Services.prefs.getStringPref("wildbuzzard.search.searxngRuntime", "") ||
      Services.env.get("WILDBUZZARD_SEARXNG_RUNTIME");
    if (configured) {
      return configured;
    }
    return PathUtils.join(
      Services.dirsvc.get("GreD", Ci.nsIFile).path,
      "runtime",
      "search",
      "wildbuzzard-searxng-runtime.zip"
    );
  }

  sourceArchivePath() {
    const configured =
      this.configuredSourcePath ||
      Services.prefs.getStringPref("wildbuzzard.search.searxngSource", "") ||
      Services.env.get("WILDBUZZARD_SEARXNG_SOURCE");
    if (configured) {
      return configured;
    }
    return PathUtils.join(
      Services.dirsvc.get("GreD", Ci.nsIFile).path,
      "notices",
      "source",
      SOURCE_ARCHIVE
    );
  }

  isAvailable() {
    if (AppConstants.platform !== "linux") {
      return false;
    }
    try {
      const archive = new LocalFile(this.archivePath());
      const source = new LocalFile(this.sourceArchivePath());
      return (
        archive.isFile() &&
        !archive.isSymlink() &&
        source.isFile() &&
        !source.isSymlink()
      );
    } catch {
      return Boolean(
        (this.configuredArchivePath ||
          Services.prefs.getStringPref(
            "wildbuzzard.search.searxngRuntime",
            ""
          ) ||
          Services.env.get("WILDBUZZARD_SEARXNG_RUNTIME")) &&
        (this.configuredSourcePath ||
          Services.prefs.getStringPref(
            "wildbuzzard.search.searxngSource",
            ""
          ) ||
          Services.env.get("WILDBUZZARD_SEARXNG_SOURCE"))
      );
    }
  }

  async initialize() {
    if (this.initializationTask) {
      return this.initializationTask;
    }
    const task = this.ensure();
    this.initializationTask = task;
    try {
      return await task;
    } finally {
      if (this.initializationTask === task) {
        this.initializationTask = null;
      }
    }
  }

  retry() {
    return this.initialize();
  }

  async status() {
    const unavailable = {
      available: this.isAvailable(),
      component: "searxng",
      running: false,
    };
    if (AppConstants.platform !== "linux") {
      return { ...unavailable, state: "unsupported" };
    }
    if (!(await IOUtils.exists(this.activeRuntimePath))) {
      return { ...unavailable, state: "not-installed" };
    }
    let active;
    try {
      active = await this.readActiveRuntime();
    } catch {
      return {
        ...unavailable,
        errorCode: "active-runtime-invalid",
        state: "repair-required",
      };
    }
    const identity = {
      dataRootId: active.dataRootId,
      runtimeVersion: active.manifest.runtimeVersion,
    };
    if (!(await IOUtils.exists(this.connectionPath))) {
      return { ...unavailable, ...identity, state: "stopped" };
    }
    try {
      const record = await this.readConnection(active);
      await this.authenticateConnection(record);
      return {
        ...identity,
        address: record.address,
        available: true,
        component: "searxng",
        pid: record.pid,
        port: record.port,
        running: true,
        state: "running",
      };
    } catch {
      return {
        ...unavailable,
        ...identity,
        errorCode: "service-identity-invalid",
        state: "repair-required",
      };
    }
  }

  repair() {
    if (this.initializationTask) {
      return this.initializationTask;
    }
    const task = this.performRepair();
    this.initializationTask = task;
    return task.finally(() => {
      if (this.initializationTask === task) {
        this.initializationTask = null;
      }
    });
  }

  async ensureDirectories() {
    for (const path of [
      this.rootDirectory,
      this.bundleRoot,
      this.archivesDirectory,
      this.sourcesDirectory,
      this.dataDirectory,
      this.cacheDirectory,
      this.stateDirectory,
    ]) {
      await privateDirectory(path);
    }
  }

  async performRepair() {
    if (AppConstants.platform !== "linux") {
      throw new Error("The bundled SearXNG runtime currently supports Linux");
    }
    await this.ensureDirectories();
    const release = await acquireExtractionLock(this.stateDirectory);
    let runtime;
    try {
      let active = null;
      let activeInvalid = false;
      if (await IOUtils.exists(this.activeRuntimePath)) {
        try {
          active = await this.readActiveRuntime();
        } catch {
          activeInvalid = true;
        }
      }
      if (await IOUtils.exists(this.connectionPath)) {
        if (activeInvalid || !active) {
          throw new Error(
            "Cannot repair SearXNG while an unverified service record exists"
          );
        }
        const record = await this.readConnection(active);
        await this.authenticateConnection(record);
        await this.stopRuntime(active);
      }
      if (active?.directory && (await IOUtils.exists(active.directory))) {
        await this.quarantine(active.directory, "repair-runtime");
      }
      if (await IOUtils.exists(this.activeRuntimePath)) {
        await this.quarantine(this.activeRuntimePath, "repair-active");
      }
      if (await IOUtils.exists(this.stagedActivationPath)) {
        await this.quarantine(this.stagedActivationPath, "repair-staged");
      }
      runtime = await this.extractRuntime();
    } finally {
      await release();
    }
    const record = await this.activateRuntime(runtime, null);
    return this.runtimeResult(runtime, record);
  }

  async readDataRootId({ required = false } = {}) {
    const path = PathUtils.join(this.dataDirectory, "data-root-id");
    if (!(await IOUtils.exists(path))) {
      if (!required) {
        return null;
      }
      throw new Error("SearXNG data identity is missing");
    }
    return readPrivateText(path, 256);
  }

  runtimeDescriptor(runtime) {
    return {
      archivePath: runtime.archivePath,
      archiveSha256: runtime.archiveSha256,
      bundleId: runtime.bundleId,
      directory: runtime.directory,
      manifestSha256: runtime.manifestSha256,
      runtimeVersion: runtime.manifest.runtimeVersion,
      sourcePath: runtime.sourcePath,
      sourceSha256: runtime.sourceSha256,
    };
  }

  activeRuntimeRecord(runtime, dataRootId, activatedAt = Date.now()) {
    return {
      ...this.runtimeDescriptor(runtime),
      activatedAt,
      dataRootId,
      schema: 2,
    };
  }

  async validateRuntimeDescriptor(value, { repairExtraction = false } = {}) {
    const release = trustedReleaseForArchive(value?.archiveSha256);
    if (
      !exactFields(value, RUNTIME_DESCRIPTOR_FIELDS) ||
      !release ||
      value.runtimeVersion !== release.manifest.runtimeVersion ||
      !isDigest(value.archiveSha256) ||
      !isDigest(value.manifestSha256) ||
      value.sourceSha256 !== release.manifest.correspondingSourceSha256 ||
      value.archivePath !==
        PathUtils.join(this.archivesDirectory, `${value.archiveSha256}.zip`) ||
      value.sourcePath !==
        PathUtils.join(this.sourcesDirectory, `${value.sourceSha256}.tar.xz`)
    ) {
      throw new Error("Invalid active SearXNG runtime descriptor");
    }
    const bundle = await runtimeBundleInfo(value.archivePath);
    const expectedDirectory = PathUtils.join(this.bundleRoot, bundle.bundleId);
    if (
      bundle.archiveSha256 !== value.archiveSha256 ||
      bundle.manifestSha256 !== value.manifestSha256 ||
      bundle.bundleId !== value.bundleId ||
      bundle.manifest.runtimeVersion !== value.runtimeVersion ||
      value.directory !== expectedDirectory
    ) {
      throw new Error("Active SearXNG runtime identity mismatch");
    }
    const source = new LocalFile(value.sourcePath);
    if (
      !source.isFile() ||
      source.isSymlink() ||
      (source.permissions & 0o777) !== 0o600 ||
      (await fileDigest(value.sourcePath)) !== value.sourceSha256
    ) {
      throw new Error("Active SearXNG corresponding source is invalid");
    }
    try {
      await verifyExtractedRuntime(value.directory, bundle);
    } catch (error) {
      if (!repairExtraction) {
        throw error;
      }
      if (await IOUtils.exists(value.directory)) {
        await this.quarantine(value.directory, "corrupt-retained-runtime");
      }
      await this.materializeRuntime(bundle, value.archivePath, value.directory);
    }
    return {
      ...bundle,
      archivePath: value.archivePath,
      directory: value.directory,
      sourcePath: value.sourcePath,
      sourceSha256: value.sourceSha256,
    };
  }

  async readActiveRuntime({ repairExtraction = false } = {}) {
    if (!(await IOUtils.exists(this.activeRuntimePath))) {
      return null;
    }
    const value = await readPrivateJSON(this.activeRuntimePath);
    if (!value) {
      throw new Error("Invalid active SearXNG runtime metadata");
    }
    const dataRootId = await this.readDataRootId({ required: true });
    let descriptor;
    let activatedAt;
    if (exactFields(value, ACTIVE_RUNTIME_FIELDS) && value.schema === 2) {
      if (
        value.dataRootId !== dataRootId ||
        !Number.isSafeInteger(value.activatedAt) ||
        value.activatedAt < 1
      ) {
        throw new Error("Active SearXNG data identity mismatch");
      }
      descriptor = Object.fromEntries(
        [...RUNTIME_DESCRIPTOR_FIELDS].map(field => [field, value[field]])
      );
      activatedAt = value.activatedAt;
    } else if (exactFields(value, LEGACY_ACTIVE_RUNTIME_FIELDS)) {
      if (!Number.isSafeInteger(value.activatedAt) || value.activatedAt < 1) {
        throw new Error("Invalid active SearXNG runtime metadata");
      }
      const bundle = await runtimeBundleInfo(value.archivePath);
      descriptor = {
        archivePath: value.archivePath,
        archiveSha256: value.archiveSha256,
        bundleId: value.bundleId,
        directory: value.directory,
        manifestSha256: bundle.manifestSha256,
        runtimeVersion: bundle.manifest.runtimeVersion,
        sourcePath: PathUtils.join(
          this.sourcesDirectory,
          `${bundle.manifest.correspondingSourceSha256}.tar.xz`
        ),
        sourceSha256: bundle.manifest.correspondingSourceSha256,
      };
      activatedAt = value.activatedAt;
    } else {
      throw new Error("Invalid active SearXNG runtime metadata");
    }
    const runtime = await this.validateRuntimeDescriptor(descriptor, {
      repairExtraction,
    });
    return { ...runtime, activatedAt, dataRootId };
  }

  async readStagedActivation({ repairExtraction = false } = {}) {
    if (!(await IOUtils.exists(this.stagedActivationPath))) {
      return null;
    }
    const value = await readPrivateJSON(this.stagedActivationPath);
    if (
      !exactFields(value, STAGED_ACTIVATION_FIELDS) ||
      value.schema !== 1 ||
      value.ownerInstanceId !== this.ownerInstanceId ||
      !Number.isSafeInteger(value.preparedAt) ||
      value.preparedAt < 1 ||
      (value.dataRootId !== null &&
        (typeof value.dataRootId !== "string" || !value.dataRootId))
    ) {
      throw new Error("Invalid staged SearXNG activation metadata");
    }
    const currentDataRootId = await this.readDataRootId();
    const firstActivationCreatedDataRoot =
      value.previous === null &&
      value.dataRootId === null &&
      typeof currentDataRootId === "string" &&
      Boolean(currentDataRootId);
    if (
      value.dataRootId !== currentDataRootId &&
      !firstActivationCreatedDataRoot
    ) {
      throw new Error("Staged SearXNG data identity mismatch");
    }
    const candidate = await this.validateRuntimeDescriptor(value.candidate, {
      repairExtraction,
    });
    const previous = value.previous
      ? await this.validateRuntimeDescriptor(value.previous, {
          repairExtraction,
        })
      : null;
    return {
      ...value,
      candidate,
      dataRootId: firstActivationCreatedDataRoot
        ? currentDataRootId
        : value.dataRootId,
      previous,
    };
  }

  async stageActivation(candidate, previous, dataRootId) {
    await writePrivateJSON(this.stagedActivationPath, {
      candidate: this.runtimeDescriptor(candidate),
      dataRootId,
      ownerInstanceId: this.ownerInstanceId,
      preparedAt: Date.now(),
      previous: previous ? this.runtimeDescriptor(previous) : null,
      schema: 1,
    });
  }

  sameRuntime(left, right) {
    return (
      Boolean(left && right) &&
      left.bundleId === right.bundleId &&
      left.archiveSha256 === right.archiveSha256 &&
      left.directory === right.directory
    );
  }

  validateLifecycle(runtime, lifecycle, running) {
    if (
      lifecycle?.component !== "searxng" ||
      lifecycle.running !== running ||
      (running &&
        (lifecycle.protocolVersion !== runtime.manifest.protocolVersion ||
          lifecycle.runtimeVersion !== runtime.manifest.runtimeVersion ||
          !Number.isSafeInteger(lifecycle.pid) ||
          typeof lifecycle.processStartTime !== "string"))
    ) {
      throw new Error("SearXNG lifecycle returned an invalid status");
    }
    return lifecycle;
  }

  async startRuntime(runtime, expectedDataRootId = null) {
    const lifecycle = this.validateLifecycle(
      runtime,
      await this.runLifecycle(runtime, "start"),
      true
    );
    const record = await this.readConnection(runtime);
    if (
      record.pid !== lifecycle.pid ||
      record.processStartTime !== lifecycle.processStartTime ||
      (expectedDataRootId && record.dataRootId !== expectedDataRootId)
    ) {
      throw new Error("SearXNG lifecycle and connection identities differ");
    }
    await this.authenticateConnection(record);
    return record;
  }

  async stopRuntime(runtime) {
    const status = await this.runLifecycle(runtime, "status");
    this.validateLifecycle(runtime, status, status.running === true);
    if (!status.running) {
      return;
    }
    const record = await this.readConnection(runtime);
    await this.authenticateConnection(record);
    this.validateLifecycle(
      runtime,
      await this.runLifecycle(runtime, "stop"),
      false
    );
  }

  async recoverStagedActivation(staged, active) {
    const activeIsCandidate = this.sameRuntime(active, staged.candidate);
    const activeIsPrevious = this.sameRuntime(active, staged.previous);
    if (!activeIsCandidate && !activeIsPrevious && active) {
      throw new Error(
        "Staged SearXNG activation does not match active metadata"
      );
    }
    if (activeIsCandidate) {
      const record = await this.startRuntime(
        staged.candidate,
        staged.dataRootId
      );
      await IOUtils.remove(this.stagedActivationPath);
      return { active, record };
    }
    if (!staged.previous) {
      if (await IOUtils.exists(this.connectionPath)) {
        const record = await this.readConnection(staged.candidate);
        await this.authenticateConnection(record);
        await this.synchronizeEngine({
          address: record.address,
          port: record.port,
        });
        await writePrivateJSON(
          this.activeRuntimePath,
          this.activeRuntimeRecord(
            staged.candidate,
            record.dataRootId,
            Date.now()
          )
        );
        await IOUtils.remove(this.stagedActivationPath);
        return {
          active: { ...staged.candidate, dataRootId: record.dataRootId },
          record,
        };
      }
      await IOUtils.remove(this.stagedActivationPath);
      return null;
    }
    if (await IOUtils.exists(this.connectionPath)) {
      try {
        const candidateRecord = await this.readConnection(staged.candidate);
        await this.authenticateConnection(candidateRecord);
        await this.stopRuntime(staged.candidate);
      } catch (candidateError) {
        try {
          const previousRecord = await this.readConnection(staged.previous);
          await this.authenticateConnection(previousRecord);
        } catch {
          throw candidateError;
        }
      }
    }
    const record = await this.startRuntime(staged.previous, staged.dataRootId);
    const activatedAt = active?.activatedAt ?? Date.now();
    const restored = {
      ...staged.previous,
      activatedAt,
      dataRootId: record.dataRootId,
    };
    await writePrivateJSON(
      this.activeRuntimePath,
      this.activeRuntimeRecord(staged.previous, record.dataRootId, activatedAt)
    );
    await IOUtils.remove(this.stagedActivationPath);
    return { active: restored, record };
  }

  async activateRuntime(runtime, previous) {
    const expectedDataRootId =
      previous?.dataRootId ?? (await this.readDataRootId());
    await this.stageActivation(runtime, previous, expectedDataRootId);
    const handoff = previous && !this.sameRuntime(runtime, previous);
    if (handoff) {
      await this.stopRuntime(previous);
    }
    try {
      const record = await this.startRuntime(runtime, expectedDataRootId);
      await this.synchronizeEngine({
        address: record.address,
        port: record.port,
      });
      await writePrivateJSON(
        this.activeRuntimePath,
        this.activeRuntimeRecord(runtime, record.dataRootId)
      );
      await IOUtils.remove(this.stagedActivationPath);
      return record;
    } catch (error) {
      if (!handoff) {
        throw error;
      }
      try {
        if (await IOUtils.exists(this.connectionPath)) {
          const candidateRecord = await this.readConnection(runtime);
          await this.authenticateConnection(candidateRecord);
          await this.stopRuntime(runtime);
        }
        const record = await this.startRuntime(previous, previous.dataRootId);
        await this.synchronizeEngine({
          address: record.address,
          port: record.port,
        });
        await writePrivateJSON(
          this.activeRuntimePath,
          this.activeRuntimeRecord(
            previous,
            record.dataRootId,
            previous.activatedAt
          )
        );
        await IOUtils.remove(this.stagedActivationPath);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "SearXNG upgrade and verified rollback both failed"
        );
      }
      throw error;
    }
  }

  async ensure() {
    if (AppConstants.platform !== "linux") {
      throw new Error("The bundled SearXNG runtime currently supports Linux");
    }
    await this.ensureDirectories();
    const release = await acquireExtractionLock(this.stateDirectory);
    let runtime;
    let previous;
    let staged;
    try {
      runtime = await this.extractRuntime();
      previous = await this.readActiveRuntime({ repairExtraction: true });
      staged = await this.readStagedActivation({ repairExtraction: true });
    } finally {
      await release();
    }
    if (staged) {
      const recovered = await this.recoverStagedActivation(staged, previous);
      if (recovered) {
        previous = recovered.active;
      }
    }
    const record = await this.activateRuntime(runtime, previous);
    return this.runtimeResult(runtime, record);
  }

  runtimeResult(runtime, record) {
    return {
      address: record.address,
      connectionPath: this.connectionPath,
      correspondingSourcePath: runtime.sourcePath,
      ownerInstanceId: record.ownerInstanceId,
      pid: record.pid,
      port: record.port,
      processStartTime: record.processStartTime,
      ready: true,
      runtimeVersion: record.runtimeVersion,
    };
  }

  async retainArchive(source, sourceBundle) {
    const destination = PathUtils.join(
      this.archivesDirectory,
      `${sourceBundle.archiveSha256}.zip`
    );
    if (await IOUtils.exists(destination)) {
      const retained = new LocalFile(destination);
      if (
        retained.isFile() &&
        !retained.isSymlink() &&
        (retained.permissions & 0o777) === 0o600 &&
        (await fileDigest(destination)) === sourceBundle.archiveSha256
      ) {
        return destination;
      }
      await this.quarantine(destination, "retained-archive");
    }
    const temporary = `${destination}.new-${randomToken(18)}`;
    try {
      await IOUtils.copy(source, temporary, { noOverwrite: true });
      await IOUtils.setPermissions(temporary, 0o600);
      if ((await fileDigest(temporary)) !== sourceBundle.archiveSha256) {
        throw new Error("SearXNG runtime changed while it was retained");
      }
      await IOUtils.move(temporary, destination, { noOverwrite: true });
      return destination;
    } finally {
      await IOUtils.remove(temporary, { ignoreAbsent: true }).catch(() => {});
    }
  }

  async quarantine(path, kind) {
    if (!(await IOUtils.exists(path))) {
      return null;
    }
    const destination = PathUtils.join(
      PathUtils.parent(path),
      `.quarantine-${kind}-${Date.now()}-${randomToken(12)}`
    );
    await IOUtils.move(path, destination, { noOverwrite: true });
    return destination;
  }

  async retainSourceArchive(source, bundle) {
    const file = new LocalFile(source);
    if (!file.isFile() || file.isSymlink()) {
      throw new Error("Unsafe SearXNG corresponding source archive");
    }
    const info = await IOUtils.stat(source);
    if (info.size < 1 || info.size > MAX_SOURCE_ARCHIVE_SIZE) {
      throw new Error("SearXNG corresponding source size is invalid");
    }
    const expected = bundle.manifest.correspondingSourceSha256;
    if (
      bundle.manifest.correspondingSource !==
        bundle.release.manifest.correspondingSource ||
      expected !== bundle.release.manifest.correspondingSourceSha256 ||
      (await fileDigest(source)) !== expected
    ) {
      throw new Error("SearXNG corresponding source digest mismatch");
    }
    const destination = PathUtils.join(
      this.sourcesDirectory,
      `${expected}.tar.xz`
    );
    if (await IOUtils.exists(destination)) {
      const retained = new LocalFile(destination);
      if (
        retained.isFile() &&
        !retained.isSymlink() &&
        (retained.permissions & 0o777) === 0o600 &&
        (await fileDigest(destination)) === expected
      ) {
        return destination;
      }
      await this.quarantine(destination, "retained-source");
    }
    const temporary = `${destination}.new-${randomToken(18)}`;
    try {
      await IOUtils.copy(source, temporary, { noOverwrite: true });
      await IOUtils.setPermissions(temporary, 0o600);
      if ((await fileDigest(temporary)) !== expected) {
        throw new Error("SearXNG corresponding source changed while retained");
      }
      await IOUtils.move(temporary, destination, { noOverwrite: true });
      return destination;
    } finally {
      await IOUtils.remove(temporary, { ignoreAbsent: true }).catch(() => {});
    }
  }

  async materializeRuntime(bundle, archivePath, destination) {
    const staging = PathUtils.join(
      this.bundleRoot,
      `.staging-${bundle.bundleId}-${Services.appinfo.processID}-${randomToken(
        12
      )}`
    );
    await IOUtils.makeDirectory(staging, {
      ignoreExisting: false,
      permissions: 0o700,
    });
    const zip = new ZipReader(new LocalFile(archivePath));
    try {
      for (const [entry, central] of bundle.centralEntries) {
        const target = PathUtils.join(staging, ...entry.split("/"));
        await IOUtils.makeDirectory(PathUtils.parent(target), {
          createAncestors: true,
          ignoreExisting: true,
          permissions: 0o755,
        });
        const zipEntry = zip.getEntry(entry);
        if (zipEntry.realSize !== central.realSize) {
          throw new Error(`Size mismatch in SearXNG runtime: ${entry}`);
        }
        const stream = zip.getInputStream(entry);
        let bytes;
        try {
          bytes = new Uint8Array(
            NetUtil.readInputStream(stream, zipEntry.realSize)
          );
        } finally {
          stream.close();
        }
        const expectedDigest =
          entry === MANIFEST
            ? bundle.manifestSha256
            : bundle.files.get(entry).sha256;
        if (hexDigest(bytes) !== expectedDigest) {
          throw new Error(`Digest mismatch in SearXNG runtime: ${entry}`);
        }
        await IOUtils.write(target, bytes, { mode: "create" });
        await IOUtils.setPermissions(
          target,
          central.executable ? 0o755 : 0o644
        );
      }
      const pending = [staging];
      while (pending.length) {
        for (const child of await IOUtils.getChildren(pending.pop())) {
          const file = new LocalFile(child);
          if (file.isSymlink()) {
            throw new Error("Link appeared during SearXNG extraction");
          }
          if (file.isDirectory()) {
            await IOUtils.setPermissions(child, 0o755);
            pending.push(child);
          }
        }
      }
      await IOUtils.setPermissions(staging, 0o700);
      await writePrivateJSON(PathUtils.join(staging, ".extraction-complete"), {
        archiveSha256: bundle.archiveSha256,
        bundleId: bundle.bundleId,
        manifestSha256: bundle.manifestSha256,
        schema: 1,
      });
      await verifyExtractedRuntime(staging, bundle);
      await IOUtils.move(staging, destination, { noOverwrite: true });
      await verifyExtractedRuntime(destination, bundle);
    } catch (error) {
      await IOUtils.remove(staging, {
        recursive: true,
        ignoreAbsent: true,
      }).catch(() => {});
      throw error;
    } finally {
      zip.close();
    }
  }

  async extractRuntime() {
    const source = this.archivePath();
    if (!(await IOUtils.exists(source))) {
      throw new Error(
        "The bundled SearXNG runtime was not found. Build with --searxng-runtime."
      );
    }
    const sourceBundle = await runtimeBundleInfo(source);
    if (sourceBundle.archiveSha256 !== RUNTIME_ARCHIVE_SHA256) {
      throw new Error("Packaged SearXNG runtime is not the current release");
    }
    const retainedPath = await this.retainArchive(source, sourceBundle);
    const bundle = await runtimeBundleInfo(retainedPath);
    if (bundle.archiveSha256 !== sourceBundle.archiveSha256) {
      throw new Error("Retained SearXNG runtime identity mismatch");
    }
    const sourcePath = await this.retainSourceArchive(
      this.sourceArchivePath(),
      bundle
    );
    const destination = PathUtils.join(this.bundleRoot, bundle.bundleId);
    const marker = PathUtils.join(destination, ".extraction-complete");
    if (await IOUtils.exists(marker)) {
      try {
        await verifyExtractedRuntime(destination, bundle);
        return {
          ...bundle,
          archivePath: retainedPath,
          directory: destination,
          sourcePath,
          sourceSha256: bundle.manifest.correspondingSourceSha256,
        };
      } catch {
        await this.quarantine(destination, "corrupt-runtime");
      }
    }
    if (await IOUtils.exists(destination)) {
      await this.quarantine(destination, "incomplete-runtime");
    }
    await this.materializeRuntime(bundle, retainedPath, destination);
    return {
      ...bundle,
      archivePath: retainedPath,
      directory: destination,
      sourcePath,
      sourceSha256: bundle.manifest.correspondingSourceSha256,
    };
  }

  async runLifecycle(runtime, command) {
    const pythonRoot = PathUtils.join(runtime.directory, "python");
    const process = await Subprocess.call({
      command: PathUtils.join(pythonRoot, "bin", "python3"),
      arguments: [
        "-I",
        "-B",
        PathUtils.join(runtime.directory, ...SERVICE_PATH.split("/")),
        "--runtime-root",
        runtime.directory,
        command,
        "--data-root",
        this.dataDirectory,
        "--cache-root",
        this.cacheDirectory,
        "--runtime-dir",
        this.stateDirectory,
        "--connection-file",
        this.connectionPath,
        "--owner-instance-id",
        this.ownerInstanceId,
      ],
      environmentAppend: false,
      environment: {
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        LD_LIBRARY_PATH: PathUtils.join(pythonRoot, "lib"),
        OPENSSL_MODULES: PathUtils.join(pythonRoot, "lib"),
        PATH: PathUtils.join(pythonRoot, "bin"),
        PYTHONHASHSEED: "0",
        TZ: "UTC",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, result] = await Promise.all([
      readPipe(process.stdout),
      readPipe(process.stderr),
      process.wait(),
    ]);
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      if (result.exitCode === 0) {
        throw new Error(`SearXNG ${command} returned invalid JSON`);
      }
    }
    if (
      command === "status" &&
      result.exitCode === 3 &&
      parsed?.component === "searxng" &&
      parsed.running === false
    ) {
      return parsed;
    }
    if (result.exitCode !== 0) {
      throw new Error(
        stderr.trim() || stdout.trim() || `SearXNG ${command} failed`
      );
    }
    return parsed;
  }

  async readConnection(runtime) {
    const record = await readPrivateJSON(this.connectionPath);
    if (!record) {
      throw new Error("SearXNG did not publish a private connection record");
    }
    const dataRootId = await readPrivateText(
      PathUtils.join(this.dataDirectory, "data-root-id"),
      256
    );
    return validateConnectionRecord(
      record,
      runtime,
      this.ownerInstanceId,
      dataRootId
    );
  }

  async authenticateConnection(record) {
    if ((await processStartTime(record.pid)) !== record.processStartTime) {
      throw new Error("SearXNG process start identity mismatch");
    }
    const executable = new LocalFile(`/proc/${record.pid}/exe`).target;
    if (
      executable !== record.executablePath ||
      (await fileDigest(executable)) !== record.executableSha256
    ) {
      throw new Error("SearXNG process executable identity mismatch");
    }
    const response = await requestHealth(record);
    const body = response.body;
    if (
      response.status !== 200 ||
      body?.ok !== true ||
      body.component !== "searxng" ||
      body.protocolVersion !== record.protocolVersion ||
      body.runtimeVersion !== record.runtimeVersion ||
      body.pid !== record.pid ||
      body.processStartTime !== record.processStartTime ||
      body.executableSha256 !== record.executableSha256 ||
      body.dataRootId !== record.dataRootId ||
      body.ownerInstanceId !== record.ownerInstanceId
    ) {
      throw new Error("SearXNG authenticated identity mismatch");
    }
  }
}

export const SearXNGRuntimeTestUtils = {
  acquireExtractionLock,
  extractionLockOwnerIsStale,
  safeArchivePath,
  validateConnectionRecord,
  verifyExtractedRuntime,
};

let defaultSupervisor;

function supervisor() {
  defaultSupervisor ??= new SearXNGRuntimeSupervisor();
  return defaultSupervisor;
}

export const SearXNGRuntime = {
  get connectionPath() {
    return supervisor().connectionPath;
  },

  get correspondingSourcePath() {
    return supervisor().sourceArchivePath();
  },

  initialize() {
    return supervisor().initialize();
  },

  repair() {
    return supervisor().repair();
  },

  retry() {
    return supervisor().retry();
  },

  status() {
    return supervisor().status();
  },

  isAvailable() {
    return supervisor().isAvailable();
  },
};
