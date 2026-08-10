/* SPDX-License-Identifier: AGPL-3.0-or-later */

"use strict";

/* global ExtensionAPI, IOUtils, PathUtils, Services, TextDecoder */

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
const CryptoHash = Components.Constructor(
  "@mozilla.org/security/hash;1",
  "nsICryptoHash",
  "initWithString"
);

const AGENT_PORT = 8765;
const PI_WEB_URL = `http://127.0.0.1:${AGENT_PORT}/`;
const CONFIG_FILE = "config.json";
const STATE_FILE = "state.json";
const CONNECTION_FILE = "browser-control.json";
const RUNTIME_MANIFEST = "wildbuzzard-runtime.json";
const ACTIVE_RUNTIME_FILE = "active-runtime.json";
const MAX_RUNTIME_ARCHIVE_SIZE = 1024 * 1024 * 1024;
const MAX_RUNTIME_FILE_SIZE = 512 * 1024 * 1024;
const MAX_RUNTIME_EXPANDED_SIZE = 2 * 1024 * 1024 * 1024;
const MAX_RUNTIME_ENTRIES = 200000;

function hexDigest(bytes) {
  const hash = new CryptoHash("sha256");
  hash.update(bytes, bytes.length);
  return Array.from(hash.finish(false), byte =>
    byte.charCodeAt(0).toString(16).padStart(2, "0")
  ).join("");
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
      !/^[a-f0-9]{64}$/.test(manifest.sourceSha256) ||
      !/^[a-f0-9]{64}$/.test(manifest.dependencyLockSha256) ||
      !/^[a-f0-9]{64}$/.test(manifest.browserToolsSha256) ||
      !/^[a-f0-9]{64}$/.test(manifest.webAccessSha256) ||
      !/^[a-f0-9]{64}$/.test(manifest.browserRunnerSha256) ||
      !/^[a-f0-9]{64}$/.test(manifest.gitRuntimeSha256) ||
      !/^[a-f0-9]{64}$/.test(manifest.ytdlpRuntimeSha256) ||
      manifest.protocolVersion !== 1 ||
      !safeArchivePath(manifest.correspondingSource) ||
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
    const previousRuntime = await this.#readActiveRuntime();
    const runtime = await this.#extractRuntime();
    this.runtimeDirectory = runtime.directory;
    try {
      await this.#installAgentExtensions();
      await this.#writeConfig();
      await this.#ensureServices();
      await this.#waitUntilReady();
      await this.#activateRuntime(runtime.bundleId, runtime.directory);
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

  async #extractRuntime() {
    const archivePath = this.#archivePath();
    if (!(await IOUtils.exists(archivePath))) {
      throw new Error(
        "The bundled Pi Web runtime was not found. Build with --pi-web-runtime."
      );
    }
    const bundle = await runtimeBundleInfo(archivePath);
    const { bundleId } = bundle;
    const destination = PathUtils.join(this.bundleRoot, bundleId);
    const marker = PathUtils.join(destination, ".extraction-complete");
    if (await IOUtils.exists(marker)) {
      const extracted = await IOUtils.readJSON(marker).catch(() => null);
      if (extracted?.archiveSha256 !== bundle.archiveSha256) {
        throw new Error("Pi Web runtime activation marker is invalid");
      }
      return { bundleId, directory: destination };
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
    const zip = new ZipReader(new LocalFile(archivePath));
    try {
      for (const entry of zip.findEntries(null)) {
        const metadata = bundle.centralEntries.get(entry);
        if (!metadata) {
          throw new Error(`Unindexed path in Pi Web runtime: ${entry}`);
        }
        const isDirectory = metadata.directory;
        const path = isDirectory ? entry.slice(0, -1) : entry;
        const parts = path.split("/");
        const targetPath = PathUtils.join(staging, ...parts);
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
        const zipEntry = zip.getEntry(entry);
        if (zipEntry.realSize !== metadata.realSize) {
          throw new Error(`Size mismatch in Pi Web runtime: ${entry}`);
        }
        const stream = zip.getInputStream(entry);
        let bytes;
        try {
          bytes = NetUtil.readInputStream(stream, zipEntry.realSize);
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
    const stagingMarker = PathUtils.join(staging, ".extraction-complete");
    await IOUtils.writeJSON(
      stagingMarker,
      { bundleId, archiveSha256: bundle.archiveSha256 },
      { tmpPath: `${stagingMarker}.tmp` }
    );
    try {
      await IOUtils.move(staging, destination, { noOverwrite: true });
    } catch (error) {
      await IOUtils.remove(staging, { recursive: true, ignoreAbsent: true });
      throw error;
    }
    return { bundleId, directory: destination };
  }

  async #readActiveRuntime() {
    const active = await IOUtils.readJSON(this.activeRuntimePath).catch(
      () => null
    );
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

  async #activateRuntime(bundleId, directory) {
    await IOUtils.writeJSON(
      this.activeRuntimePath,
      { bundleId, directory, activatedAt: Date.now() },
      { tmpPath: `${this.activeRuntimePath}.tmp` }
    );
    await IOUtils.setPermissions(this.activeRuntimePath, 0o600);
  }

  async #rollbackRuntime(previousRuntime) {
    this.runtimeDirectory = previousRuntime.directory;
    await this.#installAgentExtensions();
    await this.#writeConfig();
    await this.#ensureServices();
    await this.#waitUntilReady();
    await this.#activateRuntime(
      previousRuntime.bundleId,
      previousRuntime.directory
    );
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
    if (!(await this.#serviceMatchesRuntime())) {
      throw new Error("Pi Web service activation did not select the runtime");
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
