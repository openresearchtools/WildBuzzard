/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { clearTimeout, setTimeout } from "resource://gre/modules/Timer.sys.mjs";

const OPAQUE_ID = /^[A-Za-z0-9_-]{32}$/;
const SEARCH_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_RESULTS = 100;
const MAX_FILES = 10_000;
const TORRENT_ID = /^[0-9a-f]{40}$/i;
const TORRENT_FILTERS = new Set([
  "all",
  "downloading",
  "seeding",
  "completed",
  "stopped",
  "running",
  "active",
  "inactive",
  "stalled",
  "stalled_uploading",
  "stalled_downloading",
  "errored",
]);
const TORRENT_SORTS = new Set([
  "name",
  "size",
  "progress",
  "dlspeed",
  "upspeed",
  "priority",
  "num_seeds",
  "num_leechs",
  "eta",
  "ratio",
  "added_on",
  "completion_on",
]);
const TORRENT_SECTIONS = new Set([
  "overview",
  "files",
  "trackers",
  "peers",
]);
const SEARCH_SORTS = new Set([
  "seeders",
  "leechers",
  "size",
  "published",
  "name",
]);

function requireObject(value, tool) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${tool}: arguments must be an object`);
  }
  return value;
}

function assertKeys(value, allowed, tool) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`${tool}: unexpected argument ${key}`);
    }
  }
}

function boundedText(value, label, maximum) {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > maximum ||
    /\p{Cc}/u.test(normalized)
  ) {
    throw new Error(`${label} must be non-empty, bounded text`);
  }
  return normalized;
}

function cleanExternalText(value, maximum) {
  if (typeof value !== "string") {
    throw new Error("Torrent service returned invalid data");
  }
  return [...value.normalize("NFC")]
    .filter(character => !/\p{Cc}/u.test(character))
    .join("")
    .slice(0, maximum);
}

function nullableInteger(value) {
  if (value === null) {
    return null;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Torrent service returned invalid data");
  }
  return value;
}

function validateOpaqueId(value, label) {
  if (!OPAQUE_ID.test(value || "")) {
    throw new Error(`${label} is invalid or expired`);
  }
  return value;
}

function validateFiles(files) {
  if (files === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(files) ||
    !files.length ||
    files.length > MAX_FILES ||
    new Set(files).size !== files.length ||
    files.some(index => !Number.isInteger(index) || index < 0)
  ) {
    throw new Error("files must contain unique non-negative indexes");
  }
  return files;
}

function validateTorrentId(value, label = "id") {
  if (!TORRENT_ID.test(value || "")) {
    throw new Error(`${label} must be a qBittorrent torrent ID`);
  }
  return value.toLowerCase();
}

function validateTorrentIds(value) {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 100 ||
    new Set(value).size !== value.length
  ) {
    throw new Error("ids must contain one to 100 unique torrent IDs");
  }
  return value.map((id, index) => validateTorrentId(id, `ids[${index}]`));
}

function safeNumber(value, minimum = 0) {
  return Number.isFinite(value) && value >= minimum ? value : null;
}

function safeText(value, maximum) {
  return typeof value === "string" ? cleanExternalText(value, maximum) : "";
}

function sanitizeTorrentSummary(torrent) {
  return {
    id: validateTorrentId(torrent?.hash),
    name: safeText(torrent.name, 512),
    state: safeText(torrent.state, 64),
    progress: safeNumber(torrent.progress),
    sizeBytes: safeNumber(torrent.total_size),
    downloadedBytes: safeNumber(torrent.downloaded),
    uploadedBytes: safeNumber(torrent.uploaded),
    downloadSpeed: safeNumber(torrent.dlspeed),
    uploadSpeed: safeNumber(torrent.upspeed),
    seeds: safeNumber(torrent.num_seeds),
    peers: safeNumber(torrent.num_leechs),
    etaSeconds: safeNumber(torrent.eta),
    ratio: safeNumber(torrent.ratio, -1),
    addedAt: safeNumber(torrent.added_on),
    completedAt: safeNumber(torrent.completion_on),
    savePath: safeText(torrent.save_path, 4096),
    category: safeText(torrent.category, 256),
    tags: safeText(torrent.tags, 1024),
    forceStart: Boolean(torrent.force_start),
    sequentialDownload: Boolean(torrent.seq_dl),
    firstLastPiecePriority: Boolean(torrent.f_l_piece_prio),
  };
}

function safeTrackerURL(value) {
  const text = safeText(value, 4096);
  if (!text.includes("://")) {
    return text;
  }
  try {
    const url = new URL(text);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "invalid tracker URL";
  }
}

function paginate(items, offset, limit) {
  return {
    total: items.length,
    offset,
    items: items.slice(offset, offset + limit),
    truncated: offset + limit < items.length,
  };
}

export function validateTorrentListArgs(raw) {
  const args = requireObject(raw, "torrent_list");
  assertKeys(
    args,
    new Set(["filter", "category", "tag", "sort", "reverse", "limit", "offset"]),
    "torrent_list"
  );
  const filter = args.filter ?? "all";
  const sort = args.sort ?? "added_on";
  if (!TORRENT_FILTERS.has(filter)) {
    throw new Error("filter is not supported by qBittorrent");
  }
  if (!TORRENT_SORTS.has(sort)) {
    throw new Error("sort is not supported by qBittorrent");
  }
  const limit = args.limit ?? 50;
  const offset = args.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("limit must be an integer from 1 to 100");
  }
  if (!Number.isInteger(offset) || offset < 0 || offset > 100_000) {
    throw new Error("offset must be an integer from 0 to 100000");
  }
  const category =
    args.category === undefined
      ? undefined
      : boundedText(args.category, "category", 256);
  const tag =
    args.tag === undefined ? undefined : boundedText(args.tag, "tag", 256);
  if (args.reverse !== undefined && typeof args.reverse !== "boolean") {
    throw new Error("reverse must be a boolean");
  }
  return {
    filter,
    category,
    tag,
    sort,
    reverse: args.reverse ?? true,
    limit,
    offset,
  };
}

export function validateTorrentDetailsArgs(raw) {
  const args = requireObject(raw, "torrent_details");
  assertKeys(args, new Set(["id", "section", "offset", "limit"]), "torrent_details");
  const section = args.section ?? "overview";
  const offset = args.offset ?? 0;
  const limit = args.limit ?? 100;
  if (!TORRENT_SECTIONS.has(section)) {
    throw new Error("section must be overview, files, trackers, or peers");
  }
  if (!Number.isInteger(offset) || offset < 0 || offset > 100_000) {
    throw new Error("offset must be an integer from 0 to 100000");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("limit must be an integer from 1 to 500");
  }
  return { id: validateTorrentId(args.id), section, offset, limit };
}

export function validateTorrentControlArgs(raw) {
  const args = requireObject(raw, "torrent_control");
  assertKeys(
    args,
    new Set([
      "ids",
      "action",
      "confirmed",
      "deleteData",
      "fileIds",
      "priority",
      "downloadLimit",
      "uploadLimit",
      "name",
      "enabled",
    ]),
    "torrent_control"
  );
  const ids = validateTorrentIds(args.ids);
  const actions = new Set([
    "start",
    "stop",
    "forceStart",
    "autoStart",
    "reannounce",
    "recheck",
    "delete",
    "filePriority",
    "limits",
    "rename",
    "sequential",
    "firstLastPiece",
  ]);
  if (!actions.has(args.action)) {
    throw new Error("action is not supported by qBittorrent");
  }
  if (args.action === "delete" && args.confirmed !== true) {
    throw new Error("Deleting a torrent requires explicit user confirmation");
  }
  if (args.deleteData !== undefined && typeof args.deleteData !== "boolean") {
    throw new Error("deleteData must be a boolean");
  }
  if (args.action === "filePriority") {
    if (ids.length !== 1) {
      throw new Error("filePriority accepts one torrent ID");
    }
    if (
      !Array.isArray(args.fileIds) ||
      !args.fileIds.length ||
      args.fileIds.length > 10_000 ||
      new Set(args.fileIds).size !== args.fileIds.length ||
      args.fileIds.some(id => !Number.isInteger(id) || id < 0)
    ) {
      throw new Error("fileIds must contain unique non-negative file indexes");
    }
    if (![0, 1, 6, 7].includes(args.priority)) {
      throw new Error("priority must be 0, 1, 6, or 7");
    }
  }
  if (args.action === "limits") {
    if (args.downloadLimit === undefined && args.uploadLimit === undefined) {
      throw new Error("limits requires downloadLimit or uploadLimit");
    }
    for (const [name, value] of [
      ["downloadLimit", args.downloadLimit],
      ["uploadLimit", args.uploadLimit],
    ]) {
      if (
        value !== undefined &&
        (!Number.isInteger(value) || value < 0 || value > 2_147_483_647)
      ) {
        throw new Error(`${name} must be an integer from 0 to 2147483647`);
      }
    }
  }
  if (args.action === "rename") {
    if (ids.length !== 1) {
      throw new Error("rename accepts one torrent ID");
    }
    boundedText(args.name, "name", 512);
  }
  if (
    ["sequential", "firstLastPiece"].includes(args.action) &&
    typeof args.enabled !== "boolean"
  ) {
    throw new Error(`${args.action} requires enabled`);
  }
  return { ...args, ids };
}

export function validateTorrentSearchArgs(raw) {
  const args = requireObject(raw, "torrent_search");
  assertKeys(
    args,
    new Set(["query", "providers", "sort", "direction", "limit", "timeoutMs"]),
    "torrent_search"
  );
  const query = boundedText(args.query, "query", 256);
  let providers;
  if (args.providers !== undefined) {
    if (
      !Array.isArray(args.providers) ||
      !args.providers.length ||
      args.providers.length > 100 ||
      new Set(args.providers).size !== args.providers.length ||
      args.providers.some(
        id =>
          typeof id !== "string" || !id || id.length > 128 || /\p{Cc}/u.test(id)
      )
    ) {
      throw new Error("providers must contain unique provider IDs");
    }
    providers = [...args.providers];
  }
  const sort = args.sort ?? "seeders";
  if (!SEARCH_SORTS.has(sort)) {
    throw new Error("sort must be seeders, leechers, size, published, or name");
  }
  const direction = args.direction ?? "desc";
  if (direction !== "asc" && direction !== "desc") {
    throw new Error("direction must be asc or desc");
  }
  const limit = args.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RESULTS) {
    throw new Error(`limit must be an integer from 1 to ${MAX_RESULTS}`);
  }
  const timeoutMs = args.timeoutMs ?? 30_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) {
    throw new Error("timeoutMs must be an integer from 1000 to 30000");
  }
  return { query, providers, sort, direction, limit, timeoutMs };
}

function sanitizeProvider(provider) {
  if (
    typeof provider?.id !== "string" ||
    !provider.id ||
    provider.id.length > 128 ||
    !["ready", "unavailable"].includes(provider.state)
  ) {
    throw new Error("Torrent service returned invalid data");
  }
  return {
    id: provider.id,
    name: cleanExternalText(provider.name, 160),
    state: provider.state,
  };
}

function sanitizeProviderState(provider) {
  if (
    typeof provider?.id !== "string" ||
    !provider.id ||
    provider.id.length > 128 ||
    !["ok", "unavailable", "unsupported", "timeout", "error"].includes(
      provider.state
    ) ||
    !Number.isSafeInteger(provider.elapsedMs) ||
    provider.elapsedMs < 0
  ) {
    throw new Error("Torrent service returned invalid data");
  }
  return {
    id: provider.id,
    state: provider.state,
    elapsedMs: provider.elapsedMs,
  };
}

function sanitizeResult(result, resultId) {
  if (
    !OPAQUE_ID.test(result?.resultId || "") ||
    typeof result.providerId !== "string" ||
    !result.providerId ||
    result.providerId.length > 128 ||
    !["magnet", "torrent"].includes(result.acquisition) ||
    !Array.isArray(result.categoryIds) ||
    result.categoryIds.some(
      category => !Number.isSafeInteger(category) || category < 0
    )
  ) {
    throw new Error("Torrent service returned invalid data");
  }
  let publishedAt = null;
  if (result.publishedAt !== null) {
    const timestamp = Date.parse(result.publishedAt);
    if (!Number.isFinite(timestamp)) {
      throw new Error("Torrent service returned invalid data");
    }
    publishedAt = new Date(timestamp).toISOString();
  }
  return {
    resultId,
    providerId: result.providerId,
    providerName: cleanExternalText(result.providerName, 160),
    name: cleanExternalText(result.name, 512),
    sizeBytes: nullableInteger(result.sizeBytes),
    seeders: nullableInteger(result.seeders),
    leechers: nullableInteger(result.leechers),
    publishedAt,
    categoryIds: [...new Set(result.categoryIds)].sort(
      (left, right) => left - right
    ),
    acquisition: result.acquisition,
  };
}

function comparable(result, sort) {
  switch (sort) {
    case "seeders":
      return result.seeders;
    case "leechers":
      return result.leechers;
    case "size":
      return result.sizeBytes;
    case "published":
      return result.publishedAt === null
        ? null
        : Date.parse(result.publishedAt);
    default:
      return result.name.normalize("NFC").toLowerCase();
  }
}

function compareResults(left, right, sort, direction) {
  const leftValue = comparable(left, sort);
  const rightValue = comparable(right, sort);
  if (leftValue === null || rightValue === null) {
    if (leftValue === rightValue) {
      return stableResultCompare(left, right);
    }
    return leftValue === null ? 1 : -1;
  }
  let order = 0;
  if (leftValue < rightValue) {
    order = -1;
  } else if (leftValue > rightValue) {
    order = 1;
  }
  if (!order) {
    return stableResultCompare(left, right);
  }
  return direction === "asc" ? order : -order;
}

function stableResultCompare(left, right) {
  for (const [a, b] of [
    [left.providerId, right.providerId],
    [
      left.name.normalize("NFC").toLowerCase(),
      right.name.normalize("NFC").toLowerCase(),
    ],
    [left.resultId, right.resultId],
  ]) {
    if (a < b) {
      return -1;
    }
    if (a > b) {
      return 1;
    }
  }
  return 0;
}

function sanitizeDraft(draft, draftId) {
  if (
    !draft ||
    typeof draft !== "object" ||
    !["metadata", "ready", "error"].includes(draft.state) ||
    !Array.isArray(draft.files) ||
    draft.files.length > MAX_FILES
  ) {
    throw new Error("Torrent service returned invalid draft data");
  }
  const seen = new Set();
  const files = draft.files.map(file => {
    if (
      !Number.isInteger(file?.index) ||
      file.index < 0 ||
      seen.has(file.index)
    ) {
      throw new Error("Torrent service returned invalid draft data");
    }
    seen.add(file.index);
    return {
      index: file.index,
      name: cleanExternalText(file.name, 512),
      path: cleanExternalText(file.path, 4096),
      sizeBytes: nullableInteger(file.length),
    };
  });
  return {
    draftId,
    state: draft.state,
    name: cleanExternalText(draft.name, 512),
    totalSizeBytes: nullableInteger(draft.totalSize),
    files,
    private: Boolean(draft.private),
    error:
      draft.state === "error" ? "Torrent metadata could not be prepared" : null,
  };
}

function abortedError() {
  return new Error("Torrent search cancelled");
}

/** Restricts torrent discovery and draft operations to session-scoped handles. */
export class TorrentAgentToolController {
  constructor({ discoveryManager, torrentManager, makeId, now } = {}) {
    if (!discoveryManager || !torrentManager) {
      throw new Error("Torrent agent managers are required");
    }
    this.discoveryManager = discoveryManager;
    this.torrentManager = torrentManager;
    this.makeId = makeId ?? (() => crypto.randomUUID().replaceAll("-", ""));
    this.now = now ?? (() => Date.now());
    this.sessions = new Map();
  }

  #session(clientId) {
    const id = boundedText(clientId, "Pi session identity", 512);
    let session = this.sessions.get(id);
    if (!session) {
      session = { searches: new Map(), drafts: new Map(), handles: new Set() };
      this.sessions.set(id, session);
    }
    const now = this.now();
    for (const [searchId, search] of session.searches) {
      if (search.expiresAt <= now) {
        session.handles.delete(searchId);
        for (const resultId of search.results.keys()) {
          session.handles.delete(resultId);
        }
        session.searches.delete(searchId);
      }
    }
    return session;
  }

  #newId(session) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const id = this.makeId();
      if (OPAQUE_ID.test(id) && !session.handles.has(id)) {
        session.handles.add(id);
        return id;
      }
    }
    throw new Error("Could not allocate a torrent handle");
  }

  async execute(tool, rawArgs, clientId, signal) {
    switch (tool) {
      case "torrent_list":
        return this.list(rawArgs);
      case "torrent_details":
        return this.details(rawArgs);
      case "torrent_control":
        return this.control(rawArgs);
      case "torrent_providers":
        return this.providers(rawArgs);
      case "torrent_search":
        return this.search(rawArgs, clientId, signal);
      case "torrent_prepare":
        return this.prepare(rawArgs, clientId, signal);
      case "torrent_draft":
        return this.draft(rawArgs, clientId);
      case "torrent_commit":
        return this.commit(rawArgs, clientId);
      case "torrent_cancel":
        return this.cancel(rawArgs, clientId);
      default:
        throw new Error(`Unknown torrent tool: ${tool}`);
    }
  }

  async list(rawArgs) {
    const args = validateTorrentListArgs(rawArgs);
    let torrents;
    try {
      torrents = await this.torrentManager.listTorrents(args);
    } catch {
      throw new Error("Torrent list is unavailable");
    }
    if (!Array.isArray(torrents) || torrents.length > args.limit) {
      throw new Error("Torrent service returned invalid data");
    }
    return {
      offset: args.offset,
      limit: args.limit,
      torrents: torrents.map(sanitizeTorrentSummary),
    };
  }

  async details(rawArgs) {
    const args = validateTorrentDetailsArgs(rawArgs);
    let details;
    try {
      details = await this.torrentManager.getTorrentSection(
        args.id,
        args.section
      );
    } catch {
      throw new Error("Torrent details are unavailable");
    }
    if (args.section === "overview") {
      return {
        id: args.id,
        section: args.section,
        name: safeText(details?.name, 512),
        infohashV1: safeText(details?.infohash_v1, 40),
        infohashV2: safeText(details?.infohash_v2, 64),
        totalSizeBytes: safeNumber(details?.total_size),
        downloadedBytes: safeNumber(details?.total_downloaded),
        uploadedBytes: safeNumber(details?.total_uploaded),
        downloadSpeed: safeNumber(details?.dl_speed),
        uploadSpeed: safeNumber(details?.up_speed),
        seeds: safeNumber(details?.seeds),
        peers: safeNumber(details?.peers),
        etaSeconds: safeNumber(details?.eta),
        ratio: safeNumber(details?.share_ratio, -1),
        availability: safeNumber(details?.availability, -1),
        connections: safeNumber(details?.nb_connections),
        savePath: safeText(details?.save_path, 4096),
        downloadPath: safeText(details?.download_path, 4096),
        private: details?.private === null ? null : Boolean(details?.private),
      };
    }
    if (!Array.isArray(details) || details.length > 100_000) {
      throw new Error("Torrent service returned invalid data");
    }
    let items;
    switch (args.section) {
      case "files":
        items = details.map(file => ({
          index: safeNumber(file.index),
          name: safeText(file.name, 4096),
          sizeBytes: safeNumber(file.size),
          progress: safeNumber(file.progress),
          priority: safeNumber(file.priority),
          availability: safeNumber(file.availability, -1),
        }));
        break;
      case "trackers":
        items = details.map(tracker => ({
          url: safeTrackerURL(tracker.url),
          status: safeNumber(tracker.status),
          tier: safeNumber(tracker.tier, -1),
          peers: safeNumber(tracker.num_peers, -1),
          seeds: safeNumber(tracker.num_seeds, -1),
          leeches: safeNumber(tracker.num_leeches, -1),
          downloaded: safeNumber(tracker.num_downloaded, -1),
          message: safeText(tracker.msg, 512),
        }));
        break;
      case "peers":
        items = details.map(peer => ({
          ip: safeText(peer.ip || peer.i2p_dest, 256),
          port: safeNumber(peer.port),
          client: safeText(peer.client, 256),
          connection: safeText(peer.connection, 64),
          country: safeText(peer.country, 128),
          progress: safeNumber(peer.progress),
          downloadSpeed: safeNumber(peer.dl_speed),
          uploadSpeed: safeNumber(peer.up_speed),
          downloadedBytes: safeNumber(peer.downloaded),
          uploadedBytes: safeNumber(peer.uploaded),
          flags: safeText(peer.flags, 128),
        }));
        break;
    }
    return {
      id: args.id,
      section: args.section,
      ...paginate(items, args.offset, args.limit),
    };
  }

  async control(rawArgs) {
    const args = validateTorrentControlArgs(rawArgs);
    const hashes = args.ids.join("|");
    try {
      switch (args.action) {
        case "start":
        case "stop":
        case "reannounce":
        case "recheck":
          await this.torrentManager.action(hashes, args.action);
          break;
        case "forceStart":
          await this.torrentManager.setForceStart(args.ids, true);
          break;
        case "autoStart":
          await this.torrentManager.setForceStart(args.ids, false);
          break;
        case "delete":
          await this.torrentManager.remove(hashes, args.deleteData === true);
          break;
        case "filePriority":
          await this.torrentManager.setFilePriority(
            args.ids[0],
            args.fileIds,
            args.priority
          );
          break;
        case "limits":
          await this.torrentManager.setLimits(
            args.ids,
            args.downloadLimit,
            args.uploadLimit
          );
          break;
        case "rename":
          await this.torrentManager.rename(args.ids[0], args.name.trim());
          break;
        case "sequential":
          await this.torrentManager.setToggle(
            args.ids[0],
            "sequential",
            args.enabled
          );
          break;
        case "firstLastPiece":
          await this.torrentManager.setToggle(
            args.ids[0],
            "firstLastPiece",
            args.enabled
          );
          break;
      }
    } catch {
      throw new Error("Torrent control operation failed");
    }
    return { action: args.action, ids: args.ids, applied: true };
  }

  async providers(rawArgs) {
    const args = requireObject(rawArgs, "torrent_providers");
    assertKeys(args, new Set(), "torrent_providers");
    try {
      const response = await this.discoveryManager.getSources();
      if (response?.immutable !== true || !Array.isArray(response.sources)) {
        throw new Error("invalid");
      }
      return {
        immutable: true,
        providers: response.sources.map(sanitizeProvider),
      };
    } catch {
      throw new Error("Torrent provider status is unavailable");
    }
  }

  async search(rawArgs, clientId, signal) {
    const args = validateTorrentSearchArgs(rawArgs);
    if (signal?.aborted) {
      throw abortedError();
    }
    let timer;
    let abort;
    try {
      const cancellation = new Promise((resolve, reject) => {
        abort = () => {
          this.discoveryManager.cancelSearch();
          reject(abortedError());
        };
        signal?.addEventListener("abort", abort, { once: true });
      });
      const timeout = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          this.discoveryManager.cancelSearch();
          reject(new Error("Torrent search timed out"));
        }, args.timeoutMs);
      });
      const response = await Promise.race([
        this.discoveryManager.search({
          query: args.query,
          sourceIds: args.providers,
          limit: 200,
        }),
        cancellation,
        timeout,
      ]);
      if (
        !response ||
        typeof response.partial !== "boolean" ||
        !Array.isArray(response.providers) ||
        !Array.isArray(response.results) ||
        response.results.length > 200
      ) {
        throw new Error("invalid");
      }
      const providers = response.providers.map(sanitizeProviderState);
      const candidates = response.results.map(result => ({
        backendResultId: result.resultId,
        result: sanitizeResult(result, result.resultId),
      }));
      candidates.sort((left, right) =>
        compareResults(left.result, right.result, args.sort, args.direction)
      );
      const session = this.#session(clientId);
      const searchId = this.#newId(session);
      const backendResults = new Map();
      const results = candidates.slice(0, args.limit).map(candidate => {
        const resultId = this.#newId(session);
        backendResults.set(resultId, candidate.backendResultId);
        return { ...candidate.result, resultId };
      });
      session.searches.set(searchId, {
        expiresAt: this.now() + SEARCH_TTL_MS,
        results: backendResults,
      });
      return {
        searchId,
        partial: response.partial,
        providers,
        results,
      };
    } catch (error) {
      if (
        signal?.aborted ||
        error?.cancelled ||
        error?.message === "Torrent search cancelled" ||
        error?.message === "Torrent search timed out"
      ) {
        throw signal?.aborted || error?.cancelled ? abortedError() : error;
      }
      throw new Error("Torrent search failed");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  async prepare(rawArgs, clientId, signal) {
    const args = requireObject(rawArgs, "torrent_prepare");
    assertKeys(args, new Set(["searchId", "resultId"]), "torrent_prepare");
    const searchId = validateOpaqueId(args.searchId, "searchId");
    const resultId = validateOpaqueId(args.resultId, "resultId");
    const session = this.#session(clientId);
    const backendResultId = session.searches
      .get(searchId)
      ?.results.get(resultId);
    if (!backendResultId) {
      throw new Error("Torrent result is invalid or expired");
    }
    if (signal?.aborted) {
      throw new Error("Torrent preparation cancelled");
    }
    let backendDraftId;
    try {
      const resolution = await this.discoveryManager.resolve(backendResultId);
      if (signal?.aborted) {
        throw new Error("cancelled");
      }
      const draft = await this.torrentManager.createTorrentDraft(
        resolution.kind === "magnet"
          ? { magnet: resolution.magnet }
          : { torrent: resolution.torrent }
      );
      backendDraftId = draft?.draftId;
      if (typeof backendDraftId !== "string" || !backendDraftId) {
        throw new Error("invalid");
      }
      if (signal?.aborted) {
        await this.torrentManager.cancelTorrentDraft(backendDraftId);
        throw new Error("cancelled");
      }
      const draftId = this.#newId(session);
      session.drafts.set(draftId, backendDraftId);
      return sanitizeDraft(draft, draftId);
    } catch (error) {
      if (backendDraftId) {
        await this.torrentManager
          .cancelTorrentDraft(backendDraftId)
          .catch(() => {});
      }
      if (signal?.aborted || error?.message === "cancelled") {
        throw new Error("Torrent preparation cancelled");
      }
      throw new Error("Torrent result could not be prepared");
    }
  }

  async draft(rawArgs, clientId) {
    const args = requireObject(rawArgs, "torrent_draft");
    assertKeys(args, new Set(["draftId"]), "torrent_draft");
    const draftId = validateOpaqueId(args.draftId, "draftId");
    const backendDraftId = this.#session(clientId).drafts.get(draftId);
    if (!backendDraftId) {
      throw new Error("Torrent draft is invalid or expired");
    }
    try {
      return sanitizeDraft(
        await this.torrentManager.getTorrentDraft(backendDraftId),
        draftId
      );
    } catch {
      throw new Error("Torrent draft could not be read");
    }
  }

  async commit(rawArgs, clientId) {
    const args = requireObject(rawArgs, "torrent_commit");
    assertKeys(
      args,
      new Set(["draftId", "files", "confirmed"]),
      "torrent_commit"
    );
    if (args.confirmed !== true) {
      throw new Error("Torrent download requires explicit user confirmation");
    }
    const draftId = validateOpaqueId(args.draftId, "draftId");
    const files = validateFiles(args.files);
    const session = this.#session(clientId);
    const backendDraftId = session.drafts.get(draftId);
    if (!backendDraftId) {
      throw new Error("Torrent draft is invalid or expired");
    }
    try {
      await this.torrentManager.commitTorrentDraft(backendDraftId, files);
      session.drafts.delete(draftId);
      session.handles.delete(draftId);
      return { draftId, committed: true };
    } catch {
      throw new Error("Torrent draft could not be committed");
    }
  }

  async cancel(rawArgs, clientId) {
    const args = requireObject(rawArgs, "torrent_cancel");
    assertKeys(args, new Set(["draftId"]), "torrent_cancel");
    const draftId = validateOpaqueId(args.draftId, "draftId");
    const session = this.#session(clientId);
    const backendDraftId = session.drafts.get(draftId);
    if (!backendDraftId) {
      throw new Error("Torrent draft is invalid or expired");
    }
    try {
      await this.torrentManager.cancelTorrentDraft(backendDraftId);
      session.drafts.delete(draftId);
      session.handles.delete(draftId);
      return { draftId, cancelled: true };
    } catch {
      throw new Error("Torrent draft could not be cancelled");
    }
  }

  async close() {
    this.discoveryManager.cancelSearch();
    const drafts = [...this.sessions.values()].flatMap(session => [
      ...session.drafts.values(),
    ]);
    this.sessions.clear();
    await Promise.allSettled(
      drafts.map(draftId => this.torrentManager.cancelTorrentDraft(draftId))
    );
  }
}
