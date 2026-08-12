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

const ARTIFACT_ENV = "WILDBUZZARD_SEARXNG_TEST_EXECUTABLE";
const LIVE_SEARCH_ENV = "WILDBUZZARD_SEARXNG_LIVE_TEST";
const EXECUTABLE_PREF = "wildbuzzard.search.searxngExecutable";

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
    const stat = await IOUtils.stat(path);
    if (stat.type === "regular") {
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
      () => content.document.documentElement.classList.contains("js"),
      "SearXNG JavaScript initialized the document"
    );
    const document = content.document;
    const styles = [...document.styleSheets]
      .map(sheet => sheet.href)
      .filter(href => href?.startsWith("moz-searxng://local/static/"));
    const scripts = [...document.scripts]
      .map(script => script.src)
      .filter(src => src.startsWith("moz-searxng://local/static/"));
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
      hasForm: !!document.querySelector('form[action="/search"]'),
      hasQuery: !!document.querySelector('input[name="q"]'),
      leakedInternalURLs,
      location: content.location.href,
      scriptCount: scripts.length,
      styleCount: styles.length,
      styleRules: [...document.styleSheets]
        .filter(sheet => styles.includes(sheet.href))
        .reduce((count, sheet) => count + sheet.cssRules.length, 0),
      title: document.title,
    };
  });
  is(details.location, "moz-searxng://local/", "The internal document loaded");
  is(details.contentType, "text/html", "The document has an HTML MIME type");
  ok(details.title, "The document has a title");
  ok(details.hasForm, "The real SearXNG search form rendered");
  ok(details.hasQuery, "The real SearXNG query input rendered");
  Assert.greater(details.styleCount, 0, "Internal stylesheets loaded");
  Assert.greater(details.styleRules, 0, "Internal stylesheets were parsed");
  Assert.greater(details.scriptCount, 0, "Internal scripts loaded");
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
      query: "Firefox web browser",
      engines: ["wikipedia"],
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
    "Firefox web browser",
    "native_search preserves the query"
  );
  Assert.greater(
    result.details.results.length,
    0,
    "Wikipedia returned search results"
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
    is(submission.uri.scheme, "moz-searxng", "Search uses the internal scheme");
    is(submission.uri.host, "local", "Search uses the fixed internal host");
    is(submission.uri.filePath, "/search", "Search uses the internal route");
    is(
      new URLSearchParams(submission.uri.query).get("q"),
      "WildBuzzard integration",
      "SearchService encoded the submitted query"
    );

    tab = await BrowserTestUtils.openNewForegroundTab(
      gBrowser,
      "moz-searxng://local/"
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
