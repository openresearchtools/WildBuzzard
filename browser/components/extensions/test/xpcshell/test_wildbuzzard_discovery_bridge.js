/* SPDX-License-Identifier: AGPL-3.0-or-later */

"use strict";

const { AddonManager } = ChromeUtils.importESModule(
  "resource://gre/modules/AddonManager.sys.mjs"
);
const { WildBuzzardDiscoveryBridgeTestUtils: Bridge } =
  ChromeUtils.importESModule(
    "resource:///modules/WildBuzzardDiscoveryBridge.sys.mjs"
  );

const WEB_OWNER = "web-search@extensions.wildbuzzard";
const TORRENT_OWNER = "torrent-search@extensions.wildbuzzard";
const OPERATION_ID = "0cc29e8e-e9ca-4887-b3c2-ee68a8a8ba63";

add_setup(function setup() {
  Bridge.resetTokens();
});

add_task(function test_exact_extension_owners() {
  Assert.ok(Bridge.isAuthorizedDiscoveryContext("web", WEB_OWNER, false));
  Assert.ok(
    Bridge.isAuthorizedDiscoveryContext("torrent", TORRENT_OWNER, false)
  );
  Assert.ok(!Bridge.isAuthorizedDiscoveryContext("web", TORRENT_OWNER, false));
  Assert.ok(
    !Bridge.isAuthorizedDiscoveryContext(
      "torrent",
      "lookalike@example.com",
      false
    )
  );
  Assert.ok(!Bridge.isAuthorizedDiscoveryContext("web", WEB_OWNER, true));
  Assert.ok(
    !Bridge.isAuthorizedDiscoveryContext("torrent", TORRENT_OWNER, true)
  );

  const signed = owner => ({
    id: owner,
    manifest: { incognito: "not_allowed" },
    temporarilyInstalled: false,
    addonData: { signedState: AddonManager.SIGNEDSTATE_SIGNED },
  });
  Assert.ok(
    Bridge.isAuthorizedDiscoveryExtension("web", signed(WEB_OWNER), false)
  );
  Assert.ok(
    Bridge.isAuthorizedDiscoveryExtension(
      "web",
      {
        ...signed(WEB_OWNER),
        addonData: {
          builtIn: true,
          signedState: AddonManager.SIGNEDSTATE_NOT_REQUIRED,
        },
      },
      false
    )
  );
  Assert.ok(
    !Bridge.isAuthorizedDiscoveryExtension(
      "web",
      { ...signed(WEB_OWNER), temporarilyInstalled: true },
      false
    )
  );
  Assert.ok(
    !Bridge.isAuthorizedDiscoveryExtension(
      "web",
      {
        ...signed(WEB_OWNER),
        manifest: { incognito: "spanning" },
      },
      false
    )
  );
  Assert.ok(
    !Bridge.isAuthorizedDiscoveryExtension(
      "web",
      {
        ...signed(WEB_OWNER),
        addonData: { signedState: AddonManager.SIGNEDSTATE_MISSING },
      },
      false
    )
  );
  Assert.ok(
    !Bridge.isAuthorizedDiscoveryExtension(
      "web",
      {
        ...signed(WEB_OWNER),
        addonData: {
          isSystem: true,
          signedState: AddonManager.SIGNEDSTATE_NOT_REQUIRED,
        },
      },
      false
    )
  );
});

add_task(function test_web_request_mapping_and_response_stripping() {
  const normalized = Bridge.normalizeWebSearchRequest({
    schema: 1,
    requestId: OPERATION_ID,
    query: "  browser isolation  ",
    provider: "searxng",
    maxResults: 10,
    timeoutSeconds: 30,
    page: 2,
    safeSearch: 1,
    language: "en-US",
    searxngUrl: "https://search.example.org/",
    engines: ["general", "wikipedia"],
  });
  Assert.deepEqual(normalized.request, {
    schema: 1,
    requestId: OPERATION_ID,
    query: "browser isolation",
    provider: "searxng",
    maxResults: 10,
  });
  Assert.deepEqual(normalized.args, ["call", "web_search", "-"]);
  Assert.deepEqual(normalized.input, {
    schemaVersion: 1,
    query: "browser isolation",
    provider: "searxng",
    maxResults: 10,
    timeoutSeconds: 30,
    page: 2,
    safeSearch: 1,
    searxngUrl: "https://search.example.org/",
    engines: ["general", "wikipedia"],
    language: "en-US",
  });

  const response = Bridge.sanitizeWebSearch(
    {
      schemaVersion: 1,
      ok: true,
      provider: "searxng",
      query: "browser isolation",
      results: [
        {
          title: "safe\u202E<script>not executable</script>",
          url: "https://example.org/result",
          snippet: "display-only text",
          provider: "searxng",
          engines: ["general"],
        },
      ],
    },
    normalized.request
  );
  Assert.equal(response.requestId, OPERATION_ID);
  Assert.equal(
    response.results[0].title,
    "safe <script>not executable</script>"
  );
  Assert.equal(response.results[0].url, "https://example.org/result");
});

add_task(function test_web_rejects_unsafe_urls_and_non_protocol_fields() {
  const request = {
    schema: 1,
    requestId: OPERATION_ID,
    query: "example",
    provider: "ddgs",
    maxResults: 1,
  };
  Assert.throws(
    () =>
      Bridge.sanitizeWebSearch(
        {
          schemaVersion: 1,
          ok: true,
          provider: "ddgs",
          query: "example",
          results: [
            {
              title: "unsafe",
              url: "javascript:alert(1)",
              snippet: "",
              provider: "ddgs",
            },
          ],
        },
        request
      ),
    /\[buzzard-search\/invalid_output\]/
  );
  Assert.throws(
    () =>
      Bridge.sanitizeWebSearch(
        {
          schemaVersion: 1,
          ok: true,
          provider: "ddgs",
          query: "example",
          results: [],
          metadata: { search: { failure: "provider detail" } },
        },
        request
      ),
    /\[buzzard-search\/invalid_output\]/
  );
});

add_task(function test_torrent_cli_v1_is_reduced_to_public_contract() {
  Assert.ok(
    Bridge.isTorrentVersion({
      package: "buzzard-minijtt",
      version: "1.0.0",
      protocolVersion: 1,
      schemaVersion: 1,
    })
  );
  Assert.ok(
    !Bridge.isTorrentVersion({
      package: "buzzard-minijtt",
      version: "1.0.0",
      protocolVersion: 1,
      schemaVersion: 1,
      unexpected: true,
    })
  );
  Assert.ok(
    !Bridge.isTorrentVersion({
      package: "buzzard-torrent-search",
      version: "1.0.0",
      protocolVersion: 1,
      schemaVersion: 1,
    })
  );
  const request = Bridge.normalizeTorrentSearchRequest({
    schemaVersion: 1,
    operationId: OPERATION_ID,
    query: "  linux iso  ",
    source: "source.one",
    limit: 25,
  });
  Assert.deepEqual(request.body, {
    schemaVersion: 1,
    query: "linux iso",
    limit: 25,
    source: "source.one",
  });
  const allSourcesRequest = Bridge.normalizeTorrentSearchRequest({
    schemaVersion: 1,
    operationId: OPERATION_ID,
    query: "linux iso",
    source: null,
    limit: 25,
  });
  Assert.deepEqual(allSourcesRequest.body, {
    schemaVersion: 1,
    query: "linux iso",
    limit: 25,
  });
  Assert.equal(allSourcesRequest.source, undefined);
  Assert.deepEqual(
    Bridge.sanitizeTorrentSources({
      schemaVersion: 1,
      ok: true,
      sources: [{ id: "source.one", name: "Source One" }],
    }),
    {
      schemaVersion: 1,
      sources: [{ id: "source.one", name: "Source One" }],
    }
  );

  const response = Bridge.sanitizeTorrentSearch(
    {
      schemaVersion: 1,
      ok: true,
      query: "linux iso",
      truncated: false,
      results: [
        {
          resultId: "B".repeat(32),
          sourceId: "source.one",
          sourceName: "Source One",
          title: "Linux ISO",
          sizeBytes: 1024,
          seeders: 7,
          leechers: 1,
          publishedAt: null,
        },
      ],
    },
    request,
    TORRENT_OWNER
  );
  Assert.equal(response.schemaVersion, 1);
  Assert.equal(response.operationId, OPERATION_ID);
  Assert.equal(response.results.length, 1);
  Assert.ok(
    /^v1_[A-Za-z0-9_-]{43}$/.test(response.results[0].resultToken),
    "result token has the versioned opaque format"
  );
  Assert.equal(response.results[0].title, "Linux ISO");
  Assert.ok(!Object.hasOwn(response.results[0], "resultId"));
  Assert.ok(!Object.hasOwn(response.results[0], "sourceId"));
});

add_task(function test_resolved_payload_never_needs_extension_exposure() {
  const magnet = "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567";
  Assert.deepEqual(
    Bridge.sanitizeResolved(
      {
        schemaVersion: 1,
        ok: true,
        name: "Linux ISO",
        sourceName: "Source One",
        sizeBytes: 1024,
        payload: { kind: "magnet", value: magnet },
      },
      { sourceName: "Source One" }
    ),
    {
      resolved: { kind: "magnet", magnet },
      name: "Linux ISO",
      sourceName: "Source One",
      sizeBytes: 1024,
    }
  );
  Assert.throws(
    () =>
      Bridge.sanitizeResolved(
        {
          schemaVersion: 1,
          ok: true,
          name: "Linux ISO",
          sourceName: "Different Source",
          sizeBytes: 1024,
          payload: { kind: "magnet", value: magnet },
        },
        { sourceName: "Source One" }
      ),
    /torrentSearch\.CLI_PROTOCOL_ERROR/
  );
  for (const invalid of [
    `${magnet}#fragment`,
    `${magnet}&dn=Linux%00ISO`,
    `${magnet}&dn=Linux%zzISO`,
    `magnet:?xt=urn:btih:${"0".repeat(39)}`,
  ]) {
    Assert.throws(
      () =>
        Bridge.sanitizeResolved(
          {
            schemaVersion: 1,
            ok: true,
            name: "Linux ISO",
            sourceName: "Source One",
            sizeBytes: 1024,
            payload: { kind: "magnet", value: invalid },
          },
          { sourceName: "Source One" }
        ),
      /torrentSearch\.TORRENT_INVALID/
    );
  }

  const torrent = Bridge.sanitizeResolved(
    {
      schemaVersion: 1,
      ok: true,
      name: "Linux ISO",
      sourceName: "Source One",
      sizeBytes: 10,
      payload: { kind: "torrent", dataBase64: "ZDQ6aW5mb2RlZQ==" },
    },
    { sourceName: "Source One" }
  );
  Assert.equal(torrent.resolved.kind, "torrent");
  Assert.deepEqual(
    Array.from(torrent.resolved.torrent),
    Array.from(new TextEncoder().encode("d4:infodee"))
  );
});

add_task(function test_torrent_cli_error_envelopes_are_sanitized() {
  Assert.throws(
    () =>
      Bridge.sanitizeTorrentSources({
        schemaVersion: 1,
        ok: false,
        error: { code: "TIMEOUT", message: "provider details" },
      }),
    /torrentSearch\.CLI_TIMEOUT/
  );
  Assert.throws(
    () =>
      Bridge.sanitizeTorrentSources({
        schemaVersion: 1,
        ok: false,
        error: { code: "PROTOCOL_ERROR", message: "parser details" },
      }),
    /torrentSearch\.CLI_PROTOCOL_ERROR/
  );
  Assert.throws(
    () =>
      Bridge.sanitizeTorrentSources({
        schemaVersion: 1,
        ok: true,
        sources: [],
        unexpected: "not allowed",
      }),
    /torrentSearch\.CLI_PROTOCOL_ERROR/
  );
});
