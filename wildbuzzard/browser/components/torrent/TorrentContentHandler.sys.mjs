/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { TorrentIngress } from "resource:///modules/TorrentIngress.sys.mjs";

const CONTENT_TYPES = new Set([
  "application/x-bittorrent",
  "application/vnd.bittorrent",
]);

/** Handles user-initiated torrent document responses. */
export class TorrentContentHandler {
  handleContent(contentType, _context, request) {
    if (
      !CONTENT_TYPES.has(contentType) ||
      !(request instanceof Ci.nsIChannel) ||
      request.loadInfo.externalContentPolicyType !==
        Ci.nsIContentPolicy.TYPE_DOCUMENT
    ) {
      throw Components.Exception(
        "Unsupported torrent content",
        Cr.NS_ERROR_WONT_HANDLE_CONTENT
      );
    }
    const { loadInfo, URI } = request;
    let referrerInfo = null;
    if (request instanceof Ci.nsIHttpChannel) {
      referrerInfo = request.referrerInfo;
    }
    const sourceContext = Object.freeze({
      loadingPrincipal: loadInfo.loadingPrincipal,
      triggeringPrincipal: loadInfo.triggeringPrincipal,
      cookieJarSettings: loadInfo.cookieJarSettings,
      referrerInfo,
    });
    request.cancel(Cr.NS_BINDING_ABORTED);
    TorrentIngress.addTorrentURL(URI, loadInfo, sourceContext).catch(error => {
      console.error("Failed to add torrent metadata", error);
    });
  }

  QueryInterface = ChromeUtils.generateQI(["nsIContentHandler"]);
}
