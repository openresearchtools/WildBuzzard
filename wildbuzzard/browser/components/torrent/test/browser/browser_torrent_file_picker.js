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
    BrowserTestUtils.synthesizeKey(key, {}, browser);
  } else {
    BrowserTestUtils.synthesizeMouseAtCenter(selector, {}, browser);
  }
  await TestUtils.waitForTick();
  await TestUtils.waitForTick();
}

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
    addTorrentBytes: TorrentManager.addTorrentBytes,
  };
  const hadConfig = Object.hasOwn(TorrentManager, "config");
  const originalConfig = TorrentManager.config;
  TorrentManager.config = { downloadDirectory: directory };
  let currentStatus = status();
  let statusRequests = 0;
  const additions = [];
  TorrentManager.initialize = async () => currentStatus;
  TorrentManager.getStatus = async () => {
    statusRequests++;
    return currentStatus;
  };
  TorrentManager.addTorrentBytes = async (...args) => {
    additions.push(args);
    if (args[0][0] !== validBytes[0]) {
      throw Object.assign(new Error("Invalid bencode"), {
        torrentFileError: "invalid",
      });
    }
    currentStatus = status([torrentRecord()]);
    return { id: "fixture-torrent" };
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
    await waitForToast(browser, "Torrent added.");
    Assert.equal(
      additions[0][0].length,
      MAX_TORRENT_SIZE,
      "A file exactly at the byte limit is accepted"
    );

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
    await waitForToast(browser, "Torrent added.");
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
    await SpecialPowers.spawn(browser, [], async () => {
      await ContentTaskUtils.waitForCondition(
        () => content.document.querySelector("input[data-file-index]")?.checked,
        "The existing metadata view shows every fixture file selected"
      );
      Assert.equal(
        content.document.activeElement.id,
        "choose-torrent",
        "Successful selection restores focus"
      );
    });

    pickerState.selections.push({ result: Ci.nsIFilePicker.returnCancel });
    pickerState.selections.push({
      result: Ci.nsIFilePicker.returnOK,
      file: validFile,
    });
    await activate(browser, "#choose-torrent");
    await activate(browser, "#choose-torrent");
    await waitForToast(browser, "Torrent added.");
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
