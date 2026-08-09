/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { BrowserWindowTracker } from "resource:///modules/BrowserWindowTracker.sys.mjs";
import { TorrentManager } from "resource:///modules/TorrentManager.sys.mjs";

const CONTENT_TYPES = new Set([
  "application/x-bittorrent",
  "application/vnd.bittorrent",
]);

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
    request.cancel(Cr.NS_BINDING_ABORTED);
    TorrentManager.addFromURL(
      URI.spec,
      loadInfo.triggeringPrincipal,
      undefined,
      loadInfo.cookieJarSettings
    ).catch(error => {
      console.error(error);
    });
    const window = BrowserWindowTracker.getTopWindow();
    window?.openTrustedLinkIn("about:torrents", "tab");
  }
}
