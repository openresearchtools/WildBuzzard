/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_task(async function product_information_and_supported_settings() {
  const tab = await openPrefsTab("about");
  try {
    const doc = tab.linkedBrowser.contentDocument;
    await settingGroupRenders(doc, "wildbuzzardAboutLinks");
    await TestUtils.waitForCondition(() =>
      doc.querySelector("#setting-control-wildbuzzardAboutSupport moz-box-link")
    );
    is(
      doc.querySelector("#setting-control-wildbuzzardAboutSupport moz-box-link")
        .href,
      "https://github.com/openresearchtools/WildBuzzard/issues",
      "Support points to the project issues"
    );
    is(
      doc.querySelector(
        "#setting-control-wildbuzzardAboutLicenses moz-box-link"
      ).href,
      "about:license",
      "Licences are available offline"
    );
    ok(
      !doc.getElementById("category-languages"),
      "Unsupported language and translation category is absent"
    );
    ok(
      !doc.querySelector("moz-page-nav-button[support-page]"),
      "No blank support navigation buttons"
    );
    const win = tab.linkedBrowser.contentWindow;
    win.gotoPref("paneEtp");
    await settingGroupRenders(doc, "etpAdvanced");
    ok(
      !doc.querySelector('setting-group[groupid="etpBanner"]'),
      "No protection artwork banner"
    );
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function both_english_spelling_dictionaries_are_bundled() {
  const checker = Cc["@mozilla.org/spellchecker/engine;1"].getService(
    Ci.mozISpellCheckingEngine
  );
  const dictionaries = checker.getDictionaryList();
  ok(
    dictionaries.includes("en-GB"),
    "UK English is installed with the browser"
  );
  ok(
    dictionaries.includes("en-US"),
    "US English is installed with the browser"
  );
  checker.dictionaries = ["en-GB"];
  ok(checker.check("colour"), "UK spelling works");
  checker.dictionaries = ["en-US"];
  ok(checker.check("color"), "US spelling works");
  ok(!checker.check("mispellledzz"), "The spell checker rejects misspellings");
});

add_task(async function stock_bookmark_migration_preserves_custom_bookmarks() {
  const { PlacesBrowserStartup } = ChromeUtils.importESModule(
    "moz-src:///browser/components/places/PlacesBrowserStartup.sys.mjs"
  );
  const stock = await PlacesUtils.bookmarks.insertTree({
    guid: PlacesUtils.bookmarks.menuGuid,
    children: [
      {
        title: "Mozilla Firefox",
        type: PlacesUtils.bookmarks.TYPE_FOLDER,
        children: [
          { url: "https://support.mozilla.org/products/firefox" },
          {
            url: "https://support.mozilla.org/kb/customize-firefox-controls-buttons-and-toolbars?utm_source=firefox-browser&utm_medium=default-bookmarks&utm_campaign=customize",
          },
          { url: "https://www.mozilla.org/contribute/" },
          { url: "https://www.mozilla.org/about/" },
        ],
      },
    ],
  });
  const custom = await PlacesUtils.bookmarks.insert({
    parentGuid: PlacesUtils.bookmarks.menuGuid,
    type: PlacesUtils.bookmarks.TYPE_FOLDER,
    title: "Mozilla Firefox",
  });
  await PlacesUtils.bookmarks.insert({
    parentGuid: custom.guid,
    title: "My bookmark",
    url: "https://example.com/",
  });
  await SpecialPowers.pushPrefEnv({
    set: [["browser.bookmarks.wildbuzzard.stockBookmarksRemoved", false]],
  });
  try {
    await PlacesBrowserStartup.removeStockFirefoxBookmarks();
    ok(
      !(await PlacesUtils.bookmarks.fetch(stock[0].guid)),
      "Untouched stock folder is removed"
    );
    ok(
      await PlacesUtils.bookmarks.fetch(custom.guid),
      "Customised folder is preserved"
    );
  } finally {
    await PlacesUtils.bookmarks.remove(custom.guid);
    if (await PlacesUtils.bookmarks.fetch(stock[0].guid)) {
      await PlacesUtils.bookmarks.remove(stock[0].guid);
    }
  }
});
