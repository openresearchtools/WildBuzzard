/* SPDX-License-Identifier: AGPL-3.0-or-later */

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSearchQuery,
  matchesDomainFilters,
  normalizeDomainFilters,
  normalizeSearchInput,
  sanitizeStructuredValue,
} from "../contracts.ts";
import { normalizeFetchInput } from "../extract.ts";

test("web search requires exactly one bounded query input", () => {
  assert.throws(() => normalizeSearchInput({}), /exactly one/);
  assert.throws(
    () => normalizeSearchInput({ query: "one", queries: ["two"] }),
    /exactly one/
  );
  assert.throws(
    () => normalizeSearchInput({ queries: ["1", "2", "3", "4", "5"] }),
    /at most 4/
  );
  assert.throws(
    () => normalizeSearchInput({ query: "q", numResults: 21 }),
    /1 to 20/
  );
  assert.throws(
    () =>
      normalizeSearchInput({
        query: "q",
        recencyFilter: "hour" as "day",
      }),
    /recencyFilter/
  );
  assert.deepEqual(normalizeSearchInput({ query: " test " }), {
    queries: ["test"],
    numResults: 5,
    includeContent: false,
    recencyFilter: undefined,
    domains: { included: [], excluded: [] },
    provider: "searxng",
    workflow: "none",
  });
});

test("answer mode requires a prompt and permits caller model selection", () => {
  assert.throws(
    () => normalizeFetchInput({ url: "https://example.test", mode: "answer" }),
    /requires prompt/
  );
  assert.throws(
    () =>
      normalizeFetchInput({
        url: "https://example.test",
        forceClone: "false" as unknown as boolean,
      }),
    /forceClone/
  );
  assert.throws(
    () =>
      normalizeFetchInput({
        url: "https://example.test",
        mode: "answer",
        prompt: "x".repeat(4_001),
      }),
    /prompt/
  );
  const input = normalizeFetchInput({
    url: "https://example.test",
    mode: "answer",
    prompt: "What is the conclusion?",
    answerModel: "local/model",
  });
  assert.equal(input.prompt, "What is the conclusion?");
  assert.equal(input.answerModel, "local/model");
});

test("domain filters add hints and enforce hostname boundaries", () => {
  assert.throws(
    () => normalizeDomainFilters(["https://user@example.com"]),
    /Invalid domain filter/
  );
  const filters = normalizeDomainFilters([
    "example.com",
    "-blocked.example",
    "https://docs.example.com/path",
  ]);
  assert.deepEqual(filters, {
    included: ["example.com", "docs.example.com"],
    excluded: ["blocked.example"],
  });
  assert.equal(
    buildSearchQuery("gecko", filters),
    "gecko (site:example.com OR site:docs.example.com) -site:blocked.example"
  );
  assert.equal(
    matchesDomainFilters("https://www.example.com/a", filters),
    true
  );
  assert.equal(
    matchesDomainFilters("https://example.com.attacker.invalid/a", filters),
    false
  );
  assert.equal(
    matchesDomainFilters("https://blocked.example/a", filters),
    false
  );
  assert.equal(matchesDomainFilters("file:///etc/passwd", filters), false);
  assert.equal(
    matchesDomainFilters("https://user@example.com/private", filters),
    false
  );
});

test("typed answer data stays structured and bounded", () => {
  const sanitized = sanitizeStructuredValue({
    answer: "x".repeat(5_000),
    nested: { score: Number.POSITIVE_INFINITY, safe: true },
    omitted: undefined,
    authorization: "Bearer service-secret",
    headers: { cookie: "private" },
  }) as Record<string, unknown>;
  assert.equal((sanitized.answer as string).length, 4_000);
  assert.deepEqual(sanitized.nested, { score: null, safe: true });
  assert.equal(sanitized.omitted, null);
  assert.equal(Object.hasOwn(sanitized, "authorization"), false);
  assert.equal(Object.hasOwn(sanitized, "headers"), false);
});
