/* SPDX-License-Identifier: AGPL-3.0-or-later */

const { agentEndpointURI } = ChromeUtils.importESModule(
  "resource:///modules/WildBuzzardAgentURL.sys.mjs"
);

function updateAgentEndpoint() {
  const endpoint = agentEndpointURI();
  if (!endpoint) {
    return;
  }
  location.replace(endpoint.spec);
}

window.addEventListener(
  "load",
  () => {
    const endpointObserver = { observe: updateAgentEndpoint };
    Services.obs.addObserver(
      endpointObserver,
      "wildbuzzard-agent-endpoint-changed"
    );
    window.addEventListener(
      "unload",
      () => {
        Services.obs.removeObserver(
          endpointObserver,
          "wildbuzzard-agent-endpoint-changed"
        );
      },
      { once: true }
    );
    updateAgentEndpoint();
  },
  { once: true }
);
