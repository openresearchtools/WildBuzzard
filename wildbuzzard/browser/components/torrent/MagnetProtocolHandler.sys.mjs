/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { TorrentIngress } from "resource:///modules/TorrentIngress.sys.mjs";

/**
 *
 */
export class MagnetProtocolHandler {
  scheme = "magnet";

  newChannel(uri, loadInfo) {
    if (
      loadInfo.externalContentPolicyType !== Ci.nsIContentPolicy.TYPE_DOCUMENT
    ) {
      throw Components.Exception(
        "Magnet links are restricted to top-level navigation",
        Cr.NS_ERROR_DOM_BAD_URI
      );
    }
    TorrentIngress.addMagnet(uri.spec, loadInfo).catch(error => {
      console.error("Failed to add a magnet link", error);
    });
    const channel = Services.io.newChannelFromURIWithLoadInfo(
      Services.io.newURI("about:blank"),
      loadInfo
    );
    channel.cancel(Cr.NS_BINDING_ABORTED);
    return channel;
  }

  allowPort() {
    return false;
  }

  QueryInterface = ChromeUtils.generateQI(["nsIProtocolHandler"]);
}
