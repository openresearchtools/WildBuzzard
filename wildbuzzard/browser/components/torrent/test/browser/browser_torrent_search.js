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

function result(id, name, providerId, seeders, leechers, sizeBytes) {
  return {
    resultId: id.repeat(32),
    providerId,
    providerName: `Source ${providerId.toUpperCase()}`,
    name,
    sizeBytes,
    seeders,
    leechers,
    publishedAt: "2026-08-10T00:00:00Z",
    categoryIds: [8000],
    access: "public",
    acquisition: "magnet",
  };
}

function response(results) {
  return {
    searchId: "S".repeat(32),
    partial: true,
    providers: [
      { id: "a", state: "ok", elapsedMs: 2 },
      { id: "b", state: "error", elapsedMs: 4 },
    ],
    results,
  };
}

add_task(async function test_semantic_results_sorting_and_download() {
  const results = [
    result("n", "Zulu", "b", null, null, null),
    result("a", "Alpha", "a", 10, 4, 2048),
    result("b", "Beta", "a", 10, 2, 1024),
    result("h", "Gamma", "b", 50, 8, 4096),
  ];
  const ordinaryResponse = response(results);
  const originals = {
    cancelSearch: TorrentDiscoveryManager.cancelSearch,
    getSources: TorrentDiscoveryManager.getSources,
    search: TorrentDiscoveryManager.search,
    resolve: TorrentDiscoveryManager.resolve,
    initialize: TorrentManager.initialize,
    getStatus: TorrentManager.getStatus,
    createTorrentDraft: TorrentManager.createTorrentDraft,
    cancelTorrentDraft: TorrentManager.cancelTorrentDraft,
  };
  const searchCalls = [];
  const resolved = [];
  const drafts = [];
  const cancellations = [];
  let cancelCount = 0;
  let delayed = false;
  let releaseSearch;
  TorrentDiscoveryManager.getSources = async () => ({
    immutable: true,
    sources: [
      { id: "a", name: "Source A", state: "ready" },
      { id: "b", name: "Source B", state: "ready" },
    ],
  });
  TorrentDiscoveryManager.search = async options => {
    searchCalls.push({
      query: options.query,
      sourceIds: options.sourceIds ?? null,
      isPrivate: options.isPrivate,
      hasSort: Object.hasOwn(options, "sort"),
      hasDirection: Object.hasOwn(options, "direction"),
    });
    if (delayed) {
      return new Promise(resolve => {
        releaseSearch = resolve;
      });
    }
    return ordinaryResponse;
  };
  TorrentDiscoveryManager.cancelSearch = () => {
    cancelCount++;
  };
  TorrentDiscoveryManager.resolve = async id => {
    resolved.push(id);
    return {
      kind: "magnet",
      magnet: "magnet:?xt=urn:btih:0123456789012345678901234567890123456789",
    };
  };
  TorrentManager.initialize = async () => status();
  TorrentManager.getStatus = async () => status();
  TorrentManager.createTorrentDraft = async source => {
    drafts.push(source);
    return {
      draftId: "fixture-draft",
      state: "ready",
      name: "Fixture",
      totalSize: 2,
      files: [
        { index: 0, name: "one", path: "one", length: 1 },
        { index: 1, name: "two", path: "two", length: 1 },
      ],
    };
  };
  TorrentManager.cancelTorrentDraft = async id => {
    cancellations.push(id);
    return { ok: true };
  };
  registerCleanupFunction(() => {
    Object.assign(TorrentDiscoveryManager, {
      cancelSearch: originals.cancelSearch,
      getSources: originals.getSources,
      search: originals.search,
      resolve: originals.resolve,
    });
    Object.assign(TorrentManager, {
      initialize: originals.initialize,
      getStatus: originals.getStatus,
      createTorrentDraft: originals.createTorrentDraft,
      cancelTorrentDraft: originals.cancelTorrentDraft,
    });
  });

  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "about:torrents?search=linux"
  );
  const browser = tab.linkedBrowser;
  try {
    await SpecialPowers.spawn(browser, [], async () => {
      await content.document.l10n.ready;
      await ContentTaskUtils.waitForCondition(
        () =>
          content.document.querySelectorAll("#torrent-results-body tr")
            .length === 4,
        "The torrent search results rendered"
      );
      const table = content.document.getElementById("torrent-results");
      const headers = [...table.querySelectorAll("thead th")];
      Assert.equal(table.localName, "table", "Results use a semantic table");
      Assert.ok(
        headers.every(header => header.scope === "col"),
        "Every result heading identifies a column"
      );
      Assert.deepEqual(
        headers.map(header => header.textContent.trim()),
        [
          "Title",
          "Size",
          "Seeders",
          "Leechers",
          "Source",
          "Category",
          "Published",
          "Download",
        ],
        "The required result columns are advertised"
      );
      const rowIds = () =>
        [...table.tBodies[0].rows].map(row => row.dataset.resultId[0]);
      Assert.deepEqual(
        rowIds(),
        ["h", "a", "b", "n"],
        "Seeders descending is the initial order and null stays last"
      );
      Assert.equal(
        table.querySelector("th[data-sort-column=seeders]").ariaSort,
        "descending",
        "The active default sort is exposed"
      );
      Assert.equal(
        table.querySelectorAll("th[aria-sort]").length,
        1,
        "Only the active sort column exposes aria-sort"
      );
      Assert.ok(
        [...table.tBodies[0].rows].every(row => {
          const title = row.cells[0];
          const download = row.querySelector("button[data-prepare-result]");
          return (
            row.cells.length === 8 &&
            title.localName === "th" &&
            title.scope === "row" &&
            download?.getAttribute("aria-describedby") === title.id
          );
        }),
        "Every row has a row heading that describes its Download action"
      );
      Assert.ok(
        [...table.querySelectorAll("thead button[data-sort]")].every(button => {
          const bounds = button.getBoundingClientRect();
          return bounds.width >= 24 && bounds.height >= 24;
        }),
        "Every sorting control has at least a 24 by 24 CSS pixel target"
      );

      const nodes = new Map(
        [...table.tBodies[0].rows].map(row => [row.dataset.resultId, row])
      );
      const assertSort = (field, expected, direction, message) => {
        table.querySelector(`button[data-sort=${field}]`).click();
        Assert.deepEqual(rowIds(), expected, message);
        Assert.equal(
          table.querySelector(`th[data-sort-column=${field}]`).ariaSort,
          direction,
          `${field} exposes ${direction}`
        );
        Assert.equal(
          table.querySelectorAll("th[aria-sort]").length,
          1,
          "Only the newest sort remains active"
        );
      };
      assertSort(
        "seeders",
        ["a", "b", "h", "n"],
        "ascending",
        "Ascending Seeders keeps null values last and ties stable"
      );
      assertSort(
        "name",
        ["a", "b", "h", "n"],
        "ascending",
        "A new Title sort begins ascending"
      );
      assertSort(
        "name",
        ["n", "h", "b", "a"],
        "descending",
        "Title reverses on its second activation"
      );
      assertSort(
        "sizeBytes",
        ["h", "a", "b", "n"],
        "descending",
        "A new Size sort begins descending with null last"
      );
      assertSort(
        "sizeBytes",
        ["b", "a", "h", "n"],
        "ascending",
        "Ascending Size keeps null last"
      );
      assertSort(
        "leechers",
        ["h", "a", "b", "n"],
        "descending",
        "A new Leechers sort begins descending with null last"
      );
      assertSort(
        "leechers",
        ["b", "a", "h", "n"],
        "ascending",
        "Ascending Leechers keeps null last"
      );
      Assert.ok(
        [...table.tBodies[0].rows].every(
          row => nodes.get(row.dataset.resultId) === row
        ),
        "Sorting reuses rows without a flickering rebuild"
      );
      Assert.equal(
        content.document.getElementById("torrent-search-status").role,
        "status",
        "Search completion is announced through a live status"
      );
      Assert.equal(
        content.document.querySelectorAll("#torrent-provider-status li").length,
        2,
        "Partial provider outcomes remain visible"
      );
      table.querySelector("button[data-sort=leechers]").focus();
    });
    await BrowserTestUtils.synthesizeKey("KEY_Enter", {}, browser);
    await SpecialPowers.spawn(browser, [], () => {
      const table = content.document.getElementById("torrent-results");
      Assert.deepEqual(
        [...table.tBodies[0].rows].map(row => row.dataset.resultId[0]),
        ["h", "a", "b", "n"],
        "Keyboard activation reverses the active sort"
      );
      Assert.equal(
        table.querySelector("th[data-sort-column=leechers]").ariaSort,
        "descending",
        "Keyboard sorting updates the exposed direction"
      );
      Assert.equal(
        content.document.activeElement.dataset.sort,
        "leechers",
        "Sorting preserves keyboard focus on the activating header"
      );
    });
    await BrowserTestUtils.synthesizeKey(" ", {}, browser);
    await SpecialPowers.spawn(browser, [], () => {
      const header = content.document.querySelector(
        "th[data-sort-column=leechers]"
      );
      Assert.equal(
        header.ariaSort,
        "ascending",
        "Space also updates the exposed sort direction"
      );
      Assert.equal(
        content.document.activeElement.dataset.sort,
        "leechers",
        "Space sorting preserves focus on the header"
      );
    });
    Assert.deepEqual(searchCalls[0], {
      query: "linux",
      sourceIds: null,
      isPrivate: false,
      hasSort: false,
      hasDirection: false,
    });

    await SpecialPowers.spawn(browser, [], () => {
      const sources = [
        ...content.document.querySelectorAll("#search-source-list input"),
      ];
      sources[1].click();
      content.document.getElementById("torrent-search-query").value = "subset";
      content.document.getElementById("search-form").requestSubmit();
    });
    await TestUtils.waitForCondition(
      () => searchCalls.length === 2,
      "The source-subset search completed"
    );
    Assert.deepEqual(
      searchCalls[1].sourceIds,
      ["a"],
      "A per-search subset is explicit"
    );
    await SpecialPowers.spawn(browser, [], () => {
      Assert.equal(
        content.document.querySelectorAll("#search-source-list input").length,
        2,
        "A subset search does not mutate the immutable source catalog"
      );
    });

    await SpecialPowers.spawn(browser, [], () => {
      content.document
        .querySelector(`button[data-prepare-result="${"h".repeat(32)}"]`)
        .focus();
    });
    await BrowserTestUtils.synthesizeKey("KEY_Enter", {}, browser);
    await SpecialPowers.spawn(browser, [], async () => {
      await ContentTaskUtils.waitForCondition(
        () => content.document.getElementById("torrent-draft-dialog").open,
        "Download prepares a metadata draft"
      );
      Assert.ok(
        [...content.document.querySelectorAll("input[data-draft-file]")].every(
          input => input.checked
        ),
        "Every discovered torrent file starts selected"
      );
      const dialog = content.document.getElementById("torrent-draft-dialog");
      Assert.equal(
        dialog.getAttribute("aria-labelledby"),
        "torrent-draft-heading",
        "The native dialog exposes its title"
      );
      Assert.equal(
        dialog.getAttribute("aria-describedby"),
        "torrent-draft-summary",
        "The native dialog exposes its static summary"
      );
      Assert.ok(
        dialog.contains(content.document.activeElement),
        "Opening the native dialog moves focus inside it"
      );
    });
    Assert.deepEqual(resolved, ["h".repeat(32)]);
    Assert.deepEqual(drafts, [
      {
        magnet: "magnet:?xt=urn:btih:0123456789012345678901234567890123456789",
      },
    ]);
    await BrowserTestUtils.synthesizeKey("KEY_Escape", {}, browser);
    await TestUtils.waitForCondition(
      () => cancellations.length === 1,
      "Escape cancels and destroys the prepared draft"
    );
    await SpecialPowers.spawn(browser, [], () => {
      Assert.equal(
        content.document.activeElement.dataset.prepareResult,
        "h".repeat(32),
        "Closing the dialog restores focus to the originating row action"
      );
    });

    delayed = true;
    await SpecialPowers.spawn(browser, [], () => {
      content.document.getElementById("torrent-search-query").value = "slow";
      content.document.getElementById("search-form").requestSubmit();
    });
    await TestUtils.waitForCondition(
      () => typeof releaseSearch === "function",
      "The delayed search started"
    );
    await SpecialPowers.spawn(browser, [], () => {
      content.document.getElementById("torrent-search-cancel").focus();
    });
    await BrowserTestUtils.synthesizeKey("KEY_Enter", {}, browser);
    await TestUtils.waitForCondition(
      () => cancelCount === 1,
      "Cancellation reaches the discovery transport"
    );
    releaseSearch(response([result("x", "Stale", "a", 999, 1, 1)]));
    await TestUtils.waitForTick();
    await TestUtils.waitForTick();
    await SpecialPowers.spawn(browser, [], () => {
      Assert.ok(
        !content.document.querySelector(`[data-result-id="${"x".repeat(32)}"]`),
        "A response arriving after cancellation is suppressed"
      );
      Assert.equal(
        content.document.getElementById("search-form").ariaBusy,
        "false",
        "Cancellation clears the busy state"
      );
      Assert.ok(
        content.document.getElementById("torrent-search-cancel").hidden,
        "Cancellation restores the ordinary controls"
      );
      Assert.equal(
        content.document.activeElement.id,
        "torrent-search-query",
        "Keyboard cancellation restores focus to the search query"
      );
      Assert.equal(
        content.document.getElementById("torrent-search-status").textContent,
        "Search cancelled.",
        "A stale completion does not replace the cancellation announcement"
      );
    });
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});
