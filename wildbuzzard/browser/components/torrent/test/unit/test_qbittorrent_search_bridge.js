/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);

const { TorrentDiscoveryManager } = ChromeUtils.importESModule(
  "resource:///modules/TorrentDiscoveryManager.sys.mjs"
);
const { TorrentManager } = ChromeUtils.importESModule(
  "resource:///modules/TorrentManager.sys.mjs"
);
const { QBittorrentRuntime } = ChromeUtils.importESModule(
  "resource:///modules/QBittorrentRuntime.sys.mjs"
);
const {
  QBittorrentSearchBridge,
  QBittorrentSearchBridgeTestUtils,
} = ChromeUtils.importESModule(
  "resource:///modules/QBittorrentSearchBridge.sys.mjs"
);

const RESULT_A = "A".repeat(32);
const RESULT_B = "B".repeat(32);
const MAGNET =
  "magnet:?xt=urn:btih:0123456789012345678901234567890123456789";
const original = {};

function request(method, target, parameters) {
  return QBittorrentSearchBridge.maybeRequest({
    method,
    target,
    headers: parameters
      ? { "Content-Type": "application/x-www-form-urlencoded" }
      : {},
    body: new TextEncoder().encode(parameters?.toString() || ""),
  });
}

function json(result) {
  return JSON.parse(new TextDecoder().decode(result.body));
}

add_setup(function setup() {
  original.getSources = TorrentDiscoveryManager.getSources;
  original.search = TorrentDiscoveryManager.search;
  original.resolve = TorrentDiscoveryManager.resolve;
  original.runtimeRequest = QBittorrentRuntime.request;
  original.addMagnet = TorrentManager.addMagnet;
  registerCleanupFunction(() => {
    TorrentDiscoveryManager.getSources = original.getSources;
    TorrentDiscoveryManager.search = original.search;
    TorrentDiscoveryManager.resolve = original.resolve;
    QBittorrentRuntime.request = original.runtimeRequest;
    TorrentManager.addMagnet = original.addMagnet;
  });
});

add_task(function test_opaque_result_handles_and_rows() {
  const handle = QBittorrentSearchBridgeTestUtils.resultHandle(RESULT_A);
  Assert.equal(handle, `wildbuzzard-result:${RESULT_A}`);
  Assert.equal(
    QBittorrentSearchBridgeTestUtils.parseResultHandle(handle),
    RESULT_A
  );
  Assert.equal(
    QBittorrentSearchBridgeTestUtils.parseResultHandle(
      "magnet:?xt=urn:btih:secret"
    ),
    null
  );
  const row = QBittorrentSearchBridgeTestUtils.searchRow({
    resultId: RESULT_A,
    name: "Linux ISO",
    sizeBytes: 1024,
    seeders: 8,
    leechers: null,
    publishedAt: null,
  });
  Assert.equal(row.fileName, "Linux ISO");
  Assert.equal(row.nbSeeders, 8);
  Assert.equal(row.nbLeechers, -1);
  Assert.ok(!JSON.stringify(row).includes("tracker"));
});

add_task(async function test_search_results_stream_by_source_without_failures() {
  let releaseSecond;
  TorrentDiscoveryManager.getSources = async () => ({
    sources: [
      { id: "fast", state: "ready" },
      { id: "failed", state: "ready" },
      { id: "slow", state: "ready" },
      { id: "unavailable", state: "unavailable" },
    ],
  });
  TorrentDiscoveryManager.search = async ({ sourceIds, signal }) => {
    const source = sourceIds[0];
    if (source === "failed") {
      throw new Error("provider failed");
    }
    if (source === "slow") {
      await new Promise((resolve, reject) => {
        releaseSecond = resolve;
        signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    }
    return {
      results: [
        {
          resultId: source === "fast" ? RESULT_A : RESULT_B,
          name: `${source} Linux ISO`,
          sizeBytes: 1024,
          seeders: source === "fast" ? 10 : 5,
          leechers: 1,
          publishedAt: null,
        },
      ],
    };
  };

  const started = await request(
    "POST",
    "/api/v2/search/start",
    new URLSearchParams({
      pattern: "linux iso",
      category: "all",
      plugins: "enabled",
    })
  );
  const id = json(started).id;
  await TestUtils.waitForCondition(async () => {
    const value = json(
      await request("GET", `/api/v2/search/results?id=${id}&offset=0&limit=500`)
    );
    return value.results.length === 1 && value.status === "Running";
  });
  const progressive = json(
    await request("GET", `/api/v2/search/results?id=${id}&offset=0&limit=500`)
  );
  Assert.equal(progressive.results.length, 1);
  Assert.equal(progressive.results[0].fileName, "fast Linux ISO");
  Assert.ok(!JSON.stringify(progressive).includes("failed"));

  releaseSecond();
  await TestUtils.waitForCondition(async () => {
    const value = json(
      await request("GET", `/api/v2/search/results?id=${id}&offset=0&limit=500`)
    );
    return value.results.length === 2 && value.status === "Stopped";
  });
  const completed = json(
    await request("GET", `/api/v2/search/results?id=${id}&offset=0&limit=500`)
  );
  Assert.equal(completed.total, 2);
  await request(
    "POST",
    "/api/v2/search/delete",
    new URLSearchParams({ id })
  );
});

add_task(async function test_metadata_and_direct_add_resolve_opaque_results() {
  const runtimeCalls = [];
  const added = [];
  TorrentDiscoveryManager.resolve = async id => {
    Assert.equal(id, RESULT_A);
    return { kind: "magnet", magnet: MAGNET };
  };
  QBittorrentRuntime.request = async (target, options) => {
    runtimeCalls.push({ target, options });
    return {
      body: new TextEncoder().encode('{"id":"0123456789abcdef"}'),
      headers: new Map([["content-type", ["application/json"]]]),
      status: 202,
    };
  };
  TorrentManager.addMagnet = async (magnet, downloadPath) => {
    added.push({ magnet, downloadPath });
  };

  const source = `wildbuzzard-result:${RESULT_A}`;
  const metadata = await request(
    "POST",
    "/api/v2/torrents/fetchMetadata",
    new URLSearchParams({ source, downloader: "Jackett Mini" })
  );
  Assert.equal(metadata.status, 202);
  Assert.equal(runtimeCalls[0].target, "/api/v2/torrents/fetchMetadata");
  Assert.ok(
    new TextDecoder().decode(runtimeCalls[0].options.body).includes(
      encodeURIComponent(MAGNET)
    )
  );

  const add = await request(
    "POST",
    "/api/v2/torrents/add",
    new URLSearchParams({ urls: source })
  );
  Assert.equal(add.status, 200);
  Assert.equal(added.length, 1);
  Assert.equal(added[0].magnet, MAGNET);
});
