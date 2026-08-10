/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { NetUtil } from "resource://gre/modules/NetUtil.sys.mjs";
import { ServiceRequest } from "resource://gre/modules/ServiceRequest.sys.mjs";
import { Subprocess } from "resource://gre/modules/Subprocess.sys.mjs";
import { setTimeout } from "resource://gre/modules/Timer.sys.mjs";

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

const HOST = "127.0.0.1";
const MANIFEST = "jackett-mini-runtime.json";
const MAX_ARCHIVE_SIZE = 1024 * 1024 * 1024;
const MAX_FILE_SIZE = 512 * 1024 * 1024;
const MAX_EXPANDED_SIZE = 2 * 1024 * 1024 * 1024;
const MAX_ENTRIES = 200000;
const START_ATTEMPTS = 8;
const PROFILE_NAMESPACE_DOMAIN = "wildbuzzard-jackett-mini-profile-v1\0";

function hexDigest(bytes) {
  const hash = new CryptoHash("sha256");
  hash.update(bytes, bytes.length);
  return Array.from(hash.finish(false), byte =>
    byte.charCodeAt(0).toString(16).padStart(2, "0")
  ).join("");
}

function randomToken(bytes = 32) {
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
  if (!directory.isDirectory()) {
    throw new Error("The Firefox profile directory is unavailable");
  }
  return directory.path;
}

export function jackettMiniProfileNamespace(profilePath) {
  const identity = new TextEncoder().encode(
    PROFILE_NAMESPACE_DOMAIN + canonicalProfilePath(profilePath)
  );
  return `profile-${hexDigest(identity)}`;
}

export function jackettMiniProfilePaths({
  profilePath,
  dataHome,
  runtimeHome,
}) {
  const profileNamespace = jackettMiniProfileNamespace(profilePath);
  const rootDirectory = PathUtils.join(
    dataHome,
    "wildbuzzard",
    "jackett-mini",
    "profiles",
    profileNamespace
  );
  const stateDirectory = runtimeHome
    ? PathUtils.join(
        runtimeHome,
        "wildbuzzard",
        "jackett-mini",
        "profiles",
        profileNamespace
      )
    : PathUtils.join(rootDirectory, "run");
  return { profileNamespace, rootDirectory, stateDirectory };
}

function safeArchivePath(path) {
  const parts = path.split("/");
  return (
    path &&
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

function centralDirectoryEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimum = Math.max(0, bytes.length - 65557);
  let end = -1;
  for (let offset = bytes.length - 22; offset >= minimum; offset--) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      end = offset;
      break;
    }
  }
  if (end < 0) {
    throw new Error("Jackett Mini runtime has no ZIP central directory");
  }
  let entries = view.getUint16(end + 10, true);
  let centralSize = view.getUint32(end + 12, true);
  let centralOffset = view.getUint32(end + 16, true);
  if (
    view.getUint16(end + 4, true) !== 0 ||
    view.getUint16(end + 6, true) !== 0
  ) {
    throw new Error("Unsupported Jackett Mini runtime ZIP layout");
  }
  if (
    entries === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    const locator = end - 20;
    if (locator < 0 || view.getUint32(locator, true) !== 0x07064b50) {
      throw new Error("Invalid Jackett Mini runtime ZIP64 locator");
    }
    const zip64Offset = Number(view.getBigUint64(locator + 8, true));
    if (
      !Number.isSafeInteger(zip64Offset) ||
      zip64Offset + 56 > locator ||
      view.getUint32(zip64Offset, true) !== 0x06064b50 ||
      view.getUint32(zip64Offset + 16, true) !== 0 ||
      view.getUint32(zip64Offset + 20, true) !== 0
    ) {
      throw new Error("Invalid Jackett Mini runtime ZIP64 directory");
    }
    entries = Number(view.getBigUint64(zip64Offset + 32, true));
    centralSize = Number(view.getBigUint64(zip64Offset + 40, true));
    centralOffset = Number(view.getBigUint64(zip64Offset + 48, true));
  }
  if (
    !Number.isSafeInteger(entries) ||
    !Number.isSafeInteger(centralSize) ||
    !Number.isSafeInteger(centralOffset) ||
    entries > MAX_ENTRIES ||
    centralOffset + centralSize > end
  ) {
    throw new Error("Unsupported Jackett Mini runtime ZIP layout");
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const result = new Map();
  let expandedSize = 0;
  let offset = centralOffset;
  for (let index = 0; index < entries; index++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error("Invalid Jackett Mini runtime central directory");
    }
    const flags = view.getUint16(offset + 8, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const recordLength = 46 + nameLength + extraLength + commentLength;
    if (flags & 1 || offset + recordLength > end) {
      throw new Error("Unsupported Jackett Mini runtime entry");
    }
    const name = decoder.decode(
      bytes.subarray(offset + 46, offset + 46 + nameLength)
    );
    if (result.has(name)) {
      throw new Error(`Duplicate path in Jackett Mini runtime: ${name}`);
    }
    const host = bytes[offset + 5];
    const attributes = view.getUint32(offset + 38, true);
    const realSize = view.getUint32(offset + 24, true);
    const mode = host === 3 ? attributes >>> 16 : 0;
    const kind = mode & 0xf000;
    const directory = name.endsWith("/");
    if (kind && kind !== (directory ? 0x4000 : 0x8000)) {
      throw new Error(`Link or special file in Jackett Mini runtime: ${name}`);
    }
    expandedSize += realSize;
    if (realSize > MAX_FILE_SIZE || expandedSize > MAX_EXPANDED_SIZE) {
      throw new Error("Jackett Mini runtime exceeds extraction limits");
    }
    result.set(name, {
      directory,
      executable: Boolean(mode & 0o111),
      realSize,
    });
    offset += recordLength;
  }
  if (offset !== centralOffset + centralSize) {
    throw new Error("Invalid Jackett Mini runtime central directory size");
  }
  return result;
}

// eslint-disable-next-line complexity
async function bundleInfo(archivePath) {
  const archiveInfo = await IOUtils.stat(archivePath);
  if (archiveInfo.size > MAX_ARCHIVE_SIZE) {
    throw new Error("Jackett Mini runtime archive is too large");
  }
  const archiveBytes = await IOUtils.read(archivePath);
  const archiveSha256 = hexDigest(archiveBytes);
  const centralEntries = centralDirectoryEntries(archiveBytes);
  const zip = new ZipReader(new LocalFile(archivePath));
  try {
    if (!zip.hasEntry(MANIFEST)) {
      throw new Error("Jackett Mini runtime manifest is missing");
    }
    const entry = zip.getEntry(MANIFEST);
    const stream = zip.getInputStream(MANIFEST);
    let manifest;
    try {
      manifest = JSON.parse(
        NetUtil.readInputStreamToString(stream, entry.realSize, {
          charset: "utf-8",
        })
      );
    } finally {
      stream.close();
    }
    if (
      manifest.schemaVersion !== 1 ||
      manifest.component !== "jackett-mini" ||
      manifest.semanticVersion !== "0.24.2360-wildbuzzard.1" ||
      manifest.upstreamVersion !== "v0.24.2360" ||
      manifest.protocolVersion !== 1 ||
      manifest.platform !== "linux" ||
      manifest.architecture !== "x86_64" ||
      manifest.libc !== "glibc" ||
      manifest.upstreamCommit !== "0cd8622b735922a909a128d8d6943bb8565a640f" ||
      manifest.sourceSha256 !==
        "3816fea39546b5fa440d3e33b856e73500ee6129e91b14d839fc0f04c7f9bd3e" ||
      !/^[a-f0-9]{64}$/.test(manifest.dependencyLockSha256) ||
      !/^[a-f0-9]{64}$/.test(manifest.providerPolicySha256) ||
      !/^[a-f0-9]{64}$/.test(manifest.catalogFileSha256) ||
      !/^[a-f0-9]{64}$/.test(manifest.runtimeSha256) ||
      manifest.license !== "GPL-2.0-only" ||
      manifest.correspondingSource !== "source/jackett" ||
      manifest.sbom !== "jackett-mini.spdx.json" ||
      manifest.enabledProviderCount !== 60 ||
      manifest.executableName !== "jackett-mini" ||
      manifest.updaterIncluded !== false ||
      manifest.dashboardIncluded !== false ||
      !safeArchivePath(manifest.correspondingSource) ||
      !safeArchivePath(manifest.sbom) ||
      !Array.isArray(manifest.licenseLocations) ||
      !Array.isArray(manifest.files)
    ) {
      throw new Error("Invalid Jackett Mini runtime manifest");
    }
    const files = new Map();
    const executables = new Set();
    for (const file of manifest.files) {
      if (
        !safeArchivePath(file?.path) ||
        files.has(file.path) ||
        !/^[a-f0-9]{64}$/.test(file.sha256) ||
        !Number.isSafeInteger(file.size) ||
        file.size < 0 ||
        typeof file.executable !== "boolean"
      ) {
        throw new Error("Invalid Jackett Mini runtime inventory");
      }
      files.set(file.path, file);
      if (file.executable) {
        executables.add(file.path);
      }
    }
    if (
      !files.has(manifest.executableName) ||
      !executables.has(manifest.executableName) ||
      !files.has(manifest.sbom) ||
      manifest.licenseLocations.some(path => !files.has(path)) ||
      new Set(manifest.licenseLocations).size !==
        manifest.licenseLocations.length ||
      ![...files].some(([path]) =>
        path.startsWith(`${manifest.correspondingSource}/`)
      )
    ) {
      throw new Error("Incomplete Jackett Mini runtime inventory");
    }
    const canonical = JSON.stringify(
      manifest.files.map(file => ({
        executable: file.executable,
        path: file.path,
        sha256: file.sha256,
        size: file.size,
      }))
    );
    if (
      hexDigest(new TextEncoder().encode(canonical)) !== manifest.runtimeSha256
    ) {
      throw new Error("Jackett Mini runtime inventory digest mismatch");
    }
    const actualFiles = new Set(
      [...centralEntries]
        .filter(([, metadata]) => !metadata.directory)
        .map(([path]) => path)
    );
    const expectedFiles = new Set([...files.keys(), MANIFEST]);
    if (
      actualFiles.size !== expectedFiles.size ||
      [...actualFiles].some(path => !expectedFiles.has(path)) ||
      [...centralEntries].some(([path, metadata]) => {
        const normalized = metadata.directory ? path.slice(0, -1) : path;
        return (
          !safeArchivePath(normalized) ||
          (!metadata.directory &&
            path !== MANIFEST &&
            (metadata.executable !== executables.has(path) ||
              metadata.realSize !== files.get(path).size)) ||
          (path === MANIFEST && metadata.executable)
        );
      })
    ) {
      throw new Error("Jackett Mini runtime file inventory mismatch");
    }
    return {
      archiveSha256,
      bundleId: `1-${manifest.upstreamCommit}-${archiveSha256}`,
      centralEntries,
      executables,
      files,
      manifest,
    };
  } finally {
    zip.close();
  }
}

function requestHealth(record, timeout = 1000) {
  return new Promise((resolve, reject) => {
    const request = new ServiceRequest({ mozAnon: true });
    request.mozBackgroundRequest = true;
    request.open("GET", `http://${HOST}:${record.port}/v1/health`, {
      bypassProxy: true,
    });
    request.responseType = "json";
    request.timeout = timeout;
    request.setRequestHeader("Authorization", `Bearer ${record.capability}`);
    request.setRequestHeader("Cache-Control", "no-store");
    request.addEventListener("load", () =>
      resolve({ status: request.status, body: request.response })
    );
    request.addEventListener("error", () => reject(new Error("health failed")));
    request.addEventListener("timeout", () =>
      reject(new Error("health timed out"))
    );
    request.send();
  });
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

async function fileDigest(path) {
  return hexDigest(await IOUtils.read(path));
}

async function processMatches(record) {
  try {
    if ((await processStartTime(record.pid)) !== record.linuxProcessStartTime) {
      return false;
    }
    const executablePath = new LocalFile(`/proc/${record.pid}/exe`).target;
    return (
      executablePath === record.executablePath &&
      (await fileDigest(executablePath)) === record.executableSha256
    );
  } catch {
    return false;
  }
}

async function healthMatches(record) {
  try {
    const { status, body } = await requestHealth(record);
    return (
      status === 200 &&
      body?.status === "ok" &&
      body.protocolVersion === record.protocolVersion &&
      body.runtimeVersion === record.runtimeVersion &&
      body.processId === record.pid &&
      body.instanceId === record.ownerInstanceId &&
      body.executablePath === record.executablePath &&
      body.executableSha256 === record.executableSha256 &&
      body.dataRootId === record.dataRootId
    );
  } catch {
    return false;
  }
}

async function privateDirectory(path) {
  await IOUtils.makeDirectory(path, {
    createAncestors: true,
    ignoreExisting: true,
    permissions: 0o700,
  });
  await IOUtils.setPermissions(path, 0o700);
  const file = new LocalFile(path);
  if (!file.isDirectory() || file.isSymlink()) {
    throw new Error("Unsafe Jackett Mini state directory");
  }
  return file.path;
}

async function privateJSON(path, value) {
  const temporary = `${path}.new-${randomToken(12)}`;
  await IOUtils.writeJSON(temporary, value, { mode: "create" });
  await IOUtils.setPermissions(temporary, 0o600);
  await IOUtils.move(temporary, path, { noOverwrite: false });
}

async function readPrivateJSON(path) {
  try {
    const file = new LocalFile(path);
    if (!file.isFile() || file.isSymlink() || file.permissions & 0o077) {
      return null;
    }
    return await IOUtils.readJSON(path);
  } catch {
    return null;
  }
}

async function removeRecordFiles(record, stateDirectory) {
  for (const path of [record?.capabilityPath, record?.pidPath]) {
    if (typeof path === "string" && PathUtils.parent(path) === stateDirectory) {
      await IOUtils.remove(path, { ignoreAbsent: true }).catch(() => {});
    }
  }
}

async function acquireLock(stateDirectory) {
  const lockDirectory = PathUtils.join(stateDirectory, "launch.lock");
  const ownerPath = PathUtils.join(lockDirectory, "owner.json");
  const token = randomToken(16);
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      await IOUtils.makeDirectory(lockDirectory, { ignoreExisting: false });
      await privateJSON(ownerPath, {
        pid: Services.appinfo.processID,
        linuxProcessStartTime: await processStartTime(
          Services.appinfo.processID
        ),
        token,
      });
      return async () => {
        const owner = await readPrivateJSON(ownerPath);
        if (owner?.token === token) {
          await IOUtils.remove(lockDirectory, {
            recursive: true,
            ignoreAbsent: true,
          });
        }
      };
    } catch {}
    let stale = false;
    try {
      const owner = await readPrivateJSON(ownerPath);
      stale =
        !owner ||
        (await processStartTime(owner.pid)) !== owner.linuxProcessStartTime;
    } catch {
      stale = true;
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
  throw new Error("Timed out waiting for the Jackett Mini launch lock");
}

/** Activates and supervises the bundled native Jackett Mini service. */
export class JackettMiniRuntime {
  constructor({ profilePath, dataHome, runtimeHome } = {}) {
    const home = Services.dirsvc.get("Home", Ci.nsIFile).path;
    dataHome ??=
      Services.env.get("XDG_DATA_HOME") ||
      PathUtils.join(home, ".local", "share");
    runtimeHome ??= Services.env.get("XDG_RUNTIME_DIR") || null;
    profilePath ??= Services.dirsvc.get("ProfD", Ci.nsIFile).path;
    const paths = jackettMiniProfilePaths({
      profilePath,
      dataHome,
      runtimeHome,
    });
    this.profileNamespace = paths.profileNamespace;
    this.rootDirectory = paths.rootDirectory;
    this.stateDirectory = paths.stateDirectory;
    this.bundleRoot = PathUtils.join(this.rootDirectory, "runtime");
    this.dataDirectory = PathUtils.join(this.rootDirectory, "data");
    this.connectionPath = PathUtils.join(
      this.stateDirectory,
      "connection.json"
    );
    this.activeRuntimePath = PathUtils.join(
      this.bundleRoot,
      "active-runtime.json"
    );
  }

  archivePath() {
    const configured =
      Services.prefs.getStringPref(
        "wildbuzzard.torrent.discoveryRuntime",
        ""
      ) || Services.env.get("WILDBUZZARD_JACKETT_MINI_RUNTIME");
    if (configured) {
      return configured;
    }
    return PathUtils.join(
      Services.dirsvc.get("GreD", Ci.nsIFile).path,
      "runtime",
      "jackett-mini",
      "wildbuzzard-jackett-mini-runtime.zip"
    );
  }

  async ensure() {
    if (AppConstants.platform !== "linux") {
      throw new Error(
        "The bundled Jackett Mini runtime currently supports Linux"
      );
    }
    await privateDirectory(this.rootDirectory);
    await privateDirectory(this.bundleRoot);
    await privateDirectory(this.dataDirectory);
    await privateDirectory(this.stateDirectory);
    const release = await acquireLock(this.stateDirectory);
    try {
      const previous = await this.readActiveRuntime();
      let runtime;
      try {
        runtime = await this.extractRuntime();
        const connection = await this.ensureProcess(runtime);
        await privateJSON(this.activeRuntimePath, {
          bundleId: runtime.bundleId,
          directory: runtime.directory,
          activatedAt: Date.now(),
        });
        return connection;
      } catch (error) {
        if (
          previous &&
          (!runtime || previous.directory !== runtime.directory)
        ) {
          const rollback = await this.runtimeFromDirectory(previous);
          return this.ensureProcess(rollback);
        }
        throw error;
      }
    } finally {
      await release();
    }
  }

  async extractRuntime() {
    const archivePath = this.archivePath();
    if (!(await IOUtils.exists(archivePath))) {
      throw new Error(
        "The bundled torrent search runtime was not found. Build with --jackett-mini-runtime."
      );
    }
    const bundle = await bundleInfo(archivePath);
    const destination = PathUtils.join(this.bundleRoot, bundle.bundleId);
    const marker = PathUtils.join(destination, ".extraction-complete");
    if (await IOUtils.exists(marker)) {
      const value = await readPrivateJSON(marker);
      if (value?.archiveSha256 !== bundle.archiveSha256) {
        throw new Error("Jackett Mini runtime activation marker is invalid");
      }
      return this.runtimeFromBundle(destination, bundle);
    }
    if (await IOUtils.exists(destination)) {
      throw new Error("Incomplete immutable Jackett Mini runtime exists");
    }
    const staging = PathUtils.join(
      this.bundleRoot,
      `.staging-${bundle.bundleId}-${Services.appinfo.processID}-${Date.now()}`
    );
    await IOUtils.makeDirectory(staging, {
      ignoreExisting: false,
      permissions: 0o700,
    });
    const zip = new ZipReader(new LocalFile(archivePath));
    try {
      for (const entry of zip.findEntries(null)) {
        const metadata = bundle.centralEntries.get(entry);
        if (!metadata) {
          throw new Error(`Unindexed Jackett Mini runtime path: ${entry}`);
        }
        const path = metadata.directory ? entry.slice(0, -1) : entry;
        const target = PathUtils.join(staging, ...path.split("/"));
        if (metadata.directory) {
          await IOUtils.makeDirectory(target, {
            createAncestors: true,
            ignoreExisting: true,
          });
          continue;
        }
        await IOUtils.makeDirectory(PathUtils.parent(target), {
          createAncestors: true,
          ignoreExisting: true,
        });
        const zipEntry = zip.getEntry(entry);
        if (zipEntry.realSize !== metadata.realSize) {
          throw new Error(`Size mismatch in Jackett Mini runtime: ${entry}`);
        }
        const stream = zip.getInputStream(entry);
        let bytes;
        try {
          bytes = NetUtil.readInputStream(stream, zipEntry.realSize);
        } finally {
          stream.close();
        }
        const expected = bundle.files.get(entry);
        if (entry !== MANIFEST && hexDigest(bytes) !== expected.sha256) {
          throw new Error(`Digest mismatch in Jackett Mini runtime: ${entry}`);
        }
        await IOUtils.write(target, bytes, { mode: "create" });
        await IOUtils.setPermissions(
          target,
          bundle.executables.has(entry) ? 0o755 : 0o644
        );
      }
      await privateJSON(PathUtils.join(staging, ".extraction-complete"), {
        bundleId: bundle.bundleId,
        archiveSha256: bundle.archiveSha256,
      });
      await IOUtils.move(staging, destination, { noOverwrite: true });
    } catch (error) {
      await IOUtils.remove(staging, { recursive: true, ignoreAbsent: true });
      throw error;
    } finally {
      zip.close();
    }
    return this.runtimeFromBundle(destination, bundle);
  }

  async runtimeFromBundle(directory, bundle) {
    const executablePath = PathUtils.join(
      directory,
      bundle.manifest.executableName
    );
    return {
      bundleId: bundle.bundleId,
      directory,
      executablePath,
      executableSha256: bundle.files.get(bundle.manifest.executableName).sha256,
      runtimeVersion: bundle.manifest.upstreamVersion,
    };
  }

  async readActiveRuntime() {
    const active = await readPrivateJSON(this.activeRuntimePath);
    if (
      !active ||
      !/^[0-9A-Za-z._-]+$/.test(active.bundleId) ||
      active.directory !== PathUtils.join(this.bundleRoot, active.bundleId) ||
      !(await IOUtils.exists(
        PathUtils.join(active.directory, ".extraction-complete")
      ))
    ) {
      return null;
    }
    return active;
  }

  async runtimeFromDirectory(active) {
    const manifest = await IOUtils.readJSON(
      PathUtils.join(active.directory, MANIFEST)
    );
    const executable = manifest.files.find(
      file => file.path === manifest.executableName && file.executable
    );
    if (!executable) {
      throw new Error("Previous Jackett Mini runtime is invalid");
    }
    return {
      ...active,
      executablePath: PathUtils.join(active.directory, manifest.executableName),
      executableSha256: executable.sha256,
      runtimeVersion: manifest.upstreamVersion,
    };
  }

  async ensureProcess(runtime) {
    const existing = await readPrivateJSON(this.connectionPath);
    if (
      existing?.executablePath === runtime.executablePath &&
      existing.executableSha256 === runtime.executableSha256 &&
      existing.dataRoot === this.dataDirectory &&
      (await processMatches(existing)) &&
      (await healthMatches(existing))
    ) {
      return existing;
    }
    await IOUtils.remove(this.connectionPath, { ignoreAbsent: true });
    await removeRecordFiles(existing, this.stateDirectory);
    for (let attempt = 0; attempt < START_ATTEMPTS; attempt++) {
      const random = new Uint16Array(1);
      crypto.getRandomValues(random);
      const port = 49152 + (random[0] % 16384);
      const capability = randomToken();
      const suffix = randomToken(12);
      const capabilityPath = PathUtils.join(
        this.stateDirectory,
        `capability-${suffix}`
      );
      const pidPath = PathUtils.join(
        this.stateDirectory,
        `jackett-${suffix}.pid`
      );
      await IOUtils.writeUTF8(capabilityPath, `${capability}\n`, {
        mode: "create",
      });
      await IOUtils.setPermissions(capabilityPath, 0o600);
      const process = await Subprocess.call({
        command: runtime.executablePath,
        arguments: [
          "--ListenPrivate",
          "--Port",
          String(port),
          "--PIDFile",
          pidPath,
          "--NoUpdates",
          "--NoRestart",
          "--DataFolder",
          this.dataDirectory,
          "--CapabilityFile",
          capabilityPath,
        ],
        environmentAppend: false,
        environment: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "UTC" },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      try {
        const deadline = Date.now() + 15000;
        let health;
        while (Date.now() < deadline) {
          const candidate = {
            port,
            capability,
          };
          try {
            const response = await requestHealth(candidate);
            if (
              response.status === 200 &&
              response.body?.status === "ok" &&
              response.body.protocolVersion === 1 &&
              response.body.runtimeVersion === runtime.runtimeVersion &&
              response.body.executablePath === runtime.executablePath &&
              response.body.executableSha256 === runtime.executableSha256
            ) {
              health = response.body;
              break;
            }
          } catch {}
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (!health) {
          throw new Error(
            "Jackett Mini did not become identity-verified and healthy"
          );
        }
        const record = {
          schemaVersion: 1,
          protocolVersion: 1,
          runtimeVersion: health.runtimeVersion,
          address: HOST,
          port,
          capability,
          capabilityPath,
          pid: process.pid,
          pidPath,
          linuxProcessStartTime: await processStartTime(process.pid),
          executablePath: runtime.executablePath,
          executableSha256: runtime.executableSha256,
          dataRoot: this.dataDirectory,
          dataRootId: health.dataRootId,
          ownerInstanceId: health.instanceId,
          createdAt: new Date().toISOString(),
        };
        if (!(await processMatches(record)) || !(await healthMatches(record))) {
          throw new Error(
            "Jackett Mini process identity changed during startup"
          );
        }
        await privateJSON(this.connectionPath, record);
        return record;
      } catch (error) {
        process.kill();
        await removeRecordFiles(
          { capabilityPath, pidPath },
          this.stateDirectory
        );
        if (attempt === START_ATTEMPTS - 1) {
          throw error;
        }
      }
    }
    throw new Error("Jackett Mini startup attempts were exhausted");
  }
}
