/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { JackettMiniRuntime } from "resource:///modules/JackettMiniRuntime.sys.mjs";
import { ServiceRequest } from "resource://gre/modules/ServiceRequest.sys.mjs";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TORRENT_BYTES = 12 * 1024 * 1024;
const OPAQUE_ID = /^[A-Za-z0-9_-]{32}$/;
const BTIH_MAGNET =
  /^magnet:\?xt=urn:btih:(?:[A-Fa-f0-9]{40}|[A-Za-z2-7]{32})(?:&|$)/;

function invalidResponse() {
  return new Error("Torrent search returned an invalid response");
}

function cleanText(value, maximum) {
  if (typeof value !== "string") {
    throw invalidResponse();
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
    throw invalidResponse();
  }
  return value;
}

function sanitizeSources(response) {
  if (response?.immutable !== true || !Array.isArray(response.sources)) {
    throw invalidResponse();
  }
  return {
    immutable: true,
    sources: response.sources.map(source => {
      if (
        typeof source?.id !== "string" ||
        !source.id ||
        source.id.length > 128 ||
        !["ready", "unavailable"].includes(source.state) ||
        source.access !== "public" ||
        !["general", "mixed-general"].includes(source.contentClass)
      ) {
        throw invalidResponse();
      }
      return {
        id: source.id,
        name: cleanText(source.name, 160),
        state: source.state,
        access: "public",
        contentClass: source.contentClass,
        reasons: Array.isArray(source.reasons)
          ? source.reasons.slice(0, 16).map(reason => cleanText(reason, 256))
          : [],
      };
    }),
  };
}

function sanitizeSearch(response) {
  if (
    !OPAQUE_ID.test(response?.searchId || "") ||
    typeof response.partial !== "boolean" ||
    !Array.isArray(response.providers) ||
    !Array.isArray(response.results) ||
    response.providers.length > 100 ||
    response.results.length > 200
  ) {
    throw invalidResponse();
  }
  const providers = response.providers.map(provider => {
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
      throw invalidResponse();
    }
    return {
      id: provider.id,
      state: provider.state,
      elapsedMs: provider.elapsedMs,
    };
  });
  const results = response.results.map(result => {
    if (
      !OPAQUE_ID.test(result?.resultId || "") ||
      typeof result.providerId !== "string" ||
      !result.providerId ||
      result.providerId.length > 128 ||
      result.access !== "public" ||
      !["magnet", "torrent"].includes(result.acquisition) ||
      !Array.isArray(result.categoryIds) ||
      result.categoryIds.some(
        category => !Number.isSafeInteger(category) || category < 0
      )
    ) {
      throw invalidResponse();
    }
    let publishedAt = null;
    if (result.publishedAt !== null) {
      const time = Date.parse(result.publishedAt);
      if (!Number.isFinite(time)) {
        throw invalidResponse();
      }
      publishedAt = new Date(time).toISOString();
    }
    return {
      resultId: result.resultId,
      providerId: result.providerId,
      providerName: cleanText(result.providerName, 160),
      name: cleanText(result.name, 512),
      sizeBytes: nullableInteger(result.sizeBytes),
      seeders: nullableInteger(result.seeders),
      leechers: nullableInteger(result.leechers),
      publishedAt,
      categoryIds: [...new Set(result.categoryIds)].sort((a, b) => a - b),
      access: "public",
      acquisition: result.acquisition,
    };
  });
  return {
    searchId: response.searchId,
    partial: response.partial,
    providers,
    results,
  };
}

/** Owns the privileged Jackett Mini product connection. */
class TorrentDiscoveryManagerImpl {
  async initialize() {
    if (this.connection) {
      return;
    }
    if (this.initializeTask) {
      await this.initializeTask;
      return;
    }
    this.initializeTask = this.#initialize().catch(error => {
      this.initializeTask = null;
      throw Object.assign(error, { serviceUnavailable: true });
    });
    await this.initializeTask;
  }

  async #initialize() {
    const configured = Services.env.get("WILDBUZZARD_JACKETT_MINI_CONNECTION");
    const connection = configured
      ? await IOUtils.readJSON(configured).catch(() => null)
      : await new JackettMiniRuntime().ensure();
    if (
      connection?.address !== "127.0.0.1" ||
      !Number.isInteger(connection.port) ||
      connection.port < 1 ||
      connection.port > 65535 ||
      typeof connection.capability !== "string" ||
      connection.capability.length < 32
    ) {
      throw new Error("The torrent search connection record is invalid");
    }
    this.connection = connection;
    try {
      await this.#request("GET", "/v1/health", null, 3000);
    } catch (error) {
      this.connection = null;
      throw error;
    }
  }

  #request(method, path, body = null, timeout = 35000) {
    return new Promise((resolve, reject) => {
      const request = new ServiceRequest({ mozAnon: true });
      request.mozBackgroundRequest = true;
      request.open(method, `http://127.0.0.1:${this.connection.port}${path}`, {
        bypassProxy: true,
      });
      request.responseType = "text";
      request.timeout = timeout;
      request.setRequestHeader(
        "Authorization",
        `Bearer ${this.connection.capability}`
      );
      request.setRequestHeader("Cache-Control", "no-store");
      if (body !== null) {
        request.setRequestHeader("Content-Type", "application/json");
      }
      const finish = error => {
        if (this.activeRequest === request) {
          this.activeRequest = null;
        }
        if (error) {
          if (error.serviceUnavailable) {
            this.connection = null;
            this.initializeTask = null;
          }
          reject(error);
          return;
        }
        const length = new TextEncoder().encode(request.responseText).length;
        if (length > MAX_RESPONSE_BYTES) {
          reject(new Error("Torrent search response exceeded its limit"));
          return;
        }
        let response;
        try {
          response = JSON.parse(request.responseText);
        } catch {
          reject(invalidResponse());
          return;
        }
        if (request.status < 200 || request.status >= 300) {
          reject(
            new Error(
              response.error || `Torrent search failed (${request.status})`
            )
          );
          return;
        }
        resolve(response);
      };
      request.addEventListener("load", () => finish());
      request.addEventListener("error", () =>
        finish(
          Object.assign(new Error("Torrent search service request failed"), {
            serviceUnavailable: true,
          })
        )
      );
      request.addEventListener("timeout", () =>
        finish(new Error("Torrent search request timed out"))
      );
      request.addEventListener("abort", () =>
        finish(
          Object.assign(new Error("Torrent search cancelled"), {
            cancelled: true,
          })
        )
      );
      if (path === "/v1/search") {
        this.activeRequest = request;
      }
      request.send(body === null ? null : JSON.stringify(body));
    });
  }

  async getSources() {
    await this.initialize();
    return sanitizeSources(await this.#request("GET", "/v1/sources"));
  }

  async search({ query, sourceIds, limit = 200, isPrivate = false }) {
    if (isPrivate) {
      throw new Error("Torrent search is disabled in private windows");
    }
    query = String(query || "").trim();
    if (!query || query.length > 256 || /\p{Cc}/u.test(query)) {
      throw new Error("Enter a search query of 256 characters or fewer");
    }
    const body = { query, limit };
    if (sourceIds !== undefined) {
      if (
        !Array.isArray(sourceIds) ||
        !sourceIds.length ||
        sourceIds.length > 100 ||
        new Set(sourceIds).size !== sourceIds.length ||
        sourceIds.some(id => typeof id !== "string" || !id || id.length > 128)
      ) {
        throw new Error("Choose one or more valid torrent sources");
      }
      body.sourceIds = sourceIds;
    }
    await this.initialize();
    return sanitizeSearch(await this.#request("POST", "/v1/search", body));
  }

  cancelSearch() {
    this.activeRequest?.abort();
  }

  async resolve(resultId) {
    if (!OPAQUE_ID.test(resultId || "")) {
      throw new Error("The torrent result identifier is invalid");
    }
    await this.initialize();
    const response = await this.#request(
      "POST",
      `/v1/results/${encodeURIComponent(resultId)}/resolve`,
      {}
    );
    if (
      response?.kind === "magnet" &&
      BTIH_MAGNET.test(response.magnet || "") &&
      response.torrentBase64 === null &&
      response.torrentBytes === null
    ) {
      return { kind: "magnet", magnet: response.magnet };
    }
    if (
      response?.kind === "torrent" &&
      response.magnet === null &&
      typeof response.torrentBase64 === "string" &&
      Number.isInteger(response.torrentBytes) &&
      response.torrentBytes > 0 &&
      response.torrentBytes <= MAX_TORRENT_BYTES
    ) {
      const binary = atob(response.torrentBase64);
      if (binary.length !== response.torrentBytes) {
        throw invalidResponse();
      }
      return {
        kind: "torrent",
        torrent: Uint8Array.from(binary, character => character.charCodeAt(0)),
      };
    }
    throw invalidResponse();
  }
}

export const TorrentDiscoveryManager = new TorrentDiscoveryManagerImpl();
