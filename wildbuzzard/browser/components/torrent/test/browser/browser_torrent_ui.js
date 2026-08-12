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

function createSymlink(source, destination) {
  const executable = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  executable.initWithPath("/bin/ln");
  const process = Cc["@mozilla.org/process/util;1"].createInstance(
    Ci.nsIProcess
  );
  process.init(executable);
  const argumentsList = ["-s", source, destination];
  process.run(true, argumentsList, argumentsList.length);
  Assert.equal(process.exitValue, 0, "The runtime symlink was created");
}

add_setup(async function isolate_torrent_runtime() {
  UrlbarTestUtils.init(this);
  for (const name of environmentNames) {
    Services.env.set(name, PathUtils.join(testRoot, name.toLowerCase()));
  }
  const { TorrentManager, TorrentManagerTestUtils } =
    ChromeUtils.importESModule("resource:///modules/TorrentManager.sys.mjs");
  TorrentManagerTestUtils.configurePaths({
    configHome: Services.env.get("XDG_CONFIG_HOME"),
    dataHome: Services.env.get("XDG_DATA_HOME"),
    runtimeHome: Services.env.get("XDG_RUNTIME_DIR"),
  });
  await IOUtils.makeDirectory(PathUtils.parent(TorrentManager.configPath), {
    createAncestors: true,
    permissions: 0o700,
  });
  await IOUtils.writeJSON(TorrentManager.configPath, {
    dht: false,
    lsd: false,
    natPmp: false,
    natUpnp: false,
    utp: false,
  });
  registerCleanupFunction(async () => {
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

add_task(async function test_torrent_state_is_private() {
  const { TorrentManager } = ChromeUtils.importESModule(
    "resource:///modules/TorrentManager.sys.mjs"
  );
  await TorrentManager.initialize();
  for (const path of [
    TorrentManager.rootDirectory,
    TorrentManager.config.dataDirectory,
    PathUtils.parent(TorrentManager.configPath),
    PathUtils.parent(TorrentManager.connectionPath),
  ]) {
    Assert.equal((await IOUtils.stat(path)).permissions & 0o777, 0o700, path);
  }
  for (const path of [
    TorrentManager.configPath,
    TorrentManager.connectionPath,
  ]) {
    Assert.equal((await IOUtils.stat(path)).permissions & 0o777, 0o600, path);
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
      url =>
        url.startsWith("about:torrents#draft=") ||
        url === "about:torrents#draft-error=1",
      true
    );
    BrowserTestUtils.startLoadingURIString(
      sourceTab.linkedBrowser,
      `http://localhost:${server.identity.primaryPort}/fixture.torrent`
    );
    confirmationTab = await opened;
    Assert.equal(
      confirmationTab.linkedBrowser.currentURI.spec,
      "about:torrents#",
      "The consumed draft capability is cleared before the tab is exposed"
    );
    await SpecialPowers.spawn(confirmationTab.linkedBrowser, [], async () => {
      const dialog = content.document.getElementById("torrent-draft-dialog");
      const toast = content.document.getElementById("toast");
      await ContentTaskUtils.waitForCondition(
        () => dialog.open || !toast.hidden,
        "The MIME response resolves to a confirmation or explicit error"
      );
      Assert.ok(
        dialog.open,
        `The MIME response opens the metadata confirmation dialog: ${toast.textContent}`
      );
      Assert.equal(
        content.location.href,
        "about:torrents#",
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

add_task(
  async function test_runtime_root_symlink_is_replaced_without_traversal() {
    requestLongerTimeout(4);
    const { TorrentManager } = ChromeUtils.importESModule(
      "resource:///modules/TorrentManager.sys.mjs"
    );
    await TorrentManager.initialize();
    await TorrentManager.request("POST", "/v1/shutdown", {});
    await TestUtils.waitForCondition(
      async () => !(await IOUtils.exists(TorrentManager.connectionPath)),
      "The torrent service shut down before runtime replacement"
    );
    const runtime = TorrentManager.runtimeDirectory;
    const backup = `${runtime}.symlink-test-backup`;
    const sentinelRoot = await IOUtils.createUniqueDirectory(
      PathUtils.tempDir,
      "torrent-runtime-sentinel-"
    );
    const sentinel = PathUtils.join(sentinelRoot, "sentinel.txt");
    await IOUtils.writeUTF8(sentinel, "preserve");
    registerCleanupFunction(async () => {
      await IOUtils.remove(backup, { recursive: true, ignoreAbsent: true });
      await IOUtils.remove(sentinelRoot, {
        recursive: true,
        ignoreAbsent: true,
      });
    });
    await IOUtils.move(runtime, backup, { noOverwrite: true });
    createSymlink(sentinelRoot, runtime);
    TorrentManager.initializeTask = null;
    await TorrentManager.initialize();
    Assert.equal(
      await IOUtils.readUTF8(sentinel),
      "preserve",
      "Runtime cleanup does not traverse a substituted root symlink"
    );
    const runtimeFile = Cc["@mozilla.org/file/local;1"].createInstance(
      Ci.nsIFile
    );
    runtimeFile.initWithPath(TorrentManager.runtimeDirectory);
    Assert.ok(
      !runtimeFile.isSymlink(),
      "The verified runtime is a real directory"
    );
    await IOUtils.remove(backup, { recursive: true, ignoreAbsent: true });
    await IOUtils.remove(sentinelRoot, {
      recursive: true,
      ignoreAbsent: true,
    });
  }
);

add_task(async function test_extraction_lock_is_published_atomically() {
  const { TorrentRuntimeLockTestUtils } = ChromeUtils.importESModule(
    "resource:///modules/TorrentManager.sys.mjs"
  );
  const root = await IOUtils.createUniqueDirectory(
    PathUtils.tempDir,
    "torrent-lock-race-"
  );
  registerCleanupFunction(() =>
    IOUtils.remove(root, { recursive: true, ignoreAbsent: true })
  );
  const lockPath = PathUtils.join(root, ".race-fixture.lock");
  let publishFirst;
  const firstPaused = new Promise(resolve => {
    publishFirst = resolve;
  });
  let continueFirst;
  const firstGate = new Promise(resolve => {
    continueFirst = resolve;
  });
  let retryFirst;
  const firstRetried = new Promise(resolve => {
    retryFirst = resolve;
  });
  let continueRetry;
  const retryGate = new Promise(resolve => {
    continueRetry = resolve;
  });
  let publicationCount = 0;
  const firstTask = TorrentRuntimeLockTestUtils.acquire(
    root,
    "race-fixture",
    async (_owner, temporary) => {
      publicationCount++;
      if (publicationCount === 2) {
        retryFirst();
        await retryGate;
        return;
      }
      if (publicationCount !== 1) {
        return;
      }
      Assert.ok(
        await IOUtils.readJSON(temporary),
        "The owner record is complete in a private temporary file"
      );
      Assert.ok(
        !(await IOUtils.exists(lockPath)),
        "No empty public lock exists before atomic publication"
      );
      publishFirst();
      await firstGate;
    }
  );
  await firstPaused;
  const second = await TorrentRuntimeLockTestUtils.acquire(
    root,
    "race-fixture"
  );
  const published = await IOUtils.readJSON(lockPath);
  Assert.equal(
    published.nonce,
    second.owner.nonce,
    "The second extractor atomically owns the complete lock"
  );
  let firstSettled = false;
  firstTask.then(() => {
    firstSettled = true;
  });
  continueFirst();
  await firstRetried;
  Assert.ok(!firstSettled, "A complete active lock is never stolen");
  Assert.equal(
    (await IOUtils.readJSON(lockPath)).nonce,
    second.owner.nonce,
    "The active lock remains owned while another extractor retries"
  );
  await TorrentRuntimeLockTestUtils.release(second);
  continueRetry();
  const first = await firstTask;
  Assert.equal(
    (await IOUtils.readJSON(lockPath)).nonce,
    first.owner.nonce,
    "The waiting extractor acquires the lock after release"
  );
  await TorrentRuntimeLockTestUtils.release(first);
  Assert.ok(!(await IOUtils.exists(lockPath)), "The owning lock is released");
  await IOUtils.remove(root, { recursive: true, ignoreAbsent: true });
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
