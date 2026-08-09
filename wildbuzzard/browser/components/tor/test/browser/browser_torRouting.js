/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { PrivateTab } = ChromeUtils.importESModule(
  "resource:///modules/PrivateTab.sys.mjs"
);
const { TorRouting } = ChromeUtils.importESModule(
  "resource:///modules/TorRouting.sys.mjs"
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
  is(result.port, TEST_PORT, "The selected Arti port is used");
  ok(
    result.flags & Ci.nsIProxyInfo.TRANSPARENT_PROXY_RESOLVES_HOST,
    "DNS resolution happens through Arti"
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
