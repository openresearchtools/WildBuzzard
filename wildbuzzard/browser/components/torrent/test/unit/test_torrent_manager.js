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

function metadata(id = "draft-id") {
  return {
    id,
    info: {
      name: "Linux ISO",
      files: [
        { path: "linux.iso", length: 1024 },
        { path: "checksums.txt", length: 64 },
      ],
    },
  };
}

add_setup(function setup() {
  registerCleanupFunction(() => {
    QBittorrentRuntime.request = originalRequest;
    TorrentManager.drafts?.clear();
  });
});

add_task(async function test_magnet_draft_uses_comma_separated_priorities() {
  const calls = [];
  QBittorrentRuntime.request = async (target, options) => {
    calls.push({ target, options });
    return target === "/api/v2/torrents/fetchMetadata"
      ? response(metadata())
      : response({ added_torrent_ids: ["torrent-id"] });
  };
  const magnet = `magnet:?xt=urn:btih:${"1".repeat(40)}`;
  const draft = await TorrentManager.createTorrentDraft({ magnet });
  await TorrentManager.commitTorrentDraft(draft.draftId, [0]);
  const fields = new URLSearchParams(
    new TextDecoder().decode(calls.at(-1).options.body)
  );
  Assert.equal(calls.at(-1).target, "/api/v2/torrents/add");
  Assert.equal(fields.get("filePriorities"), "1,0");
});

add_task(async function test_torrent_draft_priorities_require_one_added_id() {
  const calls = [];
  let addedIds = ["torrent-id"];
  QBittorrentRuntime.request = async (target, options) => {
    calls.push({ target, options });
    if (target === "/api/v2/torrents/parseMetadata") {
      return response([metadata("torrent-draft")]);
    }
    if (target === "/api/v2/torrents/add") {
      return response({ added_torrent_ids: addedIds });
    }
    return response("");
  };
  const draft = await TorrentManager.createTorrentDraft({
    torrent: new Uint8Array([1, 2, 3]),
  });
  await TorrentManager.commitTorrentDraft(draft.draftId, [0]);
  const priorityCall = calls.find(
    call => call.target === "/api/v2/torrents/filePrio"
  );
  Assert.ok(priorityCall);
  Assert.deepEqual(
    Object.fromEntries(
      new URLSearchParams(new TextDecoder().decode(priorityCall.options.body))
    ),
    { hash: "torrent-id", id: "1", priority: "0" }
  );

  const second = await TorrentManager.createTorrentDraft({
    torrent: new Uint8Array([4, 5, 6]),
  });
  addedIds = [];
  await Assert.rejects(
    TorrentManager.commitTorrentDraft(second.draftId, [0]),
    /did not identify the added torrent/
  );
});
