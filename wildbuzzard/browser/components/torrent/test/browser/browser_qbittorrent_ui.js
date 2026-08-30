/* SPDX-License-Identifier: AGPL-3.0-or-later */

const environmentNames = ["XDG_DATA_HOME", "XDG_RUNTIME_DIR"];
const originalEnvironment = new Map(
  environmentNames.map(name => [name, Services.env.get(name)])
);
const testRoot = PathUtils.join(
  PathUtils.tempDir,
  `wbq-${Services.appinfo.processID}-${Date.now()}`
);
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
  registerCleanupFunction(async () => {
    if (packageAvailable) {
      await runtime.stopForTests();
    }
    for (const [name, value] of originalEnvironment) {
      Services.env.set(name, value);
    }
    await IOUtils.remove(testRoot, { recursive: true, ignoreAbsent: true });
  });
});

add_task(async function test_real_qbittorrent_ui() {
  if (!packageAvailable) {
    ok(true, "Skipped: install buzzard-torrent to run the integrated UI test");
    return;
  }
  requestLongerTimeout(4);
  const tab = await openTorrentTab("about:torrents");
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
      const policy = content.document.querySelector(
        'meta[http-equiv="Content-Security-Policy"]'
      ).content;
      Assert.ok(!policy.includes("script-src-elem 'unsafe-inline'"));
      Assert.ok(!policy.includes("blob:"));
      Assert.ok(!policy.includes("frame-src about:"));
      for (const script of content.document.querySelectorAll("script[nonce]")) {
        Assert.ok(
          script.src.startsWith("resource:///modules/torrent-"),
          "Only packaged torrent infrastructure receives a nonce"
        );
      }
      for (const frame of content.document.querySelectorAll("iframe")) {
        Assert.equal(
          frame.getAttribute("sandbox"),
          "allow-downloads allow-forms allow-modals allow-same-origin allow-scripts"
        );
      }
      await Assert.rejects(
        content.fetch("https://example.invalid/"),
        /External requests are unavailable/,
        "The privileged torrent UI cannot make ordinary network requests"
      );
    });
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function test_download_hash_is_not_routed_to_qbittorrent() {
  if (!packageAvailable) {
    ok(true, "Skipped: install buzzard-torrent to run the integrated UI test");
    return;
  }
  for (const source of [
    `magnet:?xt=urn:btih:${"1".repeat(40)}&dn=Linux`,
    "https://example.invalid/linux.torrent",
  ]) {
    const tab = await openTorrentTab(
      `about:torrents#download=${encodeURIComponent(source)}`
    );
    try {
      await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
        await ContentTaskUtils.waitForCondition(
          () => content.document.getElementById("torrentsTableDiv"),
          "The qBittorrent transfer view loaded"
        );
        await new Promise(resolve => content.setTimeout(resolve, 250));
        Assert.ok(
          !content.document.querySelector('iframe[src*="addtorrent.html"]'),
          "The download hash did not open an add-torrent dialog"
        );
      });
    } finally {
      BrowserTestUtils.removeTab(tab);
    }
  }
});
