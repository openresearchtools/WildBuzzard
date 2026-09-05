/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { PrivateTab } = ChromeUtils.importESModule(
  "resource:///modules/PrivateTab.sys.mjs"
);
const { TorRouting } = ChromeUtils.importESModule(
  "resource:///modules/TorRouting.sys.mjs"
);
const { BrowserControl } = ChromeUtils.importESModule(
  "chrome://remote/content/wildbuzzard/BrowserControl.sys.mjs"
);
const { UrlbarTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/UrlbarTestUtils.sys.mjs"
);

const TEST_PORT_PREF = "wildbuzzard.tor.test.socksPort";
const TEST_PORT = 19150;

add_setup(() => {
  Services.prefs.setIntPref(TEST_PORT_PREF, TEST_PORT);
  registerCleanupFunction(() => {
    Services.prefs.clearUserPref(TEST_PORT_PREF);
    TorRouting._port = 0;
    TorRouting.clearData();
  });
});

add_task(async function test_toggle_reopens_in_private_tor_context() {
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "about:blank"
  );
  const torTab = await TorRouting.toggle(window, tab);

  is(
    torTab.userContextId,
    TorRouting.userContextId,
    "Tor uses its dedicated container"
  );
  ok(TorRouting.isTorTab(torTab), "The replacement tab is Tor-routed");
  ok(PrivateTab.isPrivate(torTab), "The Tor tab is private");
  ok(
    torTab.hasAttribute("wildbuzzard-tor"),
    "The Tor tab carries its UI state"
  );
  ok(
    document.documentElement.hasAttribute("wildbuzzard-private-tab"),
    "Private-tab browser UI is active"
  );

  const privateTab = await TorRouting.toggle(window, torTab);
  is(
    privateTab.userContextId,
    PrivateTab.userContextId,
    "Disabling Tor keeps the replacement tab private"
  );
  ok(!TorRouting.isTorTab(privateTab), "The replacement tab is direct");
  BrowserTestUtils.removeTab(privateTab);
});

add_task(async function test_control_client_opens_owned_tor_tab() {
  const clientId = "tor-browser-test-client";
  const result = await BrowserControl.dispatch(
    "tabs",
    { action: "new", tor: true },
    PathUtils.profileDir,
    clientId,
    new AbortController().signal
  );
  const page = result.details.page;
  const entry = BrowserControl.pageForId(page);

  ok(TorRouting.isTorTab(entry.tab), "Control-created tab uses Tor routing");
  ok(PrivateTab.isPrivate(entry.tab), "Control-created Tor tab is private");
  const listing = await BrowserControl.dispatch(
    "tabs",
    { action: "list" },
    PathUtils.profileDir,
    clientId,
    new AbortController().signal
  );
  const info = listing.details.pages.find(item => item.page == page);
  ok(info.tor, "Controlled tab metadata reports Tor routing");
  ok(info.private, "Controlled tab metadata reports private storage");

  await BrowserControl.dispatch(
    "tabs",
    { action: "close", page },
    PathUtils.profileDir,
    clientId,
    new AbortController().signal
  );
});

add_task(async function test_trusted_onion_storage_and_agent_page_identity() {
  const { OnionAuthStore } = ChromeUtils.importESModule(
    "resource:///modules/OnionAuthStore.sys.mjs"
  );
  const address = "2gzyxa5ihm7nsggfxnu52rck2vv4rvmdlkiu3zzui5du4xyclen53wid";
  const clientId = "trusted-onion-browser-test";
  let page;
  try {
    await OnionAuthStore.update(address, { key: null, privateMode: false });
    const uri = Services.io.newURI(`https://${address}.onion/`);
    const persistentId = TorRouting.contextIdForURI(uri);
    Assert.notEqual(persistentId, TorRouting.userContextId);
    Assert.equal(
      TorRouting.contextIdForURI(Services.io.newURI("https://example.com/")),
      TorRouting.userContextId
    );
    const result = await BrowserControl.dispatch(
      "tabs",
      { action: "new", tor: true },
      PathUtils.profileDir,
      clientId,
      new AbortController().signal
    );
    page = result.details.page;
    const original = BrowserControl.pageForId(page);
    const waiting = BrowserControl.dispatch(
      "wait",
      { page, for: "selector", value: "#trusted-onion", timeout: 5000 },
      PathUtils.profileDir,
      clientId,
      new AbortController().signal
    );
    const normal = await TorRouting._reopenInContext(
      window,
      original.tab,
      persistentId,
      "data:text/html,<p id='trusted-onion'>Trusted site</p>"
    );
    Assert.ok(
      (await waiting).details.matched,
      "An agent wait survives replacing the tab's storage context"
    );
    Assert.ok(
      TorRouting.isTorTab(normal),
      "Normal storage still routes through Tor"
    );
    Assert.ok(
      !PrivateTab.isPrivate(normal),
      "Trusted site storage is persistent"
    );
    Assert.equal(
      BrowserControl.pageForId(page).tab,
      normal,
      "The agent keeps its page after a storage switch"
    );
    Assert.equal(BrowserControl.pageOwners.get(page), clientId);
    await OnionAuthStore.update(address, { key: null, privateMode: true });
    Assert.equal(TorRouting.contextIdForURI(uri), TorRouting.userContextId);
    const privateTab = await TorRouting._reopenInContext(
      window,
      normal,
      TorRouting.userContextId,
      "about:blank"
    );
    Assert.ok(PrivateTab.isPrivate(privateTab));
    Assert.equal(BrowserControl.pageForId(page).tab, privateTab);
    Assert.equal(BrowserControl.pageOwners.get(page), clientId);
  } finally {
    await OnionAuthStore.update(address, null);
    if (page) {
      await BrowserControl.dispatch(
        "tabs",
        { action: "close", page },
        PathUtils.profileDir,
        clientId,
        new AbortController().signal
      );
    }
  }
});

add_task(async function test_user_onion_navigation_reopens_as_tor() {
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "about:blank"
  );
  const torTab = await TorRouting.routeOnion(
    window,
    tab,
    "https://exampleexample.onion/"
  );

  ok(torTab, "Onion navigation creates a replacement tab");
  ok(TorRouting.isTorTab(torTab), "Onion navigation automatically uses Tor");
  ok(PrivateTab.isPrivate(torTab), "Automatic Tor navigation is private");
  is(
    await TorRouting.routeOnion(
      window,
      torTab,
      "https://anotherexample.onion/"
    ),
    torTab,
    "An existing Tor tab is not replaced again"
  );
  BrowserTestUtils.removeTab(torTab);
});

add_task(async function test_urlbar_onion_navigation_uses_tor() {
  UrlbarTestUtils.init(this);
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "about:blank"
  );
  await UrlbarTestUtils.inputIntoURLBar(window, "https://typedexample.onion/");
  const opened = BrowserTestUtils.waitForEvent(
    gBrowser.tabContainer,
    "TabOpen"
  );
  EventUtils.synthesizeKey("KEY_Enter");
  const torTab = (await opened).target;

  ok(TorRouting.isTorTab(torTab), "Typed onion address opens in a Tor tab");
  ok(PrivateTab.isPrivate(torTab), "Typed onion address is private");
  ok(tab.closing || !tab.isConnected, "The direct tab was replaced");
  BrowserTestUtils.removeTab(torTab);
});

add_task(function test_proxy_filter_uses_remote_dns_and_no_failover() {
  const browser = gBrowser.selectedBrowser;
  const channel = {
    loadInfo: {
      browsingContext: { top: { embedderElement: browser } },
      originAttributes: { userContextId: TorRouting.userContextId },
    },
  };
  let result;
  TorRouting.applyFilter(channel, null, {
    onProxyFilterResult(proxyInfo) {
      result = proxyInfo;
    },
  });

  is(result.type, "socks", "Tor routing uses SOCKS5");
  is(result.host, "127.0.0.1", "The proxy is loopback-only");
  is(result.port, TEST_PORT, "The selected Tor port is used");
  ok(
    result.flags & Ci.nsIProxyInfo.TRANSPARENT_PROXY_RESOLVES_HOST,
    "DNS resolution happens through Tor"
  );
  ok(result.username, "The request carries stream-isolation credentials");
  is(result.failoverProxy, null, "Tor requests cannot fail open to direct");
});

add_task(function test_proxy_filter_leaves_normal_tabs_unchanged() {
  const defaultProxy = { name: "default" };
  let result;
  TorRouting.applyFilter(
    {
      loadInfo: {
        originAttributes: { userContextId: 0 },
      },
    },
    defaultProxy,
    {
      onProxyFilterResult(proxyInfo) {
        result = proxyInfo;
      },
    }
  );
  is(result, defaultProxy, "Normal tabs retain their proxy configuration");
});

add_task(async function test_toolbar_reflects_selected_tab() {
  const button = document.getElementById("wildbuzzard-tor-toolbar-button");
  ok(button, "The Tor toolbar button exists");

  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "about:blank"
  );
  const torTab = await TorRouting.toggle(window, tab);
  ok(button.hasAttribute("checked"), "The button is checked on a Tor tab");
  is(button.getAttribute("aria-pressed"), "true", "Pressed state is exposed");

  const privateTab = await TorRouting.toggle(window, torTab);
  ok(!button.hasAttribute("checked"), "The button clears outside Tor");
  BrowserTestUtils.removeTab(privateTab);
});

add_task(async function test_authorization_prompt_after_error_page_load() {
  const server = Cc["@mozilla.org/network/server-socket;1"].createInstance(
    Ci.nsIServerSocket
  );
  server.init(-1, true, -1);
  const transports = [];
  server.asyncListen({
    onSocketAccepted(socket, transport) {
      transports.push(transport);
      const output = transport.openOutputStream(0, 0, 0);
      const input = transport.openInputStream(0, 0, 0);
      const pump = Cc[
        "@mozilla.org/network/input-stream-pump;1"
      ].createInstance(Ci.nsIInputStreamPump);
      pump.init(input, 0, 0, false);
      let stage = 0;
      let buffer = "";
      pump.asyncRead({
        onStartRequest() {},
        onStopRequest() {
          output.close();
        },
        onDataAvailable(request, stream, offset, count) {
          const binary = Cc["@mozilla.org/binaryinputstream;1"].createInstance(
            Ci.nsIBinaryInputStream
          );
          binary.setInputStream(stream);
          buffer += binary.readBytes(count);
          if (stage == 0 && buffer.length >= 2 + buffer.charCodeAt(1)) {
            const auth = buffer.slice(2).includes("\x02");
            output.write(auth ? "\x05\x02" : "\x05\x00", 2);
            buffer = "";
            stage = auth ? 1 : 2;
          } else if (stage == 1 && buffer.length >= 3 + buffer.charCodeAt(1)) {
            const length =
              3 +
              buffer.charCodeAt(1) +
              buffer.charCodeAt(2 + buffer.charCodeAt(1));
            if (buffer.length >= length) {
              output.write("\x01\x00", 2);
              buffer = "";
              stage = 2;
            }
          } else if (stage == 2 && buffer.length >= 7 + buffer.charCodeAt(4)) {
            output.write("\x05\xf4\x00\x01\x00\x00\x00\x00\x00\x00", 10);
            stage = 3;
          }
        },
      });
    },
    onStopListening() {},
  });
  Services.prefs.setIntPref(TEST_PORT_PREF, server.port);
  let tab;
  try {
    tab = await TorRouting.createTab(window);
    gBrowser.selectedTab = tab;
    const browser = tab.linkedBrowser;
    const loaded = BrowserTestUtils.waitForErrorPage(browser);
    BrowserTestUtils.startLoadingURIString(
      browser,
      "https://2gzyxa5ihm7nsggfxnu52rck2vv4rvmdlkiu3zzui5du4xyclen53wid.onion/"
    );
    await loaded;
    await TestUtils.waitForCondition(
      () => TorRouting._authorizationDialogs.has(browser),
      "The loaded authorization error page opens its key dialog"
    );
    const pending = TorRouting._authorizationDialogs.get(browser);
    await pending.dialog._dialogReady;
    const doc = pending.dialog._frame.contentDocument;
    Assert.equal(doc.activeElement.id, "private-key");
    Assert.ok(doc.getElementById("private-mode").checked);
    doc.getElementById("private-mode").click();
    Assert.ok(
      doc.getElementById("remember-key").checked,
      "Trusting the site also remembers its key"
    );
    Assert.ok(doc.getElementById("remember-key").disabled);
    pending.dialog.close();
    await pending.closedPromise;
  } finally {
    if (tab) {
      BrowserTestUtils.removeTab(tab);
    }
    server.close();
    for (const transport of transports) {
      transport.close(Cr.NS_OK);
    }
    Services.prefs.setIntPref(TEST_PORT_PREF, TEST_PORT);
    TorRouting._port = TEST_PORT;
  }
});
