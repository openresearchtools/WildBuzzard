/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const test = new SearchConfigTest([
  {
    identifier: "searxng",
    aliases: ["@searxng", "@sx"],
    default: {
      included: [{}],
    },
    available: {
      excluded: [],
    },
    noSuggestionsURL: true,
    details: [
      {
        included: [{}],
        domain: "127.0.0.1",
        telemetryId: "searxng",
        partnerCode: "",
      },
    ],
  },
  {
    identifier: "ddg",
    aliases: ["@duckduckgo", "@ddg"],
    default: {},
    available: {
      excluded: [],
    },
    noSuggestionsURL: true,
    details: [
      {
        included: [{}],
        domain: "duckduckgo.com",
        telemetryId: "ddg",
        partnerCode: "",
      },
    ],
  },
]);

add_setup(async function () {
  await test.setup();
});

add_task(async function test_searchConfigs() {
  await test.run();
});

add_task(async function test_only_wildbuzzard_engines_are_advertised() {
  const selector = new SearchEngineSelector();
  const { engines, appDefaultEngineId } = await getEngines(
    selector,
    "us",
    "en-US"
  );
  Assert.deepEqual(
    engines.map(engine => engine.id),
    ["searxng", "ddg"],
    "Only SearXNG and DuckDuckGo should be application-provided"
  );
  Assert.equal(
    appDefaultEngineId,
    "searxng",
    "SearXNG should be the application default"
  );
});
