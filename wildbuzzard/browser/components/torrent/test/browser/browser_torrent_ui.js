/* SPDX-License-Identifier: AGPL-3.0-or-later */

const environmentNames = [
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
];
const originalEnvironment = new Map(
  environmentNames.map(name => [name, Services.env.get(name)])
);
const { UrlbarTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/UrlbarTestUtils.sys.mjs"
);
const { HttpServer } = ChromeUtils.importESModule(
  "resource://testing-common/httpd.sys.mjs"
);
const testRoot = PathUtils.join(
  PathUtils.tempDir,
  `wildbuzzard-torrent-${Services.appinfo.processID}-${Date.now()}`
);

add_setup(async function isolate_torrent_runtime() {
  UrlbarTestUtils.init(this);
  for (const name of environmentNames) {
    Services.env.set(name, PathUtils.join(testRoot, name.toLowerCase()));
  }
  registerCleanupFunction(async () => {
    const { TorrentManager } = ChromeUtils.importESModule(
      "resource:///modules/TorrentManager.sys.mjs"
    );
    await TorrentManager.request("POST", "/v1/shutdown", {}).catch(() => {});
    await TestUtils.waitForCondition(
      async () => !(await IOUtils.exists(TorrentManager.connectionPath)),
      "The torrent service shut down"
    );
    for (const [name, value] of originalEnvironment) {
      Services.env.set(name, value);
    }
    await IOUtils.remove(testRoot, { recursive: true, ignoreAbsent: true });
  });
});

add_task(async function test_about_torrents_shell() {
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "about:torrents"
  );
  try {
    await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
      const heading = content.document.querySelector("h1");
      const dropTarget = content.document.getElementById("drop-target");
      const torToggle = content.document.getElementById("tor-enabled");
      const toast = content.document.getElementById("toast");
      Assert.ok(heading, "The torrent client heading is present");
      Assert.ok(dropTarget, "The torrent drop target is present");
      Assert.ok(torToggle, "The Tor routing toggle is present");
      await ContentTaskUtils.waitForCondition(
        () => content.document.querySelector(".summary-item") || !toast.hidden,
        "The torrent client finished initializing",
        100,
        300
      );
      const summary = content.document.querySelector(".summary-item");
      Assert.ok(summary, `The live summary rendered: ${toast.textContent}`);
      await new Promise(resolve => content.setTimeout(resolve, 1200));
      Assert.equal(
        content.document.querySelector(".summary-item"),
        summary,
        "Periodic refresh preserves DOM identity"
      );
    });
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function test_torrent_mime_response_opens_confirmation() {
  const prefix = new TextEncoder().encode(
    "d4:infod6:lengthi1e4:name11:fixture.txt12:piece lengthi16384e6:pieces20:"
  );
  const suffix = new TextEncoder().encode("ee");
  const torrent = new Uint8Array(prefix.length + 20 + suffix.length);
  torrent.set(prefix);
  torrent.fill(1, prefix.length, prefix.length + 20);
  torrent.set(suffix, prefix.length + 20);

  const server = new HttpServer();
  let requests = 0;
  server.registerPathHandler("/fixture.torrent", (request, response) => {
    requests++;
    response.setStatusLine(request.httpVersion, 200, "OK");
    response.setHeader("Content-Type", "application/x-bittorrent", false);
    response.setHeader("Cache-Control", "no-store", false);
    const output = Cc["@mozilla.org/binaryoutputstream;1"].createInstance(
      Ci.nsIBinaryOutputStream
    );
    output.setOutputStream(response.bodyOutputStream);
    output.writeByteArray(torrent);
  });
  server.start(-1);

  const sourceTab = BrowserTestUtils.addTab(gBrowser, "about:blank");
  gBrowser.selectedTab = sourceTab;
  let confirmationTab;
  try {
    const opened = BrowserTestUtils.waitForNewTab(
      gBrowser,
      url => url.startsWith("about:torrents"),
      true
    );
    BrowserTestUtils.startLoadingURIString(
      sourceTab.linkedBrowser,
      `http://localhost:${server.identity.primaryPort}/fixture.torrent`
    );
    confirmationTab = await opened;
    await SpecialPowers.spawn(confirmationTab.linkedBrowser, [], async () => {
      const dialog = content.document.getElementById("torrent-draft-dialog");
      await ContentTaskUtils.waitForCondition(
        () => dialog.open,
        "The MIME response opens the metadata confirmation dialog"
      );
      Assert.equal(
        content.location.href,
        "about:torrents",
        "The draft capability is removed from visible history"
      );
      const files = [
        ...content.document.querySelectorAll(
          "#torrent-draft-files input[type=checkbox]"
        ),
      ];
      Assert.equal(files.length, 1, "The real sidecar parsed the torrent file");
      Assert.ok(
        files.every(file => file.checked),
        "All files default selected"
      );
    });

    const { TorrentManager } = ChromeUtils.importESModule(
      "resource:///modules/TorrentManager.sys.mjs"
    );
    let status = await TorrentManager.getStatus();
    Assert.equal(status.torrents.length, 0, "No payload starts before commit");
    Assert.equal(status.draftCount, 1, "The sidecar owns one pending draft");

    BrowserTestUtils.synthesizeMouseAtCenter(
      "#torrent-draft-cancel",
      {},
      confirmationTab.linkedBrowser
    );
    await TestUtils.waitForCondition(async () => {
      status = await TorrentManager.getStatus();
      return status.draftCount === 0;
    }, "Cancelling destroys the sidecar draft");
    Assert.greaterOrEqual(
      requests,
      2,
      "The browser response and privileged metadata fetch both reached the server"
    );
  } finally {
    if (confirmationTab) {
      BrowserTestUtils.removeTab(confirmationTab);
    }
    BrowserTestUtils.removeTab(sourceTab);
    server.stop();
  }
});

add_task(async function test_magnet_redirects_to_torrent_client() {
  const magnet =
    "magnet:?xt=urn:btih:0123456789012345678901234567890123456789&dn=Test";
  const tab = BrowserTestUtils.addTab(gBrowser, magnet);
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, url =>
    url.startsWith("about:torrents")
  );
  Assert.ok(
    tab.linkedBrowser.currentURI.spec.startsWith("about:torrents"),
    `Magnet navigation opens the native torrent client: ${tab.linkedBrowser.currentURI.spec}`
  );
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_torrent_urlbar_mode_routes_query() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.urlbar.searchRestrictKeywords.featureGate", true]],
  });
  await UrlbarTestUtils.promiseAutocompleteResultPopup({
    window,
    value: "@torrent ",
  });
  await UrlbarTestUtils.assertSearchMode(window, {
    source: UrlbarUtils.RESULT_SOURCE.TORRENT,
    entry: "typed",
    restrictType: "keyword",
  });

  await UrlbarTestUtils.promiseAutocompleteResultPopup({
    window,
    value: "linux iso",
  });
  const details = await UrlbarTestUtils.getDetailsOfResultAt(window, 0);
  Assert.equal(
    details.result.providerName,
    "UrlbarProviderTorrentSearch",
    "The native torrent provider owns the heuristic result"
  );
  Assert.equal(
    details.result.payload.url,
    "about:torrents?search=linux%20iso",
    "The query is encoded for the native torrent surface"
  );

  const loaded = BrowserTestUtils.browserLoaded(
    gBrowser.selectedBrowser,
    false,
    "about:torrents?search=linux%20iso"
  );
  EventUtils.synthesizeKey("KEY_Enter");
  await loaded;
  Assert.equal(
    gURLBar.searchMode,
    null,
    "Navigation exits torrent search mode"
  );
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_private_window_does_not_start_discovery() {
  const { TorrentDiscoveryManager } = ChromeUtils.importESModule(
    "resource:///modules/TorrentDiscoveryManager.sys.mjs"
  );
  const originalGetSources = TorrentDiscoveryManager.getSources;
  let sourceRequests = 0;
  TorrentDiscoveryManager.getSources = async () => {
    sourceRequests++;
    return { immutable: true, sources: [] };
  };
  const privateWindow = await BrowserTestUtils.openNewBrowserWindow({
    private: true,
  });
  try {
    const tab = await BrowserTestUtils.openNewForegroundTab(
      privateWindow.gBrowser,
      "about:torrents?search=linux"
    );
    await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
      const status = content.document.getElementById("torrent-search-status");
      await ContentTaskUtils.waitForCondition(
        () =>
          status.getAttribute("data-l10n-id") ===
          "wildbuzzard-torrents-search-private-disabled",
        "The private-window policy is shown"
      );
      Assert.ok(
        content.document.getElementById("torrent-search-query").disabled,
        "The private-window torrent query is disabled"
      );
      Assert.ok(
        content.document.getElementById("torrent-search-submit").disabled,
        "The private-window torrent submit action is disabled"
      );
    });
    Assert.equal(
      sourceRequests,
      0,
      "Private-window initialization does not contact ordinary discovery state"
    );
  } finally {
    TorrentDiscoveryManager.getSources = originalGetSources;
    await BrowserTestUtils.closeWindow(privateWindow);
  }
});
