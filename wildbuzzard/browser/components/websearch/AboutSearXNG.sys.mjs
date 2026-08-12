/* SPDX-License-Identifier: AGPL-3.0-or-later */

const SEARCH_URL = "chrome://browser/content/searxng/searxng.xhtml";

/** Implements the privileged about:searxng search page. */
export class AboutSearXNG {
  classID = Components.ID("{6ef418e4-ccad-4f98-8e1a-d4338dfd9d84}");
  QueryInterface = ChromeUtils.generateQI(["nsIAboutModule"]);

  newChannel(uri, loadInfo) {
    const channel = Services.io.newChannelFromURIWithLoadInfo(
      Services.io.newURI(SEARCH_URL),
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
    return Services.io.newURI(SEARCH_URL);
  }
}
