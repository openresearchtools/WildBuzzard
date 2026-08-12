/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { SearXNGManager } from "resource:///modules/SearXNGManager.sys.mjs";

const SCHEME = "moz-searxng";
const HOST = "local";
const ALLOWED_CONTENT_TYPES = new Set([
  "application/javascript",
  "application/json",
  "application/xml",
  "image/png",
  "image/svg+xml",
  "text/css",
  "text/html",
  "text/plain",
  "text/xml",
]);
const ALLOWED_DOCUMENT_PATH =
  /^\/(?:|search|preferences|manifest\.json|favicon\.ico|rss\.xsl|logo\/[A-Za-z0-9._-]+|info\/[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+|static\/[A-Za-z0-9_./-]+|client[A-Za-z0-9_-]+\.css)$/;

export function searXNGTargetFromURI(uri) {
  if (
    !uri ||
    uri.scheme !== SCHEME ||
    uri.host !== HOST ||
    uri.hasRef ||
    uri.userPass ||
    uri.port !== -1
  ) {
    throw Components.Exception(
      "Invalid internal SearXNG URI",
      Cr.NS_ERROR_MALFORMED_URI
    );
  }
  const target = `${uri.filePath}${uri.query ? `?${uri.query}` : ""}`;
  if (!ALLOWED_DOCUMENT_PATH.test(uri.filePath) || target.includes("..")) {
    throw Components.Exception(
      "Invalid internal SearXNG path",
      Cr.NS_ERROR_MALFORMED_URI
    );
  }
  return target;
}

function responseContentType(response) {
  const source = response.headers.get("content-type") ?? "";
  const match = /^([^;\s]+)(?:\s*;\s*charset=([A-Za-z0-9._-]+))?$/i.exec(
    source
  );
  const contentType = match?.[1].toLowerCase();
  if (!contentType || !ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw new Error("SearXNG returned an unsupported content type");
  }
  return { contentCharset: match?.[2] ?? "", contentType };
}

/** Proxies trusted internal search documents over the private UDS. */
export class SearXNGProtocolHandler {
  scheme = SCHEME;

  allowPort() {
    return false;
  }

  newChannel(uri, loadInfo) {
    const principalURI = loadInfo?.loadingPrincipal?.URI;
    if (
      Services.appinfo.processType !== Services.appinfo.PROCESS_TYPE_DEFAULT ||
      (!loadInfo?.loadingPrincipal?.isSystemPrincipal &&
        (principalURI?.scheme !== SCHEME || principalURI?.host !== HOST))
    ) {
      throw Components.Exception(
        "The internal SearXNG protocol is parent-only",
        Cr.NS_ERROR_DOM_BAD_URI
      );
    }
    const target = searXNGTargetFromURI(uri);
    const channel = Cc["@mozilla.org/network/input-stream-channel;1"]
      .createInstance(Ci.nsIInputStreamChannel)
      .QueryInterface(Ci.nsIChannel);
    channel.loadInfo = loadInfo;
    channel.setURI(uri);
    channel.originalURI = uri;
    const suspended = Services.io.newSuspendableChannelWrapper(channel);
    suspended.suspend();
    const controller = new AbortController();
    SearXNGManager.requestDocument(target, controller.signal)
      .then(response => {
        if (response.status !== 200) {
          throw new Error(
            `SearXNG document failed with status ${response.status}`
          );
        }
        const { contentCharset, contentType } = responseContentType(response);
        const stream = Cc[
          "@mozilla.org/io/arraybuffer-input-stream;1"
        ].createInstance(Ci.nsIArrayBufferInputStream);
        stream.setData(
          response.body.buffer,
          response.body.byteOffset,
          response.body.byteLength
        );
        channel.contentType = contentType;
        channel.contentCharset = contentCharset;
        channel.contentLength = response.body.byteLength;
        channel.contentStream = stream;
      })
      .catch(() => channel.cancel(Cr.NS_ERROR_FAILURE))
      .finally(() => suspended.resume());
    return suspended;
  }

  QueryInterface = ChromeUtils.generateQI(["nsIProtocolHandler"]);
}

export const SearXNGProtocolHandlerTestUtils = { responseContentType };
