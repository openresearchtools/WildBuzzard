/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { NetUtil } from "resource://gre/modules/NetUtil.sys.mjs";
import { ServiceRequest } from "resource://gre/modules/ServiceRequest.sys.mjs";
import { Subprocess } from "resource://gre/modules/Subprocess.sys.mjs";
import { setTimeout } from "resource://gre/modules/Timer.sys.mjs";
import { synchronizeManagedSearXNGEngine } from "resource:///modules/ManagedSearXNGEngine.sys.mjs";

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
const RUNTIME_VERSION = "2026.8.6+b023a28ba";
const SOURCE_ARCHIVE = "wildbuzzard-searxng-2026.8.6+b023a28ba-source.tar.xz";
const RUNTIME_ARCHIVE_SHA256 =
  "cf7dfaa9e4768131407e35baeda277a4f55784172290903c19ad3f524dd8a587";
const SERVICE_PATH = "libexec/searxng_service.py";
const SERVICE_SHA256 =
  "b80378457f8d8e465a1efb4fcc3c22c75323fae09af2494ac23ecc47d40d7ffa";
const LAUNCHER_PATH = "bin/searxng-service";
const LAUNCHER_SHA256 =
  "366af1e28c0fc029760f360896ce12d99ae22df58049fdc29584e3fc5f3a0fc7";
const POLICY_PATH = "share/wildbuzzard/searxng/engine-policy.json";
const POLICY_SHA256 =
  "098eb8820fa6744b174cbb5d4afb643bafc30d5859c79aa766ef787797894f82";
const MAX_ARCHIVE_SIZE = 512 * 1024 * 1024;
const MAX_MANIFEST_SIZE = 2 * 1024 * 1024;
const MAX_FILE_SIZE = 64 * 1024 * 1024;
const MAX_EXPANDED_SIZE = 512 * 1024 * 1024;
const MAX_ENTRIES = 20000;
const MAX_OUTPUT_SIZE = 64 * 1024;
const EXPECTED_FILE_COUNT = 7042;
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
  "runtimeVersion",
  "token",
  "version",
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

// eslint-disable-next-line complexity
function validateManifest(manifest, centralEntries) {
  if (
    !exactFields(manifest, MANIFEST_FIELDS) ||
    manifest.schema !== 1 ||
    manifest.component !== "searxng" ||
    manifest.runtimeVersion !== RUNTIME_VERSION ||
    manifest.upstreamCommit !== "b023a28bab8839dba9eac96e9a51cc91bbd0a267" ||
    manifest.upstreamTree !== "d2dc5354fe2281abd59f6734851bd586e6806631" ||
    manifest.upstreamSourceArchiveSha256 !==
      "f5ab68baa420f26ac0d6b3fed1a8e5754bbe1fd31357c41271449980d3df779e" ||
    manifest.pythonVersion !== "3.14.6" ||
    manifest.pythonSourceSha256 !==
      "143b1dddefaec3bd2e21e3b839b34a2b7fb9842272883c576420d605e9f30c63" ||
    manifest.dependencyLockSha256 !==
      "3532d6386c8fae458945006efae16a07ed10d327f66ceccae7a34140f753cf8e" ||
    manifest.buildToolsLockSha256 !==
      "d4a00f1257791193f703d09ead618ecc10dc11dffcf60c2d928594622a709ee2" ||
    manifest.buildToolSourcesLockSha256 !==
      "16c8eec18c59089a46f6b6d23940906057d66892d8e1c9dcc5f29c0d2db9a348" ||
    manifest.nativeSourcesLockSha256 !==
      "3eb661da5692f7934d1b39a61b8e64e9c36112883ea2aa3051dfde13fbdfb34c" ||
    manifest.toolchainLockSha256 !==
      "bf9152e611653dd8ce4c5808a15fcc61ab19bc0fbdea80d461bba044f4e37d98" ||
    manifest.granianCargoVendorLockSha256 !==
      "6fbd1c743108c9484ec7995d4ff90f2effa1796dc2c3568c7210a0c14c2f8550" ||
    manifest.granianCargoComponentsLockSha256 !==
      "8ad3c33d6967c2fcf0d2b71889b230df0df46a4a1b63a4f3af04b2d94b6e0c30" ||
    manifest.providerPolicySha256 !== POLICY_SHA256 ||
    manifest.compiler !== "Zig 0.15.2" ||
    manifest.compilerTarget !== "x86_64-linux-gnu.2.28" ||
    manifest.rustToolchain !== "Rust 1.96.0 (ac68faa20)" ||
    manifest.protocolVersion !== 1 ||
    manifest.platform !== "linux" ||
    manifest.architecture !== "x86_64" ||
    manifest.license !== "AGPL-3.0-or-later" ||
    manifest.correspondingSource !==
      "wildbuzzard-searxng-2026.8.6+b023a28ba-source.tar.xz" ||
    manifest.correspondingSourceSha256 !==
      "c10b3af18c19af1b58f41cfa3503dcf7759e7a22162b9cab7801492aa8a12751" ||
    !Array.isArray(manifest.files) ||
    manifest.files.length !== EXPECTED_FILE_COUNT
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
    files.get(SERVICE_PATH)?.sha256 !== SERVICE_SHA256 ||
    files.get(LAUNCHER_PATH)?.sha256 !== LAUNCHER_SHA256 ||
    files.get(POLICY_PATH)?.sha256 !== POLICY_SHA256 ||
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
  if (archiveSha256 !== RUNTIME_ARCHIVE_SHA256) {
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
    const files = validateManifest(manifest, centralEntries);
    return {
      archivePath,
      archiveSha256,
      bundleId: `1-${RUNTIME_VERSION.replaceAll("+", "_")}-${archiveSha256}`,
      centralEntries,
      files,
      manifest,
      manifestSha256: hexDigest(manifestBytes),
      manifestSize: manifestBytes.length,
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

async function acquireExtractionLock(stateDirectory) {
  const lockDirectory = PathUtils.join(
    stateDirectory,
    "browser-extraction.lock"
  );
  const ownerPath = PathUtils.join(lockDirectory, "owner.json");
  const token = randomToken(18);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      await IOUtils.makeDirectory(lockDirectory, {
        ignoreExisting: false,
        permissions: 0o700,
      });
      await writePrivateJSON(ownerPath, {
        pid: Services.appinfo.processID,
        processStartTime: await processStartTime(Services.appinfo.processID),
        token,
      });
      return async () => {
        if ((await readPrivateJSON(ownerPath))?.token === token) {
          await IOUtils.remove(lockDirectory, {
            recursive: true,
            ignoreAbsent: true,
          });
        }
      };
    } catch {}
    const lockFile = new LocalFile(lockDirectory);
    if (!lockFile.exists()) {
      continue;
    }
    if (!lockFile.isDirectory() || lockFile.isSymlink()) {
      throw new Error("Unsafe SearXNG extraction lock");
    }
    const owner = await readPrivateJSON(ownerPath);
    let stale = !owner;
    if (owner) {
      try {
        stale = (await processStartTime(owner.pid)) !== owner.processStartTime;
      } catch {
        stale = true;
      }
    }
    if (stale) {
      await IOUtils.remove(lockDirectory, {
        recursive: true,
        ignoreAbsent: true,
      });
      continue;
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
    record.protocolVersion !== 1 ||
    record.runtimeVersion !== RUNTIME_VERSION ||
    record.address !== ADDRESS ||
    !Number.isSafeInteger(record.port) ||
    record.port < 1024 ||
    record.port > 65535 ||
    typeof record.token !== "string" ||
    !/^[A-Za-z0-9_-]{32,512}$/.test(record.token) ||
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
  return new Promise((resolve, reject) => {
    const request = new ServiceRequest({ mozAnon: true });
    request.mozBackgroundRequest = true;
    request.open("GET", `http://${ADDRESS}:${record.port}/v1/health`, {
      bypassProxy: true,
    });
    request.responseType = "json";
    request.timeout = timeout;
    request.setRequestHeader("Authorization", `Bearer ${record.token}`);
    request.setRequestHeader("Cache-Control", "no-store");
    request.setRequestHeader("Sec-Fetch-Site", "none");
    request.addEventListener("load", () =>
      resolve({ body: request.response, status: request.status })
    );
    request.addEventListener("error", () =>
      reject(new Error("SearXNG health request failed"))
    );
    request.addEventListener("timeout", () =>
      reject(new Error("SearXNG health request timed out"))
    );
    request.send();
  });
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
    this.dataDirectory = PathUtils.join(this.rootDirectory, "data");
    this.connectionPath = PathUtils.join(
      this.stateDirectory,
      "connection.json"
    );
    this.activeRuntimePath = PathUtils.join(
      this.bundleRoot,
      "active-runtime.json"
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

  async ensure() {
    if (AppConstants.platform !== "linux") {
      throw new Error("The bundled SearXNG runtime currently supports Linux");
    }
    for (const path of [
      this.rootDirectory,
      this.bundleRoot,
      this.archivesDirectory,
      this.dataDirectory,
      this.cacheDirectory,
      this.stateDirectory,
    ]) {
      await privateDirectory(path);
    }
    const release = await acquireExtractionLock(this.stateDirectory);
    let runtime;
    try {
      runtime = await this.extractRuntime();
    } finally {
      await release();
    }
    const lifecycle = await this.runLifecycle(runtime, "start");
    if (
      lifecycle?.component !== "searxng" ||
      lifecycle.running !== true ||
      lifecycle.protocolVersion !== 1 ||
      lifecycle.runtimeVersion !== RUNTIME_VERSION ||
      !Number.isSafeInteger(lifecycle.pid) ||
      typeof lifecycle.processStartTime !== "string"
    ) {
      throw new Error("SearXNG lifecycle returned an invalid status");
    }
    const record = await this.readConnection(runtime);
    if (
      record.pid !== lifecycle.pid ||
      record.processStartTime !== lifecycle.processStartTime
    ) {
      throw new Error("SearXNG lifecycle and connection identities differ");
    }
    await this.authenticateConnection(record);
    await this.synchronizeEngine({
      address: record.address,
      port: record.port,
    });
    await writePrivateJSON(this.activeRuntimePath, {
      archivePath: runtime.archivePath,
      archiveSha256: runtime.archiveSha256,
      bundleId: runtime.bundleId,
      directory: runtime.directory,
      activatedAt: Date.now(),
    });
    return {
      address: record.address,
      connectionPath: this.connectionPath,
      correspondingSourcePath: this.sourceArchivePath(),
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
        !retained.isFile() ||
        retained.isSymlink() ||
        (retained.permissions & 0o777) !== 0o600 ||
        (await fileDigest(destination)) !== sourceBundle.archiveSha256
      ) {
        throw new Error("Invalid retained SearXNG runtime archive");
      }
      return destination;
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

  async extractRuntime() {
    const source = this.archivePath();
    if (!(await IOUtils.exists(source))) {
      throw new Error(
        "The bundled SearXNG runtime was not found. Build with --searxng-runtime."
      );
    }
    const sourceBundle = await runtimeBundleInfo(source);
    const retainedPath = await this.retainArchive(source, sourceBundle);
    const bundle = await runtimeBundleInfo(retainedPath);
    if (bundle.archiveSha256 !== sourceBundle.archiveSha256) {
      throw new Error("Retained SearXNG runtime identity mismatch");
    }
    const destination = PathUtils.join(this.bundleRoot, bundle.bundleId);
    const marker = PathUtils.join(destination, ".extraction-complete");
    if (await IOUtils.exists(marker)) {
      await verifyExtractedRuntime(destination, bundle);
      return { ...bundle, archivePath: retainedPath, directory: destination };
    }
    if (await IOUtils.exists(destination)) {
      throw new Error("Incomplete immutable SearXNG runtime exists");
    }
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
    const zip = new ZipReader(new LocalFile(retainedPath));
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
      return { ...bundle, archivePath: retainedPath, directory: destination };
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
    if (result.exitCode !== 0) {
      throw new Error(
        stderr.trim() || stdout.trim() || `SearXNG ${command} failed`
      );
    }
    try {
      return JSON.parse(stdout);
    } catch {
      throw new Error(`SearXNG ${command} returned invalid JSON`);
    }
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

  isAvailable() {
    return supervisor().isAvailable();
  },
};
