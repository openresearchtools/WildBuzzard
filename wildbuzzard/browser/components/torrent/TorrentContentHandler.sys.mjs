/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { BrowserWindowTracker } from "resource:///modules/BrowserWindowTracker.sys.mjs";

const CONTENT_TYPES = new Set([
  "application/x-bittorrent",
  "application/vnd.bittorrent",
]);
const recentDownloads = new Map();
const DUPLICATE_WINDOW_MS = 2000;

/** Routes BitTorrent metadata responses to the built-in client. */
export class TorrentContentHandler {
  classID = Components.ID("{a4241547-2440-441b-99a0-cd278ef88fdd}");
  QueryInterface = ChromeUtils.generateQI(["nsIContentHandler"]);

  handleContent(contentType, context, request) {
    if (
      !CONTENT_TYPES.has(contentType) ||
      !(request instanceof Ci.nsIChannel)
    ) {
      throw Components.Exception("", Cr.NS_ERROR_WONT_HANDLE_CONTENT);
    }
    const { loadInfo, URI } = request;
    const now = Date.now();
    for (const [key, timestamp] of recentDownloads) {
      if (now - timestamp >= DUPLICATE_WINDOW_MS) {
        recentDownloads.delete(key);
      }
    }
    const downloadKey = `${loadInfo.browsingContextID}:${URI.spec}`;
    const duplicate = recentDownloads.has(downloadKey);
    recentDownloads.set(downloadKey, now);
    const privateBrowsing = Boolean(
      loadInfo.originAttributes.privateBrowsingId
    );
    const originatingWindow =
      loadInfo.targetBrowsingContext?.top?.embedderElement?.ownerGlobal;
    const targetWindow = () =>
      originatingWindow && !originatingWindow.closed
        ? originatingWindow
        : BrowserWindowTracker.getTopWindow({ private: privateBrowsing });
    request.cancel(Cr.NS_BINDING_ABORTED);
    if (duplicate) {
      return;
    }
    const window = targetWindow();
    if (!window) {
      throw Components.Exception("", Cr.NS_ERROR_NOT_AVAILABLE);
    }
    window.openTrustedLinkIn(
      `about:torrents#download=${encodeURIComponent(URI.spec)}`,
      "tab"
    );
  }
}
