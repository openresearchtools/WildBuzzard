/* SPDX-License-Identifier: AGPL-3.0-or-later */

"use strict";

/* global ExtensionAPI, IOUtils, PathUtils, Services, TextDecoder, TextEncoder */

// eslint-disable-next-line mozilla/reject-importGlobalProperties
Cu.importGlobalProperties(["TextDecoder", "TextEncoder"]);

const { Subprocess } = ChromeUtils.importESModule(
  "resource://gre/modules/Subprocess.sys.mjs"
);
const { AppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs"
);
const { setTimeout } = ChromeUtils.importESModule(
  "resource://gre/modules/Timer.sys.mjs"
);
const { ServiceRequest } = ChromeUtils.importESModule(
  "resource://gre/modules/ServiceRequest.sys.mjs"
);
const { NetUtil } = ChromeUtils.importESModule(
  "resource://gre/modules/NetUtil.sys.mjs"
);
const { BrowserControl } = ChromeUtils.importESModule(
  "chrome://remote/content/wildbuzzard/BrowserControl.sys.mjs"
);
const { CryptoUtils } = ChromeUtils.importESModule(
  "moz-src:///services/crypto/modules/utils.sys.mjs"
);
const { setAgentEndpoint } = ChromeUtils.importESModule(
  "resource:///modules/WildBuzzardAgentURL.sys.mjs"
);
const {
  exactSystemdUnit,
  privateDirectory,
  readPrivateJSON,
  writePrivateJSON,
} = ChromeUtils.importESModule(
  "resource:///modules/WildBuzzardAgentState.sys.mjs"
);

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
const ServerSocket = Components.Constructor(
  "@mozilla.org/network/server-socket;1",
  "nsIServerSocket",
  "init"
);

const AGENT_PAGE_URL = "about:agent";
const MIN_AGENT_PORT = 49152;
const MAX_AGENT_PORT = 65535;
const CONFIG_FILE = "config.json";
const STATE_FILE = "state.json";
const CONNECTION_FILE = "browser-control.json";
const SERVICE_IDENTITY_FILE = "service-identity.json";
const RUNTIME_MANIFEST = "wildbuzzard-runtime.json";
const ACTIVE_RUNTIME_FILE = "active-runtime.json";
const MAX_RUNTIME_ARCHIVE_SIZE = 1024 * 1024 * 1024;
const MAX_RUNTIME_FILE_SIZE = 512 * 1024 * 1024;
const MAX_RUNTIME_EXPANDED_SIZE = 2 * 1024 * 1024 * 1024;
const MAX_RUNTIME_ENTRIES = 200000;

/** Marks a service that the manager must not stop or replace. */
class UnauthenticatedServiceError extends Error {}

function hexDigest(bytes) {
  const hash = new CryptoHash("sha256");
  hash.update(bytes, bytes.length);
  return Array.from(hash.finish(false), byte =>
    byte.charCodeAt(0).toString(16).padStart(2, "0")
  ).join("");
}

function bytesToHex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function safeArchivePath(path) {
  const parts = path.split("/");
  return (
    path &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
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
    throw new Error("Pi Web runtime has no ZIP central directory");
  }
  let entries = view.getUint16(end + 10, true);
  let centralSize = view.getUint32(end + 12, true);
  let centralOffset = view.getUint32(end + 16, true);
  if (
    view.getUint16(end + 4, true) !== 0 ||
    view.getUint16(end + 6, true) !== 0
  ) {
    throw new Error("Unsupported Pi Web runtime ZIP layout");
  }
  if (
    entries === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    const locator = end - 20;
    if (locator < 0 || view.getUint32(locator, true) !== 0x07064b50) {
      throw new Error("Invalid Pi Web runtime ZIP64 locator");
    }
    const zip64Offset = Number(view.getBigUint64(locator + 8, true));
    if (
      !Number.isSafeInteger(zip64Offset) ||
      zip64Offset + 56 > locator ||
      view.getUint32(zip64Offset, true) !== 0x06064b50 ||
      view.getUint32(zip64Offset + 16, true) !== 0 ||
      view.getUint32(zip64Offset + 20, true) !== 0
    ) {
      throw new Error("Invalid Pi Web runtime ZIP64 directory");
    }
    entries = Number(view.getBigUint64(zip64Offset + 32, true));
    centralSize = Number(view.getBigUint64(zip64Offset + 40, true));
    centralOffset = Number(view.getBigUint64(zip64Offset + 48, true));
  }
  if (
    !Number.isSafeInteger(entries) ||
    !Number.isSafeInteger(centralSize) ||
    !Number.isSafeInteger(centralOffset) ||
    entries > MAX_RUNTIME_ENTRIES ||
    centralOffset + centralSize > end
  ) {
    throw new Error("Unsupported Pi Web runtime ZIP layout");
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const result = new Map();
  let expandedSize = 0;
  let offset = centralOffset;
  for (let index = 0; index < entries; index++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error("Invalid Pi Web runtime central directory");
    }
    const flags = view.getUint16(offset + 8, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const recordLength = 46 + nameLength + extraLength + commentLength;
    if (flags & 1 || offset + recordLength > end) {
      throw new Error("Unsupported Pi Web runtime entry");
    }
    const name = decoder.decode(
      bytes.subarray(offset + 46, offset + 46 + nameLength)
    );
    if (result.has(name)) {
      throw new Error(`Duplicate path in Pi Web runtime: ${name}`);
    }
    const host = bytes[offset + 5];
    const attributes = view.getUint32(offset + 38, true);
    const realSize = view.getUint32(offset + 24, true);
    const mode = host === 3 ? attributes >>> 16 : 0;
    const kind = mode & 0xf000;
    const directory = name.endsWith("/");
    if (kind && kind !== (directory ? 0x4000 : 0x8000)) {
      throw new Error(`Link or special file in Pi Web runtime: ${name}`);
    }
    expandedSize += realSize;
    if (
      realSize > MAX_RUNTIME_FILE_SIZE ||
      expandedSize > MAX_RUNTIME_EXPANDED_SIZE
    ) {
      throw new Error("Pi Web runtime exceeds extraction limits");
    }
    result.set(name, {
      directory,
      executable: Boolean(mode & 0o111),
      realSize,
    });
    offset += recordLength;
  }
  if (offset !== centralOffset + centralSize) {
    throw new Error("Invalid Pi Web runtime central directory size");
  }
  return result;
}

// eslint-disable-next-line complexity
async function runtimeBundleInfo(archivePath) {
  const archiveInfo = await IOUtils.stat(archivePath);
  if (archiveInfo.size > MAX_RUNTIME_ARCHIVE_SIZE) {
    throw new Error("Pi Web runtime archive is too large");
  }
  const archiveBytes = await IOUtils.read(archivePath);
  const archiveSha256 = hexDigest(archiveBytes);
  const centralEntries = centralDirectoryEntries(archiveBytes);
  const zip = new ZipReader(new LocalFile(archivePath));
  try {
    if (!zip.hasEntry(RUNTIME_MANIFEST)) {
      throw new Error("Pi Web runtime manifest is missing");
    }
    const entry = zip.getEntry(RUNTIME_MANIFEST);
    const stream = zip.getInputStream(RUNTIME_MANIFEST);
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
      manifest.schema !== 4 ||
      manifest.component !== "pi-web" ||
      typeof manifest.version !== "string" ||
      !/^[0-9A-Za-z._+-]+$/.test(manifest.version) ||
      !/^[a-f0-9]{40}$/.test(manifest.piWebCommit) ||
      !/^[a-f0-9]{40}$/.test(manifest.piWebTree) ||
      manifest.piWebRepository !==
        "https://github.com/openresearchtools/pi-web.git" ||
      !/^[a-f0-9]{40}$/.test(manifest.wildbuzzardCommit) ||
      !/^[a-f0-9]{40}$/.test(manifest.wildbuzzardTree) ||
      !/^[a-f0-9]{64}$/.test(manifest.sourceSha256) ||
      !/^[a-f0-9]{64}$/.test(manifest.piWebPackageSha256) ||
      !/^[a-f0-9]{64}$/.test(manifest.dependencyLockSha256) ||
      !/^[a-f0-9]{64}$/.test(manifest.browserToolsSha256) ||
      !/^[a-f0-9]{64}$/.test(manifest.webAccessSha256) ||
      !/^[a-f0-9]{64}$/.test(manifest.browserRunnerSha256) ||
      !/^[a-f0-9]{64}$/.test(manifest.gitRuntimeSha256) ||
      !/^[a-f0-9]{64}$/.test(manifest.ytdlpRuntimeSha256) ||
      !/^[a-f0-9]{64}$/.test(manifest.nodeArchiveSha256) ||
      !/^[a-f0-9]{64}$/.test(manifest.buildScriptSha256) ||
      !/^[a-f0-9]{64}$/.test(manifest.webAccessPackageLockSha256) ||
      !/^[a-f0-9]{64}$/.test(manifest.browserRunnerCargoLockSha256) ||
      typeof manifest.nodeVersion !== "string" ||
      manifest.protocolVersion !== 1 ||
      !safeArchivePath(manifest.correspondingSource) ||
      !safeArchivePath(manifest.sbom) ||
      !safeArchivePath(manifest.spdxSbom) ||
      !safeArchivePath(manifest.runtimeDependencyInventory) ||
      !safeArchivePath(manifest.buildInputs) ||
      manifest.platform !== "linux-x64" ||
      !Array.isArray(manifest.licenseLocations) ||
      !manifest.files ||
      Array.isArray(manifest.files) ||
      typeof manifest.files !== "object" ||
      !Array.isArray(manifest.executableAllowlist)
    ) {
      throw new Error("Invalid Pi Web runtime manifest");
    }
    const files = new Map(Object.entries(manifest.files));
    const executableAllowlist = new Set(manifest.executableAllowlist);
    if (
      files.size !== Object.keys(manifest.files).length ||
      executableAllowlist.size !== manifest.executableAllowlist.length ||
      !files.has(manifest.correspondingSource) ||
      files.get(manifest.correspondingSource) !== manifest.sourceSha256 ||
      !files.has(manifest.sbom) ||
      !files.has(manifest.spdxSbom) ||
      !files.has(manifest.runtimeDependencyInventory) ||
      !files.has(manifest.buildInputs) ||
      manifest.licenseLocations.some(path => !files.has(path)) ||
      [...files].some(
        ([path, digest]) =>
          !safeArchivePath(path) || !/^[a-f0-9]{64}$/.test(digest)
      ) ||
      [...executableAllowlist].some(path => !files.has(path))
    ) {
      throw new Error("Invalid Pi Web runtime manifest");
    }
    const actualFiles = new Set(
      [...centralEntries]
        .filter(([, metadata]) => !metadata.directory)
        .map(([path]) => path)
    );
    const expectedFiles = new Set([...files.keys(), RUNTIME_MANIFEST]);
    if (
      actualFiles.size !== expectedFiles.size ||
      [...actualFiles].some(path => !expectedFiles.has(path)) ||
      [...centralEntries].some(([path, metadata]) => {
        const normalized = metadata.directory ? path.slice(0, -1) : path;
        return (
          !safeArchivePath(normalized) ||
          (!metadata.directory &&
            path !== RUNTIME_MANIFEST &&
            metadata.executable !== executableAllowlist.has(path)) ||
          (path === RUNTIME_MANIFEST && metadata.executable)
        );
      })
    ) {
      throw new Error("Pi Web runtime file inventory mismatch");
    }
    return {
      archiveSha256,
      bundleId: `4-${manifest.piWebCommit}-${archiveSha256}`,
      centralEntries,
      executableAllowlist,
      files,
      manifest,
    };
  } finally {
    zip.close();
  }
}

async function readAll(pipe) {
  const chunks = [];
  for (let chunk; (chunk = await pipe.readString()); ) {
    chunks.push(chunk);
  }
  return chunks.join("");
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function requestJSON(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = new ServiceRequest({ mozAnon: true });
    request.mozBackgroundRequest = true;
    request.open("GET", url, { bypassProxy: true });
    request.responseType = "json";
    request.timeout = 1000;
    request.setRequestHeader("Cache-Control", "no-store");
    for (const [name, value] of Object.entries(headers)) {
      request.setRequestHeader(name, value);
    }
    request.addEventListener("load", () => {
      resolve({
        body: request.response,
        ok: request.status >= 200 && request.status < 300,
        status: request.status,
      });
    });
    request.addEventListener("error", () => {
      reject(new Error(`Pi Web health check failed (${request.status})`));
    });
    request.addEventListener("timeout", () => {
      reject(new Error("Pi Web health check timed out"));
    });
    request.send();
  });
}

/** Owns the browser-side bootstrap for persistent Pi Web services. */
class PiWebManager {
  constructor() {
    const homeDirectory = Services.dirsvc.get("Home", Ci.nsIFile).path;
    const dataHome =
      Services.env.get("XDG_DATA_HOME") ||
      PathUtils.join(homeDirectory, ".local", "share");
    const configHome =
      Services.env.get("XDG_CONFIG_HOME") ||
      PathUtils.join(homeDirectory, ".config");
    const runtimeHome =
      Services.env.get("XDG_RUNTIME_DIR") ||
      PathUtils.join(dataHome, "wildbuzzard", "agent", "run");
    this.rootDirectory = PathUtils.join(dataHome, "wildbuzzard", "agent");
    this.bundleRoot = PathUtils.join(this.rootDirectory, "runtime");
    this.archiveRoot = PathUtils.join(this.bundleRoot, "archives");
    this.activeRuntimePath = PathUtils.join(
      this.bundleRoot,
      ACTIVE_RUNTIME_FILE
    );
    this.piDirectory = PathUtils.join(this.rootDirectory, "profile");
    this.configPath = PathUtils.join(
      configHome,
      "wildbuzzard",
      "agent",
      CONFIG_FILE
    );
    this.statePath = PathUtils.join(this.rootDirectory, STATE_FILE);
    this.identityPath = PathUtils.join(
      this.rootDirectory,
      SERVICE_IDENTITY_FILE
    );
    this.connectionPath = PathUtils.join(
      runtimeHome,
      "wildbuzzard-agent",
      CONNECTION_FILE
    );
  }

  async initialize() {
    if (this.initializeTask) {
      return this.initializeTask;
    }
    this.initializeTask = this.#initialize().catch(async error => {
      this.initializeTask = null;
      await this.#stopBrowserControl();
      throw error;
    });
    return this.initializeTask;
  }

  async #initialize() {
    if (AppConstants.platform !== "linux") {
      throw new Error("The bundled Pi Web runtime currently supports Linux");
    }
    for (const path of [
      this.rootDirectory,
      this.bundleRoot,
      this.archiveRoot,
      this.piDirectory,
      PathUtils.parent(this.configPath),
      PathUtils.parent(this.connectionPath),
    ]) {
      await privateDirectory(path);
    }
    await this.#publishBrowserControl();
    const previousRuntime = await this.#readActiveRuntime();
    const runtime = await this.#extractRuntime();
    this.runtimeDirectory = runtime.directory;
    this.runtime = runtime;
    this.upgradeRuntime = null;
    try {
      await this.#installAgentExtensions();
      await this.#prepareServiceIdentity(runtime);
      this.agentPort = await this.#selectPort(previousRuntime);
      let lastError;
      const rejectedPorts = new Set();
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          await this.#writeConfig();
          await this.#ensureServices();
          await this.#waitUntilReady();
          lastError = null;
          break;
        } catch (error) {
          if (error instanceof UnauthenticatedServiceError) {
            throw error;
          }
          lastError = error;
          rejectedPorts.add(this.agentPort);
          this.agentPort = await this.#allocatePort(rejectedPorts);
        }
      }
      if (lastError) {
        throw lastError;
      }
      setAgentEndpoint(this.#agentURL());
      await this.#activateRuntime(runtime);
      return { ...(await this.refreshStatus()), ready: true };
    } catch (error) {
      if (
        previousRuntime &&
        previousRuntime.directory !== this.runtimeDirectory
      ) {
        await this.#rollbackRuntime(previousRuntime).catch(rollbackError =>
          console.error("Pi Web runtime rollback failed", rollbackError)
        );
      }
      throw error;
    }
  }

  #archivePath() {
    const configured =
      Services.prefs.getStringPref("wildbuzzard.agent.piWeb.runtime", "") ||
      Services.env.get("WILDBUZZARD_PI_WEB_RUNTIME");
    if (configured) {
      return configured;
    }
    const applicationDirectory = Services.dirsvc.get("GreD", Ci.nsIFile).path;
    return PathUtils.join(
      applicationDirectory,
      "runtime",
      "pi-web",
      "wildbuzzard-pi-web-runtime.zip"
    );
  }

  async #retainArchive(archivePath, bundle) {
    const retained = PathUtils.join(
      this.archiveRoot,
      `${bundle.archiveSha256}.zip`
    );
    if (await IOUtils.exists(retained)) {
      const retainedFile = new LocalFile(retained);
      if (
        !retainedFile.isFile() ||
        retainedFile.isSymlink() ||
        (retainedFile.permissions & 0o777) !== 0o600
      ) {
        throw new Error("Unsafe retained Pi Web runtime archive");
      }
      const retainedBundle = await runtimeBundleInfo(retained);
      if (retainedBundle.archiveSha256 !== bundle.archiveSha256) {
        throw new Error("Retained Pi Web runtime digest mismatch");
      }
      return { path: retained, bundle: retainedBundle };
    }
    const temporary = `${retained}.new-${Services.appinfo.processID}-${bytesToHex(
      CryptoUtils.generateRandomBytes(24)
    )}`;
    await IOUtils.copy(archivePath, temporary, { noOverwrite: true });
    await IOUtils.setPermissions(temporary, 0o600);
    try {
      const retainedBundle = await runtimeBundleInfo(temporary);
      if (retainedBundle.archiveSha256 !== bundle.archiveSha256) {
        throw new Error("Pi Web runtime changed while it was retained");
      }
      await IOUtils.move(temporary, retained, { noOverwrite: true });
      const retainedFile = new LocalFile(retained);
      if (
        !retainedFile.isFile() ||
        retainedFile.isSymlink() ||
        (retainedFile.permissions & 0o777) !== 0o600
      ) {
        throw new Error("Unsafe retained Pi Web runtime archive");
      }
      return { path: retained, bundle: retainedBundle };
    } finally {
      await IOUtils.remove(temporary, { ignoreAbsent: true });
    }
  }

  async #extractRuntime() {
    const archivePath = this.#archivePath();
    if (!(await IOUtils.exists(archivePath))) {
      throw new Error(
        "The bundled Pi Web runtime was not found. Build with --pi-web-runtime."
      );
    }
    const sourceBundle = await runtimeBundleInfo(archivePath);
    const retained = await this.#retainArchive(archivePath, sourceBundle);
    const { bundle } = retained;
    const { bundleId } = bundle;
    const destination = PathUtils.join(this.bundleRoot, bundleId);
    const marker = PathUtils.join(destination, ".extraction-complete");
    if (await IOUtils.exists(marker)) {
      if (await this.#validateExtractedRuntime(destination, bundle)) {
        return {
          archivePath: retained.path,
          archiveSha256: bundle.archiveSha256,
          bundle,
          bundleId,
          directory: destination,
        };
      }
      await IOUtils.remove(destination, { recursive: true });
    }

    if (await IOUtils.exists(destination)) {
      throw new Error("Incomplete immutable Pi Web runtime exists");
    }
    const staging = PathUtils.join(
      this.bundleRoot,
      `.staging-${bundleId}-${Services.appinfo.processID}-${Date.now()}`
    );
    await IOUtils.makeDirectory(staging, {
      createAncestors: true,
      ignoreExisting: false,
    });
    await IOUtils.setPermissions(staging, 0o700);
    const zip = new ZipReader(new LocalFile(retained.path));
    try {
      for (const [entry, metadata] of bundle.centralEntries) {
        const isDirectory = metadata.directory;
        const path = isDirectory ? entry.slice(0, -1) : entry;
        const parts = path.split("/");
        const targetPath = PathUtils.join(staging, ...parts);
        if (isDirectory) {
          await IOUtils.makeDirectory(targetPath, {
            createAncestors: true,
            ignoreExisting: true,
          });
          await IOUtils.setPermissions(targetPath, 0o755);
          continue;
        }
        await IOUtils.makeDirectory(PathUtils.parent(targetPath), {
          createAncestors: true,
          ignoreExisting: true,
        });
        const zipEntry = zip.getEntry(entry);
        if (zipEntry.realSize !== metadata.realSize) {
          throw new Error(`Size mismatch in Pi Web runtime: ${entry}`);
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
        if (
          entry !== RUNTIME_MANIFEST &&
          hexDigest(bytes) !== bundle.files.get(entry)
        ) {
          throw new Error(`Digest mismatch in Pi Web runtime: ${entry}`);
        }
        await IOUtils.write(targetPath, bytes);
        await IOUtils.setPermissions(
          targetPath,
          bundle.executableAllowlist.has(entry) ? 0o755 : 0o644
        );
      }
    } catch (error) {
      await IOUtils.remove(staging, {
        recursive: true,
        ignoreAbsent: true,
      });
      throw error;
    } finally {
      zip.close();
    }
    const pendingDirectories = [staging];
    while (pendingDirectories.length) {
      for (const child of await IOUtils.getChildren(pendingDirectories.pop())) {
        const info = await IOUtils.stat(child);
        if (info.type === "directory") {
          await IOUtils.setPermissions(child, 0o755);
          pendingDirectories.push(child);
        }
      }
    }
    const stagingMarker = PathUtils.join(staging, ".extraction-complete");
    await IOUtils.writeJSON(
      stagingMarker,
      { schema: 1, bundleId, archiveSha256: bundle.archiveSha256 },
      { tmpPath: `${stagingMarker}.tmp` }
    );
    await IOUtils.setPermissions(stagingMarker, 0o600);
    if (!(await this.#validateExtractedRuntime(staging, bundle))) {
      await IOUtils.remove(staging, { recursive: true });
      throw new Error("Pi Web runtime failed post-extraction verification");
    }
    try {
      await IOUtils.move(staging, destination, { noOverwrite: true });
    } catch (error) {
      await IOUtils.remove(staging, { recursive: true, ignoreAbsent: true });
      throw error;
    }
    return {
      archivePath: retained.path,
      archiveSha256: bundle.archiveSha256,
      bundle,
      bundleId,
      directory: destination,
    };
  }

  async #validateExtractedRuntime(directory, bundle) {
    try {
      const root = new LocalFile(directory);
      if (!root.isDirectory() || root.isSymlink()) {
        return false;
      }
      if ((root.permissions & 0o777) !== 0o700) {
        return false;
      }
      const marker = await readPrivateJSON(
        PathUtils.join(directory, ".extraction-complete")
      );
      if (
        marker?.schema !== 1 ||
        marker.bundleId !== bundle.bundleId ||
        marker.archiveSha256 !== bundle.archiveSha256
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
      const expectedFiles = new Set([
        ...bundle.files.keys(),
        RUNTIME_MANIFEST,
        ".extraction-complete",
      ]);
      const expectedDirectories = new Set();
      for (const path of expectedFiles) {
        const parts = path.split("/");
        for (let index = 1; index < parts.length; index++) {
          expectedDirectories.add(parts.slice(0, index).join("/"));
        }
      }
      const pending = [directory];
      const foundFiles = new Set();
      const foundDirectories = new Set();
      while (pending.length) {
        for (const child of await IOUtils.getChildren(pending.pop())) {
          const file = new LocalFile(child);
          if (file.isSymlink()) {
            return false;
          }
          const info = await IOUtils.stat(child);
          const relative = child
            .slice(directory.length + 1)
            .replaceAll("\\", "/");
          if (info.type === "directory") {
            if (
              !expectedDirectories.has(relative) ||
              foundDirectories.has(relative) ||
              (info.permissions & 0o777) !== 0o755
            ) {
              return false;
            }
            foundDirectories.add(relative);
            pending.push(child);
          } else if (
            info.type !== "regular" ||
            !expectedFiles.has(relative) ||
            foundFiles.has(relative)
          ) {
            return false;
          } else {
            foundFiles.add(relative);
          }
        }
      }
      if (
        foundFiles.size !== expectedFiles.size ||
        foundDirectories.size !== expectedDirectories.size
      ) {
        return false;
      }
      for (const [path, expectedDigest] of bundle.files) {
        const target = PathUtils.join(directory, ...path.split("/"));
        const info = await IOUtils.stat(target);
        const expectedMode = bundle.executableAllowlist.has(path)
          ? 0o755
          : 0o644;
        if (
          info.type !== "regular" ||
          info.size !== bundle.centralEntries.get(path).realSize ||
          (info.permissions & 0o777) !== expectedMode ||
          (await IOUtils.computeHexDigest(target, "sha256")) !== expectedDigest
        ) {
          return false;
        }
      }
      const manifestInfo = await IOUtils.stat(
        PathUtils.join(directory, RUNTIME_MANIFEST)
      );
      const markerInfo = await IOUtils.stat(
        PathUtils.join(directory, ".extraction-complete")
      );
      return (
        (manifestInfo.permissions & 0o777) === 0o644 &&
        (markerInfo.permissions & 0o777) === 0o600
      );
    } catch {
      return false;
    }
  }

  async #readActiveRuntime() {
    const active = await readPrivateJSON(this.activeRuntimePath);
    if (
      !active ||
      !/^[0-9A-Za-z._-]+$/.test(active.bundleId) ||
      active.directory !== PathUtils.join(this.bundleRoot, active.bundleId) ||
      active.archivePath !==
        PathUtils.join(this.archiveRoot, `${active.archiveSha256}.zip`) ||
      !/^[a-f0-9]{64}$/.test(active.archiveSha256)
    ) {
      return null;
    }
    const archiveFile = new LocalFile(active.archivePath);
    if (
      !archiveFile.isFile() ||
      archiveFile.isSymlink() ||
      (archiveFile.permissions & 0o777) !== 0o600
    ) {
      return null;
    }
    const bundle = await runtimeBundleInfo(active.archivePath).catch(
      () => null
    );
    if (
      !bundle ||
      bundle.bundleId !== active.bundleId ||
      bundle.archiveSha256 !== active.archiveSha256 ||
      !(await this.#validateExtractedRuntime(active.directory, bundle))
    ) {
      return null;
    }
    return { ...active, bundle };
  }

  async #activateRuntime(runtime) {
    await writePrivateJSON(this.activeRuntimePath, {
      bundleId: runtime.bundleId,
      directory: runtime.directory,
      archivePath: runtime.archivePath,
      archiveSha256: runtime.archiveSha256,
      activatedAt: Date.now(),
    });
  }

  async #rollbackRuntime(previousRuntime) {
    const failedRuntime = this.runtime;
    this.runtimeDirectory = previousRuntime.directory;
    this.runtime = previousRuntime;
    this.upgradeRuntime = failedRuntime;
    await this.#prepareServiceIdentity(previousRuntime);
    await this.#installAgentExtensions();
    await this.#writeConfig();
    await this.#ensureServices();
    await this.#waitUntilReady();
    await this.#activateRuntime(previousRuntime);
  }

  async #installAgentExtensions() {
    const extensionsDirectory = PathUtils.join(this.piDirectory, "extensions");
    await IOUtils.makeDirectory(extensionsDirectory, {
      createAncestors: true,
      ignoreExisting: true,
    });
    for (const name of ["browser-tools", "web-access"]) {
      const source = PathUtils.join(this.runtimeDirectory, "seed", name);
      const destination = PathUtils.join(extensionsDirectory, name);
      await IOUtils.remove(destination, {
        recursive: true,
        ignoreAbsent: true,
      });
      await IOUtils.copy(source, destination, { recursive: true });
    }
    await IOUtils.setPermissions(
      PathUtils.join(
        extensionsDirectory,
        "browser-tools",
        "wildbuzzard-browser-runner"
      ),
      0o755
    );
  }

  async #writeConfig() {
    const stored = await readPrivateJSON(this.configPath);
    let config =
      stored && typeof stored === "object" && !Array.isArray(stored)
        ? stored
        : {};
    config = {
      ...config,
      host: "127.0.0.1",
      port: this.agentPort,
      agent: {
        ...(config.agent ?? {}),
        command: PathUtils.join(this.runtimeDirectory, "bin", "pi"),
        dir: this.piDirectory,
      },
    };
    await writePrivateJSON(this.configPath, config);
  }

  async #prepareServiceIdentity(runtime) {
    this.identitySecret = CryptoUtils.generateRandomBytes(32);
    this.identityId = hexDigest(this.identitySecret);
    await writePrivateJSON(this.identityPath, {
      schema: 1,
      secret: bytesToHex(this.identitySecret),
      runtimeIdentity: runtime.bundleId,
    });
  }

  async #publishBrowserControl() {
    const connection = BrowserControl.start();
    await writePrivateJSON(this.connectionPath, {
      version: 1,
      port: connection.port,
      token: connection.token,
      browserPid: Services.appinfo.processID,
      updatedAt: Date.now(),
    });
  }

  async #runCli(argumentsList, environment = {}) {
    const executable = PathUtils.join(this.runtimeDirectory, "bin", "pi-web");
    const process = await Subprocess.call({
      command: executable,
      arguments: argumentsList,
      stdout: "pipe",
      stderr: "pipe",
      environmentAppend: true,
      environment: {
        PI_WEB_DATA_DIR: this.rootDirectory,
        PI_CODING_AGENT_DIR: this.piDirectory,
        WILDBUZZARD_AGENT_LOCAL_ONLY: "1",
        WILDBUZZARD_PI_WEB_IDENTITY_FILE: this.identityPath,
        WILDBUZZARD_BROWSER_CONTROL_FILE: this.connectionPath,
        WILDBUZZARD_BUNDLED_GIT: PathUtils.join(
          this.runtimeDirectory,
          "tools",
          "git",
          "bin",
          "git"
        ),
        WILDBUZZARD_BUNDLED_NODE: PathUtils.join(
          this.runtimeDirectory,
          "node",
          "bin",
          "node"
        ),
        WILDBUZZARD_YTDLP: PathUtils.join(
          this.runtimeDirectory,
          "tools",
          "yt-dlp",
          "bin",
          "yt-dlp"
        ),
        ...environment,
      },
    });
    const [stdout, stderr, result] = await Promise.all([
      readAll(process.stdout),
      readAll(process.stderr),
      process.wait(),
    ]);
    return { exitCode: result.exitCode, stdout, stderr };
  }

  #serviceEnvironment(runtimeDirectory = this.runtimeDirectory) {
    const environment = {
      PI_WEB_CONFIG: this.configPath,
      PI_WEB_DATA_DIR: this.rootDirectory,
      PI_CODING_AGENT_DIR: this.piDirectory,
      WILDBUZZARD_AGENT_LOCAL_ONLY: "1",
      WILDBUZZARD_BROWSER_CONTROL_FILE: this.connectionPath,
      WILDBUZZARD_PI_WEB_IDENTITY_FILE: this.identityPath,
      WILDBUZZARD_BUNDLED_GIT: PathUtils.join(
        runtimeDirectory,
        "tools",
        "git",
        "bin",
        "git"
      ),
      WILDBUZZARD_BUNDLED_NODE: PathUtils.join(
        runtimeDirectory,
        "node",
        "bin",
        "node"
      ),
    };
    for (const name of [
      "WILDBUZZARD_YTDLP",
      "WILDBUZZARD_CAPTION_FALLBACK_LANGUAGES",
    ]) {
      const value =
        name === "WILDBUZZARD_YTDLP"
          ? PathUtils.join(runtimeDirectory, "tools", "yt-dlp", "bin", "yt-dlp")
          : Services.env.get(name);
      if (value) {
        environment[name] = value;
      }
    }
    return environment;
  }

  async #serviceMatchesRuntime(runtimeDirectory = this.runtimeDirectory) {
    const homeDirectory = Services.dirsvc.get("Home", Ci.nsIFile).path;
    const serviceDirectory = PathUtils.join(
      homeDirectory,
      ".config",
      "systemd",
      "user"
    );
    const services = [
      ["wildbuzzard-agent-web.service", "pi-web-server", true],
      ["wildbuzzard-agent-sessiond.service", "pi-web-sessiond", false],
    ];
    const environment = this.#serviceEnvironment(runtimeDirectory);
    for (const [serviceName, executableName, web] of services) {
      const servicePath = PathUtils.join(serviceDirectory, serviceName);
      if (!(await IOUtils.exists(servicePath))) {
        return false;
      }
      const serviceFile = new LocalFile(servicePath);
      if (!serviceFile.isFile() || serviceFile.isSymlink()) {
        return false;
      }
      const definition = await IOUtils.readUTF8(servicePath);
      if (
        !exactSystemdUnit(definition, {
          environment,
          executable: PathUtils.join(runtimeDirectory, "bin", executableName),
          web,
        })
      ) {
        return false;
      }
    }
    return true;
  }

  #agentURL(port = this.agentPort) {
    return `http://127.0.0.1:${port}/`;
  }

  #portAvailable(port) {
    try {
      const socket = new ServerSocket(port, true, -1);
      socket.close();
      return true;
    } catch {
      return false;
    }
  }

  async #allocatePort(excluded = new Set()) {
    const count = MAX_AGENT_PORT - MIN_AGENT_PORT + 1;
    const random = CryptoUtils.generateRandomBytes(2);
    const start = ((random[0] << 8) | random[1]) % count;
    for (let offset = 0; offset < count; offset++) {
      const port = MIN_AGENT_PORT + ((start + offset) % count);
      if (!excluded.has(port) && this.#portAvailable(port)) {
        return port;
      }
    }
    throw new Error("No free high loopback port is available for Pi Web");
  }

  async #processMatchesRuntime(
    pid,
    entrypoint,
    runtimeDirectory = this.runtimeDirectory
  ) {
    if (!Number.isInteger(pid) || pid < 2) {
      return false;
    }
    try {
      const commandLine = (await IOUtils.readUTF8(`/proc/${pid}/cmdline`))
        .split("\0")
        .filter(Boolean);
      const node = PathUtils.join(runtimeDirectory, "node", "bin", "node");
      const script = PathUtils.join(
        runtimeDirectory,
        "node_modules",
        "@jmfederico",
        "pi-web",
        "dist",
        "server",
        entrypoint
      );
      const executable = new LocalFile(`/proc/${pid}/exe`);
      executable.normalize();
      const commandExecutable = new LocalFile(commandLine[0]);
      commandExecutable.normalize();
      const commandScript = new LocalFile(commandLine[1]);
      commandScript.normalize();
      return (
        executable.path === node &&
        commandLine.length === 2 &&
        commandExecutable.path === node &&
        commandScript.path === script
      );
    } catch {
      return false;
    }
  }

  // eslint-disable-next-line complexity
  async #managedServiceOwnsPort(
    port,
    runtimeDirectory = this.runtimeDirectory,
    runtimeIdentity = this.runtime.bundleId
  ) {
    if (!Number.isInteger(port)) {
      return false;
    }
    const result = await this.#runCli(["status"]);
    const status = this.#parseStatus(result);
    const config = await readPrivateJSON(this.configPath);
    if (
      !status.running ||
      config?.host !== "127.0.0.1" ||
      config?.port !== port ||
      !(await this.#processMatchesRuntime(
        status.processes.web,
        "index.js",
        runtimeDirectory
      )) ||
      !(await this.#processMatchesRuntime(
        status.processes.sessiond,
        "sessiond.js",
        runtimeDirectory
      ))
    ) {
      return false;
    }
    try {
      const challengeBytes = CryptoUtils.generateRandomBytes(32);
      const challenge = bytesToHex(challengeBytes);
      const response = await requestJSON(
        `${this.#agentURL(port)}api/machines/local/health`,
        { "X-WildBuzzard-Agent-Challenge": challenge }
      );
      const identity = response.body?.serviceIdentity;
      if (
        !response.ok ||
        response.body?.ok !== true ||
        !identity ||
        Object.keys(identity).sort().join("\0") !==
          [
            "configPath",
            "dataRoot",
            "executablePath",
            "host",
            "identityId",
            "pid",
            "port",
            "proof",
            "runtimeIdentity",
            "schema",
          ]
            .sort()
            .join("\0") ||
        identity.schema !== 1 ||
        !/^[a-f0-9]{64}$/.test(identity.identityId) ||
        !Number.isInteger(identity.pid) ||
        typeof identity.executablePath !== "string" ||
        typeof identity.configPath !== "string" ||
        typeof identity.dataRoot !== "string" ||
        typeof identity.host !== "string" ||
        !Number.isInteger(identity.port) ||
        typeof identity.runtimeIdentity !== "string" ||
        !/^[a-f0-9]{64}$/.test(identity.proof)
      ) {
        return false;
      }
      const fields = {
        schema: identity.schema,
        identityId: identity.identityId,
        pid: identity.pid,
        executablePath: identity.executablePath,
        configPath: identity.configPath,
        dataRoot: identity.dataRoot,
        host: identity.host,
        port: identity.port,
        runtimeIdentity: identity.runtimeIdentity,
      };
      const payload = new TextEncoder().encode(
        JSON.stringify([
          fields.schema,
          challenge,
          fields.identityId,
          fields.pid,
          fields.executablePath,
          fields.configPath,
          fields.dataRoot,
          fields.host,
          fields.port,
          fields.runtimeIdentity,
        ])
      );
      const proof = await CryptoUtils.hmac(
        "SHA-256",
        this.identitySecret,
        payload
      );
      if (bytesToHex(proof) !== identity.proof) {
        return false;
      }
      return (
        identity.identityId === this.identityId &&
        identity.pid === status.processes.web &&
        identity.executablePath ===
          PathUtils.join(runtimeDirectory, "node", "bin", "node") &&
        identity.configPath === this.configPath &&
        identity.dataRoot === this.rootDirectory &&
        identity.host === "127.0.0.1" &&
        identity.port === port &&
        identity.runtimeIdentity === runtimeIdentity
      );
    } catch {
      return false;
    }
  }

  async #selectPort(previousRuntime) {
    const previous = await readPrivateJSON(this.statePath);
    const port = previous?.port;
    if (
      Number.isInteger(port) &&
      port >= MIN_AGENT_PORT &&
      port <= MAX_AGENT_PORT
    ) {
      if (await this.#managedServiceOwnsPort(port)) {
        return port;
      }
      if (
        previousRuntime &&
        (await this.#serviceMatchesRuntime(previousRuntime.directory)) &&
        (await this.#managedServiceOwnsPort(
          port,
          previousRuntime.directory,
          this.runtime.bundleId
        ))
      ) {
        this.upgradeRuntime = previousRuntime;
        return port;
      }
      if (this.#portAvailable(port)) {
        return port;
      }
      throw new UnauthenticatedServiceError(
        "The saved Pi Web port is occupied by an unauthenticated process"
      );
    }
    return this.#allocatePort();
  }

  async #ensureServices() {
    if (await this.#serviceMatchesRuntime()) {
      if (await this.#managedServiceOwnsPort(this.agentPort)) {
        this.upgradeRuntime = null;
        return;
      }
      if (!this.#portAvailable(this.agentPort)) {
        throw new UnauthenticatedServiceError(
          "Pi Web service identity failed; refusing to stop the process on the selected port"
        );
      }
      const restart = await this.#runCli(["restart"]);
      if (restart.exitCode !== 0) {
        throw new Error(restart.stderr.trim() || restart.stdout.trim());
      }
      this.upgradeRuntime = null;
      return;
    }

    const authenticatedUpgrade =
      this.upgradeRuntime &&
      (await this.#serviceMatchesRuntime(this.upgradeRuntime.directory)) &&
      (await this.#managedServiceOwnsPort(
        this.agentPort,
        this.upgradeRuntime.directory,
        this.runtime.bundleId
      ));
    if (!authenticatedUpgrade && !this.#portAvailable(this.agentPort)) {
      throw new UnauthenticatedServiceError(
        "The selected Pi Web port is occupied by an unauthenticated process"
      );
    }

    const server = shellQuote(
      PathUtils.join(this.runtimeDirectory, "bin", "pi-web-server")
    );
    const sessiond = shellQuote(
      PathUtils.join(this.runtimeDirectory, "bin", "pi-web-sessiond")
    );
    const install = await this.#runCli(
      [
        "install",
        "--host",
        "127.0.0.1",
        "--port",
        String(this.agentPort),
        "--config",
        this.configPath,
      ],
      {
        PI_WEB_SERVER_EXEC: server,
        PI_WEB_SESSIOND_EXEC: sessiond,
      }
    );
    if (install.exitCode !== 0) {
      await new Promise(resolve => setTimeout(resolve, 500));
      const status = await this.#runCli(["status"]);
      if (status.exitCode !== 0) {
        throw new Error(install.stderr.trim() || install.stdout.trim());
      }
    }
    if (!(await this.#serviceMatchesRuntime())) {
      throw new Error("Pi Web service activation did not select the runtime");
    }
    this.upgradeRuntime = null;
  }

  async #waitUntilReady() {
    let lastError = "Pi Web did not become ready";
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const response = await requestJSON(
          `${this.#agentURL()}api/machines/local/health`
        );
        if (
          response.ok &&
          response.body?.ok === true &&
          (await this.#managedServiceOwnsPort(this.agentPort))
        ) {
          return;
        }
        lastError = `Pi Web health check returned ${response.status}`;
      } catch (error) {
        lastError = error.message;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(lastError);
  }

  #parseStatus(result) {
    const processes = {};
    for (const line of result.stdout.split("\n")) {
      const match =
        /^(?:✓|\u2713) (session daemon|web server):.*?, pid (\d+)\)/u.exec(
          line
        );
      if (match) {
        processes[match[1] === "web server" ? "web" : "sessiond"] = Number(
          match[2]
        );
      }
    }
    return {
      url: this.#agentURL(),
      pageUrl: AGENT_PAGE_URL,
      port: this.agentPort,
      running: result.exitCode === 0,
      processes,
      runtimeDirectory: this.runtimeDirectory,
      configPath: this.configPath,
      detail: (result.stdout || result.stderr).trim(),
      checkedAt: Date.now(),
    };
  }

  async refreshStatus() {
    if (!this.runtimeDirectory) {
      return this.initialize();
    }
    const status = this.#parseStatus(await this.#runCli(["status"]));
    status.running = await this.#managedServiceOwnsPort(this.agentPort);
    if (!status.running) {
      status.detail = "Pi Web service identity verification failed";
    }
    await writePrivateJSON(this.statePath, status);
    return status;
  }

  async restart() {
    await this.initialize();
    const result = await this.#runCli(["restart"]);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim());
    }
    await this.#waitUntilReady();
    return this.refreshStatus();
  }

  shutdown() {
    this.#stopBrowserControl();
  }

  async #stopBrowserControl() {
    setAgentEndpoint(null);
    BrowserControl.stop();
    await IOUtils.remove(this.connectionPath, { ignoreAbsent: true }).catch(
      () => {}
    );
  }
}

const manager = new PiWebManager();

this.wildbuzzardAgent = class extends ExtensionAPI {
  getAPI() {
    return {
      wildbuzzardAgent: {
        initialize() {
          return manager.initialize();
        },
        getStatus() {
          return manager.refreshStatus();
        },
        restart() {
          return manager.restart();
        },
      },
    };
  }

  onShutdown() {
    manager.shutdown();
  }
};
