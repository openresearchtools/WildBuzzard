/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { UrlbarTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/UrlbarTestUtils.sys.mjs"
);
const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);
const { CryptoUtils } = ChromeUtils.importESModule(
  "resource://services-crypto/utils.sys.mjs"
);

const AGENT_URL = "about:agent";

add_setup(function () {
  UrlbarTestUtils.init(this);
});

async function enterAgentAlias(value) {
  await UrlbarTestUtils.promiseAutocompleteResultPopup({ window, value });
  EventUtils.synthesizeKey("KEY_Enter");
}

async function startHighLoopbackServer() {
  const { HttpServer } = ChromeUtils.importESModule(
    "resource://testing-common/httpd.sys.mjs"
  );
  for (let attempt = 0; attempt < 200; attempt++) {
    const random = CryptoUtils.generateRandomBytes(2);
    const port = 49152 + (((random[0] << 8) | random[1]) % 16384);
    try {
      const server = new HttpServer();
      server.start(port);
      return server;
    } catch {}
  }
  throw new Error("No high loopback test port is available");
}

add_task(async function test_agent_alias_uses_switch_or_open_route() {
  const sandbox = sinon.createSandbox();
  try {
    const switchOrOpen = sandbox.stub(window, "switchToTabHavingURI");
    switchOrOpen.onFirstCall().returns(false);
    switchOrOpen.onSecondCall().returns(true);

    await enterAgentAlias("AgEnT");
    await enterAgentAlias("AGENT");

    is(
      switchOrOpen.callCount,
      2,
      "Every case variation uses the switch-or-open route"
    );
    for (const call of switchOrOpen.getCalls()) {
      is(call.args[0].spec, AGENT_URL, "The alias opens the Agent URL");
      is(call.args[1], true, "The alias recreates a missing Agent tab");
      ok(call.args[2].ignoreQueryString, "Pi Web session URLs are reused");
      ok(
        call.args[2].triggeringPrincipal.isSystemPrincipal,
        "The route is privileged"
      );
    }
  } finally {
    sandbox.restore();
  }
});

add_task(async function test_agent_page_has_stable_address_bar_identity() {
  const { setAgentEndpoint } = ChromeUtils.importESModule(
    "resource:///modules/WildBuzzardAgentURL.sys.mjs"
  );
  const server = await startHighLoopbackServer();
  server.registerPathHandler("/", (_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.write("<!doctype html><title>Agent test</title>");
  });
  const endpoint = `http://127.0.0.1:${server.identity.primaryPort}/`;
  setAgentEndpoint(endpoint);
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, AGENT_URL);
  try {
    is(gURLBar.value, "Agent", "The Agent page has a stable address-bar label");
    is(
      tab.linkedBrowser.currentURI.spec,
      AGENT_URL,
      "The stable alias remains visible"
    );
    is(
      tab.linkedBrowser.contentPrincipal.originNoSuffix,
      endpoint.slice(0, -1),
      "Pi Web retains its loopback web-content principal"
    );
    ok(
      !tab.linkedBrowser.contentPrincipal.isSystemPrincipal,
      "Pi Web does not receive the system principal"
    );
    is(
      tab.linkedBrowser.contentTitle,
      "Agent test",
      "The web-content title is retained without exposing the endpoint"
    );
    const { SessionStore } = ChromeUtils.importESModule(
      "resource:///modules/sessionstore/SessionStore.sys.mjs"
    );
    const { TabStateFlusher } = ChromeUtils.importESModule(
      "resource:///modules/sessionstore/TabStateFlusher.sys.mjs"
    );
    await TabStateFlusher.flush(tab.linkedBrowser);
    const state = JSON.parse(SessionStore.getTabState(tab));
    is(
      state.entries.at(-1).url,
      AGENT_URL,
      "session history persists the stable Agent URL"
    );
  } finally {
    BrowserTestUtils.removeTab(tab);
    setAgentEndpoint(null);
    await new Promise(resolve => server.stop(resolve));
  }
});

add_task(async function test_starting_page_does_not_elevate_web_content() {
  const { setAgentEndpoint } = ChromeUtils.importESModule(
    "resource:///modules/WildBuzzardAgentURL.sys.mjs"
  );
  setAgentEndpoint(null);
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, AGENT_URL);
  const browser = tab.linkedBrowser;
  let server = null;
  try {
    ok(
      browser.contentPrincipal.isSystemPrincipal,
      "the packaged starting document has its normal chrome principal"
    );
    server = await startHighLoopbackServer();
    server.registerPathHandler("/", (_request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.write("<!doctype html><title>Agent ready</title>");
    });
    setAgentEndpoint(`http://127.0.0.1:${server.identity.primaryPort}/`);
    const loaded = BrowserTestUtils.browserLoaded(browser);
    BrowserTestUtils.startLoadingURIString(browser, AGENT_URL);
    await loaded;
    ok(
      !browser.contentPrincipal.isSystemPrincipal,
      "loading Pi Web after startup receives only a web-content principal"
    );
    is(browser.currentURI.spec, AGENT_URL, "the stable URL remains visible");
  } finally {
    BrowserTestUtils.removeTab(tab);
    setAgentEndpoint(null);
    if (server) {
      await new Promise(resolve => server.stop(resolve));
    }
  }
});

add_task(
  function test_agent_endpoint_accepts_only_dynamic_high_loopback_port() {
    const { agentEndpointURI, setAgentEndpoint } = ChromeUtils.importESModule(
      "resource:///modules/WildBuzzardAgentURL.sys.mjs"
    );
    setAgentEndpoint("http://127.0.0.1:54321/");
    is(
      agentEndpointURI().spec,
      "http://127.0.0.1:54321/",
      "The about page resolves the verified dynamic endpoint"
    );
    for (const value of [
      "http://127.0.0.1:8765/",
      "http://localhost:54321/",
      "https://127.0.0.1:54321/",
      "http://127.0.0.1:54321/path",
    ]) {
      setAgentEndpoint(value);
      is(agentEndpointURI(), null, `The endpoint is rejected: ${value}`);
    }
    setAgentEndpoint(null);
  }
);
