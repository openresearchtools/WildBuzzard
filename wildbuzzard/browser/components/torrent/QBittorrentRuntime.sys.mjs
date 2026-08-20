/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { Subprocess } from "resource://gre/modules/Subprocess.sys.mjs";
import { requestQBittorrentUDS } from "resource:///modules/QBittorrentUDSTransport.sys.mjs";

const LocalFile = Components.Constructor(
  "@mozilla.org/file/local;1",
  "nsIFile",
  "initWithPath"
);
const API_KEY = /^qbt_.{28}$/;
const INSTANCE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_COMMAND = "/usr/bin/buzzard-torrent";
const MAX_LIFECYCLE_OUTPUT = 64 * 1024;

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
      throw new Error("buzzard-torrent lifecycle output exceeded its limit");
    }
  }
  return output;
}

function decodeText(response) {
  return new TextDecoder("utf-8", { fatal: true }).decode(response.body);
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
    this.rootDirectory = PathUtils.join(dataHome, "buzzard", "torrent");
    this.profileDirectory = PathUtils.join(this.rootDirectory, "profile");
    this.stateDirectory = PathUtils.join(
      runtimeHome,
      "buzzard",
      "torrent"
    );
    this.socketPath = PathUtils.join(this.stateDirectory, "q");
    this.apiKeyPath = PathUtils.join(this.stateDirectory, "api-key");
    this.connectionPath = PathUtils.join(
      this.stateDirectory,
      "connection.json"
    );
  }

  configurePathsForTests(paths) {
    if (!Cu.isInAutomation || this.initializeTask || this.connection) {
      throw new Error("qBittorrent test paths are unavailable");
    }
    this.configurePaths(paths);
  }

  commandPath() {
    return (
      Services.prefs.getStringPref("wildbuzzard.torrent.command", "") ||
      Services.env.get("BUZZARD_TORRENT_COMMAND") ||
      DEFAULT_COMMAND
    );
  }

  validateCommand() {
    const path = this.commandPath();
    const command = new LocalFile(path);
    if (!command.isFile() || command.isSymlink() || !command.isExecutable()) {
      throw new Error("The buzzard-torrent package is not installed");
    }
    return path;
  }

  async runLifecycle(action) {
    const process = await Subprocess.call({
      command: this.validateCommand(),
      arguments: [action],
      environmentAppend: true,
      environment: {
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        TZ: "UTC",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const settled = await Promise.allSettled([
      readPipe(process.stdout),
      readPipe(process.stderr),
      process.wait(),
    ]);
    const failure = settled.find(entry => entry.status === "rejected");
    if (failure) {
      throw failure.reason;
    }
    const [stdout, stderr, result] = settled.map(entry => entry.value);
    if (result.exitCode !== 0 || stderr.trim()) {
      throw new Error(stderr.trim() || `buzzard-torrent ${action} failed`);
    }
    return JSON.parse(stdout);
  }

  async ensure() {
    if (AppConstants.platform !== "linux") {
      throw new Error("The buzzard-torrent package currently supports Linux");
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
    const connection = await this.runLifecycle("start");
    if (
      connection?.schema !== 1 ||
      connection.protocolVersion !== 1 ||
      connection.version !== "v5.2.3" ||
      !INSTANCE_ID.test(connection.instanceId || "") ||
      typeof connection.socketPath !== "string" ||
      typeof connection.apiKeyPath !== "string" ||
      typeof connection.profileDirectory !== "string" ||
      typeof connection.executable !== "string" ||
      !(await processMatches(
        connection.pid,
        connection.pidStartTime,
        connection.executable
      ))
    ) {
      throw new Error("buzzard-torrent returned an invalid connection");
    }
    const executable = new LocalFile(connection.executable);
    executable.normalize();
    if (!executable.isFile() || executable.isSymlink()) {
      throw new Error("buzzard-torrent executable is unavailable");
    }
    const socket = new LocalFile(connection.socketPath);
    if (!socket.isSpecial() || socket.isSymlink()) {
      throw new Error("buzzard-torrent socket is unavailable");
    }
    if (!(await privateRegularFile(connection.apiKeyPath))) {
      throw new Error("buzzard-torrent capability file is unsafe");
    }
    const key = (await IOUtils.readUTF8(connection.apiKeyPath)).trim();
    if (!API_KEY.test(key)) {
      throw new Error("buzzard-torrent capability is invalid");
    }
    this.apiKey = key;
    this.apiKeyPath = connection.apiKeyPath;
    this.socketPath = connection.socketPath;
    this.stateDirectory = PathUtils.parent(connection.socketPath);
    this.connectionPath = PathUtils.join(
      this.stateDirectory,
      "connection.json"
    );
    this.profileDirectory = connection.profileDirectory;
    this.rootDirectory = PathUtils.parent(connection.profileDirectory);
    this.runtimeDirectory = PathUtils.parent(
      PathUtils.parent(connection.executable)
    );
    this.executable = connection.executable;
    this.connection = connection;
    if ((await this.#version()) !== connection.version) {
      throw new Error("buzzard-torrent health verification failed");
    }
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
    await this.runLifecycle("stop").catch(() => {});
    this.connection = null;
    this.initializeTask = null;
  }
}

export const QBittorrentRuntime = new QBittorrentRuntimeImpl();

export const QBittorrentRuntimeTestUtils = Object.freeze({
  DEFAULT_COMMAND,
  configurePaths(paths) {
    QBittorrentRuntime.configurePathsForTests(paths);
  },
  processMatches,
});
