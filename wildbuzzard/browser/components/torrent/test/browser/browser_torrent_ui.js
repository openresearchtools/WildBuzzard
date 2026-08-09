/* SPDX-License-Identifier: AGPL-3.0-or-later */

add_task(async function test_about_torrents_shell() {
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "about:torrents"
  );
  await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    const heading = content.document.querySelector("h1");
    const dropTarget = content.document.getElementById("drop-target");
    Assert.ok(heading, "The torrent client heading is present");
    Assert.ok(dropTarget, "The torrent drop target is present");
  });
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_magnet_redirects_to_torrent_client() {
  const magnet =
    "magnet:?xt=urn:btih:0123456789012345678901234567890123456789&dn=Test";
  const tab = BrowserTestUtils.addTab(gBrowser, magnet);
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, url =>
    url.startsWith("about:torrents")
  );
  Assert.stringStartsWith(
    tab.linkedBrowser.currentURI.spec,
    "about:torrents",
    "Magnet navigation opens the native torrent client"
  );
  BrowserTestUtils.removeTab(tab);
});
