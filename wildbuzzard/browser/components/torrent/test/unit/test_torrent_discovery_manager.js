/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

ChromeUtils.defineESModuleGetters(this, {
  HttpServer: "resource://testing-common/httpd.sys.mjs",
  NetUtil: "resource://gre/modules/NetUtil.sys.mjs",
  TestUtils: "resource://testing-common/TestUtils.sys.mjs",
  TorrentDiscoveryManager:
    "resource:///modules/TorrentDiscoveryManager.sys.mjs",
});

const CAPABILITY = "A".repeat(43);
const RESULT_ID = "R".repeat(32);
let connectionPath;
let originalConnection;
let searchMode = "valid";
let server;

function sendJson(request, response, body, status = 200) {
  const encoded = JSON.stringify(body);
  response.setStatusLine(request.httpVersion, status, "OK");
  response.setHeader("Content-Type", "application/json", false);
  response.setHeader("Content-Length", String(encoded.length), false);
  response.bodyOutputStream.write(encoded, encoded.length);
}

function assertRequest(request) {
  Assert.equal(
    request.getHeader("Authorization"),
    `Bearer ${CAPABILITY}`,
    "The capability is sent only in the authorization header"
  );
  Assert.ok(!request.hasHeader("Origin"), "No web origin is sent");
}

add_setup(async function setup() {
  do_get_profile();
  server = new HttpServer();
  server.registerPathHandler("/v1/health", (request, response) => {
    assertRequest(request);
    sendJson(request, response, { status: "ok" });
  });
  server.registerPathHandler("/v1/sources", (request, response) => {
    assertRequest(request);
    sendJson(request, response, {
      immutable: true,
      sources: [
        {
          id: "linuxtracker",
          name: "Linux\u0000Tracker",
          state: "ready",
          access: "public",
          contentClass: "general",
          reasons: ["credential-free"],
        },
      ],
    });
  });
  server.registerPathHandler("/v1/search", (request, response) => {
    assertRequest(request);
    if (searchMode === "delayed") {
      response.processAsync();
      do_timeout(5000, () => {
        try {
          sendJson(request, response, { error: "late" });
          response.finish();
        } catch {}
      });
      return;
    }
    const body = JSON.parse(
      NetUtil.readInputStreamToString(
        request.bodyInputStream,
        request.bodyInputStream.available()
      )
    );
    Assert.deepEqual(
      body,
      { query: "linux iso", limit: 200 },
      "The product request contains no upstream credentials or mutation fields"
    );
    sendJson(request, response, {
      searchId: "S".repeat(32),
      partial: true,
      providers: [{ id: "linuxtracker", state: "ok", elapsedMs: 2 }],
      results: [
        {
          resultId: RESULT_ID,
          providerId: "linuxtracker",
          providerName: "Linux Tracker",
          name: "Linux\u0007 ISO",
          sizeBytes: 1024,
          seeders: 10,
          leechers: null,
          publishedAt: "2026-08-10T00:00:00Z",
          categoryIds: searchMode === "adult" ? [6000] : [8000],
          access: "public",
          acquisition: "magnet",
        },
      ],
    });
  });
  server.registerPathHandler(
    `/v1/results/${RESULT_ID}/resolve`,
    (request, response) => {
      assertRequest(request);
      sendJson(request, response, {
        kind: "magnet",
        magnet: "magnet:?xt=urn:btih:0123456789012345678901234567890123456789",
        torrentBase64: null,
        torrentBytes: null,
      });
    }
  );
  server.start(-1);
  connectionPath = PathUtils.join(PathUtils.profileDir, "jackett.json");
  await IOUtils.writeJSON(connectionPath, {
    address: "127.0.0.1",
    port: server.identity.primaryPort,
    capability: CAPABILITY,
  });
  originalConnection = Services.env.get("WILDBUZZARD_JACKETT_MINI_CONNECTION");
  Services.env.set("WILDBUZZARD_JACKETT_MINI_CONNECTION", connectionPath);
  registerCleanupFunction(async () => {
    TorrentDiscoveryManager.cancelSearch();
    TorrentDiscoveryManager.connection = null;
    Services.env.set("WILDBUZZARD_JACKETT_MINI_CONNECTION", originalConnection);
    await new Promise(resolve => server.stop(resolve));
  });
});

add_task(async function test_bounded_sanitized_product_contract() {
  const sources = await TorrentDiscoveryManager.getSources();
  Assert.equal(sources.sources[0].name, "LinuxTracker");

  const result = await TorrentDiscoveryManager.search({ query: "linux iso" });
  Assert.equal(result.partial, true);
  Assert.equal(result.results[0].name, "Linux ISO");
  Assert.equal(result.results[0].leechers, null);
  Assert.deepEqual(result.results[0].categoryIds, [8000]);

  const resolution = await TorrentDiscoveryManager.resolve(RESULT_ID);
  Assert.equal(resolution.kind, "magnet");
  Assert.ok(!("capability" in result), "The capability never enters results");
});

add_task(async function test_adult_category_fails_closed() {
  searchMode = "adult";
  await Assert.rejects(
    TorrentDiscoveryManager.search({ query: "linux iso" }),
    /invalid response/,
    "An adult-category result invalidates the response"
  );
  searchMode = "valid";
});

add_task(async function test_search_cancellation_aborts_transport() {
  searchMode = "delayed";
  const pending = TorrentDiscoveryManager.search({ query: "linux iso" });
  await TestUtils.waitForCondition(
    () => TorrentDiscoveryManager.activeRequest,
    "The search request reached the local service"
  );
  TorrentDiscoveryManager.cancelSearch();
  await Assert.rejects(
    pending,
    error => error.cancelled,
    "Cancelling a generation aborts the local request"
  );
  searchMode = "valid";
});

add_task(async function test_private_search_is_explicitly_disabled() {
  await Assert.rejects(
    TorrentDiscoveryManager.search({ query: "linux iso", isPrivate: true }),
    /disabled in private windows/,
    "Private windows cannot reuse ordinary discovery state"
  );
});
