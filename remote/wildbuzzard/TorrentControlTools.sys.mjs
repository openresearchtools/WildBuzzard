/* SPDX-License-Identifier: AGPL-3.0-or-later */

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
const TORRENT_SECTIONS = new Set(["overview", "files", "trackers", "peers"]);

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
    /[\p{Cc}\p{Cf}]/u.test(normalized)
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
    .filter(character => !/[\p{Cc}\p{Cf}]/u.test(character))
    .join("")
    .slice(0, maximum);
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
    new Set([
      "filter",
      "category",
      "tag",
      "sort",
      "reverse",
      "limit",
      "offset",
    ]),
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
  assertKeys(
    args,
    new Set(["id", "section", "offset", "limit"]),
    "torrent_details"
  );
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
    ids.length !== 1
  ) {
    throw new Error(`${args.action} accepts one torrent ID`);
  }
  if (
    ["sequential", "firstLastPiece"].includes(args.action) &&
    typeof args.enabled !== "boolean"
  ) {
    throw new Error(`${args.action} requires enabled`);
  }
  return { ...args, ids };
}

/** Provides bounded access to existing native torrent transfers. */
export class TorrentControlToolController {
  constructor({ torrentManager } = {}) {
    if (!torrentManager) {
      throw new Error("Torrent manager is required");
    }
    this.torrentManager = torrentManager;
  }

  async execute(tool, rawArgs) {
    switch (tool) {
      case "torrent_list":
        return this.list(rawArgs);
      case "torrent_details":
        return this.details(rawArgs);
      case "torrent_control":
        return this.control(rawArgs);
      default:
        throw new Error(`Unknown torrent control tool: ${tool}`);
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
}
