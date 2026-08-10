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

add_task(async function test_runtime_tampering_is_repaired_atomically() {
  requestLongerTimeout(4);
  const { TorrentManager } = ChromeUtils.importESModule(
    "resource:///modules/TorrentManager.sys.mjs"
  );
  await TorrentManager.initialize();
  const servicePath = PathUtils.join(
    TorrentManager.runtimeDirectory,
    "app",
    "service.mjs"
  );
  const original = await IOUtils.readUTF8(servicePath);
  const oldInstance = TorrentManager.connection.instanceId;
  await IOUtils.writeUTF8(servicePath, `${original}\ninvalid-tamper`);
  TorrentManager.initializeTask = null;
  await TorrentManager.initialize();
  Assert.equal(
    await IOUtils.readUTF8(servicePath),
    original,
    "A modified runtime file is restored from the verified archive"
  );
  Assert.notEqual(
    TorrentManager.connection.instanceId,
    oldInstance,
    "The verified service is restarted after atomic runtime replacement"
  );
});

add_task(async function test_live_connection_forgery_fails_closed() {
  const { TorrentManager } = ChromeUtils.importESModule(
    "resource:///modules/TorrentManager.sys.mjs"
  );
  await TorrentManager.initialize();
  const connection = { ...TorrentManager.connection };
  const forged = { ...connection, token: "0".repeat(64) };
  await IOUtils.writeJSON(TorrentManager.connectionPath, forged);
  TorrentManager.initializeTask = null;
  await Assert.rejects(
    TorrentManager.initialize(),
    /unverified live process/,
    "A bearer response without the expected process identity is rejected"
  );
  Assert.deepEqual(
    await IOUtils.readJSON(TorrentManager.connectionPath),
    forged,
    "The manager does not delete a connection owned by a live process"
  );
  await IOUtils.writeJSON(TorrentManager.connectionPath, connection);
  TorrentManager.initializeTask = null;
  await TorrentManager.initialize();
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
