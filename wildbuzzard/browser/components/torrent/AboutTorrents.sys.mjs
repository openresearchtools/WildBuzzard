/* SPDX-License-Identifier: AGPL-3.0-or-later */

const TORRENTS_URL = "moz-torrent://local/";

/** Implements the privileged about:torrents page. */
export class AboutTorrents {
  classID = Components.ID("{75897cdd-45d8-4d8c-872f-1b603fb55d9a}");
  QueryInterface = ChromeUtils.generateQI(["nsIAboutModule"]);

  newChannel(uri, loadInfo) {
    const suffix = `${uri.query ? `?${uri.query}` : ""}${uri.ref ? `#${uri.ref}` : ""}`;
    const channel = Services.io.newChannelFromURIWithLoadInfo(
      Services.io.newURI(`${TORRENTS_URL}${suffix}`),
      loadInfo
    );
    channel.originalURI = uri;
    channel.owner = Services.scriptSecurityManager.getSystemPrincipal();
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
    return Services.io.newURI(TORRENTS_URL);
  }
}
