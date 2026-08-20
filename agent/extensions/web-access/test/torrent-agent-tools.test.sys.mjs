/* SPDX-License-Identifier: AGPL-3.0-or-later */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL(
    "../../../../remote/wildbuzzard/TorrentAgentTools.sys.mjs",
    import.meta.url
  ),
  "utf8"
);
const nodeSource = source.replace(
  'import { clearTimeout, setTimeout } from "resource://gre/modules/Timer.sys.mjs";',
  "const { clearTimeout, setTimeout } = globalThis;"
);
assert.notEqual(nodeSource, source);
const {
  TorrentAgentToolController,
  validateTorrentControlArgs,
  validateTorrentDetailsArgs,
  validateTorrentListArgs,
  validateTorrentSearchArgs,
} = await import(
  `data:text/javascript;base64,${Buffer.from(nodeSource).toString("base64")}`
);

function fixture() {
  let nextId = 1;
  const calls = {
    cancelledSearches: 0,
    commits: [],
    cancelledDrafts: [],
    resolved: [],
    controls: [],
  };
  const discoveryManager = {
    async getSources() {
      return {
        immutable: true,
        sources: [
          {
            id: "public-source",
            name: "Public\u0000 Source",
            state: "ready",
          },
        ],
      };
    },
    async search() {
      return {
        searchId: "backend-search-secret",
        partial: true,
        providers: [{ id: "public-source", state: "ok", elapsedMs: 4 }],
        results: [
          result("N".repeat(32), "Unknown seeders", null),
          result("W".repeat(32), "Two seeders", 2),
          result("T".repeat(32), "Ten seeders", 10),
        ],
      };
    },
    cancelSearch() {
      calls.cancelledSearches++;
    },
    async resolve(id) {
      calls.resolved.push(id);
      return {
        kind: "magnet",
        magnet: "magnet:?xt=urn:btih:0123456789012345678901234567890123456789",
      };
    },
  };
  const draft = backendDraft();
  const torrentManager = {
    async listTorrents(args) {
      calls.list = args;
      return [
        {
          hash: "a".repeat(40),
          name: "Linux ISO",
          state: "downloading",
          progress: 0.5,
          total_size: 2048,
          downloaded: 1024,
          uploaded: 10,
          dlspeed: 500,
          upspeed: 20,
          num_seeds: 4,
          num_leechs: 2,
          eta: 60,
          ratio: 0.01,
          added_on: 123,
          completion_on: -1,
          save_path: "/tmp/downloads",
          category: "",
          tags: "linux",
          force_start: false,
          seq_dl: false,
          f_l_piece_prio: false,
        },
      ];
    },
    async getTorrentSection(id, section) {
      calls.details = { id, section };
      if (section === "files") {
        return [
          {
            index: 0,
            name: "Linux/linux.iso",
            size: 2048,
            progress: 0.5,
            priority: 1,
            availability: 4,
          },
        ];
      }
      return { name: "Linux ISO", total_size: 2048, private: false };
    },
    async action(ids, action) {
      calls.controls.push({ ids, action });
    },
    async setForceStart(ids, value) {
      calls.controls.push({ ids, forceStart: value });
    },
    async setFilePriority(id, fileIds, priority) {
      calls.controls.push({ id, fileIds, priority });
    },
    async setLimits(ids, downloadLimit, uploadLimit) {
      calls.controls.push({ ids, downloadLimit, uploadLimit });
    },
    async rename(id, name) {
      calls.controls.push({ id, name });
    },
    async setToggle(id, property, enabled) {
      calls.controls.push({ id, property, enabled });
    },
    async remove(ids, deleteData) {
      calls.controls.push({ ids, deleteData });
    },
    async createTorrentDraft() {
      return structuredClone(draft);
    },
    async getTorrentDraft(id) {
      assert.equal(id, draft.draftId);
      return structuredClone(draft);
    },
    async commitTorrentDraft(id, files) {
      calls.commits.push({ id, files });
      return { id: "backend-torrent-secret", trackers: ["secret-url"] };
    },
    async cancelTorrentDraft(id) {
      calls.cancelledDrafts.push(id);
      return { ok: true };
    },
  };
  return {
    calls,
    controller: new TorrentAgentToolController({
      discoveryManager,
      torrentManager,
      makeId: () => String(nextId++).padStart(32, "0"),
    }),
    discoveryManager,
    torrentManager,
  };
}

test("qBittorrent list, details, and controls use bounded typed contracts", async () => {
  const { controller, calls } = fixture();
  const id = "a".repeat(40);
  const list = await controller.execute(
    "torrent_list",
    { filter: "downloading", limit: 10 },
    "session-one"
  );
  assert.equal(list.torrents[0].id, id);
  assert.equal(list.torrents[0].downloadSpeed, 500);
  assert.equal(list.torrents[0].name, "Linux ISO");
  assert.equal(calls.list.sort, "added_on");

  const details = await controller.execute(
    "torrent_details",
    { id, section: "files" },
    "session-one"
  );
  assert.deepEqual(details.items[0], {
    index: 0,
    name: "Linux/linux.iso",
    sizeBytes: 2048,
    progress: 0.5,
    priority: 1,
    availability: 4,
  });

  await controller.execute(
    "torrent_control",
    { ids: [id], action: "filePriority", fileIds: [0], priority: 7 },
    "session-one"
  );
  assert.deepEqual(calls.controls.pop(), {
    id,
    fileIds: [0],
    priority: 7,
  });
  await assert.rejects(
    controller.execute(
      "torrent_control",
      { ids: [id], action: "delete", deleteData: true },
      "session-one"
    ),
    /explicit user confirmation/
  );
  await controller.execute(
    "torrent_control",
    { ids: [id], action: "delete", deleteData: true, confirmed: true },
    "session-one"
  );
  assert.deepEqual(calls.controls.pop(), { ids: id, deleteData: true });

  assert.deepEqual(validateTorrentListArgs({}), {
    filter: "all",
    category: undefined,
    tag: undefined,
    sort: "added_on",
    reverse: true,
    limit: 50,
    offset: 0,
  });
  assert.deepEqual(validateTorrentDetailsArgs({ id }), {
    id,
    section: "overview",
    offset: 0,
    limit: 100,
  });
  assert.equal(
    validateTorrentControlArgs({ ids: [id], action: "reannounce" }).action,
    "reannounce"
  );
  assert.throws(
    () =>
      validateTorrentControlArgs({
        ids: [id, "b".repeat(40)],
        action: "sequential",
        enabled: true,
      }),
    /accepts one torrent ID/
  );
  assert.throws(
    () =>
      validateTorrentControlArgs({
        ids: [id, "b".repeat(40)],
        action: "firstLastPiece",
        enabled: false,
      }),
    /accepts one torrent ID/
  );
});

function result(resultId, title, seeders) {
  return {
    resultId,
    providerId: "public-source",
    providerName: "Public Source",
    name: title,
    sizeBytes: 1024,
    seeders,
    leechers: null,
    publishedAt: null,
    categoryIds: [8000],
    acquisition: "magnet",
    acquisitionUrl: "https://provider.invalid/secret",
  };
}

function backendDraft() {
  return {
    draftId: "backend-draft-secret",
    state: "ready",
    name: "Linux ISO",
    totalSize: 1024,
    files: [
      { index: 0, name: "linux.iso", path: "Linux/linux.iso", length: 1024 },
    ],
    private: false,
    error: null,
  };
}

async function searched(controller, session = "session-one") {
  return controller.execute("torrent_search", { query: "linux" }, session);
}

test("search defaults to seeders descending and keeps unknown values last", async () => {
  const { controller } = fixture();
  const response = await searched(controller);
  assert.deepEqual(
    response.results.map(item => item.seeders),
    [10, 2, null]
  );
  assert.match(response.searchId, /^[A-Za-z0-9_-]{32}$/);
  assert.doesNotMatch(JSON.stringify(response), /backend-|provider\.invalid/);
  assert.deepEqual(validateTorrentSearchArgs({ query: " linux " }), {
    query: "linux",
    providers: undefined,
    sort: "seeders",
    direction: "desc",
    limit: 20,
    timeoutMs: 30_000,
  });
  assert.throws(
    () => validateTorrentSearchArgs({ query: "linux", url: "magnet:?xt=x" }),
    /unexpected argument/
  );
});

test("prepare replaces backend identifiers and scopes handles to a session", async () => {
  const { controller, calls } = fixture();
  const search = await searched(controller);
  const prepared = await controller.execute(
    "torrent_prepare",
    { searchId: search.searchId, resultId: search.results[0].resultId },
    "session-one"
  );
  assert.match(prepared.draftId, /^[A-Za-z0-9_-]{32}$/);
  assert.doesNotMatch(JSON.stringify(prepared), /backend-draft-secret|magnet:/);
  assert.equal(calls.resolved[0], "T".repeat(32));
  await assert.rejects(
    controller.execute(
      "torrent_prepare",
      { searchId: search.searchId, resultId: search.results[0].resultId },
      "session-two"
    ),
    /invalid or expired/
  );
});

test("commit requires explicit confirmation before the manager side effect", async () => {
  const { controller, calls } = fixture();
  const search = await searched(controller);
  const prepared = await controller.execute(
    "torrent_prepare",
    { searchId: search.searchId, resultId: search.results[0].resultId },
    "session-one"
  );
  await assert.rejects(
    controller.execute(
      "torrent_commit",
      { draftId: prepared.draftId, files: [0], confirmed: false },
      "session-one"
    ),
    /explicit user confirmation/
  );
  assert.equal(calls.commits.length, 0);
  await assert.rejects(
    controller.execute(
      "torrent_commit",
      { draftId: prepared.draftId, files: [], confirmed: true },
      "session-one"
    ),
    /unique non-negative indexes/
  );
  assert.equal(calls.commits.length, 0);
  const committed = await controller.execute(
    "torrent_commit",
    { draftId: prepared.draftId, files: [0], confirmed: true },
    "session-one"
  );
  assert.deepEqual(committed, { draftId: prepared.draftId, committed: true });
  assert.deepEqual(calls.commits, [{ id: "backend-draft-secret", files: [0] }]);
  assert.doesNotMatch(JSON.stringify(committed), /backend-|secret-url/);
});

test("draft failures do not expose backend error details", async () => {
  const { controller, torrentManager } = fixture();
  torrentManager.createTorrentDraft = async () => ({
    ...backendDraft(),
    state: "error",
    error: "https://tracker.invalid/announce?passkey=secret",
  });
  const search = await searched(controller);
  const prepared = await controller.execute(
    "torrent_prepare",
    { searchId: search.searchId, resultId: search.results[0].resultId },
    "session-one"
  );
  assert.equal(prepared.error, "Torrent metadata could not be prepared");
  assert.doesNotMatch(
    JSON.stringify(prepared),
    /tracker\.invalid|passkey|secret/
  );
});

test("search abort and explicit draft cancellation reach browser-owned managers", async () => {
  const first = fixture();
  first.discoveryManager.search = () =>
    new Promise((resolve, reject) => {
      first.discoveryManager.cancelSearch = () => {
        first.calls.cancelledSearches++;
        reject(Object.assign(new Error("cancelled"), { cancelled: true }));
      };
    });
  const abortController = new AbortController();
  const pending = first.controller.execute(
    "torrent_search",
    { query: "linux" },
    "session-one",
    abortController.signal
  );
  abortController.abort();
  await assert.rejects(pending, /Torrent search cancelled/);
  assert.equal(first.calls.cancelledSearches, 1);

  const second = fixture();
  const search = await searched(second.controller);
  const prepared = await second.controller.execute(
    "torrent_prepare",
    { searchId: search.searchId, resultId: search.results[0].resultId },
    "session-one"
  );
  const cancelled = await second.controller.execute(
    "torrent_cancel",
    { draftId: prepared.draftId },
    "session-one"
  );
  assert.deepEqual(cancelled, { draftId: prepared.draftId, cancelled: true });
  assert.deepEqual(second.calls.cancelledDrafts, ["backend-draft-secret"]);
});

test("transport errors do not expose provider URLs or capabilities", async () => {
  const { controller, discoveryManager } = fixture();
  discoveryManager.getSources = async () => {
    throw new Error("https://provider.invalid/?token=secret-capability");
  };
  await assert.rejects(
    controller.execute("torrent_providers", {}, "session-one"),
    error => {
      assert.equal(error.message, "Torrent provider status is unavailable");
      return true;
    }
  );
});
