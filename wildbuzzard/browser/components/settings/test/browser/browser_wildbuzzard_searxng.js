/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const MIGRATION_PREF = "wildbuzzard.search.searxngMigrationVersion";

add_task(async function test_managed_searxng_dynamic_template_and_migration() {
  const tab = await openPrefsTab("search");
  const { synchronizeManagedSearXNGEngine } = ChromeUtils.importESModule(
    "chrome://browser/content/wildbuzzard/settings/wildbuzzardSearch.mjs"
  );
  const { SearchService } = ChromeUtils.importESModule(
    "moz-src:///toolkit/components/search/SearchService.sys.mjs"
  );
  await SearchService.init();

  const searxng = SearchService.getEngineById("searxng");
  const duckDuckGo = SearchService.getEngineById("ddg");
  ok(searxng, "SearXNG is application-provided");
  ok(duckDuckGo, "DuckDuckGo is application-provided");
  is(
    searxng.getSubmission("unavailable").uri.port,
    0,
    "The pre-start template cannot reach another loopback service"
  );
  Assert.deepEqual(
    (await SearchService.getAppProvidedEngines()).map(engine => engine.id),
    ["searxng", "ddg"],
    "Exactly two product engines are advertised"
  );

  const originalURLs = [...searxng._urls];
  const originalDefault = await SearchService.getDefault();
  const originalPrivateDefault = await SearchService.getDefaultPrivate();
  const custom = await SearchService.addUserEngine({
    name: "Preserved custom engine",
    url: "https://example.com/search?q={searchTerms}",
    alias: "preserved-custom",
  });
  registerCleanupFunction(async () => {
    searxng._urls = originalURLs;
    await SearchService.setDefault(
      originalDefault,
      SearchService.CHANGE_REASON.CONFIG
    );
    if (
      Services.prefs.getBoolPref("browser.search.separatePrivateDefault", false)
    ) {
      await SearchService.setDefaultPrivate(
        originalPrivateDefault,
        SearchService.CHANGE_REASON.CONFIG
      );
    }
    if (SearchService.getEngineById(custom.id)) {
      await SearchService.removeEngine(
        custom,
        SearchService.CHANGE_REASON.CONFIG
      );
    }
    Services.prefs.clearUserPref(MIGRATION_PREF);
    BrowserTestUtils.removeTab(tab);
  });

  await SearchService.setDefault(
    duckDuckGo,
    SearchService.CHANGE_REASON.CONFIG
  );
  Services.prefs.clearUserPref(MIGRATION_PREF);
  await synchronizeManagedSearXNGEngine({
    address: "127.0.0.1",
    port: 49152,
  });
  is(
    searxng.getSubmission("café 東京").uri.spec,
    "http://127.0.0.1:49152/search?q=caf%C3%A9+%E6%9D%B1%E4%BA%AC",
    "The managed engine uses the current loopback port"
  );
  is(await SearchService.getDefault(), searxng, "Migration selects SearXNG");
  ok(
    SearchService.getEngineById(custom.id),
    "Migration preserves a user-installed custom engine"
  );

  searxng._urls = [...originalURLs];
  Services.obs.notifyObservers(
    null,
    "browser-search-service",
    "engines-reloaded"
  );
  await TestUtils.waitForCondition(
    () => searxng.getSubmission("reload").uri.port === 49152,
    "The managed template is restored after SearchService reloads"
  );

  await SearchService.setDefault(duckDuckGo, SearchService.CHANGE_REASON.USER);
  await synchronizeManagedSearXNGEngine({
    address: "127.0.0.1",
    port: 49153,
  });
  is(
    searxng.getSubmission("port change").uri.spec,
    "http://127.0.0.1:49153/search?q=port+change",
    "A restart updates the ephemeral port"
  );
  is(
    await SearchService.getDefault(),
    duckDuckGo,
    "A later port change does not overwrite the user's default choice"
  );

  await Assert.rejects(
    synchronizeManagedSearXNGEngine({ address: "0.0.0.0", port: 49154 }),
    /IPv4 loopback/,
    "Non-loopback addresses are rejected"
  );
});
