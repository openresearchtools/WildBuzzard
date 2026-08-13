/* SPDX-License-Identifier: AGPL-3.0-or-later */

export const AGENT_PAGE_URL = "about:agent";

let endpoint = null;

export function setAgentEndpoint(value) {
  endpoint = value;
  Services.obs.notifyObservers(null, "wildbuzzard-agent-endpoint-changed");
}

export function agentEndpointURI() {
  try {
    const uri = Services.io.newURI(endpoint);
    if (
      uri.scheme !== "http" ||
      uri.host !== "127.0.0.1" ||
      uri.port < 49152 ||
      uri.port > 65535 ||
      uri.pathQueryRef !== "/"
    ) {
      return null;
    }
    return uri;
  } catch {
    return null;
  }
}

export function isAgentPageURL(value) {
  if (value === AGENT_PAGE_URL) {
    return true;
  }
  const currentEndpoint = agentEndpointURI();
  if (!currentEndpoint) {
    return false;
  }
  try {
    return Services.io.newURI(value).prePath === currentEndpoint.prePath;
  } catch {
    return false;
  }
}
