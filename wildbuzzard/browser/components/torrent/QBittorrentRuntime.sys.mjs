/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { Subprocess } from "resource://gre/modules/Subprocess.sys.mjs";
import { setTimeout } from "resource://gre/modules/Timer.sys.mjs";
import { requestQBittorrentUDS } from "resource:///modules/QBittorrentUDSTransport.sys.mjs";

const LocalFile = Components.Constructor(
  "@mozilla.org/file/local;1",
  "nsIFile",
  "initWithPath"
);
const API_KEY = /^qbt_.{28}$/;
const INSTANCE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QBITTORRENT_VERSION = "v5.2.3";
const MAX_LIFECYCLE_OUTPUT = 64 * 1024;
const KEY_CREATE_ATTEMPTS = 20;
const START_ATTEMPTS = 80;
const START_INTERVAL_MS = 250;

function safeDirectory(value, fallback) {
  try {
    return typeof value === "string" &&
      value.startsWith("/") &&
      value.length <= 4096 &&
      !/[\p{Cc}\p{Cf}]/u.test(value) &&
      PathUtils.normalize(value) === value
      ? value
      : fallback;
  } catch {
    return fallback;
  }
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

async function readPipe(pipe) {
  let output = "";
  for (let chunk; (chunk = await pipe.readString()); ) {
    output += chunk;
    if (output.length > MAX_LIFECYCLE_OUTPUT) {
      throw new Error("qBittorrent startup output exceeded its limit");
    }
  }
  return output;
}

function decodeText(response) {
  return new TextDecoder("utf-8", { fatal: true }).decode(response.body);
}

async function makePrivateDirectory(path) {
  const directory = new LocalFile(path);
  if (
    directory.exists() &&
    (!directory.isDirectory() || directory.isSymlink())
  ) {
    throw new Error(`Unsafe qBittorrent directory: ${path}`);
  }
  await IOUtils.makeDirectory(path, {
    createAncestors: true,
    ignoreExisting: true,
    permissions: 0o700,
  });
  await IOUtils.setPermissions(path, 0o700);
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

/** Owns the lifecycle and private transport for the packaged runtime. */
class QBittorrentRuntimeImpl {
  constructor() {
    const home = Services.dirsvc.get("Home", Ci.nsIFile).path;
    const dataHome = safeDirectory(
      Services.env.get("XDG_DATA_HOME"),
      PathUtils.join(home, ".local", "share")
    );
    const runtimeHome = safeDirectory(
      Services.env.get("XDG_RUNTIME_DIR"),
      PathUtils.join(dataHome, "run")
    );
    this.homeDirectory = home;
    this.downloadDirectory = safeDirectory(
      Services.env.get("BUZZARD_TORRENT_DOWNLOADS"),
      PathUtils.join(home, "Downloads")
    );
    this.configurePaths({ dataHome, runtimeHome });
  }

  configurePaths({ dataHome, runtimeHome }) {
    this.rootDirectory = PathUtils.join(dataHome, "wildbuzzard", "torrent");
    this.profileDirectory = PathUtils.join(this.rootDirectory, "profile");
    this.stateDirectory = PathUtils.join(runtimeHome, "wildbuzzard", "torrent");
    this.socketPath = PathUtils.join(this.stateDirectory, "q");
    this.apiKeyPath = PathUtils.join(this.stateDirectory, "api-key");
    this.runtimeDirectory = PathUtils.join(
      Services.dirsvc.get("GreD", Ci.nsIFile).path,
      "runtime",
      "torrent"
    );
    this.executable = PathUtils.join(
      this.runtimeDirectory,
      "bin",
      "qbittorrent-nox"
    );
  }

  configurePathsForTests(paths) {
    if (!Cu.isInAutomation || this.initializeTask || this.connection) {
      throw new Error("qBittorrent test paths are unavailable");
    }
    this.configurePaths(paths);
  }

  validateRuntime() {
    try {
      const runtime = new LocalFile(this.runtimeDirectory);
      const command = new LocalFile(this.executable);
      if (
        !runtime.isDirectory() ||
        runtime.isSymlink() ||
        (runtime.permissions & 0o022) !== 0 ||
        !command.isFile() ||
        command.isSymlink() ||
        !command.isExecutable() ||
        (command.permissions & 0o022) !== 0
      ) {
        throw new Error();
      }
    } catch {
      throw new Error("The bundled qBittorrent runtime is unavailable");
    }
    return this.executable;
  }

  async #startProcess(downloads) {
    const environment = {
      HOME: PathUtils.join(this.rootDirectory, "home"),
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      LD_LIBRARY_PATH: PathUtils.join(this.runtimeDirectory, "lib"),
      PATH: "/usr/bin:/bin",
      QT_PLUGIN_PATH: PathUtils.join(this.runtimeDirectory, "plugins"),
      TZ: "UTC",
      WILDBUZZARD_QBITTORRENT_API_KEY_FILE: this.apiKeyPath,
      WILDBUZZARD_QBITTORRENT_SOCKET: this.socketPath,
    };
    const process = await Subprocess.call({
      command: this.validateRuntime(),
      arguments: [
        "--daemon",
        "--confirm-legal-notice",
        `--profile=${this.profileDirectory}`,
        `--save-path=${downloads}`,
      ],
      environmentAppend: false,
      environment,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    const [stderr, result] = await Promise.all([
      readPipe(process.stderr),
      process.wait(),
    ]);
    if (result.exitCode !== 0) {
      throw new Error(
        stderr.trim() || `qBittorrent exited with ${result.exitCode}`
      );
    }
  }

  async #apiKey() {
    const random = Services.uuid
      .generateUUID()
      .toString()
      .replace(/[{}-]/g, "")
      .slice(0, 28);
    const key = `qbt_${random}`;
    for (let attempt = 0; attempt < KEY_CREATE_ATTEMPTS; attempt++) {
      if (await privateRegularFile(this.apiKeyPath)) {
        const existing = (await IOUtils.readUTF8(this.apiKeyPath)).trim();
        if (API_KEY.test(existing)) {
          return existing;
        }
      }
      try {
        await IOUtils.writeUTF8(this.apiKeyPath, `${key}\n`, {
          mode: "create",
        });
        await IOUtils.setPermissions(this.apiKeyPath, 0o600);
        return key;
      } catch {
        await delay(25);
      }
    }
    const temporary = `${this.apiKeyPath}.${Services.appinfo.processID}.tmp`;
    await IOUtils.writeUTF8(this.apiKeyPath, `${key}\n`, {
      tmpPath: temporary,
    });
    await IOUtils.setPermissions(this.apiKeyPath, 0o600);
    return key;
  }

  async #readProcess() {
    try {
      const lockPath = PathUtils.join(
        this.profileDirectory,
        "qBittorrent",
        "config",
        "lockfile"
      );
      const lines = (await IOUtils.readUTF8(lockPath)).trim().split(/\r?\n/);
      const pid = Number.parseInt(lines[0], 10);
      const instanceId = lines[4];
      if (
        lines.length !== 5 ||
        !Number.isInteger(pid) ||
        !INSTANCE_ID.test(instanceId || "")
      ) {
        return null;
      }
      const stat = await readProcFile(`/proc/${pid}/stat`);
      const pidStartTime = parsePidStartTime(stat);
      if (!(await processMatches(pid, pidStartTime, this.executable))) {
        return null;
      }
      return { pid, pidStartTime, instanceId };
    } catch {
      return null;
    }
  }

  async #connectionIfHealthy() {
    const identity = await this.#readProcess();
    if (!identity) {
      return null;
    }
    try {
      const socket = new LocalFile(this.socketPath);
      if (!socket.isSpecial() || socket.isSymlink()) {
        return null;
      }
      if ((await this.#version()) !== QBITTORRENT_VERSION) {
        return null;
      }
    } catch {
      return null;
    }
    return {
      schema: 1,
      protocolVersion: 1,
      ...identity,
      profileDirectory: this.profileDirectory,
      socketPath: this.socketPath,
      apiKeyPath: this.apiKeyPath,
      executable: this.executable,
      version: QBITTORRENT_VERSION,
    };
  }

  async #waitForHealthy(attempts = START_ATTEMPTS) {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const connection = await this.#connectionIfHealthy();
      if (connection) {
        return connection;
      }
      await delay(START_INTERVAL_MS);
    }
    return null;
  }

  async ensure() {
    if (AppConstants.platform !== "linux") {
      throw new Error(
        "The bundled qBittorrent runtime currently supports Linux"
      );
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
    this.validateRuntime();
    for (const path of [
      this.rootDirectory,
      PathUtils.join(this.rootDirectory, "home"),
      this.profileDirectory,
      this.stateDirectory,
    ]) {
      await makePrivateDirectory(path);
    }
    this.apiKey = await this.#apiKey();
    let connection = await this.#connectionIfHealthy();
    if (!connection) {
      const startingProcess = await this.#readProcess();
      if (startingProcess) {
        connection = await this.#waitForHealthy();
      }
    }
    if (!connection) {
      if (!(await this.#readProcess())) {
        await IOUtils.remove(this.socketPath, { ignoreAbsent: true });
      }
      await IOUtils.makeDirectory(this.downloadDirectory, {
        createAncestors: true,
        ignoreExisting: true,
      });
      await this.#startProcess(this.downloadDirectory);
      connection = await this.#waitForHealthy();
    }
    if (!connection) {
      throw new Error("The bundled qBittorrent runtime did not become ready");
    }
    this.connection = connection;
    return connection;
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
    return decodeText(response).trim();
  }

  async request(target, options = {}) {
    await this.ensure();
    if (!(await this.#connectionIfHealthy())) {
      this.connection = null;
      this.initializeTask = null;
      await this.ensure();
    }
    return requestQBittorrentUDS(this.socketPath, {
      ...options,
      target,
      headers: {
        ...options.headers,
        Authorization: `Bearer ${this.apiKey}`,
      },
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
        body: new Uint8Array(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }).catch(() => {});
      for (let attempt = 0; attempt < 40; attempt++) {
        if (!(await processMatches(
          this.connection.pid,
          this.connection.pidStartTime,
          this.executable
        ))) {
          break;
        }
        await delay(250);
      }
    }
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
