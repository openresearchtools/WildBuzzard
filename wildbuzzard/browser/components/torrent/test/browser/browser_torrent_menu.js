/* SPDX-License-Identifier: AGPL-3.0-or-later */

add_task(async function torrents_open_new_tabs_in_the_current_window() {
  const existing = BrowserTestUtils.addTab(gBrowser, "about:torrents");
  const other = await BrowserTestUtils.openNewBrowserWindow();
  try {
    const originalTabs = [...other.gBrowser.tabs];
    const originalURLs = originalTabs.map(
      tab => tab.linkedBrowser.currentURI.spec
    );
    const sourceCount = gBrowser.tabs.length;
    const windows = [...Services.wm.getEnumerator("navigator:browser")];
    for (let i = 1; i <= 2; i++) {
      other.gBrowser.selectedTab = originalTabs[0];
      other.document.getElementById("Tools:Torrents").doCommand();
      is(
        other.gBrowser.tabs.length,
        originalTabs.length + i,
        "Each command adds a tab"
      );
      const selected = other.gBrowser.selectedTab;
      await TestUtils.waitForCondition(
        () => selected.linkedBrowser.currentURI.spec === "about:torrents"
      );
      ok(!originalTabs.includes(selected), "Torrents owns its new tab");
      for (const [index, tab] of originalTabs.entries()) {
        ok(other.gBrowser.tabs.includes(tab), "Original tab remains open");
        is(
          tab.linkedBrowser.currentURI.spec,
          originalURLs[index],
          "Original page is unchanged"
        );
      }
      is(
        gBrowser.tabs.length,
        sourceCount,
        "Other window's tabs are unchanged"
      );
      ok(
        gBrowser.tabs.includes(existing),
        "Existing torrent tab stays in its window"
      );
      Assert.deepEqual(
        [...Services.wm.getEnumerator("navigator:browser")],
        windows,
        "No windows are opened or closed"
      );
    }
  } finally {
    await BrowserTestUtils.closeWindow(other);
    BrowserTestUtils.removeTab(existing);
  }
});
