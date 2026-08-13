/* SPDX-License-Identifier: AGPL-3.0-or-later */

"use strict";

const { BrowserControl } = ChromeUtils.importESModule(
  "chrome://remote/content/wildbuzzard/BrowserControl.sys.mjs"
);
const { SearchService } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/search/SearchService.sys.mjs"
);
const { SearXNGManager, SearXNGManagerTestUtils, searXNGManagerPaths } =
  ChromeUtils.importESModule("resource:///modules/SearXNGManager.sys.mjs");

const LocalFile = Components.Constructor(
  "@mozilla.org/file/local;1",
  "nsIFile",
  "initWithPath"
);
const ARTIFACT_ENV = "WILDBUZZARD_SEARXNG_TEST_EXECUTABLE";
const LIVE_SEARCH_ENV = "WILDBUZZARD_SEARXNG_LIVE_TEST";
const EXECUTABLE_PREF = "wildbuzzard.search.searxngExecutable";
const MIGRATION_PREF = "wildbuzzard.search.searxngMigrationVersion";

async function packagedArtifactPath() {
  const override = Services.env.get(ARTIFACT_ENV);
  const path =
    override ||
    PathUtils.join(
      Services.dirsvc.get("GreD", Ci.nsIFile).path,
      "runtime",
      "search",
      SearXNGManagerTestUtils.ARTIFACT_NAME
    );
  try {
    const artifact = new LocalFile(path);
    if (artifact.isFile() && !artifact.isSymlink()) {
      return path;
    }
  } catch {}
  return null;
}

function managerPaths() {
  return searXNGManagerPaths({
    profilePath: PathUtils.profileDir,
    dataHome: Services.env.get("XDG_DATA_HOME"),
    cacheHome: Services.env.get("XDG_CACHE_HOME"),
    runtimeHome: Services.env.get("XDG_RUNTIME_DIR"),
  });
}

async function removeManagerState(paths) {
  for (const path of [
    paths.stateDirectory,
    paths.cacheDirectory,
    paths.rootDirectory,
  ]) {
    await IOUtils.remove(path, { ignoreAbsent: true, recursive: true });
  }
}

async function assertSearchDocument(browser) {
  const details = await SpecialPowers.spawn(browser, [], async () => {
    await ContentTaskUtils.waitForCondition(
      () => content.document.documentElement.dataset.ready === "true",
      "The native SearXNG search page initialized"
    );
    const document = content.document;
    const leakedInternalURLs = [
      ...document.querySelectorAll("[href], [src], [action]"),
    ]
      .flatMap(node => [
        node.getAttribute("href"),
        node.getAttribute("src"),
        node.getAttribute("action"),
      ])
      .filter(value =>
        /^(?:https?:\/\/(?:127\.0\.0\.1|localhost|local)(?::|\/)|file:|unix:)/i.test(
          value ?? ""
        )
      );
    return {
      contentType: document.contentType,
      hasForm: !!document.querySelector("#search-form"),
      hasQuery: !!document.querySelector('#search-query[name="q"]'),
      leakedInternalURLs,
      location: content.location.href,
      styleRules: [...document.styleSheets].reduce(
        (count, sheet) => count + sheet.cssRules.length,
        0
      ),
      title: document.title,
    };
  });
  is(details.location, "about:searxng", "The internal search page loaded");
  is(
    details.contentType,
    "application/xhtml+xml",
    "The search page has an XHTML MIME type"
  );
  ok(details.title, "The document has a title");
  ok(details.hasForm, "The native SearXNG search form rendered");
  ok(details.hasQuery, "The native SearXNG query input rendered");
  Assert.greater(details.styleRules, 0, "Internal stylesheets were parsed");
  Assert.deepEqual(
    details.leakedInternalURLs,
    [],
    "The document exposes no loopback, filesystem, or socket URLs"
  );
}

async function runLiveNativeSearch() {
  const result = await BrowserControl.dispatch(
    "native_search",
    {
      query: "Mozilla Firefox browser",
      engines: ["github"],
      maxResults: 5,
    },
    PathUtils.profileDir,
    "searxng-integration-test",
    new AbortController().signal
  );
  is(result.details.schema, 1, "native_search returns the stable schema");
  is(
    result.details.implementation,
    "bundled-searxng",
    "native_search used the bundled implementation"
  );
  is(
    result.details.query,
    "Mozilla Firefox browser",
    "native_search preserves the query"
  );
  Assert.greater(
    result.details.results.length,
    0,
    "GitHub returned search results"
  );
  ok(
    result.details.results.every(item => /^https?:\/\//.test(item.url)),
    "Every normalized result has a web URL"
  );

  const controller = new AbortController();
  const pending = BrowserControl.dispatch(
    "native_search",
    { query: "Firefox cancellation integration" },
    PathUtils.profileDir,
    "searxng-integration-test",
    controller.signal
  );
  await TestUtils.waitForTick();
  controller.abort();
  await Assert.rejects(
    pending,
    /cancel|abort/i,
    "BrowserControl propagates cancellation to the native search request"
  );
  const status = await SearXNGManager.status();
  ok(status.running && status.healthy, "Cancellation leaves SearXNG healthy");
}

add_task(async function test_packaged_searxng_integration() {
  requestLongerTimeout(6);
  const artifactPath = await packagedArtifactPath();
  if (!artifactPath) {
    ok(
      true,
      `Skipped: set ${ARTIFACT_ENV} or install the bundled SearXNG executable`
    );
    return;
  }

  const paths = managerPaths();
  let pid = null;
  let tab = null;
  Services.prefs.setStringPref(EXECUTABLE_PREF, artifactPath);
  try {
    const ready = await SearXNGManager.initialize();
    pid = ready.pid;
    ok(ready.ready, "The real bundled SearXNG runtime initialized");
    is(ready.socket, "private", "The manager publishes only a private socket");
    is(
      ready.catalogSha256,
      "7d054c87f25e2925f71c1a12fdff6973ffc735e2cfff71df744d2d3b14d786f1",
      "The runtime uses the pinned engine catalog"
    );

    const connection = await IOUtils.stat(paths.connectionPath);
    const socket = await IOUtils.stat(paths.socketPath);
    is(connection.permissions & 0o777, 0o600, "Connection metadata is private");
    is(socket.permissions & 0o777, 0o600, "The Unix socket is private");

    await SearchService.init();
    const engine = SearchService.getEngineById("searxng");
    ok(engine, "SearchService exposes the managed SearXNG engine");
    const submission = engine.getSubmission("WildBuzzard integration");
    is(submission.uri.scheme, "about", "Search uses an internal page");
    is(
      submission.uri.pathQueryRef.split("?", 1)[0],
      "searxng",
      "Search uses the fixed internal route"
    );
    is(
      new URLSearchParams(submission.uri.query).get("q"),
      "WildBuzzard integration",
      "SearchService encoded the submitted query"
    );

    tab = await BrowserTestUtils.openNewForegroundTab(
      gBrowser,
      "about:searxng"
    );
    await assertSearchDocument(tab.linkedBrowser);

    if (Services.env.get(LIVE_SEARCH_ENV) === "1") {
      await runLiveNativeSearch();
    } else {
      ok(
        true,
        `Skipped live native_search: set ${LIVE_SEARCH_ENV}=1 to enable it`
      );
    }
  } finally {
    if (tab) {
      BrowserTestUtils.removeTab(tab);
    }
    await SearXNGManager.stop().catch(error =>
      info(`SearXNG cleanup stop failed: ${error}`)
    );
    Services.prefs.clearUserPref(EXECUTABLE_PREF);
    Services.prefs.clearUserPref(MIGRATION_PREF);
    if (pid) {
      await TestUtils.waitForCondition(
        async () => !(await IOUtils.exists(`/proc/${pid}`)),
        "The SearXNG process exited"
      );
    }
    ok(
      !(await IOUtils.exists(paths.connectionPath)),
      "The connection record was removed"
    );
    ok(!(await IOUtils.exists(paths.socketPath)), "The socket was removed");
    await removeManagerState(paths);
  }
});
