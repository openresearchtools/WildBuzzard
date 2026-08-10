/* SPDX-License-Identifier: AGPL-3.0-or-later */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  EngineURL: "moz-src:///toolkit/components/search/SearchEngine.sys.mjs",
  SearchService: "moz-src:///toolkit/components/search/SearchService.sys.mjs",
  SearchUtils: "moz-src:///toolkit/components/search/SearchUtils.sys.mjs",
});

const ENGINE_ID = "searxng";
const MIGRATION_PREF = "wildbuzzard.search.searxngMigrationVersion";
const MIGRATION_VERSION = 1;
let endpoint;
let observingReloads = false;

const reloadObserver = {
  observe(_subject, _topic, data) {
    if (data === "engines-reloaded" && endpoint) {
      synchronizeManagedSearXNGEngine(endpoint).catch(console.error);
    }
  },
};

export function managedSearXNGSearchTemplate(address, port) {
  if (address !== "127.0.0.1") {
    throw new TypeError("Managed SearXNG must use the IPv4 loopback address");
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new TypeError("Managed SearXNG port is invalid");
  }
  return `http://${address}:${port}/search`;
}

export async function synchronizeManagedSearXNGEngine({ address, port }) {
  const template = managedSearXNGSearchTemplate(address, port);
  endpoint = { address, port };
  await lazy.SearchService.init();
  if (!observingReloads) {
    Services.obs.addObserver(
      reloadObserver,
      lazy.SearchUtils.TOPIC_SEARCH_SERVICE
    );
    observingReloads = true;
  }
  const engine = lazy.SearchService.getEngineById(ENGINE_ID);
  if (!engine) {
    throw new Error("The application-provided SearXNG engine is unavailable");
  }

  const currentURL = engine.getURLOfType(lazy.SearchUtils.URL_TYPE.SEARCH);
  if (currentURL?.template !== template) {
    const searchURL = new lazy.EngineURL({
      type: lazy.SearchUtils.URL_TYPE.SEARCH,
      template,
    });
    searchURL.addParam("q", "{searchTerms}");
    engine._urls = engine._urls.filter(
      url => url.type !== lazy.SearchUtils.URL_TYPE.SEARCH
    );
    engine._urls.push(searchURL);
    lazy.SearchUtils.notifyAction(
      engine,
      lazy.SearchUtils.MODIFIED_TYPE.CHANGED
    );
  }

  if (Services.prefs.getIntPref(MIGRATION_PREF, 0) < MIGRATION_VERSION) {
    await lazy.SearchService.setDefault(
      engine,
      lazy.SearchService.CHANGE_REASON.CONFIG
    );
    if (
      Services.prefs.getBoolPref(
        `${lazy.SearchUtils.BROWSER_SEARCH_PREF}separatePrivateDefault`,
        false
      )
    ) {
      await lazy.SearchService.setDefaultPrivate(
        engine,
        lazy.SearchService.CHANGE_REASON.CONFIG
      );
    }
    Services.prefs.setIntPref(MIGRATION_PREF, MIGRATION_VERSION);
  }
  return engine;
}
