/* SPDX-License-Identifier: AGPL-3.0-or-later */

"use strict";

const { AddonTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/AddonTestUtils.sys.mjs"
);
const { SearchService } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/search/SearchService.sys.mjs"
);

const { UrlbarTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/UrlbarTestUtils.sys.mjs"
);

AddonTestUtils.initMochitest(this);
UrlbarTestUtils.init(this);

add_task(async function local_search_provider_lifecycle_and_urlbar() {
  await SearchService.init();
  const originalDefault = await SearchService.getDefault();
  const name = "Local plugin search";
  const extension = ExtensionTestUtils.loadExtension({
    useAddonManager: "temporary",
    manifest: {
      chrome_settings_overrides: {
        search_provider: {
          name,
          search_url: "results.html",
          search_url_get_params: "q={searchTerms}",
          is_default: false,
        },
      },
    },
    files: {
      "results.html":
        '<!doctype html><title>Search results</title><script src="results.js"></script>',
      "results.js": function () {
        browser.test.sendMessage(
          "query",
          new URL(location.href).searchParams.get("q")
        );
      },
    },
  });
  await extension.startup();
  await AddonTestUtils.waitForSearchProviderStartup(extension);
  const engine = SearchService.getEngineByName(name);
  ok(engine, "Enabled plugin is registered as a search engine");
  is(
    (await SearchService.getDefault()).name,
    originalDefault.name,
    "Enabling a plugin does not change the user's default"
  );
  const query = 'Ubuntu C++ & "Linux" β';
  const target = engine.getSubmission(query).uri;
  is(target.scheme, "moz-extension", "Search goes to the plugin's local UI");
  is(
    new URL(target.spec).searchParams.get("q"),
    query,
    "Query characters round-trip"
  );
  try {
    await BrowserTestUtils.withNewTab(
      { gBrowser, url: "about:blank" },
      async browser => {
        await UrlbarTestUtils.promiseAutocompleteResultPopup({
          window,
          waitForFocus,
          value: query,
        });
        await UrlbarTestUtils.activateSearchModeSwitcherItem(
          window,
          `panel-item[data-engine-id="${engine.id}"]`
        );
        const loaded = BrowserTestUtils.browserLoaded(
          browser,
          false,
          target.spec
        );
        EventUtils.synthesizeKey("KEY_Enter");
        await loaded;
        is(
          await extension.awaitMessage("query"),
          query,
          "Choosing the plugin in the address bar loads its query in its own page"
        );
      }
    );
    await SearchService.setDefault(engine, SearchService.CHANGE_REASON.UNKNOWN);
    await BrowserTestUtils.withNewTab(
      { gBrowser, url: "about:blank" },
      async browser => {
        await UrlbarTestUtils.promiseAutocompleteResultPopup({
          window,
          waitForFocus,
          value: query,
        });
        const loaded = BrowserTestUtils.browserLoaded(
          browser,
          false,
          target.spec
        );
        EventUtils.synthesizeKey("KEY_Enter");
        await loaded;
        is(
          await extension.awaitMessage("query"),
          query,
          "The plugin also works as the normal default search engine"
        );
      }
    );
    const addon = await AddonManager.getAddonByID(extension.id);
    await addon.disable();
    await TestUtils.waitForCondition(
      () => !SearchService.getEngineByName(name)
    );
    is(
      (await SearchService.getDefault()).name,
      originalDefault.name,
      "Disabling the selected plugin restores an available default"
    );
    await addon.enable();
    await AddonTestUtils.waitForSearchProviderStartup(extension);
    ok(
      SearchService.getEngineByName(name),
      "Re-enabling restores the search choice"
    );
  } finally {
    await SearchService.setDefault(
      originalDefault,
      SearchService.CHANGE_REASON.UNKNOWN
    );
    await extension.unload();
  }
  ok(
    !SearchService.getEngineByName(name),
    "Uninstalling removes the search choice"
  );
});

add_task(async function bundled_search_plugins_follow_enabled_state() {
  for (const [id, name] of [
    ["web-search@extensions.wildbuzzard", "Buzzard Web Search"],
    ["torrent-search@extensions.wildbuzzard", "Torrent Search"],
  ]) {
    const addon = await AddonManager.getAddonByID(id);
    ok(addon?.isBuiltin, "The plugin comes from the browser's bundled source");
    const wasDisabled = addon.userDisabled;
    try {
      await addon.enable();
      await TestUtils.waitForCondition(() =>
        SearchService.getEngineByName(name)
      );
      const engine = SearchService.getEngineByName(name);
      const base = WebExtensionPolicy.getByID(id).extension.baseURI.spec;
      ok(
        engine.getSubmission("Ubuntu").uri.spec.startsWith(base),
        "The built-in plugin searches its own extension page"
      );
      await addon.disable();
      await TestUtils.waitForCondition(
        () => !SearchService.getEngineByName(name)
      );
      ok(
        !SearchService.getEngineByName(name),
        "Disabled built-in is not a search choice"
      );
      await addon.enable();
      await TestUtils.waitForCondition(() =>
        SearchService.getEngineByName(name)
      );
      ok(
        SearchService.getEngineByName(name),
        "Enabled built-in returns to the search choices"
      );
    } finally {
      if (wasDisabled) {
        await addon.disable();
      }
    }
  }
});
