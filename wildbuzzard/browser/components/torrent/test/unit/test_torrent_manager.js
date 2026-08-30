/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { QBittorrentRuntime } = ChromeUtils.importESModule(
  "resource:///modules/QBittorrentRuntime.sys.mjs"
);
const { TorrentManager } = ChromeUtils.importESModule(
  "resource:///modules/TorrentManager.sys.mjs"
);

const originalRequest = QBittorrentRuntime.request;

function response(body, status = 200) {
  return {
    body: new TextEncoder().encode(JSON.stringify(body)),
    headers: new Map([["content-type", ["application/json; charset=UTF-8"]]]),
    status,
  };
}

add_setup(function setup() {
  registerCleanupFunction(() => {
    QBittorrentRuntime.request = originalRequest;
  });
});

add_task(async function test_magnet_add_skips_metadata_prefetch() {
  let call;
  QBittorrentRuntime.request = async (target, options) => {
    call = { target, options };
    return response({ added_torrent_ids: ["torrent-id"] });
  };
  const magnet = `magnet:?xt=urn:btih:${"1".repeat(40)}`;
  await TorrentManager.addMagnet(magnet, "/downloads");
  const fields = new URLSearchParams(
    new TextDecoder().decode(call.options.body)
  );
  Assert.equal(call.target, "/api/v2/torrents/add");
  Assert.equal(fields.get("urls"), magnet);
  Assert.equal(fields.get("savepath"), "/downloads");
});

add_task(async function test_reviewed_torrent_bytes_are_added_directly() {
  let call;
  QBittorrentRuntime.request = async (target, options) => {
    call = { target, options };
    return response({ added_torrent_ids: ["torrent-id"] });
  };
  const result = await TorrentManager.addTorrentBytes(
    new Uint8Array([1, 2, 3]),
    "/downloads"
  );
  Assert.equal(call.target, "/api/v2/torrents/add");
  Assert.equal(
    call.options.headers["Content-Type"].startsWith("multipart/form-data;"),
    true
  );
  Assert.deepEqual(result.ids, ["torrent-id"]);
});

add_task(async function test_import_inputs_are_bounded() {
  for (const source of [
    "magnet:",
    `magnet:?xt=urn:btih:${"1".repeat(39)}`,
    `magnet:?xt=urn:btih:${"1".repeat(40)}#fragment`,
    `magnet:?xt=urn:btih:${"1".repeat(40)}&dn=fixture%00name`,
  ]) {
    await Assert.rejects(
      TorrentManager.addMagnet(source),
      /A magnet link is required/
    );
  }
  await Assert.rejects(
    TorrentManager.addTorrentBytes(new Uint8Array([1]), "bad\r\npath"),
    /download path is invalid/
  );
});
