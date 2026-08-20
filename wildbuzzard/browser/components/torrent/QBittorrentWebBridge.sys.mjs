/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { QBittorrentRuntime } from "resource:///modules/QBittorrentRuntime.sys.mjs";
import { QBittorrentSearchBridge } from "resource:///modules/QBittorrentSearchBridge.sys.mjs";

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
const BRIDGE_SCRIPT = '<script src="/scripts/wildbuzzard-bridge.js"></script>';

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

class QBittorrentWebBridgeImpl {
  async request({ method = "GET", target, headers = {}, body, signal }) {
    if (
      !["GET", "POST"].includes(method) ||
      typeof target !== "string" ||
      !target.startsWith("/") ||
      target.length > MAX_TARGET_LENGTH ||
      /[^\x20-\x7e]/.test(target) ||
      /[\r\n]/.test(target) ||
      !isByteArray(body) ||
      body.length > MAX_REQUEST_BYTES
    ) {
      throw new TypeError("Invalid torrent WebUI request");
    }
    body = new Uint8Array(body);
    const safeHeaders = normalizedHeaders(headers);
    const response =
      (await QBittorrentSearchBridge.maybeRequest({
        method,
        target,
        headers: safeHeaders,
        body,
        signal,
      })) ??
      (await QBittorrentRuntime.request(target, {
        method,
        headers: safeHeaders,
        body,
        signal,
        maximum: 64 * 1024 * 1024,
      }));
    let responseBody = response.body;
    const contentType = response.headers.get("content-type")?.[0] || "";
    if (
      method === "GET" &&
      contentType.startsWith("text/html") &&
      !new TextDecoder().decode(responseBody).includes("wildbuzzard-bridge.js")
    ) {
      const source = new TextDecoder().decode(responseBody);
      const marker = source.indexOf("<script");
      const transformed =
        marker === -1
          ? source.replace("</head>", `${BRIDGE_SCRIPT}</head>`)
          : `${source.slice(0, marker)}${BRIDGE_SCRIPT}${source.slice(marker)}`;
      responseBody = new TextEncoder().encode(transformed);
    }
    return {
      body: responseBody,
      headers: publicResponseHeaders(response.headers),
      status: response.status,
    };
  }
}

export const QBittorrentWebBridge = new QBittorrentWebBridgeImpl();
