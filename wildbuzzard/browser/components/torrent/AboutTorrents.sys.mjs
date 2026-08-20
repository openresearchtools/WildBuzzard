/* SPDX-License-Identifier: AGPL-3.0-or-later */

const BOOTSTRAP_URL = "resource:///modules/torrent-bootstrap.html";
const WEBUI_PRINCIPAL_URL = "https://torrent.wildbuzzard.invalid/";

export class AboutTorrents {
  QueryInterface = ChromeUtils.generateQI(["nsIAboutModule"]);

  newChannel(uri, loadInfo) {
    const channel = Services.io.newChannelFromURIWithLoadInfo(
      Services.io.newURI(BOOTSTRAP_URL),
      loadInfo
    );
    channel.originalURI = uri;
    channel.owner = Services.scriptSecurityManager.createContentPrincipal(
      Services.io.newURI(WEBUI_PRINCIPAL_URL),
      loadInfo.originAttributes
    );
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
