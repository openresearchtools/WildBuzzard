/* SPDX-License-Identifier: AGPL-3.0-or-later */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { RESULT_TTL_MS, type QueryResponse } from "../contracts.ts";
import {
  clearStoredSearches,
  createStoredDocuments,
  createStoredSearch,
  getStoredSearch,
  hasStoredSearches,
  pageStoredSearch,
  restoreSearches,
  storedSearchReference,
  storeSearch,
} from "../storage.ts";
import type { ExtractedContent } from "../extract.ts";
import { closeStoredSearchDatabase } from "../database.ts";

const databaseDirectory = mkdtempSync(
  join(tmpdir(), "wildbuzzard-storage-test-")
);
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
        snippet:
          "A distinctive browser research passage about Gecko extraction.",
        engines: ["fixture"],
        score: 1,
        date: null,
        provenance: "searxng",
        trust: "untrusted",
      },
    ],
  };
}

test("search handles expire after one hour and restore only live entries", () => {
  clearStoredSearches();
  const now = Date.now();
  const stored = createStoredSearch([response()], "session-a", "search", now);
  storeSearch(stored);
  assert.deepEqual(Object.keys(storedSearchReference(stored)).sort(), [
    "expiresAt",
    "id",
    "sessionScope",
    "type",
  ]);
  assert.equal(hasStoredSearches("session-a", now), true);
  restoreSearches(
    [
      {
        type: "custom",
        customType: "wildbuzzard-web-search",
        data: storedSearchReference(stored),
      },
    ],
    "session-a",
    now + 1
  );
  assert.equal(getStoredSearch(stored.id, "session-a", now + 1).id, stored.id);
  assert.deepEqual(
    getStoredSearch(stored.id, "session-a", now + RESULT_TTL_MS - 1),
    stored
  );
  assert.throws(
    () => getStoredSearch(stored.id, "session-a", now + RESULT_TTL_MS),
    /missing or expired/
  );
  assert.equal(hasStoredSearches("session-a", now + RESULT_TTL_MS), false);
});

test("stored content is bounded, selectable, and passage searchable", () => {
  const stored = createStoredSearch([response()], "session-a");
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

test("stored handles and restored references are isolated by Pi session", () => {
  clearStoredSearches();
  const stored = createStoredSearch([response()], "session-a");
  storeSearch(stored);
  assert.throws(
    () => getStoredSearch(stored.id, "session-b"),
    /missing or expired/
  );
  assert.equal(hasStoredSearches("session-b"), false);
  restoreSearches(
    [
      {
        type: "custom",
        customType: "wildbuzzard-web-search",
        data: storedSearchReference(stored),
      },
    ],
    "session-b"
  );
  assert.equal(hasStoredSearches("session-b"), false);
  assert.equal(hasStoredSearches("session-a"), true);
});

test("stored GitHub, Gecko, and YouTube documents strip URL secrets", () => {
  const provenances: ExtractedContent["provenance"][] = [
    "github-clone",
    "gecko",
    "youtube-captions",
  ];
  const stored = createStoredDocuments(
    provenances.map(provenance => ({
      url: `https://user:password@example.test/source?q=${provenance}&access_token=source-secret#token=fragment-secret&section=content`,
      finalUrl: `https://example.test/final?page=2&api_key=final-secret`,
      title: "Fixture",
      content: "Fixture content",
      error: provenance === "github-clone" ? "Clone failed" : null,
      mimeType: "text/plain",
      status: provenance === "github-clone" ? 0 : 200,
      provenance,
      trust: "untrusted" as const,
    })),
    "session-a"
  );
  const serialized = JSON.stringify(stored.documents);
  assert.doesNotMatch(
    serialized,
    /source-secret|fragment-secret|final-secret|user|password/
  );
  assert.match(serialized, /q=github-clone/);
  assert.match(serialized, /page=2/);
  assert.match(serialized, /section=content/);
  const search = createStoredSearch(
    [
      {
        ...response(),
        query: "https://example.test/search?q=gecko&access_token=query-secret",
        results: [
          {
            ...response().results[0],
            url: "https://user:password@example.test/result?q=gecko&api_key=result-secret",
          },
        ],
      },
    ],
    "session-a"
  );
  const serializedSearch = JSON.stringify(search.queries);
  assert.doesNotMatch(
    serializedSearch,
    /query-secret|result-secret|user|password/
  );
  assert.match(serializedSearch, /q=gecko/);
});

test("storage failures do not expose local database paths", () => {
  closeStoredSearchDatabase();
  const invalidParent = join(databaseDirectory, "sensitive-parent");
  writeFileSync(invalidParent, "not a directory");
  process.env.WILDBUZZARD_WEB_SEARCH_DATABASE = join(
    invalidParent,
    "web-search.sqlite"
  );
  try {
    assert.throws(
      () => clearStoredSearches(),
      error => {
        assert.equal(
          (error as Error).message,
          "WildBuzzard web-search storage is unavailable"
        );
        assert.doesNotMatch((error as Error).message, /sensitive/);
        return true;
      }
    );
  } finally {
    closeStoredSearchDatabase();
    process.env.WILDBUZZARD_WEB_SEARCH_DATABASE = join(
      databaseDirectory,
      "web-search.sqlite"
    );
  }
});
