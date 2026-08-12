/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const MIGRATION_PREF = "wildbuzzard.search.searxngMigrationVersion";

add_task(async function test_managed_searxng_dynamic_template_and_migration() {
  const { managedSearXNGSearchTemplate, synchronizeManagedSearXNGEngine } =
    ChromeUtils.importESModule(
      "resource:///modules/ManagedSearXNGEngine.sys.mjs"
    );
  const { SearchUtils } = ChromeUtils.importESModule(
    "moz-src:///toolkit/components/search/SearchUtils.sys.mjs"
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
    searxng.getSubmission("unavailable").uri.scheme,
    "https",
    "The pre-start template is valid in shared Firefox search data"
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
  });

  await SearchService.setDefault(
    duckDuckGo,
    SearchService.CHANGE_REASON.CONFIG
  );
  Services.prefs.clearUserPref(MIGRATION_PREF);
  await synchronizeManagedSearXNGEngine();
  is(
    managedSearXNGSearchTemplate(),
    "about:searxng",
    "The managed engine uses the internal search page"
  );
  is(
    searxng.getSubmission("café 東京").uri.spec,
    "about:searxng?q=caf%C3%A9+%E6%9D%B1%E4%BA%AC",
    "The managed engine never exposes a loopback port"
  );
  is(
    Services.uriFixup.keywordToURI("café 東京", false).preferredURI.spec,
    "about:searxng?q=caf%C3%A9+%E6%9D%B1%E4%BA%AC",
    "Address-bar searches accept only the product's internal engine URI"
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
    () => searxng.getSubmission("reload").uri.spec === "about:searxng?q=reload",
    "The managed template is restored after SearchService reloads"
  );

  await SearchService.setDefault(duckDuckGo, SearchService.CHANGE_REASON.USER);
  await synchronizeManagedSearXNGEngine();
  is(
    searxng.getSubmission("port change").uri.spec,
    "about:searxng?q=port+change",
    "A restart retains the internal search page"
  );
  is(
    await SearchService.getDefault(),
    duckDuckGo,
    "A later port change does not overwrite the user's default choice"
  );

  is(
    searxng.getURLOfType(SearchUtils.URL_TYPE.SEARCH).template,
    "about:searxng",
    "The application engine cannot be redirected to a TCP endpoint"
  );
});
