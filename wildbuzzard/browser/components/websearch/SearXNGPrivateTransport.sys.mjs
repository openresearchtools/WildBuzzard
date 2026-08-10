/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { CryptoUtils } from "resource://services-crypto/utils.sys.mjs";

const LocalFile = Components.Constructor(
  "@mozilla.org/file/local;1",
  "nsIFile",
  "initWithPath"
);
const CryptoHash = Components.Constructor(
  "@mozilla.org/security/hash;1",
  "nsICryptoHash",
  "initWithString"
);

const AUTHORIZATION_SCHEME = "WildBuzzard-HMAC-SHA256";
const REQUEST_AUTH_DOMAIN = "wildbuzzard-searxng-request-v1";
const RESPONSE_AUTH_DOMAIN = "wildbuzzard-searxng-response-v1";
const MAX_RESPONSE_BYTES = 64 * 1024;
const SOCKET_PATH = /^\/tmp\/wb-sx-g-\d+-[a-f0-9]{24}-[a-f0-9]{32}\/s$/;

function bytesToHex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function hexDigest(bytes) {
  const hash = new CryptoHash("sha256");
  hash.update(bytes, bytes.length);
  return Array.from(hash.finish(false), byte =>
    byte.charCodeAt(0).toString(16).padStart(2, "0")
  ).join("");
}

async function hmacHex(token, parts) {
  const encoder = new TextEncoder();
  return bytesToHex(
    await CryptoUtils.hmac(
      "SHA-256",
      encoder.encode(token),
      encoder.encode(parts.join("\0"))
    )
  );
}

async function requestAuthentication(token, method, target, body, nonce) {
  return hmacHex(token, [
    REQUEST_AUTH_DOMAIN,
    method,
    target,
    nonce,
    hexDigest(body),
  ]);
}

async function responseAuthentication(token, nonce, status, contentType, body) {
  return hmacHex(token, [
    RESPONSE_AUTH_DOMAIN,
    nonce,
    String(status),
    contentType,
    hexDigest(body),
  ]);
}

function timingSafeEqual(left, right) {
  if (typeof left !== "string" || left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function validatePrivateSocket(record) {
  if (
    typeof record.privateSocket !== "string" ||
    !SOCKET_PATH.test(record.privateSocket) ||
    new TextEncoder().encode(record.privateSocket).length > 107 ||
    !Number.isSafeInteger(record.privateSocketDevice) ||
    record.privateSocketDevice < 0 ||
    !Number.isSafeInteger(record.privateSocketInode) ||
    record.privateSocketInode < 1
  ) {
    throw new Error("SearXNG private socket identity is invalid");
  }
  const socket = new LocalFile(record.privateSocket);
  const parent = socket.parent;
  if (
    !socket.exists() ||
    socket.isSymlink() ||
    !socket.isSpecial() ||
    (socket.permissions & 0o777) !== 0o600 ||
    !parent.isDirectory() ||
    parent.isSymlink() ||
    (parent.permissions & 0o777) !== 0o700
  ) {
    throw new Error("SearXNG private socket identity is invalid");
  }
  return socket;
}

function readUnixResponse(socket, request, timeout) {
  return new Promise((resolve, reject) => {
    let transport;
    let output;
    try {
      transport = Cc["@mozilla.org/network/socket-transport-service;1"]
        .getService(Ci.nsISocketTransportService)
        .createUnixDomainTransport(socket);
      const seconds = Math.max(1, Math.ceil(timeout / 1000));
      transport.setTimeout(Ci.nsISocketTransport.TIMEOUT_CONNECT, seconds);
      transport.setTimeout(Ci.nsISocketTransport.TIMEOUT_READ_WRITE, seconds);
      const input = transport
        .openInputStream(0, 0, 0)
        .QueryInterface(Ci.nsIAsyncInputStream);
      output = transport.openOutputStream(0, 0, 0);
      for (let offset = 0; offset < request.length; ) {
        const written = output.write(
          request.slice(offset),
          request.length - offset
        );
        if (written < 1) {
          throw new Error("SearXNG private socket write failed");
        }
        offset += written;
      }
      output.flush();
      const pump = Cc[
        "@mozilla.org/network/input-stream-pump;1"
      ].createInstance(Ci.nsIInputStreamPump);
      pump.init(input, 0, 0, true);
      const chunks = [];
      let size = 0;
      pump.asyncRead({
        onStartRequest() {},
        onDataAvailable(activeRequest, stream) {
          const reader = Cc[
            "@mozilla.org/scriptableinputstream;1"
          ].createInstance(Ci.nsIScriptableInputStream);
          reader.init(stream);
          const chunk = reader.readBytes(reader.available());
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            activeRequest.cancel(Cr.NS_ERROR_FILE_TOO_BIG);
            return;
          }
          chunks.push(chunk);
        },
        onStopRequest(_activeRequest, status) {
          try {
            if (!Components.isSuccessCode(status)) {
              throw new Error("SearXNG private socket request failed");
            }
            resolve(chunks.join(""));
          } catch (error) {
            reject(error);
          } finally {
            output?.close();
          }
        },
      });
    } catch (error) {
      output?.close();
      transport?.close(Cr.NS_ERROR_ABORT);
      reject(error);
    }
  });
}

function parseHTTPResponse(source) {
  const separator = source.indexOf("\r\n\r\n");
  if (separator < 0) {
    throw new Error("SearXNG private socket returned invalid HTTP");
  }
  const headerLines = source.slice(0, separator).split("\r\n");
  const statusMatch = /^HTTP\/1\.1 ([1-5]\d\d)(?: [^\r\n]*)?$/.exec(
    headerLines.shift()
  );
  if (!statusMatch) {
    throw new Error("SearXNG private socket returned invalid HTTP");
  }
  const headers = new Map();
  for (const line of headerLines) {
    const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*([^\r\n]*)$/.exec(line);
    if (!match) {
      throw new Error("SearXNG private socket returned invalid HTTP headers");
    }
    const name = match[1].toLowerCase();
    if (headers.has(name)) {
      throw new Error("SearXNG private socket returned duplicate HTTP headers");
    }
    headers.set(name, match[2].trim());
  }
  const bodySource = source.slice(separator + 4);
  const body = Uint8Array.from(bodySource, character =>
    character.charCodeAt(0)
  );
  if (
    !/^\d+$/.test(headers.get("content-length") ?? "") ||
    Number(headers.get("content-length")) !== body.length ||
    headers.has("transfer-encoding")
  ) {
    throw new Error("SearXNG private socket returned invalid HTTP framing");
  }
  return { body, headers, status: Number(statusMatch[1]) };
}

export async function requestSearXNGPrivateJSON(record, path, timeout = 3000) {
  if (!/^\/v1\/(?:health|identity)$/.test(path)) {
    throw new Error("Invalid SearXNG private request path");
  }
  const socket = validatePrivateSocket(record);
  const nonceBytes = new Uint8Array(24);
  crypto.getRandomValues(nonceBytes);
  const nonce = ChromeUtils.base64URLEncode(nonceBytes, { pad: false });
  const body = new Uint8Array();
  const authentication = await requestAuthentication(
    record.token,
    "GET",
    path,
    body,
    nonce
  );
  const request =
    `GET ${path} HTTP/1.1\r\n` +
    `Host: localhost\r\n` +
    `Authorization: ${AUTHORIZATION_SCHEME} ${authentication}\r\n` +
    `X-WildBuzzard-Nonce: ${nonce}\r\n` +
    `Cache-Control: no-store\r\n` +
    `Sec-Fetch-Site: none\r\n` +
    `Connection: close\r\n\r\n`;
  const response = parseHTTPResponse(
    await readUnixResponse(socket, request, timeout)
  );
  const contentType = response.headers.get("content-type") ?? "";
  const expected = await responseAuthentication(
    record.token,
    nonce,
    response.status,
    contentType,
    response.body
  );
  if (
    !timingSafeEqual(
      response.headers.get("x-wildbuzzard-response-authentication"),
      expected
    )
  ) {
    throw new Error("SearXNG private response authentication failed");
  }
  let value;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(response.body)
    );
  } catch {
    throw new Error("SearXNG private socket returned invalid JSON");
  }
  return { body: value, status: response.status };
}

export const SearXNGPrivateTransportTestUtils = {
  parseHTTPResponse,
  requestAuthentication,
  responseAuthentication,
  timingSafeEqual,
  validatePrivateSocket,
};
