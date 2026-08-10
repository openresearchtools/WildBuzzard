/* SPDX-License-Identifier: AGPL-3.0-or-later */

import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";
import {
  TORRENT_TOOL_NAMES,
  TorrentCommitParameters,
  TorrentPrepareParameters,
  TorrentSearchParameters,
  torrentToolsForPrompt,
} from "../torrent-contracts.ts";

test("torrent tools activate only for torrent intent", () => {
  assert.deepEqual(
    torrentToolsForPrompt("Refactor the local search module"),
    []
  );
  assert.deepEqual(
    torrentToolsForPrompt("Find an Ubuntu torrent with healthy seeders"),
    TORRENT_TOOL_NAMES
  );
  assert.deepEqual(
    torrentToolsForPrompt("Inspect this magnet link before downloading"),
    TORRENT_TOOL_NAMES
  );
});

test("torrent tool payload schemas expose only bounded opaque contracts", () => {
  assert.equal(
    Value.Check(TorrentSearchParameters, {
      query: "linux iso",
      sort: "seeders",
      direction: "desc",
      limit: 20,
      timeoutMs: 30_000,
    }),
    true
  );
  assert.equal(
    Value.Check(TorrentSearchParameters, {
      query: "linux iso",
      acquisitionUrl: "https://tracker.invalid/file.torrent",
    }),
    false
  );
  assert.equal(
    Value.Check(TorrentPrepareParameters, {
      searchId: "S".repeat(32),
      resultId: "R".repeat(32),
    }),
    true
  );
  assert.equal(
    Value.Check(TorrentPrepareParameters, {
      searchId: "https://provider.invalid/search",
      resultId: "R".repeat(32),
    }),
    false
  );
  assert.equal(
    Value.Check(TorrentCommitParameters, {
      draftId: "D".repeat(32),
      files: [0, 2],
      confirmed: true,
    }),
    true
  );
  assert.equal(
    Value.Check(TorrentCommitParameters, {
      draftId: "D".repeat(32),
      files: [2, 2],
      confirmed: true,
    }),
    false
  );
});
