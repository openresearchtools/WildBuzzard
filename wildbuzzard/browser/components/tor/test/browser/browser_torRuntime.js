/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { TorRouting } = ChromeUtils.importESModule(
  "resource:///modules/TorRouting.sys.mjs"
);

const LIVE_TEST_PREF = "wildbuzzard.tor.test.live";
const CHECK_URL = "https://check.torproject.org/api/ip";
const ONION_URL =
  "https://2gzyxa5ihm7nsggfxnu52rck2vv4rvmdlkiu3zzui5du4xyclen53wid.onion/index.html";

add_task(async function test_live_bundled_tor() {
  if (!Services.prefs.getBoolPref(LIVE_TEST_PREF, false)) {
    ok(true, `Set ${LIVE_TEST_PREF}=true to run the live Tor test`);
    return;
  }
  requestLongerTimeout(2);

  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "about:blank"
  );
  const torTab = await TorRouting.toggle(window, tab);
  ok(torTab, "The bundled Tor runtime started");
  try {
    const checkLoaded = BrowserTestUtils.browserLoaded(
      torTab.linkedBrowser,
      false,
      CHECK_URL
    );
    BrowserTestUtils.startLoadingURIString(torTab.linkedBrowser, CHECK_URL);
    await checkLoaded;
    const check = await SpecialPowers.spawn(
      torTab.linkedBrowser,
      [],
      () => content.wrappedJSObject.$json?.data
    );
    ok(check.IsTor, "The selected tab reaches the internet through Tor");

    const onionLoaded = BrowserTestUtils.browserLoaded(
      torTab.linkedBrowser,
      false,
      ONION_URL
    );
    BrowserTestUtils.startLoadingURIString(torTab.linkedBrowser, ONION_URL);
    await onionLoaded;
    is(
      torTab.linkedBrowser.currentURI.host,
      new URL(ONION_URL).hostname,
      "The selected tab loads a v3 onion service"
    );
  } finally {
    BrowserTestUtils.removeTab(torTab);
  }
});
