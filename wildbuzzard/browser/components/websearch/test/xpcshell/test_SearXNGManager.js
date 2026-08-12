/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const {
  normalizeNativeSearchResponse,
  searXNGManagerPaths,
  validateNativeSearchRequest,
} = ChromeUtils.importESModule("resource:///modules/SearXNGManager.sys.mjs");
const { managedSearXNGSearchTemplate } = ChromeUtils.importESModule(
  "resource:///modules/ManagedSearXNGEngine.sys.mjs"
);
const { EngineURL, isWildBuzzardInternalSearchTemplate } =
  ChromeUtils.importESModule(
    "moz-src:///toolkit/components/search/SearchEngine.sys.mjs"
  );
const { SearchUtils } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/search/SearchUtils.sys.mjs"
);

add_setup(function setup() {
  do_get_profile();
});

add_task(function test_profile_paths_are_private_and_bounded() {
  const profile = do_get_profile();
  const paths = searXNGManagerPaths({
    profilePath: profile.path,
    dataHome: "/tmp/wildbuzzard-test-data",
    cacheHome: "/tmp/wildbuzzard-test-cache",
    runtimeHome: "/tmp",
  });
  Assert.equal(paths.stateDirectory, `/tmp/wb-sx-${paths.profileKey}`);
  Assert.less(new TextEncoder().encode(paths.socketPath).length, 108);
  Assert.equal(paths.connectionPath, `${paths.stateDirectory}/connection.json`);
});

add_task(function test_search_submission_uses_stable_internal_route() {
  const template = managedSearXNGSearchTemplate();
  Assert.equal(template, "moz-searxng://local/search");
  Assert.ok(
    isWildBuzzardInternalSearchTemplate(
      SearchUtils.URL_TYPE.SEARCH,
      template,
      "WildBuzzard"
    )
  );
  Assert.ok(
    !isWildBuzzardInternalSearchTemplate(
      SearchUtils.URL_TYPE.SEARCH,
      template,
      "Firefox"
    ),
    "A non-WildBuzzard build rejects the internal scheme"
  );
  const url = new EngineURL({
    type: SearchUtils.URL_TYPE.SEARCH,
    template,
  });
  url.addParam("q", "{searchTerms}");
  Assert.equal(
    url.getSubmission("café", "UTF-8").uri.spec,
    "moz-searxng://local/search?q=caf%C3%A9"
  );
  Assert.throws(
    () =>
      new EngineURL({
        type: SearchUtils.URL_TYPE.SEARCH,
        template: "moz-searxng://other/search",
      }),
    /invalid internal search URI/
  );
});

add_task(function test_native_search_request_boundary() {
  const request = validateNativeSearchRequest({
    query: "WildBuzzard café",
    engines: ["github", "wikipedia"],
    language: "en-GB",
    page: 10,
    timeRange: "year",
    safeSearch: 1,
    maxResults: 100,
  });
  Assert.equal(request.engines.length, 2);
  for (const invalid of [
    {},
    { query: "x", safeSearch: 0 },
    { query: "x", engines: ["github", "github"] },
    { query: "x", page: 11 },
    { query: "x", extra: true },
  ]) {
    Assert.throws(() => validateNativeSearchRequest(invalid), /native_search/);
  }
});

add_task(function test_native_response_normalization_and_diagnostics() {
  const request = {
    query: "firefox",
    engines: ["github", "wikipedia"],
    maxResults: 1,
  };
  const response = normalizeNativeSearchResponse(
    {
      query: "firefox",
      results: [
        {
          url: "https://example.com/",
          title: "Example",
          content: "Snippet",
          engines: ["github"],
          score: 1,
          publishedDate: "2026-08-12",
          ignored: true,
        },
        { url: "https://second.example/" },
      ],
      answers: [{ answer: "typed" }],
      corrections: ["fire fox"],
      suggestions: ["Firefox"],
      infoboxes: [{ infobox: "Firefox" }],
      unresponsive_engines: [["wikipedia", "timeout"]],
    },
    request,
    {
      attemptedEngines: request.engines,
      catalogSha256: "a".repeat(64),
    }
  );
  Assert.equal(response.schema, 1);
  Assert.equal(response.results.length, 1);
  Assert.deepEqual(response.diagnostics.attemptedEngines, [
    "github",
    "wikipedia",
  ]);
  Assert.deepEqual(response.diagnostics.completedEngines, ["github"]);
  Assert.equal(response.diagnostics.totalEntries, 343);
  Assert.equal(response.diagnostics.eligibleEntries, 332);
  Assert.equal(response.diagnostics.totalModules, 222);
  Assert.equal(response.diagnostics.eligibleModules, 211);
});
