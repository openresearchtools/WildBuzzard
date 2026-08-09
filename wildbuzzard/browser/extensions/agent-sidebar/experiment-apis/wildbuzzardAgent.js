/* SPDX-License-Identifier: AGPL-3.0-or-later */

"use strict";

/* global ExtensionAPI, IOUtils, PathUtils, Services */

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

const AGENT_PORT = 8765;
const PI_WEB_URL = `http://127.0.0.1:${AGENT_PORT}/`;
const CONFIG_FILE = "config.json";
const STATE_FILE = "state.json";
const CONNECTION_FILE = "browser-control.json";
const RUNTIME_MANIFEST = "wildbuzzard-runtime.json";

function runtimeBundleId(archivePath) {
  const zip = new ZipReader(new LocalFile(archivePath));
  try {
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
    const id = [
      manifest.schema,
      manifest.piWebCommit,
      manifest.browserToolsSha256,
      manifest.browserRunnerSha256,
      manifest.nodeVersion,
      manifest.platform,
    ].join("-");
    if (!/^[0-9A-Za-z._-]+$/.test(id)) {
      throw new Error("Invalid Pi Web runtime manifest");
    }
    return id;
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

function requestJSON(url) {
  return new Promise((resolve, reject) => {
    const request = new ServiceRequest({ mozAnon: true });
    request.mozBackgroundRequest = true;
    request.open("GET", url, { bypassProxy: true });
    request.responseType = "json";
    request.timeout = 1000;
    request.setRequestHeader("Cache-Control", "no-store");
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
    this.piDirectory = PathUtils.join(this.rootDirectory, "profile");
    this.configPath = PathUtils.join(
      configHome,
      "wildbuzzard",
      "agent",
      CONFIG_FILE
    );
    this.statePath = PathUtils.join(this.rootDirectory, STATE_FILE);
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
    this.initializeTask = this.#initialize().catch(error => {
      this.initializeTask = null;
      throw error;
    });
    return this.initializeTask;
  }

  async #initialize() {
    if (AppConstants.platform !== "linux") {
      throw new Error("The bundled Pi Web runtime currently supports Linux");
    }
    await IOUtils.makeDirectory(this.rootDirectory, {
      createAncestors: true,
      ignoreExisting: true,
    });
    await IOUtils.makeDirectory(this.piDirectory, {
      createAncestors: true,
      ignoreExisting: true,
    });
    await IOUtils.makeDirectory(PathUtils.parent(this.configPath), {
      createAncestors: true,
      ignoreExisting: true,
    });
    await this.#publishBrowserControl();
    this.runtimeDirectory = await this.#extractRuntime();
    await this.#installBrowserTools();
    await this.#writeConfig();
    await this.#ensureServices();
    const status = await this.refreshStatus();
    await this.#waitUntilReady();
    return { ...status, ready: true };
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

  async #extractRuntime() {
    const archivePath = this.#archivePath();
    if (!(await IOUtils.exists(archivePath))) {
      throw new Error(
        "The bundled Pi Web runtime was not found. Build with --pi-web-runtime."
      );
    }
    const bundleId = runtimeBundleId(archivePath);
    const destination = PathUtils.join(this.bundleRoot, bundleId);
    const marker = PathUtils.join(destination, ".extraction-complete");
    if (await IOUtils.exists(marker)) {
      return destination;
    }

    if (await IOUtils.exists(destination)) {
      await IOUtils.remove(destination, { recursive: true });
    }

    await IOUtils.makeDirectory(destination, {
      createAncestors: true,
      ignoreExisting: true,
    });
    const zip = new ZipReader(new LocalFile(archivePath));
    try {
      for (const entry of zip.findEntries(null)) {
        const isDirectory = entry.endsWith("/");
        const path = isDirectory ? entry.slice(0, -1) : entry;
        const parts = path.split("/");
        if (
          !path ||
          path.startsWith("/") ||
          path.includes("\\") ||
          parts.some(part => !part || part === "." || part === "..")
        ) {
          throw new Error(`Unsafe path in Pi Web runtime: ${entry}`);
        }
        const targetPath = PathUtils.join(destination, ...parts);
        if (isDirectory) {
          await IOUtils.makeDirectory(targetPath, {
            createAncestors: true,
            ignoreExisting: true,
          });
          continue;
        }
        await IOUtils.makeDirectory(PathUtils.parent(targetPath), {
          createAncestors: true,
          ignoreExisting: true,
        });
        zip.extract(entry, new LocalFile(targetPath));
      }
    } catch (error) {
      await IOUtils.remove(destination, {
        recursive: true,
        ignoreAbsent: true,
      });
      throw error;
    } finally {
      zip.close();
    }

    for (const path of [
      PathUtils.join(destination, "node", "bin", "node"),
      PathUtils.join(destination, "bin", "pi"),
      PathUtils.join(destination, "bin", "pi-web"),
      PathUtils.join(destination, "bin", "pi-web-server"),
      PathUtils.join(destination, "bin", "pi-web-sessiond"),
      PathUtils.join(
        destination,
        "seed",
        "browser-tools",
        "wildbuzzard-browser-runner"
      ),
    ]) {
      await IOUtils.setPermissions(path, 0o755);
    }
    await IOUtils.writeUTF8(marker, `${bundleId}\n`);
    return destination;
  }

  async #installBrowserTools() {
    const source = PathUtils.join(
      this.runtimeDirectory,
      "seed",
      "browser-tools"
    );
    const extensionsDirectory = PathUtils.join(this.piDirectory, "extensions");
    const destination = PathUtils.join(extensionsDirectory, "browser-tools");
    await IOUtils.makeDirectory(extensionsDirectory, {
      createAncestors: true,
      ignoreExisting: true,
    });
    await IOUtils.remove(destination, {
      recursive: true,
      ignoreAbsent: true,
    });
    await IOUtils.copy(source, destination, { recursive: true });
    await IOUtils.setPermissions(
      PathUtils.join(destination, "wildbuzzard-browser-runner"),
      0o755
    );
  }

  async #writeConfig() {
    let config = {};
    if (await IOUtils.exists(this.configPath)) {
      config = await IOUtils.readJSON(this.configPath).catch(() => ({}));
    }
    config = {
      ...config,
      host: "127.0.0.1",
      port: AGENT_PORT,
      agent: {
        ...(config.agent ?? {}),
        command: PathUtils.join(this.runtimeDirectory, "bin", "pi"),
        dir: this.piDirectory,
      },
    };
    await IOUtils.writeJSON(this.configPath, config, {
      tmpPath: `${this.configPath}.tmp`,
    });
  }

  async #publishBrowserControl() {
    const connection = BrowserControl.start();
    await IOUtils.makeDirectory(PathUtils.parent(this.connectionPath), {
      createAncestors: true,
      ignoreExisting: true,
    });
    await IOUtils.writeJSON(
      this.connectionPath,
      {
        version: 1,
        port: connection.port,
        token: connection.token,
        browserPid: Services.appinfo.processID,
        updatedAt: Date.now(),
      },
      { tmpPath: `${this.connectionPath}.tmp` }
    );
    await IOUtils.setPermissions(this.connectionPath, 0o600);
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
        WILDBUZZARD_BROWSER_CONTROL_FILE: this.connectionPath,
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

  async #serviceMatchesRuntime() {
    const homeDirectory = Services.dirsvc.get("Home", Ci.nsIFile).path;
    const serviceDirectory = PathUtils.join(
      homeDirectory,
      ".config",
      "systemd",
      "user"
    );
    const services = [
      ["wildbuzzard-agent-web.service", "pi-web-server"],
      ["wildbuzzard-agent-sessiond.service", "pi-web-sessiond"],
    ];
    for (const [serviceName, executableName] of services) {
      const servicePath = PathUtils.join(serviceDirectory, serviceName);
      if (!(await IOUtils.exists(servicePath))) {
        return false;
      }
      const definition = await IOUtils.readUTF8(servicePath);
      if (
        !definition.includes(
          PathUtils.join(this.runtimeDirectory, "bin", executableName)
        ) ||
        !definition.includes(this.configPath) ||
        !definition.includes(this.rootDirectory)
      ) {
        return false;
      }
    }
    return true;
  }

  async #ensureServices() {
    if (await this.#serviceMatchesRuntime()) {
      const start = await this.#runCli(["start"]);
      if (start.exitCode !== 0) {
        throw new Error(start.stderr.trim() || start.stdout.trim());
      }
      return;
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
        String(AGENT_PORT),
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
  }

  async #waitUntilReady() {
    let lastError = "Pi Web did not become ready";
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const response = await requestJSON(
          `${PI_WEB_URL}api/machines/local/health`
        );
        if (response.ok && response.body?.ok === true) {
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
      url: PI_WEB_URL,
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
    await IOUtils.writeJSON(this.statePath, status, {
      tmpPath: `${this.statePath}.tmp`,
    });
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
    BrowserControl.stop();
    IOUtils.remove(this.connectionPath, { ignoreAbsent: true }).catch(() => {});
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
