#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  mkdir,
  open,
  readFile,
  realpath,
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
let parseTorrent;

const API_VERSION = 1;
const MAX_BODY_SIZE = 12 * 1024 * 1024;
const MAX_BENCODE_DEPTH = 64;
const MAX_FILE_COUNT = 10000;
const MAX_PATH_BYTES = 4096;
const MAX_PATH_COMPONENT_BYTES = 255;
const MAX_TOTAL_SIZE = 16 * 1024 ** 4;
const DRAFT_TTL_MS = 120000;
const API_RATE_BURST = 120;
const API_RATE_PER_SECOND = 30;
const MAX_API_CONCURRENCY = 16;
const MAX_MUTATION_CONCURRENCY = 4;
const LOCK_STALE_MS = 30000;

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

function delay(milliseconds) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
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

async function pidStartTime(pid) {
  if (!Number.isInteger(pid) || pid < 1) {
    return null;
  }
  try {
    return parsePidStartTime(await readFile(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return null;
  }
}

async function processIdentityMatches(pid, startTime) {
  return Boolean(startTime) && (await pidStartTime(pid)) === String(startTime);
}

async function staticServiceIdentity(config) {
  await mkdir(config.dataDirectory, { recursive: true });
  const executable = await realpath(process.execPath);
  return {
    ownerInstance: config.ownerInstance,
    runtimeDirectory: await realpath(resolve(dirname(process.argv[1]), "..")),
    executable,
    executableSha256: await sha256File(executable),
    dataRoot: await realpath(config.dataDirectory),
  };
}

function sameStaticIdentity(candidate, expected) {
  return Boolean(
    candidate &&
    expected &&
    candidate.ownerInstance === expected.ownerInstance &&
    candidate.runtimeDirectory === expected.runtimeDirectory &&
    candidate.executable === expected.executable &&
    candidate.executableSha256 === expected.executableSha256 &&
    candidate.dataRoot === expected.dataRoot
  );
}

async function removeIfUnchanged(path, expected) {
  const current = await readJSON(path, null);
  if (
    !current ||
    (expected.instanceId && current.instanceId !== expected.instanceId) ||
    (!expected.instanceId &&
      JSON.stringify(current) !== JSON.stringify(expected))
  ) {
    return false;
  }
  await rm(path, { force: true });
  return true;
}

async function acquireLock(path, { wait = true } = {}) {
  await mkdir(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < (wait ? 200 : 2); attempt++) {
    const owner = {
      pid: process.pid,
      pidStartTime: await pidStartTime(process.pid),
      nonce: randomBytes(16).toString("hex"),
      createdAt: Date.now(),
    };
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(owner)}\n`);
      await handle.sync();
      return { handle, owner, path };
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
    }
    const existing = await readJSON(path, null);
    const active = await processIdentityMatches(
      existing?.pid,
      existing?.pidStartTime
    );
    const age = Date.now() - Number(existing?.createdAt || 0);
    if (!active && age >= LOCK_STALE_MS) {
      await removeIfUnchanged(path, existing || {}).catch(() => {});
      continue;
    }
    if (!wait) {
      throw new Error("Torrent service is already starting or running");
    }
    await delay(100);
  }
  throw new Error("Timed out waiting for the torrent service lock");
}

async function releaseLock(lock) {
  if (!lock) {
    return;
  }
  await lock.handle.close().catch(() => {});
  const current = await readJSON(lock.path, null);
  if (current?.nonce === lock.owner.nonce) {
    await rm(lock.path, { force: true });
  }
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

function bencodeError() {
  return new Error("Invalid torrent metadata");
}

function scanBencodeString(bytes, offset) {
  const colon = bytes.indexOf(58, offset);
  if (colon === -1 || colon - offset > 16) {
    throw bencodeError();
  }
  const value = bytes.subarray(offset, colon).toString("ascii");
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw bencodeError();
  }
  const length = Number(value);
  const end = colon + 1 + length;
  if (!Number.isSafeInteger(length) || end > bytes.length) {
    throw bencodeError();
  }
  return end;
}

function scanBencodeValue(bytes, offset, depth) {
  if (depth > MAX_BENCODE_DEPTH || offset >= bytes.length) {
    throw bencodeError();
  }
  const token = bytes[offset];
  if (token >= 48 && token <= 57) {
    return scanBencodeString(bytes, offset);
  }
  if (token === 105) {
    const end = bytes.indexOf(101, offset + 1);
    if (end === -1 || end - offset > 32) {
      throw bencodeError();
    }
    const value = bytes.subarray(offset + 1, end).toString("ascii");
    if (!/^(?:0|-?[1-9][0-9]*)$/.test(value)) {
      throw bencodeError();
    }
    const number = Number(value);
    if (!Number.isSafeInteger(number)) {
      throw bencodeError();
    }
    return end + 1;
  }
  if (token !== 108 && token !== 100) {
    throw bencodeError();
  }
  let cursor = offset + 1;
  while (cursor < bytes.length && bytes[cursor] !== 101) {
    if (token === 100) {
      cursor = scanBencodeString(bytes, cursor);
    }
    cursor = scanBencodeValue(bytes, cursor, depth + 1);
  }
  if (cursor >= bytes.length) {
    throw bencodeError();
  }
  return cursor + 1;
}

function validateBencode(bytes) {
  if (!bytes.length || scanBencodeValue(bytes, 0, 0) !== bytes.length) {
    throw bencodeError();
  }
}

function canonicalTorrentPath(path) {
  if (
    typeof path !== "string" ||
    !path ||
    path.includes("\0") ||
    Buffer.byteLength(path) > MAX_PATH_BYTES ||
    /^[\\/]/.test(path) ||
    /^[a-z]:/i.test(path)
  ) {
    throw new Error("Torrent contains an unsafe file path");
  }
  const parts = path.normalize("NFC").split(/[\\/]/);
  for (const part of parts) {
    if (
      !part ||
      part === "." ||
      part === ".." ||
      Buffer.byteLength(part) > MAX_PATH_COMPONENT_BYTES ||
      /[<>:"|?*]/.test(part) ||
      /[ .]$/.test(part) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
    ) {
      throw new Error("Torrent contains an unsafe file path");
    }
  }
  return parts.map(part => part.toLowerCase()).join("/");
}

async function validatedTorrentMetadata(bytes) {
  if (!Buffer.isBuffer(bytes)) {
    bytes = Buffer.from(bytes);
  }
  if (!bytes.length || bytes.length > MAX_BODY_SIZE) {
    throw new Error("Invalid or oversized torrent metadata");
  }
  validateBencode(bytes);
  let parsed;
  try {
    parsed = await parseTorrent(bytes);
  } catch {
    throw bencodeError();
  }
  if (
    !parsed.name ||
    !Array.isArray(parsed.files) ||
    !parsed.files.length ||
    parsed.files.length > MAX_FILE_COUNT ||
    !Number.isSafeInteger(parsed.length) ||
    parsed.length <= 0 ||
    parsed.length > MAX_TOTAL_SIZE ||
    !Number.isSafeInteger(parsed.pieceLength) ||
    parsed.pieceLength < 16 * 1024 ||
    parsed.pieceLength > 32 * 1024 * 1024 ||
    (parsed.pieceLength & (parsed.pieceLength - 1)) !== 0 ||
    parsed.info?.pieces?.byteLength % 20 !== 0 ||
    parsed.pieces.length !== Math.ceil(parsed.length / parsed.pieceLength)
  ) {
    throw bencodeError();
  }
  let totalSize = 0;
  const paths = [];
  for (const file of parsed.files) {
    if (!Number.isSafeInteger(file.length) || file.length < 0) {
      throw bencodeError();
    }
    totalSize += file.length;
    if (!Number.isSafeInteger(totalSize) || totalSize > MAX_TOTAL_SIZE) {
      throw bencodeError();
    }
    paths.push(canonicalTorrentPath(file.path));
  }
  if (totalSize !== parsed.length) {
    throw bencodeError();
  }
  const pathSet = new Set(paths);
  if (pathSet.size !== paths.length) {
    throw new Error("Torrent contains colliding file paths");
  }
  for (const path of pathSet) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index++) {
      if (pathSet.has(parts.slice(0, index).join("/"))) {
        throw new Error("Torrent contains colliding file paths");
      }
    }
    if (parts.some(part => !part)) {
      throw new Error("Torrent contains colliding file paths");
    }
  }
  return parsed;
}

function decodeTorrentPayload(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > Math.ceil((MAX_BODY_SIZE * 4) / 3) + 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    throw new Error("Invalid or oversized torrent metadata");
  }
  const bytes = Buffer.from(value, "base64");
  if (
    bytes.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")
  ) {
    throw new Error("Invalid or oversized torrent metadata");
  }
  return bytes;
}

async function validatedMagnet(value, omitted = new Set()) {
  if (typeof value !== "string" || value.length > 65536) {
    throw new Error("Invalid magnet link");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid magnet link");
  }
  if (url.protocol !== "magnet:" || [...url.searchParams].length > 256) {
    throw new Error("Invalid magnet link");
  }
  const parameters = [];
  for (const [rawName, decodedValue] of url.searchParams) {
    const name = rawName.toLowerCase();
    if (
      omitted.has(name) ||
      !/^[a-z0-9.]{1,16}$/.test(name) ||
      decodedValue.length > 8192
    ) {
      continue;
    }
    const valuePart = ["xt", "x.pe"].includes(name)
      ? decodedValue
      : encodeURIComponent(decodedValue).replace(/%20/g, "+");
    parameters.push(`${name}=${valuePart}`);
  }
  const normalized = `magnet:?${parameters.join("&")}`;
  let parsed;
  try {
    parsed = await parseTorrent(normalized);
  } catch {
    throw new Error("Invalid magnet link");
  }
  if (!/^[0-9a-f]{40}$/.test(parsed.infoHash)) {
    throw new Error("Invalid magnet link");
  }
  return normalized;
}

function publicDraft(draft) {
  return {
    draftId: draft.draftId,
    state: draft.state,
    name: draft.name,
    totalSize: draft.totalSize,
    files: draft.files,
    private: draft.private,
    createdAt: draft.createdAt,
    expiresAt: draft.expiresAt,
    precommitPayloadBytes: draft.precommitPayloadBytes,
    error: draft.error,
  };
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
  const { runtime, metainfoPath, validatedMetadata, ...result } = record;
  result.connections = includeConnections
    ? connectionsFor(record, torEnabled)
    : [];
  result.discovery = {
    private: Boolean(record.private),
    dht: Boolean(runtime?.discovery?.dht),
    pex: Boolean(runtime && !runtime.private && runtime.client.utPex),
  };
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
    if (!["http:", "https:"].includes(parsed.protocol)) {
      reject(new Error("Torrent request redirected to an unsafe protocol"));
      return;
    }
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
    this.draftDirectory = join(this.dataDirectory, "drafts");
    this.connectionPath = config.connectionPath;
    this.draftTtlMs = clampInteger(
      config.draftTtlMs ?? DRAFT_TTL_MS,
      100,
      DRAFT_TTL_MS
    );
    this.records = new Map();
    this.drafts = new Map();
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
    await rm(this.draftDirectory, { recursive: true, force: true });
    await mkdir(this.draftDirectory, { recursive: true });
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
    this.draftTimer = setInterval(() => {
      this.cleanupExpiredDrafts().catch(error => {
        this.lastError = error.message;
      });
    }, 1000);
    this.draftTimer.unref();
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
      serviceIdentity: this.serviceIdentity,
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
      draftCount: this.drafts.size,
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

  async cleanupDraftRuntime(draft) {
    if (!draft.cleanupTask) {
      draft.cleanupTask = (async () => {
        const torrent = draft.runtime;
        draft.runtime = null;
        if (torrent && !torrent.destroyed) {
          await new Promise(resolveCleanup => {
            this.client.remove(torrent, { destroyStore: true }, () =>
              resolveCleanup()
            );
          });
        }
        await rm(draft.stagingPath, { recursive: true, force: true });
      })();
    }
    return draft.cleanupTask;
  }

  async failDraft(draft, error) {
    if (
      this.drafts.get(draft.draftId) !== draft ||
      !["metadata", "ready"].includes(draft.state)
    ) {
      return;
    }
    draft.state = "error";
    draft.error = error.message || String(error);
    await this.cleanupDraftRuntime(draft);
  }

  async populateDraft(draft, bytes) {
    const parsed = await validatedTorrentMetadata(bytes);
    draft.torrent = Buffer.from(bytes);
    draft.name = parsed.name;
    draft.totalSize = parsed.length;
    draft.private = Boolean(parsed.private);
    draft.files = parsed.files.map((file, index) => ({
      index,
      name: file.name,
      path: file.path,
      length: file.length,
    }));
    draft.state = "ready";
    draft.error = null;
  }

  async startMagnetDraft(draft, magnet) {
    await mkdir(draft.stagingPath, { recursive: true });
    const torrent = this.client.add(magnet, {
      path: draft.stagingPath,
      deselect: true,
      destroyStoreOnDestroy: true,
    });
    draft.runtime = torrent;
    torrent.on("wire", wire => {
      wire.on("piece", (_index, _offset, bytes) => {
        draft.precommitPayloadBytes += Number(bytes?.length) || 0;
        this.failDraft(
          draft,
          new Error(
            `Torrent payload arrived before the draft was committed (${draft.precommitPayloadBytes} bytes)`
          )
        ).catch(() => {});
      });
    });
    torrent.once("metadata", () => {
      Promise.resolve()
        .then(async () => {
          if (!this.drafts.has(draft.draftId) || draft.state !== "metadata") {
            return;
          }
          if (draft.precommitPayloadBytes || torrent.downloaded) {
            throw new Error(
              "Torrent payload arrived before the draft was committed"
            );
          }
          if (
            !torrent.torrentFile ||
            torrent.torrentFile.byteLength > MAX_BODY_SIZE
          ) {
            throw new Error("Invalid or oversized torrent metadata");
          }
          const torrentFile = Buffer.from(torrent.torrentFile);
          await this.cleanupDraftRuntime(draft);
          if (
            this.drafts.get(draft.draftId) !== draft ||
            draft.state !== "metadata"
          ) {
            return;
          }
          if (draft.precommitPayloadBytes) {
            throw new Error(
              "Torrent payload arrived before the draft was committed"
            );
          }
          await this.populateDraft(draft, torrentFile);
        })
        .catch(error => this.failDraft(draft, error));
    });
    torrent.once("error", error => {
      this.failDraft(draft, error).catch(() => {});
    });
  }

  async createDraft({ magnet, torrent }) {
    if ((magnet === undefined) === (torrent === undefined)) {
      throw new Error("Supply one magnet or one torrent payload");
    }
    const draftId = randomUUID();
    const draft = {
      draftId,
      state: "metadata",
      name: magnet ? magnetName(magnet) : "Torrent",
      totalSize: null,
      files: [],
      private: false,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.draftTtlMs,
      precommitPayloadBytes: 0,
      error: null,
      torrent: null,
      runtime: null,
      cleanupTask: null,
      stagingPath: join(this.draftDirectory, draftId),
    };
    this.drafts.set(draftId, draft);
    try {
      if (torrent !== undefined) {
        await this.populateDraft(draft, decodeTorrentPayload(torrent));
      } else {
        const omitted = this.settings.torEnabled
          ? new Set(["as", "ws", "xs"])
          : new Set();
        await this.startMagnetDraft(
          draft,
          await validatedMagnet(magnet, omitted)
        );
      }
      return publicDraft(draft);
    } catch (error) {
      this.drafts.delete(draftId);
      await this.cleanupDraftRuntime(draft);
      throw error;
    }
  }

  getDraft(id) {
    const draft = this.drafts.get(id);
    if (!draft) {
      throw new Error("Torrent draft not found");
    }
    if (Date.now() >= draft.expiresAt) {
      this.drafts.delete(id);
      draft.state = "expired";
      this.cleanupDraftRuntime(draft).catch(error => {
        this.lastError = error.message;
      });
      throw new Error("Torrent draft expired");
    }
    return publicDraft(draft);
  }

  async cancelDraft(id) {
    const draft = this.drafts.get(id);
    if (!draft) {
      throw new Error("Torrent draft not found");
    }
    this.drafts.delete(id);
    draft.state = "cancelled";
    await this.cleanupDraftRuntime(draft);
    return { ok: true };
  }

  async cleanupExpiredDrafts() {
    const expired = [...this.drafts.values()].filter(
      draft => Date.now() >= draft.expiresAt
    );
    await Promise.allSettled(
      expired.map(draft => this.cancelDraft(draft.draftId))
    );
  }

  async commitDraft(id, { files, downloadPath }) {
    const draft = this.drafts.get(id);
    if (!draft) {
      throw new Error("Torrent draft not found");
    }
    if (Date.now() >= draft.expiresAt) {
      this.drafts.delete(id);
      draft.state = "expired";
      await this.cleanupDraftRuntime(draft);
      throw new Error("Torrent draft expired");
    }
    if (draft.state !== "ready" || !draft.torrent) {
      throw new Error("Torrent metadata is not ready");
    }
    const selection = files === undefined ? undefined : files;
    if (
      selection !== undefined &&
      (!Array.isArray(files) ||
        new Set(selection).size !== selection.length ||
        selection.some(
          index =>
            !Number.isInteger(index) || index < 0 || index >= draft.files.length
        ))
    ) {
      throw new Error("Invalid torrent file selection");
    }
    this.drafts.delete(id);
    draft.state = "committing";
    try {
      return await this.add({
        torrent: draft.torrent.toString("base64"),
        downloadPath,
        files: selection,
      });
    } finally {
      await this.cleanupDraftRuntime(draft);
    }
  }

  async add({ source, torrent, downloadPath, files }) {
    if ((!source && !torrent) || (source && torrent)) {
      throw new Error("Supply one magnet/URL or one torrent payload");
    }
    if (source && !/^(magnet:|https?:\/\/)/i.test(source)) {
      throw new Error("Only magnet and HTTP(S) torrent sources are supported");
    }
    if (source?.startsWith("magnet:")) {
      source = await validatedMagnet(source);
    }
    const id = randomUUID();
    let metainfoPath = null;
    let parsed = null;
    if (torrent) {
      const bytes = decodeTorrentPayload(torrent);
      parsed = await validatedTorrentMetadata(bytes);
      metainfoPath = join(this.metainfoDirectory, `${id}.torrent`);
      await writeFile(metainfoPath, bytes, { mode: 0o600 });
    }
    let selectedFiles;
    if (files !== undefined) {
      if (
        !parsed ||
        !Array.isArray(files) ||
        new Set(files).size !== files.length ||
        files.some(
          index =>
            !Number.isInteger(index) ||
            index < 0 ||
            index >= parsed.files.length
        )
      ) {
        throw new Error("Invalid torrent file selection");
      }
      selectedFiles = new Set(files);
    }
    const destination = resolve(
      downloadPath || this.settings.downloadDirectory
    );
    await mkdir(destination, { recursive: true });
    const record = {
      id,
      source: source || null,
      metainfoPath,
      name:
        parsed?.name ||
        (source?.startsWith("magnet:")
          ? magnetName(source)
          : basename(source || "Torrent")),
      downloadPath: destination,
      state: "queued",
      forceStart: false,
      priority: 0,
      addedAt: Date.now(),
      completedAt: null,
      infoHash: null,
      length: parsed?.length || 0,
      downloaded: 0,
      uploaded: 0,
      progress: 0,
      ratio: 0,
      downloadSpeed: 0,
      uploadSpeed: 0,
      numPeers: 0,
      timeRemaining: null,
      trackers: parsed ? [...parsed.announce] : [],
      files:
        parsed?.files.map((file, index) => ({
          index,
          name: file.name,
          path: file.path,
          length: file.length,
          downloaded: 0,
          progress: 0,
          selected: selectedFiles ? selectedFiles.has(index) : true,
          priority: 0,
        })) || [],
      fileSelection:
        parsed?.files.map((_, index) => ({
          selected: selectedFiles ? selectedFiles.has(index) : true,
          priority: 0,
        })) || [],
      private: parsed ? Boolean(parsed.private) : null,
      validatedMetadata: Boolean(parsed),
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
      return validatedMagnet(record.source, new Set(["as", "ws", "xs"]));
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
      deselect: true,
      destroyStoreOnDestroy: false,
    });
    record.runtime = torrent;
    torrent.on("infoHash", () => {
      record.infoHash = torrent.infoHash;
      record.state = "checking";
    });
    torrent.on("ready", () => {
      Promise.resolve()
        .then(async () => {
          if (!record.validatedMetadata) {
            const parsed = await validatedTorrentMetadata(
              Buffer.from(torrent.torrentFile)
            );
            record.private = Boolean(parsed.private);
            record.validatedMetadata = true;
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
          await this.persist();
        })
        .catch(error => {
          record.error = error.message;
          record.state = "error";
          this.stopRuntime(record).catch(() => {});
        });
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
    for (const draft of [...this.drafts.values()]) {
      await this.cancelDraft(draft.draftId);
    }
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
    clearInterval(this.draftTimer);
    for (const draft of [...this.drafts.values()]) {
      await this.cancelDraft(draft.draftId);
    }
    await this.persist();
    await new Promise(resolve => this.client.destroy(() => resolve()));
  }
}

async function requestBody(request) {
  const declaredSize = Number(request.headers["content-length"] || 0);
  if (
    !Number.isFinite(declaredSize) ||
    declaredSize < 0 ||
    declaredSize > MAX_BODY_SIZE * 2
  ) {
    throw new Error("Request body is too large");
  }
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
  if (response.headersSent || response.destroyed) {
    return;
  }
  const data = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": data.length,
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(data);
}

function validBearer(value, token) {
  const prefix = "Bearer ";
  const supplied = Buffer.from(
    typeof value === "string" && value.startsWith(prefix)
      ? value.slice(prefix.length)
      : ""
  );
  const expected = Buffer.from(token);
  const comparable = Buffer.alloc(expected.length);
  supplied.copy(comparable, 0, 0, expected.length);
  const equal = timingSafeEqual(comparable, expected);
  return supplied.length === expected.length && equal;
}

function fullIdentityMatches(candidate, expected) {
  return Boolean(
    sameStaticIdentity(candidate, expected) &&
    candidate.instanceId === expected.instanceId &&
    candidate.pid === expected.pid &&
    String(candidate.pidStartTime) === String(expected.pidStartTime)
  );
}

function createRateLimiter() {
  let tokens = API_RATE_BURST;
  let lastRefill = Date.now();
  return () => {
    const now = Date.now();
    tokens = Math.min(
      API_RATE_BURST,
      tokens + ((now - lastRefill) / 1000) * API_RATE_PER_SECOND
    );
    lastRefill = now;
    if (tokens < 1) {
      return false;
    }
    tokens--;
    return true;
  };
}

async function serve(configPath) {
  ({ default: parseTorrent } = await import("parse-torrent"));
  ({ default: WebTorrent } = await import("webtorrent"));
  const config = await readJSON(configPath, null);
  if (
    !config?.dataDirectory ||
    !config?.connectionPath ||
    !config?.downloadDirectory ||
    typeof config.ownerInstance !== "string" ||
    !/^[0-9A-Za-z._-]{16,128}$/.test(config.ownerInstance)
  ) {
    throw new Error("Invalid torrent service configuration");
  }
  const staticIdentity = await staticServiceIdentity(config);
  const serviceLock = await acquireLock(
    `${config.connectionPath}.service.lock`,
    {
      wait: false,
    }
  );
  const oldConnection = await readJSON(config.connectionPath, null);
  if (oldConnection) {
    if (
      await processIdentityMatches(
        oldConnection.pid,
        oldConnection.pidStartTime
      )
    ) {
      await releaseLock(serviceLock);
      throw new Error("A torrent service already owns this connection path");
    }
    await removeIfUnchanged(config.connectionPath, oldConnection);
  }
  const token = randomBytes(32).toString("hex");
  const serviceIdentity = {
    ...staticIdentity,
    instanceId: randomUUID(),
    pid: process.pid,
    pidStartTime: await pidStartTime(process.pid),
  };
  const engine = new TorrentEngine(config, configPath);
  try {
    await engine.initialize();
  } catch (error) {
    await releaseLock(serviceLock);
    throw error;
  }
  engine.serviceIdentity = serviceIdentity;
  let shuttingDown = false;
  let inFlight = 0;
  let mutationsInFlight = 0;
  const consumeRateToken = createRateLimiter();

  async function handleRequest(request, response) {
    const url = new URL(request.url, "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/v1/status") {
      send(response, 200, engine.snapshot());
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/torrent-drafts") {
      send(response, 201, await engine.createDraft(await requestBody(request)));
      return;
    }
    const draftMatch =
      /^\/v1\/torrent-drafts\/([0-9a-f-]+)(?:\/(commit))?$/.exec(url.pathname);
    if (draftMatch && request.method === "GET" && !draftMatch[2]) {
      send(response, 200, engine.getDraft(draftMatch[1]));
      return;
    }
    if (draftMatch && request.method === "POST" && draftMatch[2]) {
      send(
        response,
        201,
        await engine.commitDraft(draftMatch[1], await requestBody(request))
      );
      return;
    }
    if (draftMatch && request.method === "DELETE" && !draftMatch[2]) {
      send(response, 200, await engine.cancelDraft(draftMatch[1]));
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
      setImmediate(() => {
        shutdown().catch(error => {
          console.error(error);
          process.exit(1);
        });
      });
      return;
    }
    send(response, 404, { error: "Not found" });
  }

  const server = createServer((request, response) => {
    const address = server.address();
    const expectedHost = `127.0.0.1:${address.port}`;
    if (request.headers.host !== expectedHost) {
      send(response, 421, { error: "Misdirected request" });
      return;
    }
    if (request.headers.origin !== undefined) {
      send(response, 403, { error: "Browser origins are not allowed" });
      return;
    }
    if (!validBearer(request.headers.authorization, token)) {
      send(response, 401, { error: "Unauthorized" });
      return;
    }
    if (!consumeRateToken()) {
      send(response, 429, { error: "Too many requests" });
      return;
    }
    const isMutation = request.method !== "GET" && request.method !== "HEAD";
    if (
      inFlight >= MAX_API_CONCURRENCY ||
      (isMutation && mutationsInFlight >= MAX_MUTATION_CONCURRENCY)
    ) {
      send(response, 503, { error: "Torrent service is busy" });
      return;
    }
    inFlight++;
    if (isMutation) {
      mutationsInFlight++;
    }
    request.setTimeout(10000, () =>
      request.destroy(new Error("Torrent service request timed out"))
    );
    Promise.resolve(handleRequest(request, response))
      .catch(error => send(response, 400, { error: error.message }))
      .finally(() => {
        inFlight--;
        if (isMutation) {
          mutationsInFlight--;
        }
      });
  });
  server.maxConnections = MAX_API_CONCURRENCY + 8;
  server.headersTimeout = 5000;
  server.requestTimeout = 15000;
  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("error", error => {
    console.error(error);
    process.exitCode = 1;
  });
  try {
    await new Promise((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolveListen);
    });
  } catch (error) {
    await engine.close();
    await releaseLock(serviceLock);
    throw error;
  }
  const address = server.address();
  const connection = {
    version: API_VERSION,
    ...serviceIdentity,
    port: address.port,
    token,
    startedAt: Date.now(),
  };
  try {
    await writeJSON(config.connectionPath, connection);
  } catch (error) {
    await new Promise(resolveClose => server.close(resolveClose));
    await engine.close();
    await releaseLock(serviceLock);
    throw error;
  }

  async function shutdown() {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    await new Promise(resolveClose => server.close(resolveClose));
    try {
      await engine.close();
    } finally {
      await removeIfUnchanged(config.connectionPath, connection).catch(
        () => {}
      );
      await releaseLock(serviceLock);
    }
    process.exit(0);
  }

  const handleSignal = () => {
    shutdown().catch(error => {
      console.error(error);
      process.exit(1);
    });
  };
  process.on("SIGTERM", handleSignal);
  process.on("SIGINT", handleSignal);
}

async function health(connectionPath, expectedStaticIdentity) {
  const connection = await readJSON(connectionPath, null);
  if (
    !connection?.port ||
    !/^[0-9a-f]{64}$/.test(connection?.token || "") ||
    !/^[0-9a-f-]{36}$/.test(connection?.instanceId || "") ||
    !sameStaticIdentity(connection, expectedStaticIdentity) ||
    !(await processIdentityMatches(connection.pid, connection.pidStartTime))
  ) {
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
    if (!response.ok) {
      return false;
    }
    const status = await response.json();
    return fullIdentityMatches(status.serviceIdentity, connection);
  } catch {
    return false;
  }
}

async function start(configPath) {
  const config = await readJSON(configPath, null);
  if (
    !config?.connectionPath ||
    typeof config.ownerInstance !== "string" ||
    !/^[0-9A-Za-z._-]{16,128}$/.test(config.ownerInstance)
  ) {
    throw new Error("Invalid torrent service configuration");
  }
  const expectedIdentity = await staticServiceIdentity(config);
  if (await health(config.connectionPath, expectedIdentity)) {
    return;
  }
  const launchLock = await acquireLock(`${config.connectionPath}.launch.lock`);
  try {
    if (await health(config.connectionPath, expectedIdentity)) {
      return;
    }
    const staleConnection = await readJSON(config.connectionPath, null);
    if (staleConnection) {
      if (
        await processIdentityMatches(
          staleConnection.pid,
          staleConnection.pidStartTime
        )
      ) {
        throw new Error(
          "An unverified live process owns the torrent connection path"
        );
      }
      await removeIfUnchanged(config.connectionPath, staleConnection);
    }
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
      await delay(125);
      if (await health(config.connectionPath, expectedIdentity)) {
        return;
      }
    }
    throw new Error("Torrent service did not become ready");
  } finally {
    await releaseLock(launchLock);
  }
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
  process.exitCode =
    config &&
    config.connectionPath &&
    (await health(config.connectionPath, await staticServiceIdentity(config)))
      ? 0
      : 1;
} else if (command === "serve") {
  await serve(configPath);
} else {
  throw new Error(`Unknown command: ${command}`);
}
