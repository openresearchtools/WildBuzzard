/* SPDX-License-Identifier: AGPL-3.0-or-later */

import assert from "node:assert/strict";
import test from "node:test";
import {
  TorrentAgentToolController,
  validateTorrentSearchArgs,
} from "../../../../remote/wildbuzzard/TorrentAgentTools.sys.mjs";

function fixture() {
  let nextId = 1;
  const calls = {
    cancelledSearches: 0,
    commits: [],
    cancelledDrafts: [],
    resolved: [],
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
  const committed = await controller.execute(
    "torrent_commit",
    { draftId: prepared.draftId, files: [0], confirmed: true },
    "session-one"
  );
  assert.deepEqual(committed, { draftId: prepared.draftId, committed: true });
  assert.deepEqual(calls.commits, [{ id: "backend-draft-secret", files: [0] }]);
  assert.doesNotMatch(JSON.stringify(committed), /backend-|secret-url/);
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
