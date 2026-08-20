/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { Downloads } from "resource://gre/modules/Downloads.sys.mjs";
import { NetUtil } from "resource://gre/modules/NetUtil.sys.mjs";
import { QBittorrentRuntime } from "resource:///modules/QBittorrentRuntime.sys.mjs";
import { TorRouting } from "resource:///modules/TorRouting.sys.mjs";

const LocalFile = Components.Constructor(
  "@mozilla.org/file/local;1",
  "nsIFile",
  "initWithPath"
);
const MAX_TORRENT_SIZE = 12 * 1024 * 1024;

function isByteArray(value) {
  return (
    ArrayBuffer.isView(value) &&
    Object.prototype.toString.call(value) === "[object Uint8Array]"
  );
}

function torrentFileError(reason) {
  return Object.assign(new Error(`Torrent file ${reason}`), {
    torrentFileError: reason,
  });
}

function validateTorrentFileDescriptor(name, size, type = "") {
  if (
    !name?.toLowerCase().endsWith(".torrent") ||
    (type && type !== "application/x-bittorrent")
  ) {
    throw torrentFileError("wrong-type");
  }
  if (!Number.isFinite(size) || size <= 0) {
    throw torrentFileError("invalid");
  }
  if (size > MAX_TORRENT_SIZE) {
    throw torrentFileError("too-large");
  }
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

function formBody(fields) {
  return new TextEncoder().encode(new URLSearchParams(fields).toString());
}

function multipartTorrent(bytes) {
  const boundary = `wildbuzzard-${Services.uuid.generateUUID().toString().replace(/[{}-]/g, "")}`;
  const prefix = new TextEncoder().encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="torrents"; filename="torrent.torrent"\r\nContent-Type: application/x-bittorrent\r\n\r\n`
  );
  const suffix = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(prefix.length + bytes.length + suffix.length);
  body.set(prefix);
  body.set(bytes, prefix.length);
  body.set(suffix, prefix.length + bytes.length);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

function draftState(metadata) {
  const files = metadata.info?.files;
  return {
    draftId:
      metadata.id || metadata.infohash_v1 || metadata.infohash_v2 || "pending",
    state: Array.isArray(files) ? "ready" : "metadata",
    name: metadata.info?.name || "Retrieving metadata",
    totalSize: metadata.info?.length ?? null,
    private: Boolean(metadata.info?.private),
    files: Array.isArray(files)
      ? files.map((file, index) => ({
          index,
          name: file.path,
          path: file.path,
          length: file.length,
        }))
      : [],
  };
}

class TorrentManagerImpl {
  async initialize() {
    await QBittorrentRuntime.ensure();
    this.rootDirectory = QBittorrentRuntime.rootDirectory;
    this.runtimeDirectory = QBittorrentRuntime.runtimeDirectory;
    this.connectionPath = QBittorrentRuntime.connectionPath;
    this.config = {
      downloadDirectory: await Downloads.getPreferredDownloadsDirectory(),
      torEnabled: false,
    };
    return this.getStatus();
  }

  async request(method, path, body = null) {
    if (path === "/v1/status" && method === "GET") {
      return this.getStatus();
    }
    throw new Error(`Unsupported legacy torrent request: ${method} ${path}`);
  }

  async getStatus() {
    const [version, torrents, transfer] = await Promise.all([
      QBittorrentRuntime.requestText("/api/v2/app/version"),
      QBittorrentRuntime.requestJSON("/api/v2/torrents/info"),
      QBittorrentRuntime.requestJSON("/api/v2/transfer/info"),
    ]);
    return {
      ready: true,
      version: version.trim(),
      torrents,
      transfer,
      settings: this.config ?? {
        downloadDirectory: await Downloads.getPreferredDownloadsDirectory(),
        torEnabled: false,
      },
    };
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

  async createTorrentDraft({ magnet, torrent }) {
    if ((magnet === undefined) === (torrent === undefined)) {
      throw new Error("Supply one magnet or one torrent payload");
    }
    if (magnet !== undefined) {
      if (typeof magnet !== "string" || !magnet.startsWith("magnet:")) {
        throw new Error("A magnet link is required");
      }
      const response = await this.#post("/api/v2/torrents/fetchMetadata", {
        source: magnet,
      });
      const metadata = JSON.parse(new TextDecoder().decode(response.body));
      const draft = draftState(metadata);
      this.drafts ??= new Map();
      this.drafts.set(draft.draftId, { source: magnet });
      return draft;
    }
    if (!isByteArray(torrent) || !torrent.length) {
      throw new Error("Torrent metadata is required");
    }
    if (torrent.length > MAX_TORRENT_SIZE) {
      throw new Error("Torrent metadata is too large");
    }
    const { body, contentType } = multipartTorrent(torrent);
    const response = await QBittorrentRuntime.request(
      "/api/v2/torrents/parseMetadata",
      {
        method: "POST",
        headers: { "Content-Type": contentType },
        body,
      }
    );
    if (response.status !== 200) {
      throw new Error("Torrent metadata is invalid");
    }
    const metadata = JSON.parse(new TextDecoder().decode(response.body))[0];
    const draft = draftState(metadata);
    this.drafts ??= new Map();
    this.drafts.set(draft.draftId, { torrent });
    return draft;
  }

  async getTorrentDraft(id) {
    const source = this.drafts?.get(id);
    if (!source) {
      throw new Error("Torrent draft is invalid or expired");
    }
    if (source.torrent) {
      const { body, contentType } = multipartTorrent(source.torrent);
      const response = await QBittorrentRuntime.request(
        "/api/v2/torrents/parseMetadata",
        { method: "POST", headers: { "Content-Type": contentType }, body }
      );
      return draftState(JSON.parse(new TextDecoder().decode(response.body))[0]);
    }
    const response = await this.#post("/api/v2/torrents/fetchMetadata", {
      source: source.source,
    });
    return draftState(JSON.parse(new TextDecoder().decode(response.body)));
  }

  async commitTorrentDraft(id, files) {
    const draft = this.drafts?.get(id);
    if (!draft) {
      throw new Error("Torrent draft is invalid or expired");
    }
    if (draft.source) {
      await this.#post("/api/v2/torrents/add", {
        urls: draft.source,
        savepath: await Downloads.getPreferredDownloadsDirectory(),
        filePriorities: files
          ? this.#filePriorities((await this.getTorrentDraft(id)).files, files)
          : "",
      });
    } else {
      const added = await this.addTorrentBytes(draft.torrent);
      if (added.ids.length !== 1) {
        throw new Error("qBittorrent did not identify the added torrent");
      }
      const addedId = added.ids[0];
      if (files) {
        const metadata = await this.getTorrentDraft(id);
        const selected = new Set(files);
        const disabled = metadata.files
          .filter(file => !selected.has(file.index))
          .map(file => file.index)
          .join("|");
        if (disabled) {
          await this.#post("/api/v2/torrents/filePrio", {
            hash: addedId,
            id: disabled,
            priority: "0",
          });
        }
      }
    }
    this.drafts.delete(id);
    return { id, committed: true };
  }

  #filePriorities(files, selectedFiles) {
    const selected = new Set(selectedFiles);
    return files.map(file => (selected.has(file.index) ? 1 : 0)).join(",");
  }

  async cancelTorrentDraft(id) {
    this.drafts?.delete(id);
    return { id, cancelled: true };
  }

  async addMagnet(source, downloadPath) {
    if (!source?.startsWith("magnet:")) {
      throw new Error("A magnet link is required");
    }
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

  async createDraftFromURL(source, principal, cookieJarSettings) {
    if (source.startsWith("magnet:")) {
      return this.createTorrentDraft({ magnet: source });
    }
    if (!/^https?:\/\//i.test(source)) {
      throw new Error("Enter a magnet link or an HTTP(S) torrent URL");
    }
    return this.createTorrentDraft({
      torrent: await requestBytes(
        Services.io.newURI(source),
        principal,
        cookieJarSettings
      ),
    });
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

  update(id, detail) {
    if (detail.downloadPath) {
      return this.#post("/api/v2/torrents/setLocation", {
        hashes: id,
        location: detail.downloadPath,
      });
    }
    throw new Error("Unsupported torrent update");
  }

  async updateSettings(settings) {
    await this.initialize();
    if (settings.torEnabled !== undefined) {
      if (settings.torEnabled) {
        TorRouting.init();
        const port = await TorRouting.ensureProxy();
        await this.#post("/api/v2/app/setPreferences", {
          json: JSON.stringify({
            proxy_type: 2,
            proxy_ip: "127.0.0.1",
            proxy_port: port,
            proxy_peer_connections: true,
            proxy_hostname_lookup: true,
          }),
        });
      } else {
        await this.#post("/api/v2/app/setPreferences", {
          json: JSON.stringify({ proxy_type: -1 }),
        });
      }
      this.config.torEnabled = Boolean(settings.torEnabled);
    }
    return this.config;
  }

  remove(id, deleteData = false) {
    return this.#post("/api/v2/torrents/delete", {
      hashes: id,
      deleteFiles: String(Boolean(deleteData)),
    });
  }

  async addTorrentFile(file) {
    validateTorrentFileDescriptor(file?.name, file?.size, file?.type);
    let bytes;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      throw torrentFileError("unreadable");
    }
    if (bytes.length !== file.size) {
      throw torrentFileError("unreadable");
    }
    return this.createTorrentDraft({ torrent: bytes });
  }

  async chooseTorrentFile(browsingContext, title, filterTitle) {
    const picker = Cc["@mozilla.org/filepicker;1"].createInstance(
      Ci.nsIFilePicker
    );
    picker.init(browsingContext, title, Ci.nsIFilePicker.modeOpen);
    picker.appendFilter(filterTitle, "*.torrent");
    picker.appendRawFilter("application/x-bittorrent");
    if (
      (await new Promise(resolve => picker.open(resolve))) !==
      Ci.nsIFilePicker.returnOK
    ) {
      return null;
    }
    const stat = await IOUtils.stat(picker.file.path).catch(() => null);
    validateTorrentFileDescriptor(picker.file.leafName, stat?.size);
    if (stat.type !== "regular") {
      throw torrentFileError("unreadable");
    }
    const bytes = await IOUtils.read(picker.file.path, {
      maxBytes: MAX_TORRENT_SIZE,
    });
    if (bytes.length !== stat.size) {
      throw torrentFileError("unreadable");
    }
    return this.createTorrentDraft({ torrent: bytes });
  }

  async chooseDownloadDirectory(browsingContext) {
    const picker = Cc["@mozilla.org/filepicker;1"].createInstance(
      Ci.nsIFilePicker
    );
    picker.init(browsingContext, "", Ci.nsIFilePicker.modeGetFolder);
    picker.displayDirectory = new LocalFile(
      this.config?.downloadDirectory ||
        (await Downloads.getPreferredDownloadsDirectory())
    );
    if (
      (await new Promise(resolve => picker.open(resolve))) !==
      Ci.nsIFilePicker.returnOK
    ) {
      return null;
    }
    await this.initialize();
    this.config.downloadDirectory = picker.file.path;
    await this.#post("/api/v2/app/setPreferences", {
      json: JSON.stringify({ save_path: picker.file.path }),
    });
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

export const TorrentManagerTestUtils = Object.freeze({
  configurePaths(paths) {
    QBittorrentRuntime.configurePathsForTests(paths);
  },
});
