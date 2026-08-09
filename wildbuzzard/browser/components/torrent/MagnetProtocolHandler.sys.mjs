/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { BrowserWindowTracker } from "resource:///modules/BrowserWindowTracker.sys.mjs";

/** Opens magnet links in the built-in torrent client. */
export class MagnetProtocolHandler {
  classID = Components.ID("{3c20a697-9508-4c7e-a00c-f0ca555a8c95}");
  QueryInterface = ChromeUtils.generateQI(["nsIProtocolHandler"]);
  scheme = "magnet";
  defaultPort = -1;
  protocolFlags =
    Ci.nsIProtocolHandler.URI_LOADABLE_BY_ANYONE |
    Ci.nsIProtocolHandler.URI_NON_PERSISTABLE |
    Ci.nsIProtocolHandler.URI_NORELATIVE |
    Ci.nsIProtocolHandler.URI_NOAUTH;

  newChannel(uri, loadInfo) {
    if (
      loadInfo.externalContentPolicyType !== Ci.nsIContentPolicy.TYPE_DOCUMENT
    ) {
      throw Components.Exception("", Cr.NS_ERROR_DOM_BAD_URI);
    }
    const target = Services.io.newURI(
      `about:torrents?add=${encodeURIComponent(uri.spec)}`
    );
    const browsingContext = loadInfo.browsingContext?.top;
    Services.tm.dispatchToMainThread(() => {
      const browser = browsingContext?.embedderElement;
      if (browser?.loadURI) {
        browser.loadURI(target.spec, {
          triggeringPrincipal:
            Services.scriptSecurityManager.getSystemPrincipal(),
        });
        return;
      }
      BrowserWindowTracker.getTopWindow()?.openTrustedLinkIn(
        target.spec,
        "tab"
      );
    });
    throw Components.Exception("", Cr.NS_BINDING_ABORTED);
  }

  allowPort() {
    return false;
  }
}
