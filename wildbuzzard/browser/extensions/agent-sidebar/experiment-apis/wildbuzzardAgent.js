/* SPDX-License-Identifier: AGPL-3.0-or-later */

"use strict";

/* global ExtensionAPI, PathUtils, Services */

const { Subprocess } = ChromeUtils.importESModule(
  "resource://gre/modules/Subprocess.sys.mjs"
);
const { AppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs"
);
const { CryptoUtils } = ChromeUtils.importESModule(
  "moz-src:///services/crypto/modules/utils.sys.mjs"
);
const { setAgentEndpoint } = ChromeUtils.importESModule(
  "resource:///modules/WildBuzzardAgentURL.sys.mjs"
);
const { privateDirectory, writePrivateJSON } = ChromeUtils.importESModule(
  "resource:///modules/WildBuzzardAgentState.sys.mjs"
);
const ServerSocket = Components.Constructor(
  "@mozilla.org/network/server-socket;1",
  "nsIServerSocket",
  "init"
);

const AGENT_PAGE_URL = "about:agent";
const AGENT_WEB_COMMAND = "/usr/bin/buzzard-agent-web";
const AGENT_COMMAND = "/usr/bin/buzzard-agent";
const MIN_AGENT_PORT = 49152;
const MAX_AGENT_PORT = 65535;

function bytesToHex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Reads a subprocess pipe to completion.
 *
 * @param {object} pipe Subprocess pipe.
 * @returns {Promise<string>} Complete pipe contents.
 */
async function readAll(pipe) {
  const chunks = [];
  for (let chunk; (chunk = await pipe.readString()); ) {
    chunks.push(chunk);
  }
  return chunks.join("");
}

/** Manages the installed Buzzard Agent Web service. */
class AgentWebManager {
  constructor() {
    const homeDirectory = Services.dirsvc.get("Home", Ci.nsIFile).path;
    const dataHome =
      Services.env.get("XDG_DATA_HOME") ||
      PathUtils.join(homeDirectory, ".local", "share");
    const configHome =
      Services.env.get("XDG_CONFIG_HOME") ||
      PathUtils.join(homeDirectory, ".config");
    this.dataDirectory = PathUtils.join(dataHome, "buzzard", "agent-web");
    this.agentDirectory = PathUtils.join(
      homeDirectory,
      ".buzzard-agent",
      "agent"
    );
    this.configPath = PathUtils.join(
      configHome,
      "buzzard",
      "agent-web",
      "config.json"
    );
    this.identityPath = PathUtils.join(
      this.dataDirectory,
      "service-identity.json"
    );
  }

  async initialize() {
    if (this.initializeTask) {
      return this.initializeTask;
    }
    this.initializeTask = this.#initialize().catch(error => {
      this.initializeTask = null;
      setAgentEndpoint(null);
      throw error;
    });
    return this.initializeTask;
  }

  async #initialize() {
    if (AppConstants.platform !== "linux") {
      throw new Error("Buzzard Agent Web currently supports Linux");
    }
    for (const path of [
      this.dataDirectory,
      this.agentDirectory,
      PathUtils.parent(this.configPath),
    ]) {
      await privateDirectory(path);
    }
    await this.#publishServiceIdentity();

    const existing = await this.#readStatus().catch(() => null);
    this.agentPort =
      existing?.running && this.#validPort(existing.port)
        ? existing.port
        : this.#allocatePort();
    const status = await this.#runAction("start");
    setAgentEndpoint(status.url);
    return status;
  }

  async #publishServiceIdentity() {
    await writePrivateJSON(this.identityPath, {
      schema: 1,
      secret: bytesToHex(CryptoUtils.generateRandomBytes(32)),
      runtimeIdentity: "buzzard-agent-web/1",
    });
  }

  #environment() {
    const environment = {
      BUZZARD_AGENT_WEB_HOST: "127.0.0.1",
      BUZZARD_AGENT_WEB_CONFIG: this.configPath,
      BUZZARD_AGENT_WEB_DATA_DIR: this.dataDirectory,
      BUZZARD_AGENT_WEB_AGENT_COMMAND: AGENT_COMMAND,
      BUZZARD_AGENT_WEB_IDENTITY_FILE: this.identityPath,
      BUZZARD_AGENT_WEB_LOCAL_ONLY: "1",
      BUZZARD_AGENT_DIR: this.agentDirectory,
    };
    if (this.agentPort) {
      environment.BUZZARD_AGENT_WEB_PORT = String(this.agentPort);
    }
    return environment;
  }

  async #runCli(argumentsList) {
    let process;
    try {
      process = await Subprocess.call({
        command: AGENT_WEB_COMMAND,
        arguments: argumentsList,
        stdout: "pipe",
        stderr: "pipe",
        environmentAppend: true,
        environment: this.#environment(),
      });
    } catch (error) {
      throw new Error(
        `Install the buzzard-agent-web package to use about:agent: ${error.message}`
      );
    }
    const [stdout, stderr, result] = await Promise.all([
      readAll(process.stdout),
      readAll(process.stderr),
      process.wait(),
    ]);
    return { exitCode: result.exitCode, stdout, stderr };
  }

  #actionArguments(action) {
    return [
      action,
      "--json",
      "--host",
      "127.0.0.1",
      "--port",
      String(this.agentPort),
      "--config",
      this.configPath,
      "--data-dir",
      this.dataDirectory,
      "--agent-dir",
      this.agentDirectory,
      "--identity-file",
      this.identityPath,
      "--local-only",
    ];
  }

  #parseStatus(result, requireReady) {
    let status;
    try {
      status = JSON.parse(result.stdout.trim());
    } catch {
      throw new Error(
        result.stderr.trim() ||
          result.stdout.trim() ||
          "buzzard-agent-web returned invalid status JSON"
      );
    }
    if (
      !status ||
      status.schema !== 1 ||
      status.service !== "buzzard-agent-web" ||
      typeof status.running !== "boolean" ||
      typeof status.ready !== "boolean"
    ) {
      throw new Error("buzzard-agent-web returned an invalid status object");
    }
    if (requireReady) {
      const expectedURL = `http://127.0.0.1:${status.port}`;
      if (
        result.exitCode !== 0 ||
        !status.running ||
        !status.ready ||
        status.host !== "127.0.0.1" ||
        !this.#validPort(status.port) ||
        (status.url !== expectedURL && status.url !== `${expectedURL}/`)
      ) {
        throw new Error(
          result.stderr.trim() || "Buzzard Agent Web did not become ready"
        );
      }
    }
    const url =
      typeof status.url !== "string" || status.url.endsWith("/")
        ? status.url
        : `${status.url}/`;
    return { ...status, url, pageUrl: AGENT_PAGE_URL, checkedAt: Date.now() };
  }

  async #readStatus() {
    return this.#parseStatus(await this.#runCli(["status", "--json"]), false);
  }

  async #runAction(action) {
    return this.#parseStatus(
      await this.#runCli(this.#actionArguments(action)),
      true
    );
  }

  #validPort(port) {
    return (
      Number.isInteger(port) && port >= MIN_AGENT_PORT && port <= MAX_AGENT_PORT
    );
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

  #allocatePort() {
    const count = MAX_AGENT_PORT - MIN_AGENT_PORT + 1;
    const random = CryptoUtils.generateRandomBytes(2);
    const start = ((random[0] << 8) | random[1]) % count;
    for (let offset = 0; offset < count; offset++) {
      const port = MIN_AGENT_PORT + ((start + offset) % count);
      if (this.#portAvailable(port)) {
        return port;
      }
    }
    throw new Error(
      "No free high loopback port is available for Buzzard Agent Web"
    );
  }

  async refreshStatus() {
    if (!this.agentPort) {
      return this.initialize();
    }
    const status = await this.#readStatus();
    setAgentEndpoint(status.running && status.ready ? status.url : null);
    return status;
  }

  async restart() {
    await this.initialize();
    const status = await this.#runAction("restart");
    setAgentEndpoint(status.url);
    return status;
  }

  shutdown() {
    setAgentEndpoint(null);
  }
}

const manager = new AgentWebManager();

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
