/* SPDX-License-Identifier: AGPL-3.0-or-later */

const { TorrentDiscoveryManager } = ChromeUtils.importESModule(
  "resource:///modules/TorrentDiscoveryManager.sys.mjs"
);
const { TorrentManager } = ChromeUtils.importESModule(
  "resource:///modules/TorrentManager.sys.mjs"
);

function status() {
  return {
    torrents: [],
    capabilities: {
      tcp: true,
      udpTrackers: true,
      dht: true,
      utp: true,
      pex: true,
      lsd: true,
      inbound: true,
      tor: false,
    },
    settings: {
      maxActive: 3,
      downloadLimit: -1,
      uploadLimit: -1,
      seedCompleted: true,
      torEnabled: false,
      downloadDirectory: "/fixture-downloads",
    },
  };
}

function metadataDraft(draftId, name) {
  return {
    draftId,
    state: "metadata",
    name,
    totalSize: null,
    files: [],
  };
}

function readyDraft(draftId, name) {
  return {
    draftId,
    state: "ready",
    name,
    totalSize: 3,
    files: [
      { index: 0, name: "one", path: "one", length: 1 },
      { index: 1, name: "two", path: "two", length: 2 },
    ],
  };
}

async function submitMagnet(browser, magnet) {
  await SpecialPowers.spawn(browser, [magnet], value => {
    const form = content.document.getElementById("add-form");
    const submit = form.querySelector("button[type=submit]");
    content.document.getElementById("torrent-source").value = value;
    submit.focus();
    form.requestSubmit(submit);
  });
}

async function waitForDialog(browser, open) {
  await SpecialPowers.spawn(browser, [open], async expected => {
    await ContentTaskUtils.waitForCondition(
      () =>
        content.document.getElementById("torrent-draft-dialog").open ===
        expected,
      `Waiting for the torrent draft dialog to be ${expected ? "open" : "closed"}`
    );
  });
}

add_task(async function test_draft_polling_cancellation_and_retry() {
  const originals = {
    getSources: TorrentDiscoveryManager.getSources,
    initialize: TorrentManager.initialize,
    getStatus: TorrentManager.getStatus,
    createDraftFromURL: TorrentManager.createDraftFromURL,
    getTorrentDraft: TorrentManager.getTorrentDraft,
    cancelTorrentDraft: TorrentManager.cancelTorrentDraft,
  };
  const controls = new Map();
  const cancellations = [];
  TorrentDiscoveryManager.getSources = async () => ({
    immutable: true,
    sources: [],
  });
  TorrentManager.initialize = async () => status();
  TorrentManager.getStatus = async () => status();
  TorrentManager.createDraftFromURL = async source => {
    if (source.includes("dn=Old")) {
      return metadataDraft("old-draft", "Old torrent");
    }
    if (source.includes("dn=New")) {
      return metadataDraft("new-draft", "New torrent");
    }
    if (source.includes("dn=Error")) {
      return metadataDraft("error-draft", "Error torrent");
    }
    return readyDraft("retry-draft", "Retry torrent");
  };
  TorrentManager.getTorrentDraft = draftId =>
    new Promise((resolve, reject) => {
      const requests = controls.get(draftId) || [];
      requests.push({ resolve, reject });
      controls.set(draftId, requests);
    });
  TorrentManager.cancelTorrentDraft = async draftId => {
    cancellations.push(draftId);
    return { ok: true };
  };

  const consoleErrors = [];
  const consoleListener = {
    observe(message) {
      if (
        message instanceof Ci.nsIScriptError &&
        /torrents\.js/.test(message.sourceName || "")
      ) {
        consoleErrors.push(message.message);
      }
    },
  };
  Services.console.registerListener(consoleListener);

  let tab;
  try {
    tab = await BrowserTestUtils.openNewForegroundTab(
      gBrowser,
      "about:torrents"
    );
    const browser = tab.linkedBrowser;
    const oldMagnet = `magnet:?xt=urn:btih:${"1".repeat(40)}&dn=Old`;
    const newMagnet = `magnet:?xt=urn:btih:${"2".repeat(40)}&dn=New`;
    const errorMagnet = `magnet:?xt=urn:btih:${"3".repeat(40)}&dn=Error`;
    const retryMagnet = `magnet:?xt=urn:btih:${"4".repeat(40)}&dn=Retry`;

    await submitMagnet(browser, oldMagnet);
    await waitForDialog(browser, true);
    await TestUtils.waitForCondition(
      () => controls.get("old-draft")?.length === 1,
      "The first metadata draft started polling"
    );
    await BrowserTestUtils.synthesizeKey("KEY_Escape", {}, browser);
    await waitForDialog(browser, false);
    await TestUtils.waitForCondition(
      () => cancellations.includes("old-draft"),
      "Cancelling destroys the first metadata draft"
    );

    await submitMagnet(browser, newMagnet);
    await waitForDialog(browser, true);
    await TestUtils.waitForCondition(
      () => controls.get("new-draft")?.length === 1,
      "The replacement metadata draft started polling"
    );
    await SpecialPowers.spawn(browser, [], async () => {
      await content.closeDraft(true, "old-draft");
      Assert.ok(
        content.document.getElementById("torrent-draft-dialog").open,
        "A stale cancellation cannot clear the current draft"
      );
    });
    controls.get("old-draft")[0].reject(new Error("stale draft failure"));
    await TestUtils.waitForTick();
    await TestUtils.waitForTick();
    await SpecialPowers.spawn(browser, [], () => {
      Assert.ok(
        content.document.getElementById("torrent-draft-dialog").open,
        "A stale failure cannot close the replacement dialog"
      );
      Assert.equal(
        content.document
          .getElementById("torrent-draft-status")
          .getAttribute("data-l10n-id"),
        "wildbuzzard-torrents-draft-fetching",
        "The replacement keeps its metadata status"
      );
      Assert.ok(
        content.document.getElementById("toast").hidden,
        "A stale failure is not announced as the replacement's error"
      );
    });
    Assert.deepEqual(
      cancellations,
      ["old-draft"],
      "The stale failure does not cancel the replacement draft"
    );

    await SpecialPowers.spawn(browser, [], () => {
      content.document.getElementById("torrent-draft-keep-waiting").click();
    });
    await TestUtils.waitForCondition(
      () => controls.get("new-draft")?.length === 2,
      "A replacement poll supersedes the in-flight metadata request"
    );
    controls
      .get("new-draft")[1]
      .resolve(readyDraft("new-draft", "New torrent"));
    await SpecialPowers.spawn(browser, [], async () => {
      await ContentTaskUtils.waitForCondition(
        () =>
          content.document.querySelectorAll("input[data-draft-file]").length ===
          2,
        "The replacement draft received metadata"
      );
      const inputs = [
        ...content.document.querySelectorAll("input[data-draft-file]"),
      ];
      Assert.ok(
        inputs.every(input => input.checked),
        "Every magnet file starts selected after metadata arrives"
      );
    });
    controls
      .get("new-draft")[0]
      .resolve(metadataDraft("new-draft", "New torrent"));
    await TestUtils.waitForTick();
    await TestUtils.waitForTick();
    await SpecialPowers.spawn(browser, [], () => {
      const inputs = [
        ...content.document.querySelectorAll("input[data-draft-file]"),
      ];
      Assert.equal(
        inputs.length,
        2,
        "A superseded poll cannot rebuild a ready file chooser"
      );
      Assert.ok(
        content.document.getElementById("torrent-draft-dialog").open,
        "A superseded poll cannot reopen or close the dialog"
      );
      const first = inputs[0];
      first.focus();
      first.click();
      Assert.equal(
        content.document.querySelector("input[data-draft-file='0']"),
        first,
        "Changing a selection preserves the file-row DOM"
      );
      Assert.equal(
        content.document.activeElement,
        first,
        "Changing a selection preserves keyboard focus"
      );
      Assert.equal(
        content.document
          .getElementById("torrent-draft-commit")
          .getAttribute("data-l10n-id"),
        "wildbuzzard-torrents-draft-download-selected",
        "A subset changes only the primary action label"
      );
      first.click();
      Assert.ok(
        inputs.every(input => input.checked),
        "Selecting the file again restores the all-files default"
      );
      first.click();
    });
    await BrowserTestUtils.synthesizeKey("KEY_Escape", {}, browser);
    await waitForDialog(browser, false);

    await submitMagnet(browser, errorMagnet);
    await waitForDialog(browser, true);
    await TestUtils.waitForCondition(
      () => controls.get("error-draft")?.length === 1,
      "The failing metadata draft started polling"
    );
    await SpecialPowers.spawn(browser, [], () => {
      Assert.equal(
        content.document
          .getElementById("torrent-draft-commit")
          .getAttribute("data-l10n-id"),
        "wildbuzzard-torrents-draft-download-all",
        "A new metadata draft immediately resets the all-files action"
      );
    });
    controls.get("error-draft")[0].reject(new Error("current draft failure"));
    await waitForDialog(browser, false);
    await SpecialPowers.spawn(browser, [], async () => {
      await ContentTaskUtils.waitForCondition(
        () => !content.document.getElementById("toast").hidden,
        "The current draft failure is announced"
      );
      const toast = content.document.getElementById("toast");
      Assert.equal(toast.getAttribute("role"), "alert");
      Assert.equal(toast.getAttribute("aria-live"), "assertive");
      Assert.equal(
        content.document.activeElement,
        content.document.querySelector("#add-form button[type=submit]"),
        "A metadata error restores focus to the invoking action"
      );
    });
    await TestUtils.waitForCondition(
      () => cancellations.includes("error-draft"),
      "A current metadata error destroys its draft"
    );

    await submitMagnet(browser, retryMagnet);
    await waitForDialog(browser, true);
    await SpecialPowers.spawn(browser, [], () => {
      const inputs = [
        ...content.document.querySelectorAll("input[data-draft-file]"),
      ];
      Assert.equal(inputs.length, 2, "A retry opens a fresh file list");
      Assert.ok(
        inputs.every(input => input.checked),
        "Every file also starts selected after an error and retry"
      );
    });
    await BrowserTestUtils.synthesizeKey("KEY_Escape", {}, browser);
    await waitForDialog(browser, false);
    Assert.deepEqual(
      cancellations,
      ["old-draft", "new-draft", "error-draft", "retry-draft"],
      "Each cancelled or failed draft is destroyed exactly once"
    );
    Assert.deepEqual(consoleErrors, [], "Draft lifecycle races log no errors");
  } finally {
    if (tab) {
      BrowserTestUtils.removeTab(tab);
    }
    Services.console.unregisterListener(consoleListener);
    TorrentDiscoveryManager.getSources = originals.getSources;
    Object.assign(TorrentManager, {
      initialize: originals.initialize,
      getStatus: originals.getStatus,
      createDraftFromURL: originals.createDraftFromURL,
      getTorrentDraft: originals.getTorrentDraft,
      cancelTorrentDraft: originals.cancelTorrentDraft,
    });
  }
});
