/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

ChromeUtils.defineESModuleGetters(this, {
  TestUtils: "resource://testing-common/TestUtils.sys.mjs",
  TorrentDiscoveryManager:
    "resource:///modules/TorrentDiscoveryManager.sys.mjs",
});

const RESULT_ID = "R".repeat(32);
let modePath;
let originalCommand;
let originalMode;

add_setup(async function setup() {
  do_get_profile();
  const commandPath = PathUtils.join(PathUtils.profileDir, "torrent-search");
  modePath = PathUtils.join(PathUtils.profileDir, "torrent-search-mode");
  const command = `#!/bin/sh
set -eu
mode=$(cat "$WILDBUZZARD_TORRENT_TEST_MODE" 2>/dev/null || printf valid)
case "$2" in
  torrent_sources)
    printf '%s\\n' '{"immutable":true,"sources":[{"id":"linuxtracker","name":"Linux\\u0000Tracker","state":"ready","access":"public","contentClass":"general","reasons":["credential-free"]}]}'
    ;;
  torrent_search)
    [ "$mode" = delayed ] && exec sleep 5
    category=8000
    [ "$mode" = adult ] && category=6000
    printf '{"searchId":"SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS","partial":true,"providers":[{"id":"linuxtracker","state":"ok","elapsedMs":2}],"results":[{"resultId":"${RESULT_ID}","providerId":"linuxtracker","providerName":"Linux Tracker","name":"Linux\\u0007 ISO","sizeBytes":1024,"seeders":10,"leechers":null,"publishedAt":"2026-08-10T00:00:00Z","categoryIds":[%s],"access":"public","acquisition":"magnet"}]}\\n' "$category"
    ;;
  torrent_resolve)
    printf '%s\\n' '{"kind":"magnet","magnet":"magnet:?xt=urn:btih:0123456789012345678901234567890123456789","torrentBase64":null,"torrentBytes":null}'
    ;;
  *) exit 2 ;;
esac
`;
  await IOUtils.writeUTF8(commandPath, command);
  await IOUtils.setPermissions(commandPath, 0o700);
  await IOUtils.writeUTF8(modePath, "valid");
  originalCommand = Services.prefs.getStringPref(
    "wildbuzzard.torrent.searchCommand",
    ""
  );
  originalMode = Services.env.get("WILDBUZZARD_TORRENT_TEST_MODE");
  Services.prefs.setStringPref(
    "wildbuzzard.torrent.searchCommand",
    commandPath
  );
  Services.env.set("WILDBUZZARD_TORRENT_TEST_MODE", modePath);
  registerCleanupFunction(() => {
    TorrentDiscoveryManager.cancelSearch();
    Services.prefs.setStringPref(
      "wildbuzzard.torrent.searchCommand",
      originalCommand
    );
    Services.env.set("WILDBUZZARD_TORRENT_TEST_MODE", originalMode);
  });
});

async function setMode(value) {
  await IOUtils.writeUTF8(modePath, value, { mode: "overwrite" });
}

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
  Assert.ok(!("capability" in result));
});

add_task(async function test_eligible_provider_categories_are_preserved() {
  await setMode("adult");
  const result = await TorrentDiscoveryManager.search({ query: "linux iso" });
  Assert.deepEqual(result.results[0].categoryIds, [6000]);
  await setMode("valid");
});

add_task(async function test_search_cancellation_aborts_package_command() {
  await setMode("delayed");
  const pending = TorrentDiscoveryManager.search({ query: "linux iso" });
  await TestUtils.waitForCondition(
    () => TorrentDiscoveryManager.activeProcesses?.size === 1
  );
  TorrentDiscoveryManager.cancelSearch();
  await Assert.rejects(pending, error => error.cancelled);
  await setMode("valid");
});

add_task(async function test_private_search_fails_closed() {
  await Assert.rejects(
    TorrentDiscoveryManager.search({ query: "linux iso", isPrivate: true }),
    /disabled in private windows/
  );
});
