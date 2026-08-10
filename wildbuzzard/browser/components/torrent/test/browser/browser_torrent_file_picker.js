/* SPDX-License-Identifier: AGPL-3.0-or-later */

const { MockRegistrar } = ChromeUtils.importESModule(
  "resource://testing-common/MockRegistrar.sys.mjs"
);
const { TorrentManager } = ChromeUtils.importESModule(
  "resource:///modules/TorrentManager.sys.mjs"
);

const MAX_TORRENT_SIZE = 12 * 1024 * 1024;
const pickerState = {
  selections: [],
  opens: [],
};

function TestFilePicker() {
  this.selectedFile = null;
}

TestFilePicker.prototype = {
  QueryInterface: ChromeUtils.generateQI(["nsIFilePicker"]),
  init(browsingContext, title, mode) {
    this.browsingContext = browsingContext;
    this.title = title;
    this.mode = mode;
  },
  appendFilter(title, filter) {
    this.filterTitle = title;
    this.filter = filter;
  },
  appendRawFilter(filter) {
    this.rawFilter = filter;
  },
  open(callback) {
    const selection = pickerState.selections.shift();
    this.selectedFile = selection?.file ?? null;
    pickerState.opens.push(this);
    Services.tm.dispatchToMainThread(() =>
      callback.done(selection?.result ?? Ci.nsIFilePicker.returnCancel)
    );
  },
  get file() {
    return this.selectedFile;
  },
  filterIndex: 0,
  displayDirectory: null,
  defaultString: "",
  defaultExtension: "",
};

function status(torrents = []) {
  return {
    torrents,
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
      downloadDirectory: "/download/path-not-exposed-by-picker",
    },
  };
}

function torrentRecord() {
  return {
    id: "fixture-torrent",
    name: "Fixture torrent",
    state: "paused",
    progress: 0,
    downloaded: 0,
    length: 1,
    downloadSpeed: 0,
    uploadSpeed: 0,
    numPeers: 0,
    timeRemaining: 0,
    ratio: 0,
    error: null,
    connections: [],
    files: [
      {
        index: 0,
        path: "fixture.txt",
        length: 1,
        progress: 0,
        selected: true,
      },
    ],
  };
}

async function makeFile(directory, name, bytes) {
  const path = PathUtils.join(directory, name);
  await IOUtils.write(path, bytes);
  return new FileUtils.File(path);
}

async function waitForToast(browser, expected) {
  await SpecialPowers.spawn(browser, [expected], async value => {
    await ContentTaskUtils.waitForCondition(() => {
      const toast = content.document.getElementById("toast");
      return !toast.hidden && toast.textContent === value;
    }, `Waiting for the torrent message: ${value}`);
  });
}

async function activate(browser, selector, key = null) {
  await SpecialPowers.spawn(browser, [selector], target => {
    content.document.querySelector(target).focus();
  });
  if (key) {
    await BrowserTestUtils.synthesizeKey(key, {}, browser);
  } else {
    await BrowserTestUtils.synthesizeMouseAtCenter(selector, {}, browser);
  }
  await TestUtils.waitForTick();
  await TestUtils.waitForTick();
}

async function waitForDraftDialog(browser) {
  await SpecialPowers.spawn(browser, [], async () => {
    await ContentTaskUtils.waitForCondition(
      () => content.document.getElementById("torrent-draft-dialog").open,
      "The torrent metadata dialog opened"
    );
  });
}

add_task(function test_native_file_picker_browsing_context_contract() {
  const invalidPicker = Cc["@mozilla.org/filepicker;1"].createInstance(
    Ci.nsIFilePicker
  );
  let conversionError;
  try {
    invalidPicker.init(
      window,
      "Torrent picker contract test",
      Ci.nsIFilePicker.modeOpen
    );
  } catch (error) {
    conversionError = error;
  }
  Assert.equal(
    conversionError?.name,
    "NS_ERROR_XPC_BAD_CONVERT_JS",
    "Passing a browser window reproduces the original native-picker failure"
  );

  const picker = Cc["@mozilla.org/filepicker;1"].createInstance(
    Ci.nsIFilePicker
  );
  picker.init(
    gBrowser.selectedBrowser.browsingContext,
    "Torrent picker contract test",
    Ci.nsIFilePicker.modeOpen
  );
  Assert.equal(
    picker.mode,
    Ci.nsIFilePicker.modeOpen,
    "The native picker accepts the privileged browser's BrowsingContext"
  );
});

add_task(async function test_torrent_file_picker_boundary() {
  const directory = await IOUtils.createUniqueDirectory(
    PathUtils.tempDir,
    "wildbuzzard-picker-test-"
  );
  const validBytes = new TextEncoder().encode(
    "d4:infod6:lengthi1e4:name11:fixture.txtee"
  );
  const validFile = await makeFile(directory, "fixture.torrent", validBytes);
  const invalidFile = await makeFile(
    directory,
    "invalid.torrent",
    new Uint8Array([1, 2, 3])
  );
  const wrongTypeFile = await makeFile(
    directory,
    "not-a-torrent.txt",
    validBytes
  );
  const oversizedFile = await makeFile(
    directory,
    "oversized.torrent",
    new Uint8Array(MAX_TORRENT_SIZE + 1)
  );
  const boundaryBytes = new Uint8Array(MAX_TORRENT_SIZE);
  boundaryBytes[0] = validBytes[0];
  const boundaryFile = await makeFile(
    directory,
    "boundary.torrent",
    boundaryBytes
  );
  const unreadableFile = new FileUtils.File(
    PathUtils.join(directory, "missing.torrent")
  );
  const pickerCID = MockRegistrar.register(
    "@mozilla.org/filepicker;1",
    TestFilePicker
  );
  const originals = {
    initialize: TorrentManager.initialize,
    getStatus: TorrentManager.getStatus,
    createTorrentDraft: TorrentManager.createTorrentDraft,
    commitTorrentDraft: TorrentManager.commitTorrentDraft,
    cancelTorrentDraft: TorrentManager.cancelTorrentDraft,
  };
  const hadConfig = Object.hasOwn(TorrentManager, "config");
  const originalConfig = TorrentManager.config;
  TorrentManager.config = { downloadDirectory: directory };
  let currentStatus = status();
  let statusRequests = 0;
  const additions = [];
  const commits = [];
  const cancellations = [];
  TorrentManager.initialize = async () => currentStatus;
  TorrentManager.getStatus = async () => {
    statusRequests++;
    return currentStatus;
  };
  TorrentManager.createTorrentDraft = async ({ torrent }) => {
    additions.push([torrent]);
    if (torrent[0] !== validBytes[0]) {
      throw Object.assign(new Error("Invalid bencode"), {
        torrentFileError: "invalid",
      });
    }
    const draftId = `fixture-draft-${additions.length}`;
    return {
      draftId,
      state: "ready",
      name: "Fixture torrent",
      totalSize: 2,
      files: [
        { index: 0, name: "fixture.txt", path: "fixture.txt", length: 1 },
        { index: 1, name: "optional.txt", path: "optional.txt", length: 1 },
      ],
    };
  };
  TorrentManager.commitTorrentDraft = async (...args) => {
    commits.push(args);
    currentStatus = status([torrentRecord()]);
    return { id: "fixture-torrent" };
  };
  TorrentManager.cancelTorrentDraft = async id => {
    cancellations.push(id);
    return { ok: true };
  };

  const consoleErrors = [];
  const consoleListener = {
    observe(message) {
      if (
        message instanceof Ci.nsIScriptError &&
        /(?:TorrentManager|torrents\.js)/.test(message.sourceName || "")
      ) {
        consoleErrors.push(message.message);
      }
    },
  };
  Services.console.registerListener(consoleListener);
  registerCleanupFunction(async () => {
    Services.console.unregisterListener(consoleListener);
    Object.assign(TorrentManager, originals);
    if (hadConfig) {
      TorrentManager.config = originalConfig;
    } else {
      delete TorrentManager.config;
    }
    MockRegistrar.unregister(pickerCID);
    await IOUtils.remove(directory, { recursive: true, ignoreAbsent: true });
  });

  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "about:torrents"
  );
  const browser = tab.linkedBrowser;
  try {
    const activationGuard = await SpecialPowers.spawn(browser, [], async () => {
      await ContentTaskUtils.waitForCondition(
        () => !content.document.getElementById("empty-state").hidden,
        "The empty torrent state is ready"
      );
      return {
        untrusted: content.isFilePickerActivation({ isTrusted: false }, true),
        inactive: content.isFilePickerActivation({ isTrusted: true }, false),
        active: content.isFilePickerActivation({ isTrusted: true }, true),
      };
    });
    Assert.ok(!activationGuard.untrusted, "Untrusted activation is rejected");
    Assert.ok(!activationGuard.inactive, "Inactive user input is rejected");
    Assert.ok(activationGuard.active, "Trusted active user input is accepted");

    pickerState.selections.push({ result: Ci.nsIFilePicker.returnCancel });
    const requestsBeforeCancel = statusRequests;
    await activate(browser, "#empty-choose-torrent", "KEY_Enter");
    Assert.equal(
      pickerState.opens.length,
      1,
      "Keyboard activation opens the picker"
    );
    Assert.equal(
      pickerState.opens[0].browsingContext,
      browser.browsingContext,
      "The initiating privileged browsing context owns the picker"
    );
    Assert.equal(pickerState.opens[0].mode, Ci.nsIFilePicker.modeOpen);
    Assert.equal(pickerState.opens[0].filter, "*.torrent");
    Assert.equal(pickerState.opens[0].rawFilter, "application/x-bittorrent");
    Assert.equal(
      statusRequests,
      requestsBeforeCancel,
      "Cancel does not refresh"
    );
    await SpecialPowers.spawn(browser, [], () => {
      Assert.equal(
        content.document.activeElement.id,
        "empty-choose-torrent",
        "Cancel restores focus to the empty-state action"
      );
      Assert.ok(
        content.document.getElementById("toast").hidden,
        "Cancel is silent"
      );
    });

    pickerState.selections.push({
      result: Ci.nsIFilePicker.returnOK,
      file: wrongTypeFile,
    });
    await activate(browser, "#choose-torrent");
    await waitForToast(browser, "Choose a file with the .torrent extension.");

    pickerState.selections.push({
      result: Ci.nsIFilePicker.returnOK,
      file: oversizedFile,
    });
    await activate(browser, "#choose-torrent");
    await waitForToast(
      browser,
      "Choose a torrent file that is 12 MiB or smaller."
    );

    pickerState.selections.push({
      result: Ci.nsIFilePicker.returnOK,
      file: boundaryFile,
    });
    await activate(browser, "#choose-torrent");
    await waitForDraftDialog(browser);
    Assert.equal(
      additions[0][0].length,
      MAX_TORRENT_SIZE,
      "A file exactly at the byte limit is accepted"
    );
    await activate(browser, "#torrent-draft-cancel");
    Assert.equal(
      cancellations.length,
      1,
      "Cancelling removes the byte-limit draft"
    );
    await SpecialPowers.spawn(browser, [], () => {
      Assert.equal(
        content.document.activeElement.id,
        "choose-torrent",
        "Closing a selected torrent's draft restores picker-button focus"
      );
    });

    pickerState.selections.push({
      result: Ci.nsIFilePicker.returnOK,
      file: unreadableFile,
    });
    await activate(browser, "#choose-torrent");
    await waitForToast(
      browser,
      "WildBuzzard could not read this torrent file."
    );

    pickerState.selections.push({
      result: Ci.nsIFilePicker.returnOK,
      file: invalidFile,
    });
    await activate(browser, "#choose-torrent");
    await waitForToast(browser, "This torrent file is invalid.");
    await SpecialPowers.spawn(browser, [], () => {
      const toast = content.document.getElementById("toast");
      Assert.equal(toast.getAttribute("role"), "alert");
      Assert.equal(toast.getAttribute("aria-live"), "assertive");
      Assert.equal(
        content.document.activeElement.id,
        "choose-torrent",
        "Invalid selection restores focus for an immediate retry"
      );
    });

    pickerState.selections.push({
      result: Ci.nsIFilePicker.returnOK,
      file: validFile,
    });
    await activate(browser, "#choose-torrent", "KEY_Enter");
    await waitForDraftDialog(browser);
    Assert.equal(
      additions.length,
      3,
      "Only bounded, invalid-bencode, and valid bytes reach the manager"
    );
    Assert.equal(
      additions[2].length,
      1,
      "The selected path is not handed downstream"
    );
    Assert.deepEqual(
      Array.from(additions[2][0]),
      Array.from(validBytes),
      "Only the selected torrent bytes are handed downstream"
    );
    await SpecialPowers.spawn(browser, [], () => {
      const selections = [
        ...content.document.querySelectorAll("input[data-draft-file]"),
      ];
      Assert.ok(
        selections.length === 2 && selections.every(input => input.checked),
        "The metadata dialog defaults every file to selected"
      );
    });
    await activate(browser, "input[data-draft-file='1']");
    await activate(browser, "#torrent-draft-commit");
    await waitForToast(browser, "Torrent download started.");
    Assert.deepEqual(
      commits[0],
      ["fixture-draft-3", [0]],
      "The explicit file subset crosses the privileged commit boundary"
    );

    pickerState.selections.push({ result: Ci.nsIFilePicker.returnCancel });
    pickerState.selections.push({
      result: Ci.nsIFilePicker.returnOK,
      file: validFile,
    });
    await activate(browser, "#choose-torrent");
    await activate(browser, "#choose-torrent");
    await waitForDraftDialog(browser);
    await activate(browser, "#torrent-draft-commit");
    await waitForToast(browser, "Torrent download started.");
    Assert.equal(additions.length, 4, "Choose/cancel/choose remains reusable");

    await SpecialPowers.spawn(browser, [], () => {
      const transfer = new content.DataTransfer();
      transfer.items.add(
        new content.File([new Uint8Array([1])], "wrong-type.torrent", {
          type: "text/plain",
        })
      );
      content.document.getElementById("drop-target").dispatchEvent(
        new content.DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
        })
      );
    });
    await waitForToast(browser, "Choose a file with the .torrent extension.");
    Assert.equal(
      additions.length,
      4,
      "Wrong-type drops are rejected before read"
    );

    await SpecialPowers.spawn(browser, [Array.from(validBytes)], bytes => {
      const transfer = new content.DataTransfer();
      transfer.items.add(
        new content.File([new Uint8Array(bytes)], "dropped.torrent", {
          type: "application/x-bittorrent",
        })
      );
      content.document.getElementById("drop-target").dispatchEvent(
        new content.DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
        })
      );
    });
    await TestUtils.waitForCondition(
      () => additions.length === 5,
      "Drag and drop uses the same validated byte path"
    );
    await waitForDraftDialog(browser);
    await activate(browser, "#torrent-draft-cancel");

    pickerState.selections.push({ result: Ci.nsIFilePicker.returnCancel });
    Assert.equal(
      await TorrentManager.chooseDownloadDirectory(browser.browsingContext),
      null,
      "Download-directory cancellation remains a no-op"
    );
    const directoryPicker = pickerState.opens.at(-1);
    Assert.equal(
      directoryPicker.browsingContext,
      browser.browsingContext,
      "The download-directory picker uses the privileged browser context"
    );
    Assert.equal(directoryPicker.mode, Ci.nsIFilePicker.modeGetFolder);
    Assert.deepEqual(consoleErrors, [], "No picker flow logs a script error");
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});
