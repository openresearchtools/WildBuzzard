/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { Downloads } from "resource://gre/modules/Downloads.sys.mjs";
import { TorrentDiscoveryManager } from "resource:///modules/TorrentDiscoveryManager.sys.mjs";
import { TorrentManager } from "resource:///modules/TorrentManager.sys.mjs";
import { QBittorrentRuntime } from "resource:///modules/QBittorrentRuntime.sys.mjs";

const RESULT_PREFIX = "wildbuzzard-result:";
const MAX_JOBS = 32;
const MAX_RESULTS = 10_000;
const MAX_SOURCE_CONCURRENCY = 8;
const RESULT_TTL_MS = 24 * 60 * 60 * 1000;
const OPAQUE_ID = /^[A-Za-z0-9_-]{32}$/;

function headers(contentType = "application/json; charset=UTF-8") {
  return new Map([["content-type", [contentType]]]);
}

function response(body, status = 200, contentType) {
  return {
    body:
      body instanceof Uint8Array
        ? body
        : new TextEncoder().encode(
            typeof body === "string" ? body : JSON.stringify(body)
          ),
    headers: headers(contentType),
    status,
  };
}

function contentTypeOf(requestHeaders) {
  for (const [name, value] of Object.entries(requestHeaders)) {
    if (name.toLowerCase() === "content-type") {
      return value;
    }
  }
  return "";
}

function formParameters(body, requestHeaders) {
  if (!contentTypeOf(requestHeaders).startsWith("application/x-www-form-urlencoded")) {
    throw new Error("Torrent search request uses unsupported form data");
  }
  return new URLSearchParams(new TextDecoder().decode(body));
}

function formBody(parameters) {
  return new TextEncoder().encode(parameters.toString());
}

function multipartTorrent(bytes, fields) {
  const boundary = `wildbuzzard-${Services.uuid.generateUUID().toString().replace(/[{}-]/g, "")}`;
  const encoder = new TextEncoder();
  const parts = [];
  let total = bytes.length;
  for (const [name, value] of fields) {
    const part = encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
    );
    parts.push(part);
    total += part.length;
  }
  const prefix = encoder.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="torrents"; filename="torrent.torrent"\r\nContent-Type: application/x-bittorrent\r\n\r\n`
  );
  const suffix = encoder.encode(`\r\n--${boundary}--\r\n`);
  total += prefix.length + suffix.length;
  const body = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.length;
  }
  body.set(prefix, offset);
  offset += prefix.length;
  body.set(bytes, offset);
  body.set(suffix, offset + bytes.length);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

function resultHandle(resultId) {
  if (!OPAQUE_ID.test(resultId || "")) {
    throw new Error("Jackett Mini returned an invalid result handle");
  }
  return `${RESULT_PREFIX}${resultId}`;
}

function parseResultHandle(value) {
  if (typeof value !== "string" || !value.startsWith(RESULT_PREFIX)) {
    return null;
  }
  const id = value.slice(RESULT_PREFIX.length);
  return OPAQUE_ID.test(id) ? id : null;
}

function searchRow(result) {
  return {
    fileName: result.name,
    fileUrl: resultHandle(result.resultId),
    fileSize: result.sizeBytes ?? -1,
    nbSeeders: result.seeders ?? -1,
    nbLeechers: result.leechers ?? -1,
    engineName: "Jackett Mini",
    siteUrl: "",
    descrLink: "",
    pubDate:
      result.publishedAt === null
        ? -1
        : Math.floor(Date.parse(result.publishedAt) / 1000),
  };
}

class QBittorrentSearchBridgeImpl {
  async maybeRequest({ method, target, headers: requestHeaders, body, signal }) {
    const url = new URL(target, "http://localhost");
    if (url.pathname === "/api/v2/torrents/fetchMetadata") {
      const parameters = formParameters(body, requestHeaders);
      const id = parseResultHandle(parameters.get("source"));
      return id ? this.#metadata(id, signal) : null;
    }
    if (url.pathname === "/api/v2/torrents/add") {
      if (!contentTypeOf(requestHeaders).startsWith("application/x-www-form-urlencoded")) {
        return null;
      }
      const parameters = formParameters(body, requestHeaders);
      const sources = (parameters.get("urls") || "").split("\n").filter(Boolean);
      return sources.some(parseResultHandle)
        ? this.#addSearchResults(sources, signal)
        : null;
    }
    if (!url.pathname.startsWith("/api/v2/search/")) {
      return null;
    }
    await this.#cleanup();
    const action = url.pathname.slice("/api/v2/search/".length);
    if (method === "GET" && action === "plugins") {
      return response([
        {
          name: "jackett",
          version: "bundled",
          fullName: "Torrent search",
          url: "",
          supportedCategories: [{ id: "all", name: "All categories" }],
          enabled: true,
        },
      ]);
    }
    if (method === "GET" && action === "status") {
      const requested = Number(url.searchParams.get("id") || 0);
      const jobs = requested ? [this.jobs.get(requested)].filter(Boolean) : [...this.jobs.values()];
      return response(
        jobs.map(job => ({
          id: job.id,
          status: job.running ? "Running" : "Stopped",
          total: job.results.length,
        }))
      );
    }
    if (method === "GET" && action === "results") {
      const id = Number(url.searchParams.get("id"));
      const job = this.jobs.get(id);
      if (!job) {
        return response("Search job not found", 404, "text/plain; charset=UTF-8");
      }
      const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
      const requestedLimit = Number(url.searchParams.get("limit"));
      const limit = requestedLimit > 0 ? Math.min(requestedLimit, 500) : 500;
      return response({
        status: job.running ? "Running" : "Stopped",
        results: job.results.slice(offset, offset + limit),
        total: job.results.length,
      });
    }
    if (method !== "POST") {
      return response("Method not allowed", 405, "text/plain; charset=UTF-8");
    }
    const parameters = formParameters(body, requestHeaders);
    if (action === "start") {
      const pattern = (parameters.get("pattern") || "").trim();
      if (!pattern || pattern.length > 256 || /\p{Cc}/u.test(pattern)) {
        return response("Invalid search pattern", 400, "text/plain; charset=UTF-8");
      }
      const job = this.#createJob(pattern);
      this.#run(job).catch(() => {
        job.running = false;
      });
      return response({ id: job.id });
    }
    if (["stop", "delete"].includes(action)) {
      const id = Number(parameters.get("id"));
      const job = this.jobs.get(id);
      if (!job) {
        return response("Search job not found", 404, "text/plain; charset=UTF-8");
      }
      job.controller.abort();
      job.running = false;
      if (action === "delete") {
        this.jobs.delete(id);
      }
      return response("");
    }
    if (action === "commit") {
      const id = parseResultHandle(parameters.get("urls"));
      if (!id) {
        return response("Invalid torrent result", 400, "text/plain; charset=UTF-8");
      }
      return this.#commit(id, parameters, signal);
    }
    if (action === "downloadTorrent") {
      const id = parseResultHandle(parameters.get("torrentUrl"));
      if (!id) {
        return response("Invalid torrent result", 400, "text/plain; charset=UTF-8");
      }
      return this.#addSearchResults([`${RESULT_PREFIX}${id}`], signal);
    }
    if (["enablePlugin", "installPlugin", "uninstallPlugin", "updatePlugins"].includes(action)) {
      return response("The bundled torrent search provider is immutable", 403, "text/plain; charset=UTF-8");
    }
    return response("Search action not found", 404, "text/plain; charset=UTF-8");
  }

  #createJob(pattern) {
    while (this.jobs.size >= MAX_JOBS) {
      const oldest = [...this.jobs.values()].sort(
        (left, right) => left.createdAt - right.createdAt
      )[0];
      oldest.controller.abort();
      this.jobs.delete(oldest.id);
    }
    let id;
    do {
      id = 1 + Math.floor(Math.random() * 0x7ffffffe);
    } while (this.jobs.has(id));
    const job = {
      controller: new AbortController(),
      createdAt: Date.now(),
      expiresAt: Date.now() + RESULT_TTL_MS,
      id,
      pattern,
      results: [],
      resultIds: new Set(),
      running: true,
    };
    this.jobs.set(id, job);
    return job;
  }

  async #run(job) {
    try {
      const sources = (await TorrentDiscoveryManager.getSources()).sources
        .filter(source => source.state === "ready")
        .map(source => source.id);
      let cursor = 0;
      const worker = async () => {
        while (!job.controller.signal.aborted && cursor < sources.length) {
          const sourceId = sources[cursor++];
          try {
            const result = await TorrentDiscoveryManager.search({
              query: job.pattern,
              sourceIds: [sourceId],
              limit: 200,
              signal: job.controller.signal,
            });
            for (const item of result.results) {
              if (
                job.results.length >= MAX_RESULTS ||
                job.resultIds.has(item.resultId)
              ) {
                continue;
              }
              job.resultIds.add(item.resultId);
              job.results.push(searchRow(item));
            }
          } catch (error) {
            if (job.controller.signal.aborted || error?.cancelled) {
              return;
            }
          }
        }
      };
      await Promise.all(
        Array.from(
          { length: Math.min(MAX_SOURCE_CONCURRENCY, sources.length) },
          worker
        )
      );
    } finally {
      job.running = false;
    }
  }

  async #resolved(id, signal) {
    const cached = this.resolved.get(id);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
    const value = await TorrentDiscoveryManager.resolve(id, signal);
    this.resolved.set(id, { expiresAt: Date.now() + RESULT_TTL_MS, value });
    return value;
  }

  async #metadata(id, signal) {
    const resolved = await this.#resolved(id, signal);
    if (resolved.kind === "magnet") {
      const parameters = new URLSearchParams({ source: resolved.magnet });
      return QBittorrentRuntime.request("/api/v2/torrents/fetchMetadata", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: formBody(parameters),
        signal,
      });
    }
    const { body, contentType } = multipartTorrent(resolved.torrent, []);
    const parsed = await QBittorrentRuntime.request(
      "/api/v2/torrents/parseMetadata",
      {
        method: "POST",
        headers: { "Content-Type": contentType },
        body,
        signal,
      }
    );
    if (parsed.status !== 200) {
      return parsed;
    }
    const values = JSON.parse(new TextDecoder().decode(parsed.body));
    return response(values[0]);
  }

  async #commit(id, parameters, signal) {
    const resolved = await this.#resolved(id, signal);
    parameters.delete("downloader");
    if (resolved.kind === "magnet") {
      parameters.set("urls", resolved.magnet);
      return QBittorrentRuntime.request("/api/v2/torrents/add", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: formBody(parameters),
        signal,
      });
    }
    parameters.delete("urls");
    const { body, contentType } = multipartTorrent(
      resolved.torrent,
      parameters
    );
    return QBittorrentRuntime.request("/api/v2/torrents/add", {
      method: "POST",
      headers: { "Content-Type": contentType },
      body,
      signal,
    });
  }

  async #addSearchResults(sources, signal) {
    const downloadPath = await Downloads.getPreferredDownloadsDirectory();
    for (const source of sources) {
      const id = parseResultHandle(source);
      if (!id) {
        return response("Invalid torrent result", 400, "text/plain; charset=UTF-8");
      }
      const resolved = await this.#resolved(id, signal);
      if (resolved.kind === "magnet") {
        await TorrentManager.addMagnet(resolved.magnet, downloadPath);
      } else {
        await TorrentManager.addTorrentBytes(resolved.torrent, downloadPath);
      }
    }
    return response("");
  }

  async #cleanup() {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      if (job.expiresAt <= now) {
        job.controller.abort();
        this.jobs.delete(id);
      }
    }
    for (const [id, item] of this.resolved) {
      if (item.expiresAt <= now) {
        this.resolved.delete(id);
      }
    }
  }

  jobs = new Map();
  resolved = new Map();
}

export const QBittorrentSearchBridge = new QBittorrentSearchBridgeImpl();

export const QBittorrentSearchBridgeTestUtils = Object.freeze({
  formParameters,
  multipartTorrent,
  parseResultHandle,
  resultHandle,
  searchRow,
});
