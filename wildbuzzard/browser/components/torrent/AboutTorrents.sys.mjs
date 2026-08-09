/* SPDX-License-Identifier: AGPL-3.0-or-later */

const TORRENTS_URL = "chrome://browser/content/torrents/torrents.xhtml";

/** Implements the privileged about:torrents page. */
export class AboutTorrents {
  classID = Components.ID("{75897cdd-45d8-4d8c-872f-1b603fb55d9a}");
  QueryInterface = ChromeUtils.generateQI(["nsIAboutModule"]);

  newChannel(uri, loadInfo) {
    const channel = Services.io.newChannelFromURIWithLoadInfo(
      Services.io.newURI(TORRENTS_URL),
      loadInfo
    );
    channel.originalURI = uri;
    channel.owner = Services.scriptSecurityManager.getSystemPrincipal();
    return channel;
  }

  getURIFlags() {
    return (
      Ci.nsIAboutModule.ALLOW_SCRIPT | Ci.nsIAboutModule.IS_SECURE_CHROME_UI
    );
  }

  getChromeURI() {
    return Services.io.newURI(TORRENTS_URL);
  }
}
