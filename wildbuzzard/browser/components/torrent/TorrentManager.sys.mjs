/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { Downloads } from "resource://gre/modules/Downloads.sys.mjs";
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

const MAX_TORRENT_SIZE = 12 * 1024 * 1024;
const RUNTIME_MANIFEST = "wildbuzzard-torrent-runtime.json";

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
      manifest.wildbuzzardCommit,
      manifest.webTorrentVersion,
      manifest.packageLockSha256,
      manifest.nodeVersion,
      manifest.platform,
    ].join("-");
    if (!/^[0-9A-Za-z._-]+$/.test(id)) {
      throw new Error("Invalid torrent runtime manifest");
    }
    return id;
  } finally {
    zip.close();
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
    this.runtimeDirectory = await this.#extractRuntime();
    await this.#writeConfig();
    await this.#ensureService();
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
    const bundleId = runtimeBundleId(archivePath);
    const destination = PathUtils.join(this.bundleRoot, bundleId);
    const marker = PathUtils.join(destination, ".extraction-complete");
    if (await IOUtils.exists(marker)) {
      return destination;
    }
    await IOUtils.remove(destination, { recursive: true, ignoreAbsent: true });
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
          throw new Error(`Unsafe path in torrent runtime: ${entry}`);
        }
        const target = PathUtils.join(destination, ...parts);
        if (isDirectory) {
          await IOUtils.makeDirectory(target, {
            createAncestors: true,
            ignoreExisting: true,
          });
        } else {
          await IOUtils.makeDirectory(PathUtils.parent(target), {
            createAncestors: true,
            ignoreExisting: true,
          });
          zip.extract(entry, new LocalFile(target));
        }
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
      PathUtils.join(destination, "bin", "wildbuzzard-torrent"),
    ]) {
      await IOUtils.setPermissions(path, 0o755);
    }
    await IOUtils.writeUTF8(marker, `${bundleId}\n`);
    return destination;
  }

  async #writeConfig() {
    const existing = await IOUtils.readJSON(this.configPath).catch(() => ({}));
    const downloadDirectory =
      existing.downloadDirectory ||
      (await Downloads.getPreferredDownloadsDirectory());
    const config = {
      ...existing,
      version: 1,
      dataDirectory: PathUtils.join(this.rootDirectory, "data"),
      downloadDirectory,
      connectionPath: this.connectionPath,
      maxActive: existing.maxActive ?? 3,
      maxConnections: existing.maxConnections ?? 80,
      utp: existing.utp ?? true,
      natUpnp: existing.natUpnp ?? true,
      natPmp: existing.natPmp ?? true,
      lsd: existing.lsd ?? true,
    };
    await IOUtils.writeJSON(this.configPath, config, {
      tmpPath: `${this.configPath}.tmp`,
    });
    await IOUtils.setPermissions(this.configPath, 0o600);
    this.config = config;
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

  async #ensureService() {
    let connection = await IOUtils.readJSON(this.connectionPath).catch(
      () => null
    );
    if (connection && connection.runtimeDirectory !== this.runtimeDirectory) {
      await this.#request("POST", "/v1/shutdown", {}, connection).catch(
        () => {}
      );
      for (let attempt = 0; attempt < 20; attempt++) {
        if (!(await IOUtils.exists(this.connectionPath))) {
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      connection = null;
    }
    if (connection) {
      const healthy = await this.#request("GET", "/v1/status", null, connection)
        .then(() => true)
        .catch(() => false);
      if (healthy) {
        this.connection = connection;
        return;
      }
    }
    await this.#run(["start", "--config", this.configPath]);
    for (let attempt = 0; attempt < 40; attempt++) {
      connection = await IOUtils.readJSON(this.connectionPath).catch(
        () => null
      );
      if (connection) {
        const healthy = await this.#request(
          "GET",
          "/v1/status",
          null,
          connection
        )
          .then(() => true)
          .catch(() => false);
        if (healthy) {
          this.connection = connection;
          return;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error("Torrent service did not become ready");
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
      request.timeout = 5000;
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
    return this.addTorrentBytes(
      await requestBytes(
        Services.io.newURI(source),
        principal,
        cookieJarSettings
      ),
      downloadPath
    );
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

  updateSettings(settings) {
    return this.request("PATCH", "/v1/settings", settings);
  }

  remove(id, deleteData = false) {
    return this.request(
      "DELETE",
      `/v1/torrents/${encodeURIComponent(id)}?deleteData=${deleteData}`
    );
  }

  async chooseTorrentFile() {
    const window = Services.wm.getMostRecentWindow("navigator:browser");
    const picker = Cc["@mozilla.org/filepicker;1"].createInstance(
      Ci.nsIFilePicker
    );
    picker.init(window, "", Ci.nsIFilePicker.modeOpen);
    picker.appendFilter("Torrent files", "*.torrent");
    const result = await new Promise(resolve => picker.open(resolve));
    if (result !== Ci.nsIFilePicker.returnOK) {
      return null;
    }
    const stat = await IOUtils.stat(picker.file.path);
    if (stat.size > MAX_TORRENT_SIZE) {
      throw new Error("Torrent metadata is too large");
    }
    const bytes = await IOUtils.read(picker.file.path, {
      maxBytes: MAX_TORRENT_SIZE,
    });
    return this.addTorrentBytes(bytes);
  }

  async chooseDownloadDirectory() {
    const window = Services.wm.getMostRecentWindow("navigator:browser");
    const picker = Cc["@mozilla.org/filepicker;1"].createInstance(
      Ci.nsIFilePicker
    );
    picker.init(window, "", Ci.nsIFilePicker.modeGetFolder);
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
