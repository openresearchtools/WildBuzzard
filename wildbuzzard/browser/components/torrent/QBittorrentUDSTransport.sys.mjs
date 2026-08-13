/* SPDX-License-Identifier: AGPL-3.0-or-later */

const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;

function abortError() {
  return Components.Exception(
    "qBittorrent request was cancelled",
    Cr.NS_ERROR_ABORT
  );
}

function byteString(bytes) {
  let result = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    result += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return result;
}

function bytesFromString(value) {
  return Uint8Array.from(value, character => character.charCodeAt(0));
}

function writeAsyncRequest(output, request, signal) {
  return new Promise((resolve, reject) => {
    let offset = 0;
    let flushing = false;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => {
      try {
        output.closeWithStatus(Cr.NS_ERROR_ABORT);
      } catch {}
      finish(reject, abortError());
    };
    const wait = () =>
      output.asyncWait(
        callback,
        0,
        flushing ? 0 : Math.min(request.length - offset, 64 * 1024),
        Services.tm.currentThread
      );
    const callback = {
      onOutputStreamReady(stream) {
        if (settled) {
          return;
        }
        try {
          if (flushing) {
            try {
              stream.flush();
            } catch (error) {
              if (
                error.result === Cr.NS_BASE_STREAM_WOULD_BLOCK ||
                error.result === Cr.NS_ERROR_FAILURE
              ) {
                wait();
                return;
              }
              throw error;
            }
            finish(resolve);
            return;
          }
          while (offset < request.length) {
            if (signal?.aborted) {
              onAbort();
              return;
            }
            let written;
            try {
              written = stream.write(
                request.slice(offset),
                request.length - offset
              );
            } catch (error) {
              if (error.result === Cr.NS_BASE_STREAM_WOULD_BLOCK) {
                wait();
                return;
              }
              throw error;
            }
            if (written < 1) {
              wait();
              return;
            }
            offset += written;
          }
          flushing = true;
          this.onOutputStreamReady(stream);
        } catch (error) {
          finish(reject, error);
        }
      },
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    wait();
  });
}

function decodeChunked(source) {
  let cursor = 0;
  const chunks = [];
  while (true) {
    const lineEnd = source.indexOf("\r\n", cursor);
    if (lineEnd < 0) {
      throw new Error("qBittorrent returned invalid chunked HTTP framing");
    }
    const sizeText = source.slice(cursor, lineEnd).split(";", 1)[0];
    if (!/^[0-9A-Fa-f]+$/.test(sizeText)) {
      throw new Error("qBittorrent returned invalid chunked HTTP framing");
    }
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isSafeInteger(size)) {
      throw new Error("qBittorrent returned invalid chunked HTTP framing");
    }
    cursor = lineEnd + 2;
    if (size === 0) {
      if (source.slice(cursor) !== "\r\n") {
        throw new Error("qBittorrent returned unsupported HTTP trailers");
      }
      return chunks.join("");
    }
    if (
      cursor + size + 2 > source.length ||
      source.slice(cursor + size, cursor + size + 2) !== "\r\n"
    ) {
      throw new Error("qBittorrent returned truncated chunked HTTP data");
    }
    chunks.push(source.slice(cursor, cursor + size));
    cursor += size + 2;
  }
}

export function parseQBittorrentHTTPResponse(
  source,
  maximum = DEFAULT_MAX_RESPONSE_BYTES
) {
  const separator = source.indexOf("\r\n\r\n");
  if (separator < 0 || separator > MAX_HEADER_BYTES) {
    throw new Error("qBittorrent returned invalid HTTP");
  }
  const lines = source.slice(0, separator).split("\r\n");
  const statusMatch = /^HTTP\/1\.[01] ([1-5]\d\d)(?: [^\r\n]*)?$/.exec(
    lines.shift()
  );
  if (!statusMatch) {
    throw new Error("qBittorrent returned invalid HTTP status");
  }
  const headers = new Map();
  for (const line of lines) {
    const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*([^\r\n]*)$/.exec(line);
    if (!match) {
      throw new Error("qBittorrent returned invalid HTTP headers");
    }
    const name = match[1].toLowerCase();
    const values = headers.get(name) ?? [];
    values.push(match[2].trim());
    headers.set(name, values);
  }
  if ((headers.get("content-encoding")?.[0] ?? "identity") !== "identity") {
    throw new Error("qBittorrent returned unsupported content encoding");
  }
  let body = source.slice(separator + 4);
  const transferEncoding = headers.get("transfer-encoding");
  const contentLength = headers.get("content-length");
  if (transferEncoding) {
    if (
      transferEncoding.length !== 1 ||
      transferEncoding[0].toLowerCase() !== "chunked" ||
      contentLength
    ) {
      throw new Error("qBittorrent returned invalid HTTP framing");
    }
    body = decodeChunked(body);
  } else if (contentLength) {
    if (
      contentLength.length !== 1 ||
      !/^(?:0|[1-9]\d*)$/.test(contentLength[0])
    ) {
      throw new Error("qBittorrent returned invalid HTTP content length");
    }
    const length = Number(contentLength[0]);
    if (!Number.isSafeInteger(length) || length !== body.length) {
      throw new Error("qBittorrent returned invalid HTTP content length");
    }
  }
  const bodyBytes = bytesFromString(body);
  if (bodyBytes.length > maximum) {
    throw new Error("qBittorrent response body exceeded its limit");
  }
  return {
    body: bodyBytes,
    headers,
    status: Number(statusMatch[1]),
  };
}

function readUnixResponse(socket, request, timeout, maximum, signal) {
  return new Promise((resolve, reject) => {
    let output;
    let pump;
    let settled = false;
    const transport = Cc["@mozilla.org/network/socket-transport-service;1"]
      .getService(Ci.nsISocketTransportService)
      .createUnixDomainTransport(socket);
    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      try {
        output?.close();
      } catch {}
      try {
        transport.close(Cr.NS_OK);
      } catch {}
      callback(value);
    };
    const onAbort = () => {
      try {
        pump?.cancel(Cr.NS_ERROR_ABORT);
      } catch {}
      try {
        transport.close(Cr.NS_ERROR_ABORT);
      } catch {}
      finish(reject, abortError());
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const seconds = Math.max(1, Math.ceil(timeout / 1000));
      transport.setTimeout(Ci.nsISocketTransport.TIMEOUT_CONNECT, seconds);
      transport.setTimeout(Ci.nsISocketTransport.TIMEOUT_READ_WRITE, seconds);
      const input = transport
        .openInputStream(0, 0, 0)
        .QueryInterface(Ci.nsIAsyncInputStream);
      output = transport
        .openOutputStream(0, 0, 0)
        .QueryInterface(Ci.nsIAsyncOutputStream);
      pump = Cc["@mozilla.org/network/input-stream-pump;1"].createInstance(
        Ci.nsIInputStreamPump
      );
      pump.init(input, 0, 0, true);
      const chunks = [];
      let size = 0;
      pump.asyncRead({
        onStartRequest() {},
        onDataAvailable(activeRequest, stream, _offset, count) {
          const reader = Cc[
            "@mozilla.org/scriptableinputstream;1"
          ].createInstance(Ci.nsIScriptableInputStream);
          reader.init(stream);
          const chunk = reader.readBytes(count);
          size += chunk.length;
          if (size > maximum + MAX_HEADER_BYTES) {
            activeRequest.cancel(Cr.NS_ERROR_FILE_TOO_BIG);
            return;
          }
          chunks.push(chunk);
        },
        onStopRequest(_activeRequest, status) {
          if (!Components.isSuccessCode(status)) {
            finish(
              reject,
              status === Cr.NS_ERROR_ABORT
                ? abortError()
                : new Error("qBittorrent socket request failed")
            );
            return;
          }
          try {
            finish(
              resolve,
              parseQBittorrentHTTPResponse(chunks.join(""), maximum)
            );
          } catch (error) {
            finish(reject, error);
          }
        },
      });
      writeAsyncRequest(output, request, signal).catch(error =>
        finish(reject, error)
      );
    } catch (error) {
      finish(reject, error);
    }
  });
}

function validHeader(name, value) {
  return Boolean(
    /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) &&
      typeof value === "string" &&
      value.length <= 8192 &&
      !/[\r\n\0]/.test(value)
  );
}

export function requestQBittorrentUDS(
  socket,
  {
    method = "GET",
    target,
    body = new Uint8Array(),
    headers = {},
    timeout = 60000,
    maximum = DEFAULT_MAX_RESPONSE_BYTES,
    signal,
  }
) {
  if (
    !["GET", "POST"].includes(method) ||
    typeof target !== "string" ||
    !target.startsWith("/") ||
    target.length > 65536 ||
    /[^\x20-\x7e]/.test(target) ||
    /[\r\n]/.test(target) ||
    !(body instanceof Uint8Array) ||
    body.length > MAX_REQUEST_BYTES ||
    !headers ||
    typeof headers !== "object" ||
    Object.entries(headers).some(([name, value]) => !validHeader(name, value)) ||
    !Number.isInteger(timeout) ||
    timeout < 1 ||
    timeout > 120000 ||
    !Number.isInteger(maximum) ||
    maximum < 1 ||
    maximum > DEFAULT_MAX_RESPONSE_BYTES
  ) {
    throw new TypeError("Invalid qBittorrent UDS request");
  }
  let request =
    `${method} ${target} HTTP/1.1\r\n` +
    "Host: localhost\r\n" +
    "Accept-Encoding: identity\r\n" +
    "Cache-Control: no-store\r\n" +
    "Connection: close\r\n" +
    "User-Agent: WildBuzzard-Torrent/1\r\n";
  for (const [name, value] of Object.entries(headers)) {
    request += `${name}: ${value}\r\n`;
  }
  if (body.length && !Object.keys(headers).some(name => name.toLowerCase() === "content-length")) {
    request += `Content-Length: ${body.length}\r\n`;
  }
  request += `\r\n${byteString(body)}`;
  return readUnixResponse(socket, request, timeout, maximum, signal);
}

export const QBittorrentUDSTransportTestUtils = {
  byteString,
  decodeChunked,
  writeAsyncRequest,
};
