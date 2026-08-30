/* SPDX-License-Identifier: AGPL-3.0-or-later */

import {
  createTorrentDocumentNonce,
  torrentBootstrapDocument,
} from "resource:///modules/TorrentDocumentPolicy.sys.mjs";
import { isPrivateTorrentLoad } from "resource:///modules/TorrentSecurityPolicy.sys.mjs";

const BOOTSTRAP_URL = "resource:///modules/torrent-bootstrap.html";
const WEBUI_PRINCIPAL_URL = "https://torrent.wildbuzzard.invalid/";

/**
 *
 */
export class AboutTorrents {
  QueryInterface = ChromeUtils.generateQI(["nsIAboutModule"]);

  newChannel(uri, loadInfo) {
    if (isPrivateTorrentLoad(loadInfo)) {
      throw Components.Exception(
        "The torrent manager is unavailable in private browsing",
        Cr.NS_ERROR_DOM_BAD_URI
      );
    }
    const nonce = createTorrentDocumentNonce();
    const stream = Cc["@mozilla.org/io/string-input-stream;1"].createInstance(
      Ci.nsIStringInputStream
    );
    stream.setUTF8Data(
      torrentBootstrapDocument(nonce, "torrent-bootstrap.js", "Torrents")
    );
    const channel = Cc["@mozilla.org/network/input-stream-channel;1"]
      .createInstance(Ci.nsIInputStreamChannel)
      .QueryInterface(Ci.nsIChannel);
    channel.loadInfo = loadInfo;
    channel.setURI(Services.io.newURI(BOOTSTRAP_URL));
    channel.originalURI = uri;
    channel.owner = Services.scriptSecurityManager.createContentPrincipal(
      Services.io.newURI(WEBUI_PRINCIPAL_URL),
      loadInfo.originAttributes
    );
    channel.contentStream = stream;
    channel.contentType = "text/html";
    channel.contentCharset = "UTF-8";
    return channel;
  }

  getURIFlags() {
    return (
      Ci.nsIAboutModule.ALLOW_SCRIPT |
      Ci.nsIAboutModule.IS_SECURE_CHROME_UI |
      Ci.nsIAboutModule.URI_CAN_LOAD_IN_PRIVILEGEDABOUT_PROCESS |
      Ci.nsIAboutModule.URI_MUST_LOAD_IN_CHILD
    );
  }

  getChromeURI() {
    return Services.io.newURI(BOOTSTRAP_URL);
  }
}
