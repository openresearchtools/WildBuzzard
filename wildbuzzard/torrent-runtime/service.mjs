#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  resolve,
} from "node:path";
import process from "node:process";
import peerIdParser from "bittorrent-peerid";
import nodeFetch from "node-fetch";
import { SocksClient } from "socks";
import { SocksProxyAgent } from "socks-proxy-agent";

globalThis.fetch = nodeFetch;

let WebTorrent;

const API_VERSION = 1;
const MAX_BODY_SIZE = 12 * 1024 * 1024;

function argument(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

async function readJSON(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJSON(path, value, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await rename(temporary, path);
  await chmod(path, mode);
}

function magnetName(source) {
  try {
    return new URL(source).searchParams.get("dn") || "Magnet download";
  } catch {
    return "Magnet download";
  }
}

function safeFilePath(path) {
  return (
    path &&
    !isAbsolute(path) &&
    !normalize(path)
      .split(/[\\/]/)
      .some(part => part === "..")
  );
}

function clampInteger(value, minimum, maximum) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number)
    ? Math.min(maximum, Math.max(minimum, number))
    : minimum;
}

function connectionsFor(record, torEnabled) {
  const torrent = record.runtime;
  if (!torrent || torrent.destroyed) {
    return [];
  }
  return torrent.wires.map((wire, index) => {
    const peer = [...torrent._peers.values()].find(item => item.wire === wire);
    let client = "Unknown";
    try {
      const parsed = peerIdParser(wire.peerId);
      client = [parsed.client, parsed.version].filter(Boolean).join(" ");
    } catch {}
    const address =
      peer?.addr ||
      [wire.remoteAddress, wire.remotePort].filter(Boolean).join(":") ||
      "Unknown";
    const transport = wire.type?.startsWith("utp")
      ? "µTP"
      : wire.type === "webSeed"
        ? "Web seed"
        : "TCP";
    const flags = [];
    if (wire.peerChoking) {
      flags.push("Choked");
    }
    if (wire.peerInterested) {
      flags.push("Interested");
    }
    if (wire.type?.endsWith("Incoming")) {
      flags.push("Incoming");
    } else if (wire.type?.endsWith("Outgoing")) {
      flags.push("Outgoing");
    }
    return {
      id: `${wire.peerId?.toString("hex") || address}-${wire.type || index}`,
      address,
      client,
      transport,
      source: peer?.source || "unknown",
      route: torEnabled ? "Tor" : "Direct",
      downloadSpeed: Number(wire.downloadSpeed?.() || 0),
      uploadSpeed: Number(wire.uploadSpeed?.() || 0),
      downloaded: Number(wire.downloaded || 0),
      uploaded: Number(wire.uploaded || 0),
      status: flags.join(", ") || "Connected",
    };
  });
}

function publicRecord(record, includeConnections = true, torEnabled = false) {
  const { runtime, metainfoPath, ...result } = record;
  result.connections = includeConnections
    ? connectionsFor(record, torEnabled)
    : [];
  return result;
}

function torProxy(value) {
  const host = String(value?.host || "");
  const port = Math.trunc(Number(value?.port));
  if (host !== "127.0.0.1" || port < 1 || port > 65535) {
    throw new Error("Tor mode requires a valid local SOCKS proxy");
  }
  return { host, port };
}

function torCredentials() {
  return {
    userId: randomBytes(16).toString("hex"),
    password: randomBytes(16).toString("hex"),
  };
}

function requestThroughAgent(url, agent, redirects = 0) {
  return new Promise((resolveRequest, reject) => {
    const parsed = new URL(url);
    const request = (parsed.protocol === "https:" ? httpsRequest : httpRequest)(
      parsed,
      { agent },
      response => {
        if (
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location &&
          redirects < 5
        ) {
          response.resume();
          resolveRequest(
            requestThroughAgent(
              new URL(response.headers.location, parsed).href,
              agent,
              redirects + 1
            )
          );
          return;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          response.resume();
          reject(new Error(`Torrent request failed (${response.statusCode})`));
          return;
        }
        const chunks = [];
        let size = 0;
        response.on("data", chunk => {
          size += chunk.length;
          if (size > MAX_BODY_SIZE) {
            request.destroy(new Error("Torrent metadata is too large"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => resolveRequest(Buffer.concat(chunks)));
      }
    );
    request.setTimeout(30000, () =>
      request.destroy(new Error("Torrent request timed out"))
    );
    request.on("error", reject);
    request.end();
  });
}

class TorrentEngine {
  constructor(config, configPath) {
    this.config = config;
    this.configPath = configPath;
    this.dataDirectory = config.dataDirectory;
    this.statePath = join(this.dataDirectory, "state.json");
    this.metainfoDirectory = join(this.dataDirectory, "metainfo");
    this.connectionPath = config.connectionPath;
    this.records = new Map();
    this.settings = {
      maxActive: clampInteger(config.maxActive ?? 3, 1, 50),
      downloadLimit: Number(config.downloadLimit ?? -1),
      uploadLimit: Number(config.uploadLimit ?? -1),
      seedCompleted: config.seedCompleted !== false,
      downloadDirectory: config.downloadDirectory,
      torEnabled: Boolean(config.torEnabled),
    };
    this.torProxy = config.torEnabled ? torProxy(config.torProxy) : null;
  }

  async initialize() {
    await mkdir(this.dataDirectory, { recursive: true });
    await mkdir(this.metainfoDirectory, { recursive: true });
    await mkdir(this.config.downloadDirectory, { recursive: true });
    const saved = await readJSON(this.statePath, { records: [], settings: {} });
    Object.assign(this.settings, saved.settings || {});
    this.settings.torEnabled = Boolean(this.config.torEnabled);
    for (const item of saved.records || []) {
      const record = {
        ...item,
        runtime: null,
        downloadSpeed: 0,
        uploadSpeed: 0,
        numPeers: 0,
        timeRemaining: Infinity,
      };
      if (
        ["downloading", "checking", "metadata", "seeding"].includes(
          record.state
        )
      ) {
        record.state = "queued";
      }
      this.records.set(record.id, record);
    }
    this.client = this.createClient();
    this.timer = setInterval(() => this.updateStats(), 1000);
    this.timer.unref();
    await this.reconcile();
  }

  createClient() {
    const options = {
      maxConns: clampInteger(this.config.maxConnections ?? 80, 10, 500),
      downloadLimit: this.settings.downloadLimit,
      uploadLimit: this.settings.uploadLimit,
      dht: this.config.dht ?? true,
      natUpnp: !this.settings.torEnabled && this.config.natUpnp !== false,
      natPmp: !this.settings.torEnabled && this.config.natPmp !== false,
      lsd: !this.settings.torEnabled && this.config.lsd !== false,
      utp: !this.settings.torEnabled && this.config.utp !== false,
      webSeeds: !this.settings.torEnabled,
      acceptIncoming: !this.settings.torEnabled,
    };
    if (this.settings.torEnabled) {
      const proxy = torProxy(this.torProxy);
      const trackerAuth = torCredentials();
      const proxyURL = new URL(`socks5h://${proxy.host}:${proxy.port}`);
      proxyURL.username = trackerAuth.userId;
      proxyURL.password = trackerAuth.password;
      const agent = new SocksProxyAgent(proxyURL);
      this.torAgent = agent;
      options.dht = false;
      options.torrentPort = 1;
      options.trackerFilter = url => /^(https?|wss?):/i.test(url);
      options.tracker = { proxyOpts: { httpAgent: agent, httpsAgent: agent } };
      options.peerConnect = (destination, callback) => {
        const auth = torCredentials();
        SocksClient.createConnection({
          command: "connect",
          proxy: { type: 5, ...proxy, ...auth },
          destination: {
            host: destination.host,
            port: Number(destination.port),
          },
          timeout: 30000,
        })
          .then(({ socket }) => callback(null, socket))
          .catch(callback);
      };
    }
    if (!this.settings.torEnabled) {
      this.torAgent = null;
    }
    const client = new WebTorrent(options);
    client.on("error", error => {
      this.lastError = error.message;
    });
    return client;
  }

  async persist() {
    await writeJSON(this.statePath, {
      version: API_VERSION,
      settings: this.settings,
      records: [...this.records.values()].map(record => {
        const value = publicRecord(record, false, this.settings.torEnabled);
        value.downloadSpeed = 0;
        value.uploadSpeed = 0;
        value.numPeers = 0;
        value.timeRemaining = null;
        return value;
      }),
    });
  }

  snapshot() {
    this.updateStats(false);
    return {
      version: API_VERSION,
      engine: `WebTorrent/${WebTorrent.VERSION}`,
      capabilities: {
        tcp: true,
        udpTrackers: !this.settings.torEnabled,
        dht: Boolean(this.client.dht),
        utp: Boolean(this.client.utp),
        pex: Boolean(this.client.utPex),
        lsd: Boolean(this.client.lsd),
        inbound: !this.settings.torEnabled,
        tor: this.settings.torEnabled,
      },
      settings: this.settings,
      lastError: this.lastError || null,
      torrents: [...this.records.values()]
        .sort((a, b) => a.addedAt - b.addedAt)
        .map(record => publicRecord(record, true, this.settings.torEnabled)),
    };
  }

  updateStats(persist = true) {
    let changed = false;
    for (const record of this.records.values()) {
      const torrent = record.runtime;
      if (!torrent || torrent.destroyed) {
        continue;
      }
      record.progress = Number(torrent.progress || 0);
      record.downloaded = Number(torrent.downloaded || 0);
      record.uploaded = Number(torrent.uploaded || 0);
      record.downloadSpeed = Number(torrent.downloadSpeed || 0);
      record.uploadSpeed = Number(torrent.uploadSpeed || 0);
      record.numPeers = Number(torrent.numPeers || 0);
      record.timeRemaining = Number.isFinite(torrent.timeRemaining)
        ? torrent.timeRemaining
        : null;
      record.ratio = Number(torrent.ratio || 0);
      if (torrent.ready) {
        record.files = torrent.files.map((file, index) => ({
          index,
          name: file.name,
          path: file.path,
          length: file.length,
          downloaded: file.downloaded,
          progress: file.progress,
          selected: record.fileSelection?.[index]?.selected !== false,
          priority: record.fileSelection?.[index]?.priority ?? 0,
        }));
      }
      if (torrent.done && record.state !== "seeding") {
        record.completedAt ||= Date.now();
        record.state = this.settings.seedCompleted ? "seeding" : "complete";
        changed = true;
        if (!this.settings.seedCompleted) {
          this.stopRuntime(record).catch(error => {
            record.error = error.message;
          });
        }
      }
    }
    if (persist && changed) {
      this.persist().catch(() => {});
      this.reconcile().catch(() => {});
    }
  }

  async add({ source, torrent, downloadPath }) {
    if ((!source && !torrent) || (source && torrent)) {
      throw new Error("Supply one magnet/URL or one torrent payload");
    }
    if (source && !/^(magnet:|https?:\/\/)/i.test(source)) {
      throw new Error("Only magnet and HTTP(S) torrent sources are supported");
    }
    const id = randomUUID();
    let metainfoPath = null;
    if (torrent) {
      const bytes = Buffer.from(torrent, "base64");
      if (!bytes.length || bytes.length > MAX_BODY_SIZE) {
        throw new Error("Invalid or oversized torrent metadata");
      }
      metainfoPath = join(this.metainfoDirectory, `${id}.torrent`);
      await writeFile(metainfoPath, bytes, { mode: 0o600 });
    }
    const destination = resolve(
      downloadPath || this.settings.downloadDirectory
    );
    await mkdir(destination, { recursive: true });
    const record = {
      id,
      source: source || null,
      metainfoPath,
      name: source?.startsWith("magnet:")
        ? magnetName(source)
        : basename(source || "Torrent"),
      downloadPath: destination,
      state: "queued",
      forceStart: false,
      priority: 0,
      addedAt: Date.now(),
      completedAt: null,
      infoHash: null,
      length: 0,
      downloaded: 0,
      uploaded: 0,
      progress: 0,
      ratio: 0,
      downloadSpeed: 0,
      uploadSpeed: 0,
      numPeers: 0,
      timeRemaining: null,
      trackers: [],
      files: [],
      fileSelection: [],
      error: null,
      runtime: null,
    };
    this.records.set(id, record);
    await this.persist();
    await this.reconcile();
    return publicRecord(record, true, this.settings.torEnabled);
  }

  async inputFor(record) {
    if (record.metainfoPath) {
      return readFile(record.metainfoPath);
    }
    if (this.settings.torEnabled && record.source.startsWith("magnet:")) {
      const magnet = new URL(record.source);
      for (const name of ["as", "ws", "xs"]) {
        magnet.searchParams.delete(name);
      }
      return magnet.href;
    }
    if (this.settings.torEnabled && /^https?:\/\//i.test(record.source)) {
      return requestThroughAgent(record.source, this.torAgent);
    }
    return record.source;
  }

  async startRuntime(record) {
    if (record.runtime) {
      return;
    }
    record.state = "metadata";
    record.error = null;
    const input = await this.inputFor(record);
    const torrent = this.client.add(input, {
      path: record.downloadPath,
      destroyStoreOnDestroy: false,
    });
    record.runtime = torrent;
    torrent.on("infoHash", () => {
      record.infoHash = torrent.infoHash;
      record.state = "checking";
    });
    torrent.on("ready", () => {
      if (torrent.files.some(file => !safeFilePath(file.path))) {
        record.error = "Torrent contains an unsafe file path";
        record.state = "error";
        this.stopRuntime(record).catch(() => {});
        return;
      }
      record.name = torrent.name || record.name;
      record.length = torrent.length;
      record.trackers = [...torrent.announce];
      record.state = torrent.done ? "seeding" : "downloading";
      record.fileSelection ||= [];
      torrent.files.forEach((file, index) => {
        const selection = record.fileSelection[index] || {
          selected: true,
          priority: 0,
        };
        record.fileSelection[index] = selection;
        file.deselect();
        if (selection.selected) {
          file.select(selection.priority);
        }
      });
      this.persist().catch(() => {});
    });
    torrent.on("warning", error => {
      record.warning = error.message;
    });
    torrent.on("error", error => {
      record.error = error.message;
      record.state = "error";
      record.runtime = null;
      this.persist().catch(() => {});
      this.reconcile().catch(() => {});
    });
    torrent.on("done", () => {
      record.completedAt ||= Date.now();
      record.state = this.settings.seedCompleted ? "seeding" : "complete";
      this.persist().catch(() => {});
      if (!this.settings.seedCompleted) {
        this.stopRuntime(record).catch(() => {});
      }
      this.reconcile().catch(() => {});
    });
  }

  async stopRuntime(record, destroyStore = false) {
    const torrent = record.runtime;
    record.runtime = null;
    record.downloadSpeed = 0;
    record.uploadSpeed = 0;
    record.numPeers = 0;
    if (torrent && !torrent.destroyed) {
      await new Promise((resolve, reject) => {
        this.client.remove(torrent, { destroyStore }, error =>
          error ? reject(error) : resolve()
        );
      });
    }
  }

  async reconcile() {
    const active = [...this.records.values()].filter(record => record.runtime);
    let available = Math.max(
      0,
      this.settings.maxActive -
        active.filter(record => !record.forceStart).length
    );
    const queued = [...this.records.values()]
      .filter(record => record.state === "queued" && !record.runtime)
      .sort(
        (a, b) =>
          Number(b.forceStart) - Number(a.forceStart) ||
          b.priority - a.priority ||
          a.addedAt - b.addedAt
      );
    for (const record of queued) {
      if (!record.forceStart && available <= 0) {
        continue;
      }
      if (!record.forceStart) {
        available--;
      }
      try {
        await this.startRuntime(record);
      } catch (error) {
        record.error = error.message;
        record.state = "error";
      }
    }
    await this.persist();
  }

  async action(id, action, payload = {}) {
    const record = this.records.get(id);
    if (!record) {
      throw new Error("Torrent not found");
    }
    switch (action) {
      case "pause":
      case "stop":
        await this.stopRuntime(record);
        record.state = action === "pause" ? "paused" : "stopped";
        record.forceStart = false;
        break;
      case "resume":
      case "start":
        record.state = "queued";
        record.forceStart = false;
        break;
      case "force-start":
        record.state = "queued";
        record.forceStart = true;
        break;
      case "reannounce": {
        const discovery = record.runtime?.discovery;
        discovery?.tracker?.update?.();
        discovery?.dhtAnnounce?.();
        break;
      }
      case "add-peer":
        if (!record.runtime || typeof payload.peer !== "string") {
          throw new Error("An active torrent and peer address are required");
        }
        record.runtime.addPeer(payload.peer, "manual");
        break;
      default:
        throw new Error("Unknown torrent action");
    }
    await this.persist();
    await this.reconcile();
    return publicRecord(record, true, this.settings.torEnabled);
  }

  async updateRecord(id, update) {
    const record = this.records.get(id);
    if (!record) {
      throw new Error("Torrent not found");
    }
    if (update.priority !== undefined) {
      record.priority = clampInteger(update.priority, -100, 100);
    }
    if (Array.isArray(update.files)) {
      for (const item of update.files) {
        const index = clampInteger(item.index, 0, 100000);
        const selected = item.selected !== false;
        const priority = clampInteger(item.priority ?? 0, -100, 100);
        record.fileSelection[index] = { selected, priority };
        const file = record.runtime?.files[index];
        if (file) {
          file.deselect();
          if (selected) {
            file.select(priority);
          }
        }
      }
    }
    await this.persist();
    return publicRecord(record, true, this.settings.torEnabled);
  }

  async updateSettings(update) {
    let rebuild = false;
    if (update.torEnabled !== undefined) {
      const enabled = Boolean(update.torEnabled);
      const proxy = enabled ? torProxy(update.torProxy) : null;
      rebuild =
        enabled !== this.settings.torEnabled ||
        proxy?.host !== this.torProxy?.host ||
        proxy?.port !== this.torProxy?.port;
      this.settings.torEnabled = enabled;
      this.torProxy = proxy;
    }
    if (update.maxActive !== undefined) {
      this.settings.maxActive = clampInteger(update.maxActive, 1, 50);
    }
    if (update.downloadLimit !== undefined) {
      this.settings.downloadLimit = Number(update.downloadLimit);
      if (!rebuild) {
        this.client.throttleDownload(this.settings.downloadLimit);
      }
    }
    if (update.uploadLimit !== undefined) {
      this.settings.uploadLimit = Number(update.uploadLimit);
      if (!rebuild) {
        this.client.throttleUpload(this.settings.uploadLimit);
      }
    }
    if (update.seedCompleted !== undefined) {
      this.settings.seedCompleted = Boolean(update.seedCompleted);
    }
    if (
      typeof update.downloadDirectory === "string" &&
      update.downloadDirectory
    ) {
      this.settings.downloadDirectory = resolve(update.downloadDirectory);
      await mkdir(this.settings.downloadDirectory, { recursive: true });
    }
    if (rebuild) {
      await this.rebuildClient();
    }
    this.config = {
      ...this.config,
      ...this.settings,
      torProxy: this.torProxy,
    };
    await writeJSON(this.configPath, this.config);
    await this.persist();
    await this.reconcile();
    return this.settings;
  }

  async rebuildClient() {
    const active = [...this.records.values()].filter(record => record.runtime);
    for (const record of active) {
      await this.stopRuntime(record);
      record.state = "queued";
    }
    const client = this.client;
    await new Promise(resolve => client.destroy(() => resolve()));
    this.client = this.createClient();
  }

  async remove(id, deleteData) {
    const record = this.records.get(id);
    if (!record) {
      throw new Error("Torrent not found");
    }
    await this.stopRuntime(record, deleteData);
    if (deleteData && record.files.length) {
      for (const file of record.files) {
        if (safeFilePath(file.path)) {
          await rm(join(record.downloadPath, file.path), { force: true });
        }
      }
    }
    if (record.metainfoPath) {
      await rm(record.metainfoPath, { force: true });
    }
    this.records.delete(id);
    await this.persist();
    await this.reconcile();
  }

  async close() {
    clearInterval(this.timer);
    await this.persist();
    await new Promise(resolve => this.client.destroy(() => resolve()));
  }
}

async function requestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_SIZE * 2) {
      throw new Error("Request body is too large");
    }
    chunks.push(chunk);
  }
  if (!chunks.length) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(response, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": data.length,
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(data);
}

async function serve(configPath) {
  ({ default: WebTorrent } = await import("webtorrent"));
  const config = await readJSON(configPath, null);
  if (
    !config?.dataDirectory ||
    !config?.connectionPath ||
    !config?.downloadDirectory
  ) {
    throw new Error("Invalid torrent service configuration");
  }
  const token = randomBytes(32).toString("hex");
  const engine = new TorrentEngine(config, configPath);
  await engine.initialize();
  let shuttingDown = false;
  const server = createServer(async (request, response) => {
    try {
      if (request.headers.authorization !== `Bearer ${token}`) {
        send(response, 401, { error: "Unauthorized" });
        return;
      }
      const url = new URL(request.url, "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/v1/status") {
        send(response, 200, engine.snapshot());
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/torrents") {
        send(response, 201, await engine.add(await requestBody(request)));
        return;
      }
      if (request.method === "PATCH" && url.pathname === "/v1/settings") {
        send(
          response,
          200,
          await engine.updateSettings(await requestBody(request))
        );
        return;
      }
      const match = /^\/v1\/torrents\/([0-9a-f-]+)(?:\/(action))?$/.exec(
        url.pathname
      );
      if (match && request.method === "POST" && match[2] === "action") {
        const body = await requestBody(request);
        send(response, 200, await engine.action(match[1], body.action, body));
        return;
      }
      if (match && request.method === "PATCH" && !match[2]) {
        send(
          response,
          200,
          await engine.updateRecord(match[1], await requestBody(request))
        );
        return;
      }
      if (match && request.method === "DELETE" && !match[2]) {
        await engine.remove(
          match[1],
          url.searchParams.get("deleteData") === "true"
        );
        send(response, 200, { ok: true });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/shutdown") {
        send(response, 200, { ok: true });
        setImmediate(() => shutdown());
        return;
      }
      send(response, 404, { error: "Not found" });
    } catch (error) {
      send(response, 400, { error: error.message });
    }
  });
  server.on("error", error => {
    console.error(error);
    process.exitCode = 1;
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const runtimeDirectory = resolve(dirname(process.argv[1]), "..");
  await writeJSON(config.connectionPath, {
    version: API_VERSION,
    pid: process.pid,
    port: address.port,
    token,
    runtimeDirectory,
    startedAt: Date.now(),
  });

  async function shutdown() {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    server.close();
    await engine.close();
    await rm(config.connectionPath, { force: true });
    process.exit(0);
  }

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

async function health(connectionPath) {
  const connection = await readJSON(connectionPath, null);
  if (!connection?.port || !connection?.token) {
    return false;
  }
  try {
    const response = await fetch(
      `http://127.0.0.1:${connection.port}/v1/status`,
      {
        headers: { authorization: `Bearer ${connection.token}` },
        signal: AbortSignal.timeout(1000),
      }
    );
    return response.ok;
  } catch {
    return false;
  }
}

async function start(configPath) {
  const config = await readJSON(configPath, null);
  if (!config?.connectionPath) {
    throw new Error("Invalid torrent service configuration");
  }
  if (await health(config.connectionPath)) {
    return;
  }
  await rm(config.connectionPath, { force: true });
  const child = spawn(
    process.execPath,
    [process.argv[1], "serve", "--config", configPath],
    {
      detached: true,
      stdio: "ignore",
      env: process.env,
    }
  );
  child.unref();
  for (let attempt = 0; attempt < 80; attempt++) {
    await new Promise(resolveWait => setTimeout(resolveWait, 125));
    if (await health(config.connectionPath)) {
      return;
    }
  }
  throw new Error("Torrent service did not become ready");
}

const command = process.argv[2] || "serve";
const configPath = resolve(
  argument(
    "--config",
    join(homedir(), ".config", "wildbuzzard", "torrent", "config.json")
  )
);

if (command === "start") {
  await start(configPath);
} else if (command === "status") {
  const config = await readJSON(configPath, null);
  process.exitCode = config && (await health(config.connectionPath)) ? 0 : 1;
} else if (command === "serve") {
  await serve(configPath);
} else {
  throw new Error(`Unknown command: ${command}`);
}
