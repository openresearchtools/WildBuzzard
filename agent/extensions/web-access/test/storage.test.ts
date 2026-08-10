/* SPDX-License-Identifier: AGPL-3.0-or-later */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { RESULT_TTL_MS, type QueryResponse } from "../contracts.ts";
import {
  clearStoredSearches,
  createStoredSearch,
  getStoredSearch,
  pageStoredSearch,
  restoreSearches,
  storeSearch,
} from "../storage.ts";
import { closeStoredSearchDatabase } from "../database.ts";

const databaseDirectory = mkdtempSync(join(tmpdir(), "wildbuzzard-storage-test-"));
const previousDatabase = process.env.WILDBUZZARD_WEB_SEARCH_DATABASE;

before(() => {
  process.env.WILDBUZZARD_WEB_SEARCH_DATABASE = join(
    databaseDirectory,
    "web-search.sqlite"
  );
});

after(() => {
  closeStoredSearchDatabase();
  if (previousDatabase === undefined) {
    delete process.env.WILDBUZZARD_WEB_SEARCH_DATABASE;
  } else {
    process.env.WILDBUZZARD_WEB_SEARCH_DATABASE = previousDatabase;
  }
  rmSync(databaseDirectory, { recursive: true });
});

function response(): QueryResponse {
  return {
    query: "wild buzzard",
    answers: [],
    corrections: [],
    suggestions: [],
    unresponsiveEngines: [],
    results: [
      {
        title: "WildBuzzard documentation",
        url: "https://example.test/docs",
        snippet: "A distinctive browser research passage about Gecko extraction.",
        engines: ["fixture"],
        score: 1,
        date: null,
      },
    ],
  };
}

test("search handles expire after one hour and restore only live entries", () => {
  clearStoredSearches();
  const now = Date.now();
  const stored = createStoredSearch([response()], "search", now);
  storeSearch(stored);
  assert.equal(getStoredSearch(stored.id, now + RESULT_TTL_MS - 1), stored);
  assert.throws(
    () => getStoredSearch(stored.id, now + RESULT_TTL_MS),
    /missing or expired/
  );
  restoreSearches(
    [
      {
        type: "custom",
        customType: "wildbuzzard-web-search",
        data: stored,
      },
    ],
    now + 1
  );
  assert.equal(getStoredSearch(stored.id, now + 1).id, stored.id);
});

test("stored content is bounded, selectable, and passage searchable", () => {
  const stored = createStoredSearch([response()]);
  const exact = pageStoredSearch(stored, {
    url: "https://example.test/docs",
    offset: 0,
    limit: 80,
    findText: [
      "distinctive browser research passage",
      "GECKO EXTRACTION",
      "browser research text about Gecko extraction",
      "not present anywhere",
    ],
  });
  assert.equal(exact.content.length, 80);
  assert.ok(exact.totalCharacters > exact.content.length);
  assert.equal(exact.passages[0].mode, "exact");
  assert.equal(exact.passages[1].mode, "case-insensitive");
  assert.equal(exact.passages[2].mode, "fuzzy");
  assert.equal(exact.passages[3].mode, "none");
  assert.throws(
    () => pageStoredSearch(stored, { limit: 30_001 }),
    /1 to 30000/
  );
  assert.throws(
    () =>
      pageStoredSearch(stored, {
        query: "wild buzzard",
        url: "https://example.test/docs",
      }),
    /at most one/
  );
});
