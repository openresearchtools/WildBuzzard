/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { agentEndpointURI } from "resource:///modules/WildBuzzardAgentURL.sys.mjs";

const STARTING_URL = "chrome://browser/content/agent/starting.xhtml";

/** Resolves the stable Agent page to the verified loopback service. */
export class AboutAgent {
  classID = Components.ID("{395d8425-b5fc-4d79-8f4c-dd83db4303dd}");
  QueryInterface = ChromeUtils.generateQI(["nsIAboutModule"]);

  newChannel(uri, loadInfo) {
    const endpoint = agentEndpointURI();
    const channel = Services.io.newChannelFromURIWithLoadInfo(
      endpoint ?? Services.io.newURI(STARTING_URL),
      loadInfo
    );
    if (endpoint) {
      channel.owner = Services.scriptSecurityManager.createContentPrincipal(
        endpoint,
        loadInfo.originAttributes
      );
    }
    channel.originalURI = uri;
    return channel;
  }

  getURIFlags() {
    return 0;
  }
}
