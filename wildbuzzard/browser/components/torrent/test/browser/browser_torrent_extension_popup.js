/* SPDX-License-Identifier: AGPL-3.0-or-later */

const TORRENT_EXTENSION_ID = "torrent-search@extensions.wildbuzzard";
const INFO_HASH = "0123456789abcdef0123456789abcdef01234567";
const MAGNET = `magnet:?xt=urn:btih:${INFO_HASH}&dn=Release%20fixture`;
const RESULT_TOKEN = `v1_${"A".repeat(43)}`;
const UNKNOWN_CONFIRMATION_TOKEN = `v1_${"B".repeat(43)}`;

const { AppUiTestDelegate } = ChromeUtils.importESModule(
  "resource://testing-common/AppUiTestDelegate.sys.mjs"
);
const {
  TorrentSearchBridge,
  WildBuzzardDiscoveryBridgeTestUtils: Bridge,
} = ChromeUtils.importESModule(
  "resource:///modules/WildBuzzardDiscoveryBridge.sys.mjs"
);
const { TorrentManager } = ChromeUtils.importESModule(
  "resource:///modules/TorrentManager.sys.mjs"
);

let extension;
let importContexts;
let managerCalls;
let originalBridgeMethods;
let originalManagerMethods;

function resetTestState() {
  importContexts = [];
  managerCalls = [];
  Bridge.resetTokens();
}

function isActivePopupContext(callContext) {
  return Boolean(
    callContext?.isHandlingUserInput === true &&
      callContext.isPrivate !== true &&
      callContext.viewType === "popup" &&
      callContext.window &&
      !callContext.window.closed &&
      Services.focus.activeWindow === callContext.window &&
      callContext.window.document.hasFocus()
  );
}

async function waitForSelector(browser, selector) {
  await SpecialPowers.spawn(browser, [selector], async target => {
    await ContentTaskUtils.waitForCondition(
      () => content.document.querySelector(target),
      `Wait for ${target}`
    );
  });
}

async function waitForText(browser, selector, expected) {
  await SpecialPowers.spawn(
    browser,
    [selector, expected],
    async (target, text) => {
      await ContentTaskUtils.waitForCondition(
        () => content.document.querySelector(target)?.textContent.includes(text),
        `Wait for ${text}`
      );
    }
  );
}

async function searchAndReview(browser) {
  await waitForSelector(browser, "#search-button:not([disabled])");
  await SpecialPowers.spawn(browser, [], () => {
    const query = content.document.querySelector("#query");
    query.value = "release fixture";
    query.dispatchEvent(new content.Event("input", { bubbles: true }));
  });
  await BrowserTestUtils.synthesizeMouseAtCenter(
    "#search-button",
    {},
    browser
  );
  await waitForSelector(browser, ".review-button");
  await BrowserTestUtils.synthesizeMouseAtCenter(".review-button", {}, browser);
  await waitForSelector(browser, "#confirmation[open]");
}

async function openActionPopup() {
  const popup = AppUiTestDelegate.awaitExtensionPanel(
    window,
    TORRENT_EXTENSION_ID,
    true
  );
  await AppUiTestDelegate.clickBrowserAction(window, TORRENT_EXTENSION_ID);
  const browser = await popup;
  await waitForSelector(browser, "#search-button:not([disabled])");
  return browser;
}

async function closeActionPopup() {
  await AppUiTestDelegate.closeBrowserAction(window, TORRENT_EXTENSION_ID);
}

add_setup(async function setup_torrent_extension_popup_test() {
  await TestUtils.waitForCondition(() => {
    extension = WebExtensionPolicy.getByID(TORRENT_EXTENSION_ID)?.extension;
    return extension?.addonData?.builtIn === true;
  }, "The built-in torrent-search extension started");

  originalBridgeMethods = {
    getStatus: TorrentSearchBridge.getStatus,
    importPrepared: TorrentSearchBridge.importPrepared,
    listSources: TorrentSearchBridge.listSources,
    prepareImport: TorrentSearchBridge.prepareImport,
    search: TorrentSearchBridge.search,
  };
  originalManagerMethods = {
    addMagnet: TorrentManager.addMagnet,
    initialize: TorrentManager.initialize,
  };

  TorrentSearchBridge.getStatus = owner => {
    Assert.equal(owner, TORRENT_EXTENSION_ID);
    return { schemaVersion: 1, available: true };
  };
  TorrentSearchBridge.listSources = owner => {
    Assert.equal(owner, TORRENT_EXTENSION_ID);
    return {
      schemaVersion: 1,
      sources: [{ id: "offline.fixture", name: "Offline fixture" }],
    };
  };
  TorrentSearchBridge.search = (request, owner) => {
    Assert.equal(owner, TORRENT_EXTENSION_ID);
    Assert.equal(request.query, "release fixture");
    return {
      schemaVersion: 1,
      operationId: request.operationId,
      results: [
        {
          resultToken: RESULT_TOKEN,
          sourceName: "Offline fixture",
          title: "Release fixture",
          sizeBytes: 65536,
          seeders: 1,
          leechers: 0,
          publishedAt: null,
        },
      ],
      truncated: false,
    };
  };
  TorrentSearchBridge.prepareImport = (_request, owner) => {
    Assert.equal(owner, TORRENT_EXTENSION_ID);
    return {
      schemaVersion: 1,
      confirmationToken: UNKNOWN_CONFIRMATION_TOKEN,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      name: "Release fixture",
      sourceName: "Offline fixture",
      kind: "magnet",
      sizeBytes: 65536,
    };
  };
  TorrentSearchBridge.importPrepared = async (request, owner, callContext) => {
    importContexts.push(callContext);
    if (!isActivePopupContext(callContext)) {
      return originalBridgeMethods.importPrepared.call(
        TorrentSearchBridge,
        request,
        owner,
        callContext
      );
    }
    if (
      !Services.prompt.confirm(
        callContext.window,
        "Torrent Search",
        "Add the Release fixture torrent?"
      )
    ) {
      return { schemaVersion: 1, accepted: false };
    }
    if (!isActivePopupContext(callContext)) {
      return originalBridgeMethods.importPrepared.call(
        TorrentSearchBridge,
        request,
        owner,
        callContext
      );
    }
    await TorrentManager.initialize();
    if (!isActivePopupContext(callContext)) {
      return originalBridgeMethods.importPrepared.call(
        TorrentSearchBridge,
        request,
        owner,
        callContext
      );
    }
    const result = await TorrentManager.addMagnet(MAGNET);
    callContext.window.gBrowser.loadOneTab("about:torrents", {
      inBackground: false,
      triggeringPrincipal:
        Services.scriptSecurityManager.getSystemPrincipal(),
    });
    return {
      schemaVersion: 1,
      accepted: true,
      downloadId: result.ids[0],
    };
  };
  TorrentManager.initialize = async () => {
    managerCalls.push({ method: "initialize" });
  };
  TorrentManager.addMagnet = async source => {
    managerCalls.push({ method: "addMagnet", source });
    return { added: true, ids: [INFO_HASH] };
  };

  registerCleanupFunction(async () => {
    Object.assign(TorrentSearchBridge, originalBridgeMethods);
    Object.assign(TorrentManager, originalManagerMethods);
    Bridge.resetTokens();
    await SimpleTest.promiseFocus(window);
  });
});

add_task(async function test_real_action_popup_imports_after_native_prompt() {
  resetTestState();
  await SimpleTest.promiseFocus(window);
  const initialTab = gBrowser.selectedTab;
  const popupBrowser = await openActionPopup();
  await searchAndReview(popupBrowser);
  Assert.ok(
    await SpecialPowers.spawn(popupBrowser, [], () =>
      content.document.hasFocus()
    ),
    "The real browser-action popup is focused before import"
  );

  const prompt = BrowserTestUtils.promiseAlertDialog("accept");
  await BrowserTestUtils.synthesizeMouseAtCenter(
    "#confirm-import",
    {},
    popupBrowser
  );
  await prompt;
  await TestUtils.waitForCondition(
    () => managerCalls.some(call => call.method === "addMagnet"),
    "The accepted popup import reached the torrent manager"
  );

  Assert.deepEqual(managerCalls, [
    { method: "initialize" },
    { method: "addMagnet", source: MAGNET },
  ]);
  Assert.equal(importContexts.length, 1);
  Assert.equal(importContexts[0].viewType, "popup");
  Assert.ok(importContexts[0].isHandlingUserInput);
  await TestUtils.waitForCondition(
    () => gBrowser.selectedBrowser.currentURI.spec === "about:torrents",
    "The native torrent manager opened"
  );
  BrowserTestUtils.removeTab(gBrowser.selectedTab);
  gBrowser.selectedTab = initialTab;
});

add_task(async function test_direct_extension_tab_cannot_import() {
  resetTestState();
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    extension.baseURI.resolve("src/popup.html")
  );
  let promptSeen = false;
  const promptObserver = subject => {
    promptSeen = true;
    subject.document.querySelector("dialog").getButton("cancel").click();
  };
  Services.obs.addObserver(promptObserver, "common-dialog-loaded");
  try {
    await searchAndReview(tab.linkedBrowser);
    await BrowserTestUtils.synthesizeMouseAtCenter(
      "#confirm-import",
      {},
      tab.linkedBrowser
    );
    await waitForText(tab.linkedBrowser, "#message", "not authorized");
    Assert.ok(!promptSeen, "A directly opened extension tab showed no prompt");
    Assert.equal(importContexts.length, 1);
    Assert.equal(importContexts[0].viewType, "tab");
    Assert.ok(importContexts[0].isHandlingUserInput);
    Assert.deepEqual(managerCalls, []);
  } finally {
    Services.obs.removeObserver(promptObserver, "common-dialog-loaded");
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function test_popup_import_without_user_input_is_rejected() {
  resetTestState();
  const popupBrowser = await openActionPopup();
  const result = await SpecialPowers.spawn(
    popupBrowser,
    [UNKNOWN_CONFIRMATION_TOKEN],
    async confirmationToken => {
      try {
        await content.browser.torrentSearch.importPrepared({
          schemaVersion: 1,
          confirmationToken,
        });
        return { accepted: true };
      } catch (error) {
        return { accepted: false, message: String(error.message) };
      }
    }
  );
  Assert.ok(!result.accepted, "Import without active user input was rejected");
  Assert.ok(result.message, "The rejected import returned an error");
  if (importContexts.length) {
    Assert.ok(!importContexts[0].isHandlingUserInput);
  }
  Assert.deepEqual(managerCalls, []);
  await closeActionPopup();
});

add_task(async function test_background_import_is_rejected() {
  resetTestState();
  const background = [...extension.views].find(
    view => view.viewType === "background"
  );
  Assert.ok(background?.browsingContext, "The built-in background view exists");
  const result = await SpecialPowers.spawn(
    background.browsingContext,
    [UNKNOWN_CONFIRMATION_TOKEN],
    async confirmationToken => {
      try {
        await content.browser.torrentSearch.importPrepared({
          schemaVersion: 1,
          confirmationToken,
        });
        return { accepted: true };
      } catch (error) {
        return { accepted: false, message: String(error.message) };
      }
    }
  );
  Assert.ok(!result.accepted, "The background view could not import a torrent");
  Assert.ok(result.message, "The rejected background import returned an error");
  if (importContexts.length) {
    Assert.equal(importContexts[0].viewType, "background");
  }
  Assert.deepEqual(managerCalls, []);
});

add_task(async function test_import_rejects_focus_loss() {
  resetTestState();
  const otherWindow = await BrowserTestUtils.openNewBrowserWindow();
  try {
    await SimpleTest.promiseFocus(otherWindow);
    await Assert.rejects(
      TorrentSearchBridge.importPrepared(
        {
          schemaVersion: 1,
          confirmationToken: UNKNOWN_CONFIRMATION_TOKEN,
        },
        TORRENT_EXTENSION_ID,
        {
          isHandlingUserInput: true,
          isPrivate: false,
          viewType: "popup",
          window,
        }
      ),
      /torrentSearch\.NOT_AUTHORIZED/,
      "A popup import fails closed after its browser window loses focus"
    );
    Assert.deepEqual(managerCalls, []);
  } finally {
    await BrowserTestUtils.closeWindow(otherWindow);
    await SimpleTest.promiseFocus(window);
  }
});
