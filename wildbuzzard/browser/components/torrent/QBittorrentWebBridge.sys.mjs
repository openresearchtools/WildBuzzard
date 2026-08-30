/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { QBittorrentRuntime } from "resource:///modules/QBittorrentRuntime.sys.mjs";
import { isFixedTorrentHTMLTarget } from "resource:///modules/TorrentDocumentPolicy.sys.mjs";
import { isTorrentAddTarget } from "resource:///modules/TorrentSecurityPolicy.sys.mjs";

export { isFixedTorrentHTMLTarget };

const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_TARGET_LENGTH = 65536;
const REQUEST_HEADERS = new Set([
  "accept",
  "content-type",
  "if-modified-since",
  "if-none-match",
  "range",
]);
const RESPONSE_HEADERS = new Set([
  "accept-ranges",
  "cache-control",
  "content-disposition",
  "content-range",
  "content-type",
  "etag",
  "last-modified",
]);

function normalizedTargetPath(target) {
  let path = target.split(/[?#]/, 1)[0].replaceAll("\\", "/");
  for (let i = 0; i < 4; i++) {
    try {
      const decoded = decodeURIComponent(path)
        .replaceAll("\\", "/")
        .split(/[?#]/, 1)[0];
      if (decoded === path) {
        break;
      }
      path = decoded;
    } catch {
      break;
    }
  }
  const segments = [];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

export function isEmbeddedSearchTarget(target) {
  return /^\/api\/v2\/search(?:\/|$)/i.test(normalizedTargetPath(target));
}

export function isUnconfirmedMetadataTarget(target) {
  return /^\/api\/v2\/torrents\/fetchMetadata(?:\/|$)/i.test(
    normalizedTargetPath(target)
  );
}

function isByteArray(value) {
  return (
    ArrayBuffer.isView(value) &&
    Object.prototype.toString.call(value) === "[object Uint8Array]"
  );
}

function normalizedHeaders(headers) {
  if (!headers || typeof headers !== "object") {
    throw new TypeError("Invalid torrent request headers");
  }
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (
      REQUEST_HEADERS.has(normalized) &&
      typeof value === "string" &&
      value.length <= 8192 &&
      !/[\r\n\0]/.test(value)
    ) {
      result[name] = value;
    }
  }
  return result;
}

function publicResponseHeaders(headers) {
  const result = [];
  for (const [name, values] of headers) {
    if (!RESPONSE_HEADERS.has(name)) {
      continue;
    }
    for (const value of values) {
      result.push([name, value]);
    }
  }
  return result;
}

function responseContentType(headers) {
  const values = headers.get("content-type") || [];
  if (values.length > 1) {
    throw new TypeError("Ambiguous torrent WebUI content type");
  }
  if (!values.length) {
    return null;
  }
  const essence = values[0].split(";", 1)[0].trim().toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(essence)) {
    throw new TypeError("Invalid torrent WebUI content type");
  }
  return essence;
}

/**
 *
 */
class QBittorrentWebBridgeImpl {
  async request(
    { method = "GET", target, headers = {}, body, signal },
    { userActivation = false } = {}
  ) {
    const htmlTarget = isFixedTorrentHTMLTarget(target);
    const htmlPath =
      typeof target === "string" ? target.split(/[?#]/, 1)[0] : "";
    const addRoute =
      typeof target === "string" &&
      normalizedTargetPath(target).toLowerCase() === "/api/v2/torrents/add";
    if (
      typeof target === "string" &&
      target.length <= MAX_TARGET_LENGTH &&
      isUnconfirmedMetadataTarget(target)
    ) {
      return {
        body: new TextEncoder().encode(
          "Torrent metadata prefetch requires explicit confirmation"
        ),
        headers: [["content-type", "text/plain; charset=UTF-8"]],
        status: 403,
      };
    }
    if (
      !["GET", "POST"].includes(method) ||
      typeof target !== "string" ||
      !target.startsWith("/") ||
      target.length > MAX_TARGET_LENGTH ||
      target.includes("#") ||
      target.includes("\\") ||
      /[^\x21-\x7e]/.test(target) ||
      (!htmlTarget && htmlPath.toLowerCase().endsWith(".html")) ||
      (htmlTarget && method !== "GET") ||
      (addRoute &&
        (!isTorrentAddTarget(target) ||
          method !== "POST" ||
          userActivation !== true)) ||
      isEmbeddedSearchTarget(target) ||
      !isByteArray(body) ||
      body.length > MAX_REQUEST_BYTES
    ) {
      throw new TypeError("Invalid torrent WebUI request");
    }
    body = new Uint8Array(body);
    const safeHeaders = normalizedHeaders(headers);
    const response = await QBittorrentRuntime.request(target, {
      method,
      headers: safeHeaders,
      body,
      signal,
      maximum: 64 * 1024 * 1024,
    });
    const contentType = responseContentType(response.headers);
    if (
      htmlTarget ? contentType !== "text/html" : contentType === "text/html"
    ) {
      throw new TypeError("Unexpected torrent WebUI HTML response");
    }
    return {
      body: response.body,
      classification: htmlTarget ? "torrent-html" : "other",
      headers: publicResponseHeaders(response.headers),
      status: response.status,
    };
  }
}

export const QBittorrentWebBridge = new QBittorrentWebBridgeImpl();
