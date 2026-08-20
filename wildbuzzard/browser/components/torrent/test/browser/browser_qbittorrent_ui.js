/* SPDX-License-Identifier: AGPL-3.0-or-later */

const environmentNames = ["XDG_DATA_HOME", "XDG_RUNTIME_DIR"];
const originalEnvironment = new Map(
  environmentNames.map(name => [name, Services.env.get(name)])
);
const testRoot = PathUtils.join(
  PathUtils.tempDir,
  `wbq-${Services.appinfo.processID}-${Date.now()}`
);
let discoveryManager;
let originalGetSources;
let originalSearch;
let runtime;
let packageAvailable = false;

async function openTorrentTab(url) {
  const tab = BrowserTestUtils.addTab(gBrowser, url, { waitForLoad: false });
  gBrowser.selectedTab = tab;
  await TestUtils.waitForCondition(
    () => tab.linkedBrowser.remoteType === "privilegedabout",
    "The torrent manager switched to the privileged about process"
  );
  await TestUtils.waitForCondition(
    () => tab.linkedBrowser.currentURI.spec !== "about:blank",
    "The torrent manager document committed"
  );
  return tab;
}

add_setup(async function isolate_qbittorrent_runtime() {
  for (const name of environmentNames) {
    Services.env.set(
      name,
      PathUtils.join(testRoot, name === "XDG_DATA_HOME" ? "data" : "run")
    );
  }
  const { QBittorrentRuntime, QBittorrentRuntimeTestUtils } =
    ChromeUtils.importESModule(
      "resource:///modules/QBittorrentRuntime.sys.mjs"
    );
  runtime = QBittorrentRuntime;
  try {
    runtime.validateCommand();
    packageAvailable = true;
  } catch {}
  QBittorrentRuntimeTestUtils.configurePaths({
    dataHome: Services.env.get("XDG_DATA_HOME"),
    runtimeHome: Services.env.get("XDG_RUNTIME_DIR"),
  });
  ({ TorrentDiscoveryManager: discoveryManager } = ChromeUtils.importESModule(
    "resource:///modules/TorrentDiscoveryManager.sys.mjs"
  ));
  originalGetSources = discoveryManager.getSources;
  originalSearch = discoveryManager.search;
  discoveryManager.getSources = async () => ({
    immutable: true,
    sources: [{ id: "public-source", name: "Public source", state: "ready" }],
  });
  discoveryManager.search = async ({ query, sourceIds }) => {
    Assert.equal(query, "linux iso");
    Assert.deepEqual(sourceIds, ["public-source"]);
    return {
      results: [
        {
          resultId: "R".repeat(32),
          providerId: "public-source",
          providerName: "Public source",
          name: "Linux ISO",
          sizeBytes: 1024,
          seeders: 12,
          leechers: 2,
          publishedAt: "2026-08-10T00:00:00Z",
          categoryIds: [8000],
          acquisition: "magnet",
        },
      ],
    };
  };
  registerCleanupFunction(async () => {
    discoveryManager.getSources = originalGetSources;
    discoveryManager.search = originalSearch;
    if (packageAvailable) {
      await runtime.stopForTests();
    }
    for (const [name, value] of originalEnvironment) {
      Services.env.set(name, value);
    }
    await IOUtils.remove(testRoot, { recursive: true, ignoreAbsent: true });
  });
});

add_task(async function test_real_qbittorrent_ui_and_search_route() {
  if (!packageAvailable) {
    ok(true, "Skipped: install buzzard-torrent to run the integrated UI test");
    return;
  }
  requestLongerTimeout(4);
  const tab = await openTorrentTab("about:torrents?search=linux%20iso");
  try {
    await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
      await ContentTaskUtils.waitForCondition(
        () => content.document.getElementById("torrentsTableDiv"),
        "The qBittorrent transfer view loaded"
      );
      Assert.equal(content.document.title, "Torrents");
      Assert.ok(content.document.getElementById("desktopNavbar"));
      Assert.ok(!content.document.getElementById("logoutLink"));
      Assert.ok(!content.document.getElementById("shutdownLink"));
      Assert.ok(!content.document.getElementById("aboutLink"));
      await ContentTaskUtils.waitForCondition(
        () =>
          content.document.getElementById("searchPattern")?.value ===
          "linux iso",
        "The about:torrents query opened qBittorrent search"
      );
      await ContentTaskUtils.waitForCondition(
        () =>
          content.document
            .querySelector("#searchResultsTableDiv tbody")
            ?.textContent.includes("Linux ISO"),
        "The browser search bridge populated the qBittorrent result table"
      );
    });
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function test_magnet_opens_qbittorrent_add_dialog() {
  if (!packageAvailable) {
    ok(true, "Skipped: install buzzard-torrent to run the integrated UI test");
    return;
  }
  const magnet = `magnet:?xt=urn:btih:${"1".repeat(40)}&dn=Linux`;
  const tab = await openTorrentTab(magnet);
  try {
    await SpecialPowers.spawn(
      tab.linkedBrowser,
      [magnet],
      async magnetValue => {
        await ContentTaskUtils.waitForCondition(() => {
          const frame = content.document.querySelector(
            'iframe[src*="addtorrent.html"][src*="magnet"]'
          );
          return (
            frame?.contentDocument?.URL.startsWith(
              "moz-torrent://local/addtorrent.html"
            ) && frame.contentDocument.getElementById("uploadForm")
          );
        }, "The magnet loaded qBittorrent's add-torrent dialog");
        const frame = content.document.querySelector(
          'iframe[src*="addtorrent.html"][src*="magnet"]'
        );
        Assert.equal(
          frame.contentDocument.getElementById("urls").value,
          magnetValue
        );
        Assert.ok(
          frame.contentDocument.querySelector(
            '#uploadForm button[type="submit"]'
          )
        );
      }
    );
    const { BrowserControl } = ChromeUtils.importESModule(
      "chrome://remote/content/wildbuzzard/BrowserControl.sys.mjs"
    );
    BrowserControl.start();
    const pageId = BrowserControl.pageIdFor(tab.linkedBrowser);
    const snapshot = await BrowserControl.snapshot(pageId);
    const addButton = snapshot.details.refs.find(
      node => node.role === "button" && node.name === "Add Torrent"
    );
    const startCheckbox = snapshot.details.refs.find(
      node => node.role === "checkbox" && node.name === "Start torrent"
    );
    Assert.ok(addButton, "Native browser control captured the torrent dialog");
    Assert.ok(startCheckbox, "Native browser control captured its checkbox");
    await BrowserControl.act(pageId, {
      kind: "uncheck",
      ref: startCheckbox?.ref,
    });
    await BrowserControl.act(pageId, { kind: "click", ref: addButton?.ref });
    await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
      await ContentTaskUtils.waitForCondition(
        () => !content.document.querySelector('iframe[src*="addtorrent.html"]'),
        "The native actions submitted and closed the add-torrent dialog"
      );
      await ContentTaskUtils.waitForCondition(
        () =>
          content.document
            .querySelector("#torrentsTableDiv tbody")
            ?.textContent.includes("Linux"),
        "The added torrent appeared in the visible transfer table"
      );
    });
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function test_torrent_url_opens_qbittorrent_add_dialog() {
  if (!packageAvailable) {
    ok(true, "Skipped: install buzzard-torrent to run the integrated UI test");
    return;
  }
  const torrentUrl = "https://example.invalid/linux.torrent";
  const tab = await openTorrentTab(
    `about:torrents#download=${encodeURIComponent(torrentUrl)}`
  );
  try {
    await SpecialPowers.spawn(
      tab.linkedBrowser,
      [torrentUrl],
      async torrentValue => {
        await ContentTaskUtils.waitForCondition(() => {
          const frame = content.document.querySelector(
            'iframe[src*="addtorrent.html"]'
          );
          return frame?.contentDocument?.getElementById("uploadForm");
        }, "The torrent URL loaded qBittorrent's add-torrent dialog");
        const frame = content.document.querySelector(
          'iframe[src*="addtorrent.html"]'
        );
        Assert.equal(
          frame.contentDocument.getElementById("urls").value,
          torrentValue
        );
      }
    );
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});
