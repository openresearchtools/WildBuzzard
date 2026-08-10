/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { Downloads } from "resource://gre/modules/Downloads.sys.mjs";
import { NetUtil } from "resource://gre/modules/NetUtil.sys.mjs";
import { ServiceRequest } from "resource://gre/modules/ServiceRequest.sys.mjs";
import { Subprocess } from "resource://gre/modules/Subprocess.sys.mjs";
import { setTimeout } from "resource://gre/modules/Timer.sys.mjs";
import { TorRouting } from "resource:///modules/TorRouting.sys.mjs";

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

const MAX_TORRENT_SIZE = 12 * 1024 * 1024;
const RUNTIME_MANIFEST = "wildbuzzard-torrent-runtime.json";
const MAX_RUNTIME_FILES = 50000;
const MAX_RUNTIME_MANIFEST_SIZE = 16 * 1024 * 1024;
const MAX_RUNTIME_FILE_SIZE = 512 * 1024 * 1024;
const MAX_RUNTIME_SIZE = 4 * 1024 * 1024 * 1024;
const RUNTIME_LOCK_STALE_MS = 30000;
const RUNTIME_NODE_VERSION = "22.23.2";
const RUNTIME_NODE_SHA256 =
  "d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307";
const RUNTIME_EXECUTABLES = new Set([
  "bin/wildbuzzard-torrent",
  "node/bin/node",
]);

function torrentFileError(reason) {
  return Object.assign(new Error(`Torrent file ${reason}`), {
    torrentFileError: reason,
  });
}

function validateTorrentFileDescriptor(name, size, type = "") {
  if (!name?.toLowerCase().endsWith(".torrent")) {
    throw torrentFileError("wrong-type");
  }
  if (type && type !== "application/x-bittorrent") {
    throw torrentFileError("wrong-type");
  }
  if (!Number.isFinite(size) || size <= 0) {
    throw torrentFileError("invalid");
  }
  if (size > MAX_TORRENT_SIZE) {
    throw torrentFileError("too-large");
  }
}

function safeRuntimePath(path) {
  const parts = path.split("/");
  return Boolean(
    path &&
    path.length <= 4096 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    parts.every(
      part => part && part.length <= 255 && part !== "." && part !== ".."
    )
  );
}

function sha256String(value) {
  const bytes = new TextEncoder().encode(value);
  const hash = Cc["@mozilla.org/security/hash;1"].createInstance(
    Ci.nsICryptoHash
  );
  hash.initWithString("sha256");
  hash.update(bytes, bytes.length);
  return Array.from(hash.finish(false), character =>
    character.charCodeAt(0).toString(16).padStart(2, "0")
  ).join("");
}

function readRuntimeManifest(archivePath) {
  const zip = new ZipReader(new LocalFile(archivePath));
  try {
    const entry = zip.getEntry(RUNTIME_MANIFEST);
    if (
      entry.isDirectory ||
      !entry.realSize ||
      entry.realSize > MAX_RUNTIME_MANIFEST_SIZE
    ) {
      throw new Error("Invalid torrent runtime manifest");
    }
    const stream = zip.getInputStream(RUNTIME_MANIFEST);
    try {
      return JSON.parse(
        NetUtil.readInputStreamToString(stream, entry.realSize, {
          charset: "utf-8",
        })
      );
    } finally {
      stream.close();
    }
  } finally {
    zip.close();
  }
}

function invalidRuntimeManifestHeader(manifest) {
  return Boolean(
    manifest?.schema !== 2 ||
    !/^[0-9a-f]{40}$/.test(manifest.wildbuzzardCommit || "") ||
    !/^[0-9a-f]{40}$/.test(manifest.webTorrentImportCommit || "") ||
    !/^[0-9a-f]{64}$/.test(manifest.packageLockSha256 || "") ||
    manifest.nodeArchiveSha256 !== RUNTIME_NODE_SHA256 ||
    manifest.nodeVersion !== RUNTIME_NODE_VERSION ||
    manifest.webTorrentVersion !== "3.0.21" ||
    manifest.utpBuiltFromSource !== true ||
    !/^[0-9a-f]{64}$/.test(manifest.payloadSha256 || "") ||
    manifest.platform !== "linux-x64" ||
    !Array.isArray(manifest.files) ||
    !manifest.files.length ||
    manifest.files.length > MAX_RUNTIME_FILES
  );
}

function validRuntimeFileManifest(file, files, previousPath) {
  return Boolean(
    safeRuntimePath(file?.path) &&
    Number.isSafeInteger(file.size) &&
    file.size >= 0 &&
    file.size <= MAX_RUNTIME_FILE_SIZE &&
    /^[0-9a-f]{64}$/.test(file.sha256 || "") &&
    typeof file.executable === "boolean" &&
    !files.has(file.path) &&
    file.path > previousPath &&
    file.executable === RUNTIME_EXECUTABLES.has(file.path)
  );
}

function validateRuntimeManifest(manifest) {
  if (invalidRuntimeManifestHeader(manifest)) {
    throw new Error("Invalid torrent runtime manifest");
  }
  const files = new Map();
  let totalSize = 0;
  let previousPath = "";
  for (const file of manifest.files) {
    if (!validRuntimeFileManifest(file, files, previousPath)) {
      throw new Error("Invalid torrent runtime file manifest");
    }
    totalSize += file.size;
    if (!Number.isSafeInteger(totalSize) || totalSize > MAX_RUNTIME_SIZE) {
      throw new Error("Torrent runtime is too large");
    }
    files.set(file.path, file);
    previousPath = file.path;
  }
  for (const executable of RUNTIME_EXECUTABLES) {
    if (!files.get(executable)?.executable) {
      throw new Error("Torrent runtime executable is missing");
    }
  }
  const payload = [...files.values()]
    .map(
      file =>
        `${file.path}\0${file.size}\0${file.sha256}\0${file.executable ? 1 : 0}\n`
    )
    .join("");
  if (sha256String(payload) !== manifest.payloadSha256) {
    throw new Error("Torrent runtime payload manifest digest does not match");
  }
  return files;
}

async function readZipCentralDirectory(archivePath) {
  const { size } = await IOUtils.stat(archivePath);
  const tailSize = Math.min(size, 65557);
  const tail = await IOUtils.read(archivePath, {
    offset: size - tailSize,
    maxBytes: tailSize,
  });
  const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let eocd = -1;
  for (let offset = tail.length - 22; offset >= 0; offset--) {
    if (tailView.getUint32(offset, true) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd === -1) {
    throw new Error("Invalid torrent runtime ZIP directory");
  }
  const entryCount = tailView.getUint16(eocd + 10, true);
  const entriesOnDisk = tailView.getUint16(eocd + 8, true);
  const centralSize = tailView.getUint32(eocd + 12, true);
  const centralOffset = tailView.getUint32(eocd + 16, true);
  const commentLength = tailView.getUint16(eocd + 20, true);
  if (
    tailView.getUint16(eocd + 4, true) !== 0 ||
    tailView.getUint16(eocd + 6, true) !== 0 ||
    entriesOnDisk !== entryCount ||
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff ||
    entryCount > MAX_RUNTIME_FILES + 1 ||
    centralSize > 64 * 1024 * 1024 ||
    centralOffset + centralSize > size ||
    eocd + 22 + commentLength !== tail.length
  ) {
    throw new Error("Unsupported torrent runtime ZIP directory");
  }
  const central = await IOUtils.read(archivePath, {
    offset: centralOffset,
    maxBytes: centralSize,
  });
  const view = new DataView(
    central.buffer,
    central.byteOffset,
    central.byteLength
  );
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const entries = new Map();
  const localOffsets = new Set();
  let cursor = 0;
  while (cursor < central.length) {
    if (
      cursor + 46 > central.length ||
      view.getUint32(cursor, true) !== 0x02014b50
    ) {
      throw new Error("Invalid torrent runtime ZIP entry");
    }
    const flags = view.getUint16(cursor + 8, true);
    const compression = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const realSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const entryCommentLength = view.getUint16(cursor + 32, true);
    const disk = view.getUint16(cursor + 34, true);
    const externalAttributes = view.getUint32(cursor + 38, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const end = cursor + 46 + nameLength + extraLength + entryCommentLength;
    if (
      end > central.length ||
      flags & 1 ||
      ![0, 8].includes(compression) ||
      disk !== 0 ||
      localOffset === 0xffffffff ||
      localOffset >= centralOffset ||
      localOffsets.has(localOffset) ||
      realSize > MAX_RUNTIME_FILE_SIZE
    ) {
      throw new Error("Unsafe torrent runtime ZIP entry");
    }
    const name = decoder.decode(
      central.subarray(cursor + 46, cursor + 46 + nameLength)
    );
    const unixMode = (externalAttributes >>> 16) & 0xffff;
    const fileType = unixMode & 0o170000;
    if (
      !safeRuntimePath(name) ||
      name.endsWith("/") ||
      entries.has(name) ||
      fileType === 0o120000 ||
      (fileType && fileType !== 0o100000) ||
      ((unixMode & 0o111) !== 0) !== RUNTIME_EXECUTABLES.has(name)
    ) {
      throw new Error("Unsafe torrent runtime ZIP entry");
    }
    entries.set(name, { compressedSize, realSize, unixMode });
    localOffsets.add(localOffset);
    cursor = end;
  }
  if (cursor !== central.length || entries.size !== entryCount) {
    throw new Error("Invalid torrent runtime ZIP directory");
  }
  return entries;
}

async function runtimeBundleInfo(archivePath) {
  const manifest = readRuntimeManifest(archivePath);
  const files = validateRuntimeManifest(manifest);
  const archiveEntries = await readZipCentralDirectory(archivePath);
  const expectedPaths = new Set([...files.keys(), RUNTIME_MANIFEST]);
  if (
    archiveEntries.size !== expectedPaths.size ||
    [...archiveEntries.keys()].some(path => !expectedPaths.has(path))
  ) {
    throw new Error("Torrent runtime archive contains unexpected entries");
  }
  for (const [path, file] of files) {
    if (archiveEntries.get(path)?.realSize !== file.size) {
      throw new Error(
        "Torrent runtime archive size does not match its manifest"
      );
    }
  }
  const archiveSha256 = await IOUtils.computeHexDigest(archivePath, "sha256");
  const checksumPath = `${archivePath}.sha256`;
  if (await IOUtils.exists(checksumPath)) {
    const checksum = (await IOUtils.readUTF8(checksumPath))
      .trim()
      .split(/\s+/)[0];
    if (checksum !== archiveSha256) {
      throw new Error("Torrent runtime archive checksum does not match");
    }
  }
  return {
    archiveEntries,
    archiveSha256,
    bundleId: `runtime-${archiveSha256}`,
    files,
    manifest,
  };
}

function parsePidStartTime(value) {
  const commandEnd = value.lastIndexOf(")");
  if (commandEnd === -1) {
    return null;
  }
  const fields = value
    .slice(commandEnd + 2)
    .trim()
    .split(/\s+/);
  return /^\d+$/.test(fields[19] || "") ? fields[19] : null;
}

async function processMatches(pid, startTime) {
  if (!Number.isInteger(pid) || pid < 1 || !/^\d+$/.test(String(startTime))) {
    return false;
  }
  try {
    const value = await IOUtils.readUTF8(`/proc/${pid}/stat`);
    return parsePidStartTime(value) === String(startTime);
  } catch {
    return false;
  }
}

function encodeBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function requestBytes(uri, principal, cookieJarSettings) {
  return new Promise((resolve, reject) => {
    const channel = NetUtil.newChannel({
      uri,
      loadingPrincipal:
        principal ?? Services.scriptSecurityManager.getSystemPrincipal(),
      securityFlags: Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL,
      contentPolicyType: Ci.nsIContentPolicy.TYPE_OTHER,
    });
    if (cookieJarSettings) {
      channel.loadInfo.cookieJarSettings = cookieJarSettings;
    }
    channel.loadFlags |= Ci.nsIRequest.LOAD_BYPASS_CACHE;
    NetUtil.asyncFetch(channel, (input, status) => {
      if (!Components.isSuccessCode(status)) {
        reject(new Error(`Torrent request failed (0x${status.toString(16)})`));
        return;
      }
      const available = input.available();
      if (!available || available > MAX_TORRENT_SIZE) {
        reject(new Error("Torrent metadata is empty or too large"));
        return;
      }
      const stream = Cc["@mozilla.org/binaryinputstream;1"].createInstance(
        Ci.nsIBinaryInputStream
      );
      stream.setInputStream(input);
      resolve(Uint8Array.from(stream.readByteArray(available)));
    });
  });
}

/** Manages the bundled torrent service and its local API. */
class TorrentManagerImpl {
  constructor() {
    const home = Services.dirsvc.get("Home", Ci.nsIFile).path;
    const dataHome =
      Services.env.get("XDG_DATA_HOME") ||
      PathUtils.join(home, ".local", "share");
    const configHome =
      Services.env.get("XDG_CONFIG_HOME") || PathUtils.join(home, ".config");
    const runtimeHome =
      Services.env.get("XDG_RUNTIME_DIR") ||
      PathUtils.join(dataHome, "wildbuzzard", "torrent", "run");
    this.rootDirectory = PathUtils.join(dataHome, "wildbuzzard", "torrent");
    this.bundleRoot = PathUtils.join(this.rootDirectory, "runtime");
    this.configPath = PathUtils.join(
      configHome,
      "wildbuzzard",
      "torrent",
      "config.json"
    );
    this.connectionPath = PathUtils.join(
      runtimeHome,
      "wildbuzzard-torrent",
      "connection.json"
    );
  }

  async initialize() {
    if (this.initializeTask) {
      return this.initializeTask;
    }
    this.initializeTask = this.#initialize().catch(error => {
      this.initializeTask = null;
      throw error;
    });
    return this.initializeTask;
  }

  async #initialize() {
    if (AppConstants.platform !== "linux") {
      throw new Error("The bundled torrent runtime currently supports Linux");
    }
    await IOUtils.makeDirectory(this.rootDirectory, {
      createAncestors: true,
      ignoreExisting: true,
    });
    await IOUtils.makeDirectory(PathUtils.parent(this.configPath), {
      createAncestors: true,
      ignoreExisting: true,
    });
    await IOUtils.makeDirectory(PathUtils.parent(this.connectionPath), {
      createAncestors: true,
      ignoreExisting: true,
    });
    await this.#writeConfig();
    this.runtimeDirectory = await this.#extractRuntime();
    await this.#prepareServiceIdentity();
    await this.#ensureService();
    if (this.config.torEnabled) {
      await this.#request("PATCH", "/v1/settings", {
        torEnabled: true,
        torProxy: this.config.torProxy,
      });
    }
    return this.#request("GET", "/v1/status");
  }

  #archivePath() {
    const configured =
      Services.prefs.getStringPref("wildbuzzard.torrent.runtime", "") ||
      Services.env.get("WILDBUZZARD_TORRENT_RUNTIME");
    if (configured) {
      return configured;
    }
    const applicationDirectory = Services.dirsvc.get("GreD", Ci.nsIFile).path;
    return PathUtils.join(
      applicationDirectory,
      "runtime",
      "torrent",
      "wildbuzzard-torrent-runtime.zip"
    );
  }

  async #extractRuntime() {
    const archivePath = this.#archivePath();
    if (!(await IOUtils.exists(archivePath))) {
      throw new Error(
        "The bundled torrent runtime was not found. Build with --torrent-runtime."
      );
    }
    const bundle = await runtimeBundleInfo(archivePath);
    let destination = PathUtils.join(this.bundleRoot, bundle.bundleId);
    if (await IOUtils.exists(destination)) {
      const destinationFile = new LocalFile(destination);
      destinationFile.normalize();
      destination = destinationFile.path;
    }
    if (await this.#verifyRuntimeDirectory(destination, bundle)) {
      return destination;
    }
    await IOUtils.makeDirectory(this.bundleRoot, {
      createAncestors: true,
      ignoreExisting: true,
    });
    const lock = await this.#acquireExtractionLock(bundle.bundleId);
    const staging = PathUtils.join(
      this.bundleRoot,
      `.${bundle.bundleId}-${Services.appinfo.processID}-${Services.uuid.generateUUID().toString().replace(/[{}]/g, "")}`
    );
    try {
      if (await this.#verifyRuntimeDirectory(destination, bundle)) {
        return destination;
      }
      await this.#stopServiceUsingRuntime(destination);
      await IOUtils.remove(destination, {
        recursive: true,
        ignoreAbsent: true,
      });
      await IOUtils.remove(staging, { recursive: true, ignoreAbsent: true });
      await IOUtils.makeDirectory(staging, {
        createAncestors: true,
        ignoreExisting: true,
      });
      const zip = new ZipReader(new LocalFile(archivePath));
      try {
        zip.test(null);
        for (const path of bundle.archiveEntries.keys()) {
          const entry = zip.getEntry(path);
          if (
            entry.isDirectory ||
            entry.realSize !== bundle.archiveEntries.get(path).realSize
          ) {
            throw new Error(
              "Torrent runtime ZIP entry changed during extraction"
            );
          }
          const target = PathUtils.join(staging, ...path.split("/"));
          await IOUtils.makeDirectory(PathUtils.parent(target), {
            createAncestors: true,
            ignoreExisting: true,
          });
          zip.extract(path, new LocalFile(target));
          const targetFile = new LocalFile(target);
          if (targetFile.isSymlink()) {
            throw new Error("Torrent runtime archive contains a symbolic link");
          }
          await IOUtils.setPermissions(
            target,
            bundle.files.get(path)?.executable ? 0o755 : 0o644
          );
        }
      } finally {
        zip.close();
      }
      await IOUtils.writeJSON(
        PathUtils.join(staging, ".extraction-complete"),
        {
          schema: 1,
          archiveSha256: bundle.archiveSha256,
          payloadSha256: bundle.manifest.payloadSha256,
        },
        { tmpPath: PathUtils.join(staging, ".extraction-complete.tmp") }
      );
      if (!(await this.#verifyRuntimeDirectory(staging, bundle))) {
        throw new Error("Torrent runtime failed post-extraction verification");
      }
      await IOUtils.move(staging, destination, { noOverwrite: true });
      return destination;
    } finally {
      await IOUtils.remove(staging, {
        recursive: true,
        ignoreAbsent: true,
      });
      await this.#releaseExtractionLock(lock);
    }
  }

  async #verifyRuntimeDirectory(directory, bundle) {
    try {
      const marker = await IOUtils.readJSON(
        PathUtils.join(directory, ".extraction-complete")
      );
      if (
        marker.schema !== 1 ||
        marker.archiveSha256 !== bundle.archiveSha256 ||
        marker.payloadSha256 !== bundle.manifest.payloadSha256
      ) {
        return false;
      }
      const installedManifest = await IOUtils.readJSON(
        PathUtils.join(directory, RUNTIME_MANIFEST)
      );
      if (
        JSON.stringify(installedManifest) !== JSON.stringify(bundle.manifest)
      ) {
        return false;
      }
      const expected = new Set([
        ...bundle.files.keys(),
        RUNTIME_MANIFEST,
        ".extraction-complete",
      ]);
      const expectedDirectories = new Set();
      for (const path of expected) {
        const parts = path.split("/");
        for (let index = 1; index < parts.length; index++) {
          expectedDirectories.add(parts.slice(0, index).join("/"));
        }
      }
      const pending = [directory];
      const found = new Set();
      const foundDirectories = new Set();
      while (pending.length) {
        for (const child of await IOUtils.getChildren(pending.pop())) {
          const file = new LocalFile(child);
          if (file.isSymlink()) {
            return false;
          }
          const info = await IOUtils.stat(child);
          if (info.type === "directory") {
            const relative = child
              .slice(directory.length + 1)
              .replaceAll("\\", "/");
            if (
              !expectedDirectories.has(relative) ||
              foundDirectories.has(relative)
            ) {
              return false;
            }
            foundDirectories.add(relative);
            pending.push(child);
            continue;
          }
          if (info.type !== "regular") {
            return false;
          }
          const relative = child
            .slice(directory.length + 1)
            .replaceAll("\\", "/");
          if (!expected.has(relative) || found.has(relative)) {
            return false;
          }
          found.add(relative);
        }
      }
      if (
        found.size !== expected.size ||
        foundDirectories.size !== expectedDirectories.size
      ) {
        return false;
      }
      for (const [path, expectedFile] of bundle.files) {
        const target = PathUtils.join(directory, ...path.split("/"));
        const info = await IOUtils.stat(target);
        if (
          info.type !== "regular" ||
          info.size !== expectedFile.size ||
          Boolean(info.permissions & 0o111) !== expectedFile.executable ||
          (await IOUtils.computeHexDigest(target, "sha256")) !==
            expectedFile.sha256
        ) {
          return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  async #acquireExtractionLock(bundleId) {
    const path = PathUtils.join(this.bundleRoot, `.${bundleId}.lock`);
    for (let attempt = 0; attempt < 400; attempt++) {
      const owner = {
        pid: Services.appinfo.processID,
        pidStartTime: parsePidStartTime(
          await IOUtils.readUTF8("/proc/self/stat")
        ),
        nonce: Services.uuid.generateUUID().toString(),
        createdAt: Date.now(),
      };
      const file = new LocalFile(path);
      try {
        file.create(Ci.nsIFile.NORMAL_FILE_TYPE, 0o600);
        await IOUtils.writeJSON(path, owner);
        return { owner, path };
      } catch (error) {
        if (!(await IOUtils.exists(path))) {
          throw error;
        }
      }
      const existing = await IOUtils.readJSON(path).catch(() => null);
      const active = await processMatches(
        existing?.pid,
        existing?.pidStartTime
      );
      if (
        !active &&
        Date.now() - Number(existing?.createdAt || 0) >= RUNTIME_LOCK_STALE_MS
      ) {
        const current = await IOUtils.readJSON(path).catch(() => null);
        if (current?.nonce === existing?.nonce) {
          await IOUtils.remove(path, { ignoreAbsent: true });
        }
        continue;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error("Timed out waiting for torrent runtime extraction");
  }

  async #releaseExtractionLock(lock) {
    const current = await IOUtils.readJSON(lock.path).catch(() => null);
    if (current?.nonce === lock.owner.nonce) {
      await IOUtils.remove(lock.path, { ignoreAbsent: true });
    }
  }

  async #stopServiceUsingRuntime(directory) {
    const connection = await IOUtils.readJSON(this.connectionPath).catch(
      () => null
    );
    if (!connection || connection.runtimeDirectory !== directory) {
      return;
    }
    if (!(await processMatches(connection.pid, connection.pidStartTime))) {
      await this.#removeDeadConnection(connection);
      return;
    }
    if (!(await this.#connectionProcessMatches(connection))) {
      throw new Error(
        "A live unverified process is using the damaged torrent runtime"
      );
    }
    const dataRoot = new LocalFile(this.config.dataDirectory);
    dataRoot.normalize();
    const executable = PathUtils.join(directory, "node", "bin", "node");
    const trusted =
      connection.ownerInstance === this.config.ownerInstance &&
      connection.dataRoot === dataRoot.path &&
      connection.executable === executable &&
      (await IOUtils.computeHexDigest(executable, "sha256").catch(
        () => null
      )) === connection.executableSha256 &&
      /^[0-9a-f]{64}$/.test(connection.token || "") &&
      /^[0-9a-f-]{36}$/.test(connection.instanceId || "");
    const status = trusted
      ? await this.#request("GET", "/v1/status", null, connection).catch(
          () => null
        )
      : null;
    if (!trusted || !this.#statusIdentityMatches(connection, status)) {
      throw new Error(
        "A live unverified process is using the damaged torrent runtime"
      );
    }
    await this.#request("POST", "/v1/shutdown", {}, connection);
    for (let attempt = 0; attempt < 40; attempt++) {
      if (!(await IOUtils.exists(this.connectionPath))) {
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error("The damaged torrent runtime did not shut down");
  }

  async #writeConfig() {
    const existing = await IOUtils.readJSON(this.configPath).catch(() => ({}));
    const downloadDirectory =
      existing.downloadDirectory ||
      (await Downloads.getPreferredDownloadsDirectory());
    const torEnabled = Boolean(existing.torEnabled);
    const ownerInstance = /^[0-9A-Za-z._-]{16,128}$/.test(
      existing.ownerInstance || ""
    )
      ? existing.ownerInstance
      : Services.uuid.generateUUID().toString().replace(/[{}]/g, "");
    let torProxy = null;
    if (torEnabled) {
      TorRouting.init();
      torProxy = {
        host: "127.0.0.1",
        port: await TorRouting.ensureProxy(),
      };
    }
    const config = {
      ...existing,
      version: 1,
      ownerInstance,
      dataDirectory: PathUtils.join(this.rootDirectory, "data"),
      downloadDirectory,
      connectionPath: this.connectionPath,
      maxActive: existing.maxActive ?? 3,
      maxConnections: existing.maxConnections ?? 80,
      utp: existing.utp ?? true,
      natUpnp: existing.natUpnp ?? true,
      natPmp: existing.natPmp ?? true,
      lsd: existing.lsd ?? true,
      torEnabled,
      torProxy,
    };
    await IOUtils.writeJSON(this.configPath, config, {
      tmpPath: `${this.configPath}.tmp`,
    });
    await IOUtils.setPermissions(this.configPath, 0o600);
    this.config = config;
  }

  async #prepareServiceIdentity() {
    await IOUtils.makeDirectory(this.config.dataDirectory, {
      createAncestors: true,
      ignoreExisting: true,
    });
    const runtime = new LocalFile(this.runtimeDirectory);
    runtime.normalize();
    const dataRoot = new LocalFile(this.config.dataDirectory);
    dataRoot.normalize();
    const executable = new LocalFile(
      PathUtils.join(this.runtimeDirectory, "node", "bin", "node")
    );
    executable.normalize();
    if (executable.isSymlink()) {
      throw new Error("Torrent service executable must not be a symbolic link");
    }
    this.expectedServiceIdentity = {
      ownerInstance: this.config.ownerInstance,
      runtimeDirectory: runtime.path,
      executable: executable.path,
      executableSha256: await IOUtils.computeHexDigest(
        executable.path,
        "sha256"
      ),
      dataRoot: dataRoot.path,
    };
  }

  async #run(argumentsList) {
    const executable = PathUtils.join(
      this.runtimeDirectory,
      "bin",
      "wildbuzzard-torrent"
    );
    const process = await Subprocess.call({
      command: executable,
      arguments: argumentsList,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, result] = await Promise.all([
      process.stdout.readString(),
      process.stderr.readString(),
      process.wait(),
    ]);
    if (result.exitCode !== 0) {
      throw new Error(
        stderr.trim() || stdout.trim() || "Torrent service failed"
      );
    }
  }

  #staticIdentityMatches(connection) {
    const expected = this.expectedServiceIdentity;
    return Boolean(
      connection &&
      connection.ownerInstance === expected.ownerInstance &&
      connection.runtimeDirectory === expected.runtimeDirectory &&
      connection.executable === expected.executable &&
      connection.executableSha256 === expected.executableSha256 &&
      connection.dataRoot === expected.dataRoot
    );
  }

  #statusIdentityMatches(connection, status) {
    const identity = status?.serviceIdentity;
    return Boolean(
      identity &&
      identity.ownerInstance === connection.ownerInstance &&
      identity.runtimeDirectory === connection.runtimeDirectory &&
      identity.executable === connection.executable &&
      identity.executableSha256 === connection.executableSha256 &&
      identity.dataRoot === connection.dataRoot &&
      identity.instanceId === connection.instanceId &&
      identity.pid === connection.pid &&
      String(identity.pidStartTime) === String(connection.pidStartTime)
    );
  }

  async #connectionProcessMatches(connection) {
    if (
      !Number.isInteger(connection?.pid) ||
      connection.pid < 1 ||
      !/^\d+$/.test(String(connection.pidStartTime)) ||
      !(await processMatches(connection.pid, connection.pidStartTime))
    ) {
      return false;
    }
    try {
      const executable = new LocalFile(`/proc/${connection.pid}/exe`);
      return executable.target === connection.executable;
    } catch {
      return false;
    }
  }

  async #healthyConnection(connection) {
    if (
      !Number.isInteger(connection.port) ||
      connection.port < 1 ||
      connection.port > 65535 ||
      !/^[0-9a-f]{64}$/.test(connection.token || "") ||
      !/^[0-9a-f-]{36}$/.test(connection.instanceId || "") ||
      connection.ownerInstance !== this.expectedServiceIdentity.ownerInstance ||
      connection.dataRoot !== this.expectedServiceIdentity.dataRoot ||
      !(await this.#connectionProcessMatches(connection))
    ) {
      return null;
    }
    const runtimeRoot = new LocalFile(this.bundleRoot);
    runtimeRoot.normalize();
    if (
      !connection.runtimeDirectory.startsWith(`${runtimeRoot.path}/runtime-`) ||
      connection.executable !==
        PathUtils.join(connection.runtimeDirectory, "node", "bin", "node") ||
      (await IOUtils.computeHexDigest(connection.executable, "sha256").catch(
        () => null
      )) !== connection.executableSha256
    ) {
      return null;
    }
    const status = await this.#request(
      "GET",
      "/v1/status",
      null,
      connection
    ).catch(() => null);
    return this.#statusIdentityMatches(connection, status) ? status : null;
  }

  async #removeDeadConnection(connection) {
    const current = await IOUtils.readJSON(this.connectionPath).catch(
      () => null
    );
    if (
      current &&
      ((connection.instanceId &&
        current.instanceId === connection.instanceId) ||
        (!connection.instanceId &&
          JSON.stringify(current) === JSON.stringify(connection)))
    ) {
      await IOUtils.remove(this.connectionPath, { ignoreAbsent: true });
    }
  }

  async #ensureService() {
    let connection = await IOUtils.readJSON(this.connectionPath).catch(
      () => null
    );
    if (connection) {
      if (await this.#healthyConnection(connection)) {
        if (this.#staticIdentityMatches(connection)) {
          this.connection = connection;
          return;
        }
        await this.#request("POST", "/v1/shutdown", {}, connection);
        for (let attempt = 0; attempt < 40; attempt++) {
          if (!(await IOUtils.exists(this.connectionPath))) {
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (await IOUtils.exists(this.connectionPath)) {
          throw new Error("The previous torrent service did not shut down");
        }
        connection = null;
      }
      if (
        connection &&
        (await processMatches(connection.pid, connection.pidStartTime))
      ) {
        throw new Error(
          "An unverified live process owns the torrent connection path"
        );
      }
      if (connection) {
        await this.#removeDeadConnection(connection);
      }
      connection = null;
    }
    let startError = null;
    try {
      await this.#run(["start", "--config", this.configPath]);
    } catch (error) {
      startError = error;
    }
    for (let attempt = 0; attempt < 40; attempt++) {
      connection = await IOUtils.readJSON(this.connectionPath).catch(
        () => null
      );
      if (connection && (await this.#healthyConnection(connection))) {
        this.connection = connection;
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw startError || new Error("Torrent service did not become ready");
  }

  #request(method, path, body = null, connection = this.connection) {
    return new Promise((resolve, reject) => {
      if (!connection?.port || !connection?.token) {
        reject(new Error("Torrent service connection is unavailable"));
        return;
      }
      const request = new ServiceRequest({ mozAnon: true });
      request.mozBackgroundRequest = true;
      request.open(method, `http://127.0.0.1:${connection.port}${path}`, {
        bypassProxy: true,
      });
      request.responseType = "json";
      request.timeout =
        method === "PATCH" && path === "/v1/settings" ? 30000 : 5000;
      request.setRequestHeader("Authorization", `Bearer ${connection.token}`);
      request.setRequestHeader("Cache-Control", "no-store");
      if (body !== null) {
        request.setRequestHeader("Content-Type", "application/json");
      }
      request.addEventListener("load", () => {
        if (request.status >= 200 && request.status < 300) {
          resolve(request.response);
        } else {
          reject(
            new Error(
              request.response?.error ||
                `Torrent request failed (${request.status})`
            )
          );
        }
      });
      request.addEventListener("error", () =>
        reject(
          Object.assign(new Error("Torrent service request failed"), {
            serviceUnavailable: true,
          })
        )
      );
      request.addEventListener("timeout", () =>
        reject(
          Object.assign(new Error("Torrent service request timed out"), {
            serviceUnavailable: true,
          })
        )
      );
      request.send(body === null ? null : JSON.stringify(body));
    });
  }

  async request(method, path, body = null) {
    await this.initialize();
    try {
      return await this.#request(method, path, body);
    } catch (error) {
      if (!error.serviceUnavailable) {
        throw error;
      }
      this.initializeTask = null;
      await this.initialize();
      return this.#request(method, path, body);
    }
  }

  getStatus() {
    return this.request("GET", "/v1/status");
  }

  createTorrentDraft({ magnet, torrent }) {
    if ((magnet === undefined) === (torrent === undefined)) {
      throw new Error("Supply one magnet or one torrent payload");
    }
    if (magnet !== undefined) {
      if (typeof magnet !== "string" || !magnet.startsWith("magnet:")) {
        throw new Error("A magnet link is required");
      }
      return this.request("POST", "/v1/torrent-drafts", { magnet });
    }
    let payload = torrent;
    if (torrent instanceof Uint8Array) {
      if (!torrent.length || torrent.length > MAX_TORRENT_SIZE) {
        throw new Error("Torrent metadata is invalid or too large");
      }
      payload = encodeBase64(torrent);
    }
    if (typeof payload !== "string" || !payload) {
      throw new Error("Torrent metadata is required");
    }
    return this.request("POST", "/v1/torrent-drafts", { torrent: payload });
  }

  getTorrentDraft(id) {
    return this.request("GET", `/v1/torrent-drafts/${encodeURIComponent(id)}`);
  }

  commitTorrentDraft(id, files) {
    return this.request(
      "POST",
      `/v1/torrent-drafts/${encodeURIComponent(id)}/commit`,
      files === undefined ? {} : { files }
    );
  }

  cancelTorrentDraft(id) {
    return this.request(
      "DELETE",
      `/v1/torrent-drafts/${encodeURIComponent(id)}`
    );
  }

  addMagnet(source, downloadPath) {
    if (!source?.startsWith("magnet:")) {
      throw new Error("A magnet link is required");
    }
    return this.request("POST", "/v1/torrents", { source, downloadPath });
  }

  addTorrentBytes(bytes, downloadPath) {
    if (!(bytes instanceof Uint8Array) || !bytes.length) {
      throw new Error("Torrent metadata is required");
    }
    if (bytes.length > MAX_TORRENT_SIZE) {
      throw new Error("Torrent metadata is too large");
    }
    return this.request("POST", "/v1/torrents", {
      torrent: encodeBase64(bytes),
      downloadPath,
    });
  }

  async addFromURL(source, principal, downloadPath, cookieJarSettings) {
    if (source.startsWith("magnet:")) {
      return this.addMagnet(source, downloadPath);
    }
    if (!/^https?:\/\//i.test(source)) {
      throw new Error("Enter a magnet link or an HTTP(S) torrent URL");
    }
    await this.initialize();
    if (this.config.torEnabled) {
      return this.request("POST", "/v1/torrents", { source, downloadPath });
    }
    return this.addTorrentBytes(
      await requestBytes(
        Services.io.newURI(source),
        principal,
        cookieJarSettings
      ),
      downloadPath
    );
  }

  async createDraftFromURL(source, principal, cookieJarSettings) {
    if (source.startsWith("magnet:")) {
      return this.createTorrentDraft({ magnet: source });
    }
    if (!/^https?:\/\//i.test(source)) {
      throw new Error("Enter a magnet link or an HTTP(S) torrent URL");
    }
    return this.createTorrentDraft({
      torrent: await requestBytes(
        Services.io.newURI(source),
        principal,
        cookieJarSettings
      ),
    });
  }

  action(id, action, detail = {}) {
    return this.request(
      "POST",
      `/v1/torrents/${encodeURIComponent(id)}/action`,
      {
        action,
        ...detail,
      }
    );
  }

  update(id, detail) {
    return this.request(
      "PATCH",
      `/v1/torrents/${encodeURIComponent(id)}`,
      detail
    );
  }

  async updateSettings(settings) {
    const update = { ...settings };
    if (settings.torEnabled !== undefined) {
      update.torEnabled = Boolean(settings.torEnabled);
      if (update.torEnabled) {
        TorRouting.init();
        update.torProxy = {
          host: "127.0.0.1",
          port: await TorRouting.ensureProxy(),
        };
      } else {
        update.torProxy = null;
      }
    }
    const result = await this.request("PATCH", "/v1/settings", update);
    this.config = { ...this.config, ...result };
    if (settings.torEnabled !== undefined) {
      this.config.torProxy = update.torProxy;
    }
    await IOUtils.writeJSON(this.configPath, this.config, {
      tmpPath: `${this.configPath}.tmp`,
    });
    await IOUtils.setPermissions(this.configPath, 0o600);
    return result;
  }

  remove(id, deleteData = false) {
    return this.request(
      "DELETE",
      `/v1/torrents/${encodeURIComponent(id)}?deleteData=${deleteData}`
    );
  }

  async #createTorrentFileDraft(bytes) {
    try {
      return await this.createTorrentDraft({ torrent: bytes });
    } catch (error) {
      if (error.serviceUnavailable) {
        throw error;
      }
      throw torrentFileError("invalid");
    }
  }

  async addTorrentFile(file) {
    validateTorrentFileDescriptor(file?.name, file?.size, file?.type);
    let bytes;
    try {
      bytes = new Uint8Array(
        await file.slice(0, MAX_TORRENT_SIZE).arrayBuffer()
      );
    } catch {
      throw torrentFileError("unreadable");
    }
    if (bytes.length !== file.size) {
      throw torrentFileError("unreadable");
    }
    return this.#createTorrentFileDraft(bytes);
  }

  async chooseTorrentFile(browsingContext, title, filterTitle) {
    const picker = Cc["@mozilla.org/filepicker;1"].createInstance(
      Ci.nsIFilePicker
    );
    picker.init(browsingContext, title, Ci.nsIFilePicker.modeOpen);
    picker.appendFilter(filterTitle, "*.torrent");
    picker.appendRawFilter("application/x-bittorrent");
    const result = await new Promise(resolve => picker.open(resolve));
    if (result !== Ci.nsIFilePicker.returnOK) {
      return null;
    }
    const file = picker.file;
    let stat;
    try {
      stat = await IOUtils.stat(file.path);
    } catch {
      throw torrentFileError("unreadable");
    }
    validateTorrentFileDescriptor(file.leafName, stat.size);
    if (stat.type !== "regular") {
      throw torrentFileError("unreadable");
    }
    let bytes;
    try {
      bytes = await IOUtils.read(file.path, { maxBytes: MAX_TORRENT_SIZE });
    } catch {
      throw torrentFileError("unreadable");
    }
    if (bytes.length !== stat.size) {
      throw torrentFileError("unreadable");
    }
    return this.#createTorrentFileDraft(bytes);
  }

  async chooseDownloadDirectory(browsingContext) {
    const picker = Cc["@mozilla.org/filepicker;1"].createInstance(
      Ci.nsIFilePicker
    );
    picker.init(browsingContext, "", Ci.nsIFilePicker.modeGetFolder);
    picker.displayDirectory = new LocalFile(this.config.downloadDirectory);
    const result = await new Promise(resolve => picker.open(resolve));
    if (result !== Ci.nsIFilePicker.returnOK) {
      return null;
    }
    this.config.downloadDirectory = picker.file.path;
    await IOUtils.writeJSON(this.configPath, this.config, {
      tmpPath: `${this.configPath}.tmp`,
    });
    await this.updateSettings({ downloadDirectory: picker.file.path });
    return picker.file.path;
  }

  reveal(path) {
    const file = new LocalFile(path);
    try {
      file.reveal();
    } catch {
      file.launch();
    }
  }
}

export const TorrentManager = new TorrentManagerImpl();
