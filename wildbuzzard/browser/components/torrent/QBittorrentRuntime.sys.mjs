/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { Downloads } from "resource://gre/modules/Downloads.sys.mjs";
import { NetUtil } from "resource://gre/modules/NetUtil.sys.mjs";
import { Subprocess } from "resource://gre/modules/Subprocess.sys.mjs";
import { setTimeout } from "resource://gre/modules/Timer.sys.mjs";
import { requestQBittorrentUDS } from "resource:///modules/QBittorrentUDSTransport.sys.mjs";

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
const API_KEY = /^qbt_.{28}$/;
const INSTANCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUNTIME_MANIFEST = "wildbuzzard-qbittorrent-runtime.json";
const MAX_RUNTIME_FILES = 10000;
const MAX_RUNTIME_FILE_SIZE = 768 * 1024 * 1024;
const MAX_RUNTIME_SIZE = 2 * 1024 * 1024 * 1024;

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
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

async function readProcFile(path, maximum = 16 * 1024) {
  return new TextDecoder().decode(
    await IOUtils.read(path, { maxBytes: maximum })
  );
}

async function processMatches(pid, startTime, executable) {
  if (!Number.isInteger(pid) || pid < 1 || !/^\d+$/.test(String(startTime))) {
    return false;
  }
  try {
    const stat = await readProcFile(`/proc/${pid}/stat`);
    const processExecutable = new LocalFile(`/proc/${pid}/exe`);
    return (
      parsePidStartTime(stat) === String(startTime) &&
      processExecutable.target === executable
    );
  } catch {
    return false;
  }
}

async function ensurePrivateDirectory(path) {
  await IOUtils.makeDirectory(path, {
    createAncestors: true,
    ignoreExisting: true,
  });
  const file = new LocalFile(path);
  if (!file.isDirectory() || file.isSymlink()) {
    throw new Error("qBittorrent state directory is unsafe");
  }
  await IOUtils.setPermissions(path, 0o700);
}

async function ensureDownloadDirectory(path) {
  await IOUtils.makeDirectory(path, {
    createAncestors: true,
    ignoreExisting: true,
  });
  const file = new LocalFile(path);
  if (!file.isDirectory() || file.isSymlink()) {
    throw new Error("The torrent download directory is unsafe");
  }
}

function randomAPIKey() {
  const bytes = Cc["@mozilla.org/security/random-generator;1"]
    .createInstance(Ci.nsIRandomGenerator)
    .generateRandomBytes(14);
  return `qbt_${Array.from(bytes, byte =>
    byte.toString(16).padStart(2, "0")
  ).join("")}`;
}

function decodeText(response) {
  return new TextDecoder("utf-8", { fatal: true }).decode(response.body);
}

async function privateRegularFile(path, mode = 0o600) {
  try {
    const file = new LocalFile(path);
    const info = await IOUtils.stat(path);
    return Boolean(
      file.isFile() &&
        !file.isSymlink() &&
        info.type === "regular" &&
        (info.permissions & 0o777) === mode
    );
  } catch {
    return false;
  }
}

async function normalizeExecutable(path) {
  const file = new LocalFile(path);
  if (!file.exists() || !file.isFile() || file.isSymlink()) {
    throw new Error("The bundled qBittorrent executable is unavailable");
  }
  file.normalize();
  return file.path;
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

function readRuntimeManifest(archivePath) {
  const zip = new ZipReader(new LocalFile(archivePath));
  try {
    const entry = zip.getEntry(RUNTIME_MANIFEST);
    if (entry.isDirectory || !entry.realSize || entry.realSize > 16 * 1024 * 1024) {
      throw new Error("Invalid qBittorrent runtime manifest");
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

function validateRuntimeManifest(manifest) {
  if (
    manifest?.schema !== 1 ||
    manifest.component !== "wildbuzzard-qbittorrent-runtime" ||
    manifest.version !== "5.2.3" ||
    manifest.protocolVersion !== 1 ||
    manifest.qbittorrentCommit !== "0b63c3d17373f6132ea211c9dcd4241284ccdfaf" ||
    manifest.libtorrentCommit !== "aab2a10e2f60d9eac78e885a696736d043527794" ||
    manifest.boostVersion !== "1.88.0" ||
    manifest.boostArchiveSha256 !== "46d9d2c06637b219270877c9e16155cbd015b6dc84349af064c088e9b5b12f7b" ||
    manifest.platform !== "linux-x64" ||
    manifest.architecture !== "x86_64" ||
    !/^[0-9a-f]{40}$/.test(manifest.wildbuzzardCommit || "") ||
    !/^[0-9a-f]{64}$/.test(manifest.payloadSha256 || "") ||
    !safeRuntimePath(manifest.correspondingSource) ||
    !/^[0-9a-f]{64}$/.test(manifest.sourceSha256 || "") ||
    !Array.isArray(manifest.files) ||
    !manifest.files.length ||
    manifest.files.length > MAX_RUNTIME_FILES
  ) {
    throw new Error("Invalid qBittorrent runtime manifest");
  }
  const files = new Map();
  let previous = "";
  let total = 0;
  for (const file of manifest.files) {
    if (
      safeRuntimePath(file?.path) &&
      file.path > previous &&
      !files.has(file.path) &&
      Number.isSafeInteger(file.size) &&
      file.size >= 0 &&
      file.size <= MAX_RUNTIME_FILE_SIZE &&
      /^[0-9a-f]{64}$/.test(file.sha256 || "") &&
      typeof file.executable === "boolean" &&
      file.executable === (file.path === "bin/qbittorrent-nox")
    ) {
      total += file.size;
      if (Number.isSafeInteger(total) && total <= MAX_RUNTIME_SIZE) {
        files.set(file.path, file);
        previous = file.path;
        continue;
      }
    }
    throw new Error("Invalid qBittorrent runtime file manifest");
  }
  if (
    files.get("bin/qbittorrent-nox")?.executable !== true ||
    files.get(manifest.correspondingSource)?.sha256 !== manifest.sourceSha256
  ) {
    throw new Error("qBittorrent runtime provenance is incomplete");
  }
  return files;
}

class QBittorrentRuntimeImpl {
  constructor() {
    const home = Services.dirsvc.get("Home", Ci.nsIFile).path;
    const dataHome =
      Services.env.get("XDG_DATA_HOME") ||
      PathUtils.join(home, ".local", "share");
    const runtimeHome =
      Services.env.get("XDG_RUNTIME_DIR") || PathUtils.join(dataHome, "run");
    this.configurePaths({ dataHome, runtimeHome });
  }

  configurePaths({ dataHome, runtimeHome }) {
    this.rootDirectory = PathUtils.join(dataHome, "wildbuzzard", "qbittorrent");
    this.bundleRoot = PathUtils.join(this.rootDirectory, "runtime");
    this.profileDirectory = PathUtils.join(this.rootDirectory, "profile");
    this.stateDirectory = PathUtils.join(
      runtimeHome,
      "wildbuzzard-qbittorrent"
    );
    if (new TextEncoder().encode(PathUtils.join(this.stateDirectory, "q")).length > 100) {
      const digest = Cc["@mozilla.org/security/hash;1"].createInstance(
        Ci.nsICryptoHash
      );
      const source = new TextEncoder().encode(this.rootDirectory);
      digest.initWithString("sha256");
      digest.update(source, source.length);
      const suffix = Array.from(digest.finish(false), character =>
        character.charCodeAt(0).toString(16).padStart(2, "0")
      )
        .join("")
        .slice(0, 16);
      this.stateDirectory = PathUtils.join("/tmp", `wildbuzzard-qbt-${suffix}`);
    }
    this.socketPath = PathUtils.join(this.stateDirectory, "q");
    this.apiKeyPath = PathUtils.join(this.stateDirectory, "api-key");
    this.connectionPath = PathUtils.join(this.stateDirectory, "connection.json");
    this.lockPath = PathUtils.join(
      this.profileDirectory,
      "qBittorrent",
      "config",
      "lockfile"
    );
  }

  configurePathsForTests(paths) {
    if (!Cu.isInAutomation || this.initializeTask || this.connection) {
      throw new Error("qBittorrent test paths are unavailable");
    }
    this.configurePaths(paths);
  }

  configuredRuntimePath() {
    const configured =
      Services.prefs.getStringPref("wildbuzzard.torrent.runtime", "") ||
      Services.env.get("WILDBUZZARD_TORRENT_RUNTIME");
    if (configured) {
      return configured;
    }
    return PathUtils.join(
      Services.dirsvc.get("GreD", Ci.nsIFile).path,
      "runtime",
      "torrent",
      "wildbuzzard-qbittorrent-runtime.zip"
    );
  }

  async ensure() {
    if (AppConstants.platform !== "linux") {
      throw new Error("The bundled qBittorrent runtime currently supports Linux");
    }
    if (!this.initializeTask) {
      this.initializeTask = this.#ensure().catch(error => {
        this.initializeTask = null;
        throw error;
      });
    }
    return this.initializeTask;
  }

  async #ensure() {
    this.runtimeDirectory = await this.#prepareRuntime();
    this.executable = await normalizeExecutable(
      PathUtils.join(this.runtimeDirectory, "bin", "qbittorrent-nox")
    );
    this.executableSha256 = await IOUtils.computeHexDigest(
      this.executable,
      "sha256"
    );
    await ensurePrivateDirectory(this.rootDirectory);
    await ensurePrivateDirectory(this.profileDirectory);
    await ensurePrivateDirectory(this.stateDirectory);
    await this.#ensureAPIKey();
    const existing = await IOUtils.readJSON(this.connectionPath).catch(
      () => null
    );
    if (existing && (await this.#healthyConnection(existing))) {
      this.connection = existing;
      return existing;
    }
    if (
      existing &&
      (await processMatches(
        existing.pid,
        existing.pidStartTime,
        existing.executable
      ))
    ) {
      throw new Error("An unverified process owns qBittorrent state");
    }
    await IOUtils.remove(this.connectionPath, { ignoreAbsent: true });
    await IOUtils.remove(this.socketPath, { ignoreAbsent: true });
    return this.#start();
  }

  async #prepareRuntime() {
    const configured = this.configuredRuntimePath();
    const configuredFile = new LocalFile(configured);
    if (configuredFile.exists() && configuredFile.isDirectory()) {
      configuredFile.normalize();
      return configuredFile.path;
    }
    if (!configuredFile.exists() || !configuredFile.isFile() || configuredFile.isSymlink()) {
      throw new Error("The bundled qBittorrent runtime was not found");
    }
    const manifest = readRuntimeManifest(configured);
    const files = validateRuntimeManifest(manifest);
    const archiveSha256 = await IOUtils.computeHexDigest(configured, "sha256");
    const destination = PathUtils.join(this.bundleRoot, `runtime-${archiveSha256}`);
    const markerPath = PathUtils.join(destination, ".extraction-complete");
    const marker = await IOUtils.readJSON(markerPath).catch(() => null);
    if (
      marker?.schema === 1 &&
      marker.archiveSha256 === archiveSha256 &&
      (await normalizeExecutable(
        PathUtils.join(destination, "bin", "qbittorrent-nox")
      ).catch(() => null))
    ) {
      return destination;
    }
    await ensurePrivateDirectory(this.bundleRoot);
    const staging = PathUtils.join(
      this.bundleRoot,
      `.runtime-${Services.appinfo.processID}-${Services.uuid.generateUUID().toString().replace(/[{}]/g, "")}`
    );
    await IOUtils.remove(staging, { recursive: true, ignoreAbsent: true });
    await ensurePrivateDirectory(staging);
    try {
      const zip = new ZipReader(configuredFile);
      try {
        zip.test(null);
        const names = [];
        const entries = zip.findEntries(null);
        while (entries.hasMore()) {
          names.push(entries.getNext());
        }
        if (
          names.length !== files.size + 1 ||
          new Set(names).size !== names.length ||
          names.some(name => name !== RUNTIME_MANIFEST && !files.has(name))
        ) {
          throw new Error("qBittorrent runtime ZIP inventory differs");
        }
        for (const name of names) {
          const entry = zip.getEntry(name);
          const expected = files.get(name);
          if (
            entry.isDirectory ||
            (expected && entry.realSize !== expected.size) ||
            (!expected && name !== RUNTIME_MANIFEST)
          ) {
            throw new Error("qBittorrent runtime ZIP entry differs");
          }
          const target = PathUtils.join(staging, ...name.split("/"));
          await IOUtils.makeDirectory(PathUtils.parent(target), {
            createAncestors: true,
            ignoreExisting: true,
          });
          zip.extract(name, new LocalFile(target));
          const targetFile = new LocalFile(target);
          if (targetFile.isSymlink()) {
            throw new Error("qBittorrent runtime contains a symbolic link");
          }
          await IOUtils.setPermissions(target, expected?.executable ? 0o755 : 0o644);
        }
      } finally {
        zip.close();
      }
      for (const [name, expected] of files) {
        const target = PathUtils.join(staging, ...name.split("/"));
        if ((await IOUtils.computeHexDigest(target, "sha256")) !== expected.sha256) {
          throw new Error(`qBittorrent runtime payload differs: ${name}`);
        }
      }
      await IOUtils.writeJSON(
        PathUtils.join(staging, ".extraction-complete"),
        { schema: 1, archiveSha256 },
        { tmpPath: PathUtils.join(staging, ".extraction-complete.tmp") }
      );
      try {
        await IOUtils.move(staging, destination, { noOverwrite: true });
        return destination;
      } catch (error) {
        const completed = await IOUtils.readJSON(markerPath).catch(() => null);
        if (
          completed?.schema === 1 &&
          completed.archiveSha256 === archiveSha256 &&
          (await normalizeExecutable(
            PathUtils.join(destination, "bin", "qbittorrent-nox")
          ).catch(() => null))
        ) {
          return destination;
        }
        throw error;
      }
    } finally {
      await IOUtils.remove(staging, { recursive: true, ignoreAbsent: true });
    }
  }

  async #ensureAPIKey() {
    let key = null;
    if (await privateRegularFile(this.apiKeyPath)) {
      key = (await IOUtils.readUTF8(this.apiKeyPath)).trim();
    }
    if (!API_KEY.test(key || "")) {
      key = randomAPIKey();
      await IOUtils.writeUTF8(this.apiKeyPath, `${key}\n`, {
        tmpPath: `${this.apiKeyPath}.tmp`,
      });
      await IOUtils.setPermissions(this.apiKeyPath, 0o600);
    }
    this.apiKey = key;
  }

  async #readLock() {
    const value = await IOUtils.readUTF8(this.lockPath, { maxBytes: 2048 });
    const lines = value.trim().split("\n");
    const pid = Number(lines[0]);
    if (
      lines.length !== 5 ||
      !Number.isInteger(pid) ||
      pid < 1 ||
      !INSTANCE_ID.test(lines[4])
    ) {
      throw new Error("qBittorrent returned an invalid process lock");
    }
    const pidStartTime = parsePidStartTime(
      await readProcFile(`/proc/${pid}/stat`)
    );
    if (!(await processMatches(pid, pidStartTime, this.executable))) {
      throw new Error("qBittorrent process identity could not be verified");
    }
    return { instanceId: lines[4], pid, pidStartTime };
  }

  async #start() {
    const downloadDirectory = await Downloads.getPreferredDownloadsDirectory();
    await ensureDownloadDirectory(downloadDirectory);
    const environment = {
      HOME: Services.dirsvc.get("Home", Ci.nsIFile).path,
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      PATH: "/usr/bin:/bin",
      QT_PLUGIN_PATH: PathUtils.join(
        PathUtils.parent(PathUtils.parent(this.executable)),
        "plugins"
      ),
      TZ: "UTC",
      WILDBUZZARD_QBITTORRENT_API_KEY_FILE: this.apiKeyPath,
      WILDBUZZARD_QBITTORRENT_SOCKET: this.socketPath,
    };
    const libraryPath = PathUtils.join(
      PathUtils.parent(PathUtils.parent(this.executable)),
      "lib"
    );
    if (await IOUtils.exists(libraryPath)) {
      environment.LD_LIBRARY_PATH = libraryPath;
    }
    const process = await Subprocess.call({
      command: this.executable,
      arguments: [
        "--daemon",
        "--confirm-legal-notice",
        `--profile=${this.profileDirectory}`,
        `--save-path=${downloadDirectory}`,
      ],
      environmentAppend: false,
      environment,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const result = await process.wait();
    if (result.exitCode !== 0) {
      throw new Error("qBittorrent failed to start");
    }
    let lastError = null;
    for (let attempt = 0; attempt < 80; attempt++) {
      try {
        const identity = await this.#readLock();
        const version = await this.#version();
        const connection = {
          schema: 1,
          ...identity,
          executable: this.executable,
          executableSha256: this.executableSha256,
          profileDirectory: this.profileDirectory,
          socketPath: this.socketPath,
          version,
        };
        await IOUtils.writeJSON(this.connectionPath, connection, {
          tmpPath: `${this.connectionPath}.tmp`,
        });
        await IOUtils.setPermissions(this.connectionPath, 0o600);
        this.connection = connection;
        return connection;
      } catch (error) {
        lastError = error;
      }
      await delay(250);
    }
    throw lastError || new Error("qBittorrent did not become ready");
  }

  async #version() {
    const response = await requestQBittorrentUDS(this.socketPath, {
      target: "/api/v2/app/version",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      timeout: 3000,
      maximum: 1024,
    });
    if (response.status !== 200) {
      throw new Error("qBittorrent rejected its private capability");
    }
    const version = decodeText(response).trim();
    if (!/^v5\.2\.3$/.test(version)) {
      throw new Error("The bundled qBittorrent version differs from its pin");
    }
    return version;
  }

  async #healthyConnection(connection) {
    if (
      connection?.schema !== 1 ||
      connection.executable !== this.executable ||
      connection.executableSha256 !== this.executableSha256 ||
      connection.profileDirectory !== this.profileDirectory ||
      connection.socketPath !== this.socketPath ||
      !INSTANCE_ID.test(connection.instanceId || "") ||
      !(await privateRegularFile(this.connectionPath)) ||
      !(await privateRegularFile(this.apiKeyPath)) ||
      !(await processMatches(
        connection.pid,
        connection.pidStartTime,
        connection.executable
      ))
    ) {
      return false;
    }
    return (await this.#version().catch(() => null)) === connection.version;
  }

  async request(target, options = {}) {
    await this.ensure();
    const headers = {
      ...options.headers,
      Authorization: `Bearer ${this.apiKey}`,
    };
    return requestQBittorrentUDS(this.socketPath, {
      ...options,
      target,
      headers,
    });
  }

  async requestText(target, options = {}) {
    const response = await this.request(target, options);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`qBittorrent request failed (${response.status})`);
    }
    return decodeText(response);
  }

  async requestJSON(target, options = {}) {
    return JSON.parse(await this.requestText(target, options));
  }

  async stopForTests() {
    if (!Cu.isInAutomation) {
      throw new Error("qBittorrent is persistent outside automation");
    }
    if (this.connection) {
      await this.request("/api/v2/app/shutdown", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }).catch(() => {});
      for (let attempt = 0; attempt < 80; attempt++) {
        if (
          !(await processMatches(
            this.connection.pid,
            this.connection.pidStartTime,
            this.connection.executable
          ))
        ) {
          break;
        }
        await delay(100);
      }
    }
    await IOUtils.remove(this.connectionPath, { ignoreAbsent: true });
    await IOUtils.remove(this.socketPath, { ignoreAbsent: true });
    this.connection = null;
    this.initializeTask = null;
  }
}

export const QBittorrentRuntime = new QBittorrentRuntimeImpl();

export const QBittorrentRuntimeTestUtils = Object.freeze({
  configurePaths(paths) {
    QBittorrentRuntime.configurePathsForTests(paths);
  },
  processMatches,
});
