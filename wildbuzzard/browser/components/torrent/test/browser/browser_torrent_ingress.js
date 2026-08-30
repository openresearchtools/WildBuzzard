/* SPDX-License-Identifier: AGPL-3.0-or-later */

const TEST_ROOT = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com"
);
const MAGNET = `magnet:?xt=urn:btih:${"1".repeat(40)}&dn=Linux%20fixture`;

const { TorrentIngressTestUtils } = ChromeUtils.importESModule(
  "resource:///modules/TorrentIngress.sys.mjs"
);

let calls;
let confirmations;

add_setup(function setup_ingress_test() {
  registerCleanupFunction(() => TorrentIngressTestUtils.reset());
});

function configureIngress(accept = true) {
  calls = [];
  confirmations = [];
  TorrentIngressTestUtils.configure({
    manager: {
      async initialize() {
        calls.push({ method: "initialize" });
      },
      async addMagnet(source) {
        calls.push({ method: "addMagnet", source });
      },
      async addTorrentBytes(bytes) {
        calls.push({ method: "addTorrentBytes", bytes: [...bytes] });
      },
    },
    confirm(_window, _title, message) {
      confirmations.push(message);
      return accept;
    },
    open() {
      calls.push({ method: "openManager" });
    },
  });
}

async function clickLink(href, browser = gBrowser) {
  const page = `data:text/html,${encodeURIComponent(`<a id="target" href="${href}">Download</a>`)}`;
  const tab = await BrowserTestUtils.openNewForegroundTab(browser, page);
  await BrowserTestUtils.synthesizeMouseAtCenter(
    "#target",
    { button: 0 },
    tab.linkedBrowser
  );
  return tab;
}

async function navigateWithoutGesture(url) {
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "data:text/html,<title>Untrusted navigation</title>"
  );
  await SpecialPowers.spawn(tab.linkedBrowser, [url], source => {
    content.location.href = source;
  });
  await TestUtils.waitForTick();
  await TestUtils.waitForTick();
  return tab;
}

async function waitForIngressIdle() {
  await TestUtils.waitForCondition(
    () => TorrentIngressTestUtils.pendingCount() === 0,
    "The torrent ingress operation settled"
  );
}

async function clickSubframeLink(href) {
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "data:text/html,<title>Framed navigation</title>"
  );
  await SpecialPowers.spawn(tab.linkedBrowser, [href], async source => {
    const frame = content.document.createElement("iframe");
    frame.srcdoc = `<a id="target" href="${source}">Download</a>`;
    content.document.body.append(frame);
    await new Promise(resolve =>
      frame.addEventListener("load", resolve, { once: true })
    );
  });
  const frame = tab.linkedBrowser.browsingContext.children[0];
  await BrowserTestUtils.synthesizeMouseAtCenter("#target", {}, frame);
  return tab;
}

add_task(async function test_user_clicked_magnet_requires_confirmation() {
  configureIngress();
  const tab = await clickLink(MAGNET);
  try {
    await TestUtils.waitForCondition(
      () => calls.some(call => call.method === "addMagnet"),
      "The confirmed magnet was added"
    );
    Assert.equal(confirmations.length, 1);
    Assert.ok(confirmations[0].includes("Linux fixture"));
    Assert.equal(
      calls.find(call => call.method === "addMagnet").source,
      MAGNET
    );
    Assert.ok(calls.some(call => call.method === "openManager"));
  } finally {
    BrowserTestUtils.removeTab(tab);
    TorrentIngressTestUtils.reset();
  }
});

add_task(async function test_rejected_magnet_is_not_added() {
  configureIngress(false);
  const tab = await clickLink(MAGNET);
  try {
    await TestUtils.waitForCondition(
      () => confirmations.length === 1,
      "The magnet confirmation was shown"
    );
    await waitForIngressIdle();
    Assert.ok(!calls.some(call => call.method === "addMagnet"));
  } finally {
    BrowserTestUtils.removeTab(tab);
    TorrentIngressTestUtils.reset();
  }
});

add_task(async function test_scripted_magnet_navigation_is_rejected() {
  configureIngress();
  const tab = await navigateWithoutGesture(MAGNET);
  try {
    Assert.deepEqual(confirmations, []);
    Assert.deepEqual(calls, []);
  } finally {
    BrowserTestUtils.removeTab(tab);
    TorrentIngressTestUtils.reset();
  }
});

add_task(async function test_subframe_magnet_navigation_is_rejected() {
  configureIngress();
  const tab = await clickSubframeLink(MAGNET);
  try {
    await TestUtils.waitForTick();
    await TestUtils.waitForTick();
    Assert.deepEqual(confirmations, []);
    Assert.deepEqual(calls, []);
  } finally {
    BrowserTestUtils.removeTab(tab);
    TorrentIngressTestUtils.reset();
  }
});

add_task(async function test_background_tab_magnet_navigation_is_rejected() {
  configureIngress();
  const page = `data:text/html,${encodeURIComponent(`<a id="target" href="${MAGNET}">Download</a>`)}`;
  const backgroundTab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    page
  );
  const foregroundTab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "about:blank"
  );
  try {
    await BrowserTestUtils.synthesizeMouseAtCenter(
      "#target",
      { button: 0 },
      backgroundTab.linkedBrowser
    );
    await TestUtils.waitForTick();
    await TestUtils.waitForTick();
    Assert.deepEqual(confirmations, []);
    Assert.deepEqual(calls, []);
  } finally {
    BrowserTestUtils.removeTab(foregroundTab);
    BrowserTestUtils.removeTab(backgroundTab);
    TorrentIngressTestUtils.reset();
  }
});

add_task(async function test_private_magnet_navigation_is_rejected() {
  configureIngress();
  const privateWindow = await BrowserTestUtils.openNewBrowserWindow({
    private: true,
  });
  const tab = await clickLink(MAGNET, privateWindow.gBrowser);
  try {
    await TestUtils.waitForTick();
    await TestUtils.waitForTick();
    Assert.deepEqual(confirmations, []);
    Assert.deepEqual(calls, []);
  } finally {
    BrowserTestUtils.removeTab(tab);
    await BrowserTestUtils.closeWindow(privateWindow);
    TorrentIngressTestUtils.reset();
  }
});

add_task(async function test_user_clicked_torrent_metadata_is_bounded_import() {
  configureIngress();
  const url = `${TEST_ROOT}file_torrent.sjs?attachment=1&nonce=${Date.now()}`;
  const tab = await clickLink(url);
  try {
    await TestUtils.waitForCondition(
      () => calls.some(call => call.method === "addTorrentBytes"),
      "The confirmed torrent metadata was added"
    );
    const call = calls.find(item => item.method === "addTorrentBytes");
    const source = new TextDecoder().decode(new Uint8Array(call.bytes));
    Assert.ok(source.startsWith("d4:info"));
    Assert.equal(confirmations.length, 1);
    Assert.ok(calls.some(item => item.method === "openManager"));
  } finally {
    BrowserTestUtils.removeTab(tab);
    TorrentIngressTestUtils.reset();
  }
});

add_task(async function test_torrent_refetch_preserves_cookie_and_referrer() {
  configureIngress();
  const nonce = String(Date.now());
  const landing = `${TEST_ROOT}file_torrent.sjs?landing=${nonce}`;
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, landing);
  await BrowserTestUtils.synthesizeMouseAtCenter(
    "#target",
    { button: 0 },
    tab.linkedBrowser
  );
  try {
    await TestUtils.waitForCondition(
      () => calls.some(call => call.method === "addTorrentBytes"),
      "The isolated refetch retained its cookie jar and referrer"
    );
    Assert.equal(confirmations.length, 1);
  } finally {
    BrowserTestUtils.removeTab(tab);
    TorrentIngressTestUtils.reset();
  }
});

add_task(async function test_scripted_torrent_navigation_is_rejected() {
  configureIngress();
  const url = `${TEST_ROOT}file_torrent.sjs?scripted=${Date.now()}`;
  const tab = await navigateWithoutGesture(url);
  try {
    Assert.deepEqual(confirmations, []);
    Assert.deepEqual(calls, []);
  } finally {
    BrowserTestUtils.removeTab(tab);
    TorrentIngressTestUtils.reset();
  }
});

add_task(async function test_wrong_mime_torrent_navigation_is_rejected() {
  configureIngress();
  const url = `${TEST_ROOT}file_torrent.sjs?wrong-type=1&nonce=${Date.now()}`;
  const tab = await clickLink(url);
  try {
    await TestUtils.waitForCondition(
      () => confirmations.length === 1,
      "The torrent confirmation was shown before the bounded refetch"
    );
    await waitForIngressIdle();
    Assert.ok(!calls.some(call => call.method === "addTorrentBytes"));
    Assert.ok(!calls.some(call => call.method === "openManager"));
  } finally {
    BrowserTestUtils.removeTab(tab);
    TorrentIngressTestUtils.reset();
  }
});

add_task(async function test_oversized_torrent_navigation_is_rejected() {
  configureIngress();
  const url = `${TEST_ROOT}file_torrent.sjs?oversize=1&nonce=${Date.now()}`;
  const tab = await clickLink(url);
  try {
    await TestUtils.waitForCondition(
      () => confirmations.length === 1,
      "The torrent confirmation was shown before the bounded refetch"
    );
    await waitForIngressIdle();
    Assert.ok(!calls.some(call => call.method === "addTorrentBytes"));
    Assert.ok(!calls.some(call => call.method === "openManager"));
  } finally {
    BrowserTestUtils.removeTab(tab);
    TorrentIngressTestUtils.reset();
  }
});

add_task(async function test_private_torrent_navigation_is_rejected() {
  configureIngress();
  const privateWindow = await BrowserTestUtils.openNewBrowserWindow({
    private: true,
  });
  const url = `${TEST_ROOT}file_torrent.sjs?private=${Date.now()}`;
  const responseSeen = TestUtils.topicObserved(
    "http-on-examine-response",
    subject => subject.QueryInterface(Ci.nsIChannel).URI.spec === url
  );
  const tab = await clickLink(url, privateWindow.gBrowser);
  try {
    await responseSeen;
    await TestUtils.waitForTick();
    Assert.deepEqual(confirmations, []);
    Assert.deepEqual(calls, []);
  } finally {
    BrowserTestUtils.removeTab(tab);
    await BrowserTestUtils.closeWindow(privateWindow);
    TorrentIngressTestUtils.reset();
  }
});
