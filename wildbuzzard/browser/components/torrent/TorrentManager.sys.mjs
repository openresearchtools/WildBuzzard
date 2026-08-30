/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { Downloads } from "resource://gre/modules/Downloads.sys.mjs";
import { QBittorrentRuntime } from "resource:///modules/QBittorrentRuntime.sys.mjs";
import { isValidBTIHMagnet } from "resource:///modules/TorrentSecurityPolicy.sys.mjs";

const MAX_TORRENT_SIZE = 12 * 1024 * 1024;

function isByteArray(value) {
  return (
    ArrayBuffer.isView(value) &&
    Object.prototype.toString.call(value) === "[object Uint8Array]"
  );
}

function formBody(fields) {
  return new TextEncoder().encode(new URLSearchParams(fields).toString());
}

function validateDownloadPath(path) {
  if (
    path !== undefined &&
    (typeof path !== "string" || path.length > 4096 || /\p{Cc}/u.test(path))
  ) {
    throw new Error("The torrent download path is invalid");
  }
}

/** Provides the bounded interface to the bundled qBittorrent runtime. */
class TorrentManagerImpl {
  async initialize() {
    await QBittorrentRuntime.ensure();
  }

  async listTorrents({ filter, category, tag, sort, reverse, limit, offset }) {
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries({
      filter,
      category,
      tag,
      sort,
      reverse: reverse === undefined ? undefined : String(reverse),
      limit: limit === undefined ? undefined : String(limit),
      offset: offset === undefined ? undefined : String(offset),
    })) {
      if (value !== undefined && value !== "") {
        query.set(name, value);
      }
    }
    const suffix = query.size ? `?${query}` : "";
    return QBittorrentRuntime.requestJSON(`/api/v2/torrents/info${suffix}`);
  }

  async getTorrentSection(id, section) {
    const hash = encodeURIComponent(id);
    switch (section) {
      case "overview":
        return QBittorrentRuntime.requestJSON(
          `/api/v2/torrents/properties?hash=${hash}`
        );
      case "files":
        return QBittorrentRuntime.requestJSON(
          `/api/v2/torrents/files?hash=${hash}`
        );
      case "trackers":
        return QBittorrentRuntime.requestJSON(
          `/api/v2/torrents/trackers?hash=${hash}`
        );
      case "peers": {
        const response = await QBittorrentRuntime.requestJSON(
          `/api/v2/sync/torrentPeers?hash=${hash}&rid=0`
        );
        return Object.values(response.peers || {});
      }
      default:
        throw new Error("Unsupported torrent details section");
    }
  }

  async #post(target, fields = {}) {
    const response = await QBittorrentRuntime.request(target, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody(fields),
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`qBittorrent request failed (${response.status})`);
    }
    return response;
  }

  async addMagnet(source, downloadPath) {
    if (!isValidBTIHMagnet(source)) {
      throw new Error("A magnet link is required");
    }
    validateDownloadPath(downloadPath);
    await this.#post("/api/v2/torrents/add", {
      urls: source,
      savepath:
        downloadPath || (await Downloads.getPreferredDownloadsDirectory()),
    });
    return { added: true };
  }

  async addTorrentBytes(bytes, downloadPath) {
    if (!isByteArray(bytes) || !bytes.length) {
      throw new Error("Torrent metadata is required");
    }
    if (bytes.length > MAX_TORRENT_SIZE) {
      throw new Error("Torrent metadata is too large");
    }
    validateDownloadPath(downloadPath);
    const boundary = `wildbuzzard-${Services.uuid.generateUUID().toString().replace(/[{}-]/g, "")}`;
    const fields = downloadPath
      ? `--${boundary}\r\nContent-Disposition: form-data; name="savepath"\r\n\r\n${downloadPath}\r\n`
      : "";
    const prefix = new TextEncoder().encode(
      `${fields}--${boundary}\r\nContent-Disposition: form-data; name="torrents"; filename="torrent.torrent"\r\nContent-Type: application/x-bittorrent\r\n\r\n`
    );
    const suffix = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
    const body = new Uint8Array(prefix.length + bytes.length + suffix.length);
    body.set(prefix);
    body.set(bytes, prefix.length);
    body.set(suffix, prefix.length + bytes.length);
    const contentType = `multipart/form-data; boundary=${boundary}`;
    const response = await QBittorrentRuntime.request("/api/v2/torrents/add", {
      method: "POST",
      headers: { "Content-Type": contentType },
      body,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`qBittorrent request failed (${response.status})`);
    }
    const result = JSON.parse(new TextDecoder().decode(response.body));
    return {
      added: true,
      ids: Array.isArray(result.added_torrent_ids)
        ? result.added_torrent_ids
        : [],
      pending: Number(result.pending_count) || 0,
    };
  }

  action(id, action) {
    const endpoint = {
      start: "start",
      resume: "start",
      stop: "stop",
      pause: "stop",
      forceStart: "setForceStart",
      reannounce: "reannounce",
      recheck: "recheck",
    }[action];
    if (!endpoint) {
      throw new Error("Unsupported torrent action");
    }
    return this.#post(`/api/v2/torrents/${endpoint}`, {
      hashes: id,
      ...(action === "forceStart" ? { value: "true" } : {}),
    });
  }

  setForceStart(ids, value) {
    return this.#post("/api/v2/torrents/setForceStart", {
      hashes: ids.join("|"),
      value: String(value),
    });
  }

  setFilePriority(id, fileIds, priority) {
    return this.#post("/api/v2/torrents/filePrio", {
      hash: id,
      id: fileIds.join("|"),
      priority: String(priority),
    });
  }

  setLimits(ids, downloadLimit, uploadLimit) {
    const hashes = ids.join("|");
    return Promise.all([
      downloadLimit === undefined
        ? null
        : this.#post("/api/v2/torrents/setDownloadLimit", {
            hashes,
            limit: String(downloadLimit),
          }),
      uploadLimit === undefined
        ? null
        : this.#post("/api/v2/torrents/setUploadLimit", {
            hashes,
            limit: String(uploadLimit),
          }),
    ]);
  }

  rename(id, name) {
    return this.#post("/api/v2/torrents/rename", { hash: id, name });
  }

  async setToggle(id, property, enabled) {
    const torrents = await this.listTorrents({});
    const torrent = torrents.find(candidate => candidate.hash === id);
    if (!torrent) {
      throw new Error("Torrent was not found");
    }
    const key = property === "sequential" ? "seq_dl" : "f_l_piece_prio";
    if (Boolean(torrent[key]) === enabled) {
      return;
    }
    const endpoint =
      property === "sequential"
        ? "toggleSequentialDownload"
        : "toggleFirstLastPiecePrio";
    await this.#post(`/api/v2/torrents/${endpoint}`, { hashes: id });
  }

  remove(id, deleteData = false) {
    return this.#post("/api/v2/torrents/delete", {
      hashes: id,
      deleteFiles: String(Boolean(deleteData)),
    });
  }
}

export const TorrentManager = new TorrentManagerImpl();
