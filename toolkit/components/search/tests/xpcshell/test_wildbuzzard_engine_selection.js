/* SPDX-License-Identifier: AGPL-3.0-or-later */

add_task(async function excluded_engines_stay_out_of_configuration() {
  const configuration = SearchTestUtils.expandPartialConfig([
    { identifier: "duckduckgo" },
    { identifier: "google" },
    { identifier: "bing" },
    { identifier: "perplexity" },
    { identifier: "wikipedia" },
    { identifier: "wikipedia-de" },
    { globalDefault: "duckduckgo" },
  ]);
  const client = RemoteSettings(SearchUtils.SETTINGS_KEY);
  const stub = sinon.stub(client, "get").resolves(configuration);
  const selector = new SearchEngineSelector(() => {});
  try {
    for (const region of ["US", "DE"]) {
      const result = await selector.fetchEngineConfiguration({
        locale: "en-US",
        region,
      });
      Assert.deepEqual(
        result.engines.map(engine => engine.identifier),
        ["duckduckgo", "google"],
        "Only retained built-in engines are selectable"
      );
      Assert.equal(result.appDefaultEngineId, "duckduckgo");
    }
    selector._onConfigurationUpdated({ data: { current: configuration } });
    Assert.deepEqual(
      (
        await selector.fetchEngineConfiguration({ locale: "de", region: "DE" })
      ).engines.map(engine => engine.identifier),
      ["duckduckgo", "google"],
      "A configuration update cannot reintroduce removed engines"
    );
  } finally {
    selector.reset();
    stub.restore();
  }
});
