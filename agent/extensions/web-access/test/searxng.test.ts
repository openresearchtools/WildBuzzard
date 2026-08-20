/* SPDX-License-Identifier: AGPL-3.0-or-later */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { normalizeSearchInput, type QueryResponse } from "../contracts.ts";
import {
  nativeSearchRequest,
  searchSearXBatch,
  searchSearXNG,
  sortSearchResults,
} from "../searxng.ts";

const fixtures = {
  catalogSha256: "a".repeat(64),
  totalEntries: 343,
  eligibleEntries: 332,
  totalModules: 222,
  eligibleModules: 211,
  attemptedEngines: ["duckduckgo", "wikipedia"],
  completedEngines: ["duckduckgo"],
};

function nativeResponse(
  query: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    schema: 1,
    implementation: "bundled-searxng",
    query,
    results: [],
    answers: [],
    corrections: [],
    suggestions: [],
    infoboxes: [],
    unresponsiveEngines: [],
    diagnostics: fixtures,
    ...overrides,
  };
}

function queryResponse(query: string): QueryResponse {
  return {
    query,
    implementation: "bundled-searxng",
    diagnostics: fixtures,
    results: [],
    answers: [],
    corrections: [],
    suggestions: [],
    infoboxes: [],
    unresponsiveEngines: [],
  };
}

test("native search uses the browser bridge contract and preserves typed fields", async () => {
  let invocation: unknown[] = [];
  const input = normalizeSearchInput({
    query: "gecko renderer",
    numResults: 10,
    includeContent: true,
    recencyFilter: "week",
    domainFilter: ["example.com"],
  });
  const result = await searchSearXNG(
    input.queries[0],
    input,
    "/work/project",
    "session-a",
    undefined,
    async (...args) => {
      invocation = args;
      const request = args[1] as { query: string };
      return {
        content: [],
        details: nativeResponse(request.query, {
          answers: [{ answer: "typed", source: "calculator" }],
          corrections: [{ correction: "corrected" }],
          suggestions: ["suggestion"],
          infoboxes: [
            { infobox: "Firefox", attributes: [["type", "browser"]] },
          ],
          unresponsiveEngines: [["wikipedia", "timeout"]],
          results: [
            {
              title: "Allowed",
              url: "https://docs.example.com/allowed?token=secret&view=1",
              content: "Evidence",
              engines: ["duckduckgo", "wikipedia"],
              score: 2.5,
              publishedDate: "2026-08-10",
            },
            {
              title: "Suffix attack",
              url: "https://example.com.attacker.invalid/blocked",
            },
            { title: "Unsafe", url: "file:///etc/passwd" },
          ],
        }),
      };
    }
  );
  assert.equal(invocation[0], "native_search");
  assert.deepEqual(invocation[1], {
    query: "gecko renderer site:example.com",
    timeRange: "week",
    safeSearch: 1,
    maxResults: 10,
  });
  assert.equal(invocation[2], "/work/project");
  assert.equal(invocation[3], "web-access:session-a");
  assert.equal(invocation[4], undefined);
  assert.equal(result.implementation, "bundled-searxng");
  assert.deepEqual(result.diagnostics, fixtures);
  assert.deepEqual(result.answers, [{ answer: "typed", source: "calculator" }]);
  assert.deepEqual(result.corrections, [{ correction: "corrected" }]);
  assert.deepEqual(result.suggestions, ["suggestion"]);
  assert.deepEqual(result.infoboxes, [
    { infobox: "Firefox", attributes: [["type", "browser"]] },
  ]);
  assert.deepEqual(result.unresponsiveEngines, [["wikipedia", "timeout"]]);
  assert.deepEqual(result.results, [
    {
      title: "Allowed",
      url: "https://docs.example.com/allowed?view=1",
      snippet: "Evidence",
      engines: ["duckduckgo", "wikipedia"],
      score: 2.5,
      date: "2026-08-10",
      provenance: "searxng",
      trust: "untrusted",
      contentPreview: "Evidence",
    },
  ]);
});

test("native search rejects malformed, fake, stale, and oversized responses", async () => {
  const input = normalizeSearchInput({ query: "fixture", numResults: 1 });
  const failures = [
    nativeResponse("fixture", { implementation: "unexpected-backend" }),
    nativeResponse("fixture", { schema: 2 }),
    { ...nativeResponse("fixture"), unexpected: true },
    nativeResponse("fixture", {
      diagnostics: { ...fixtures, eligibleEntries: 344 },
    }),
    nativeResponse("fixture", {
      diagnostics: { ...fixtures, completedEngines: ["not-attempted"] },
    }),
    nativeResponse("fixture", {
      diagnostics: { ...fixtures, catalogSha256: "A".repeat(64) },
    }),
    nativeResponse("fixture", { answers: {} }),
    nativeResponse("fixture", {
      results: [
        {
          url: "https://example.test/",
          engines: "duckduckgo",
        },
      ],
    }),
    nativeResponse("fixture", {
      results: [
        { url: "https://example.test/1" },
        { url: "https://example.test/2" },
      ],
    }),
  ];
  for (const details of failures) {
    await assert.rejects(
      searchSearXNG(
        "fixture",
        input,
        "/work/project",
        "session-a",
        undefined,
        async () => ({ content: [], details })
      ),
      /Native search returned (?:an )?invalid/
    );
  }
});

test("native request enforces audited query caps and fixed safe search", () => {
  const atLimit = "x".repeat(512);
  assert.deepEqual(
    nativeSearchRequest(atLimit, normalizeSearchInput({ query: atLimit })),
    { query: atLimit, safeSearch: 1, maxResults: 5 }
  );
  const overLimit = "x".repeat(513);
  assert.throws(
    () =>
      nativeSearchRequest(
        overLimit,
        normalizeSearchInput({ query: overLimit })
      ),
    /audited limit/
  );
  const unicodeAtLimits = "💡".repeat(512);
  assert.deepEqual(
    nativeSearchRequest(
      unicodeAtLimits,
      normalizeSearchInput({ query: unicodeAtLimits })
    ),
    { query: unicodeAtLimits, safeSearch: 1, maxResults: 5 }
  );
  const unicodeOverByteLimit = "é".repeat(512);
  assert.throws(
    () =>
      nativeSearchRequest(
        `${unicodeOverByteLimit}é`,
        normalizeSearchInput({ query: `${unicodeOverByteLimit}é` })
      ),
    /audited limit/
  );
});

test("date sorting is stable and always leaves invalid or missing dates last", () => {
  const results = [
    { title: "old", date: "2024-01-01" },
    { title: "invalid", date: "not-a-date" },
    { title: "equal-first", date: "2026-08-10T00:00:00Z" },
    { title: "missing", date: null },
    { title: "equal-second", date: "2026-08-10" },
    { title: "middle", date: "2025-06-01" },
  ].map(({ title, date }) => ({
    title,
    date,
    url: `https://${title}.example/`,
    snippet: "",
    engines: [],
    score: null,
    provenance: "searxng" as const,
    trust: "untrusted" as const,
  }));

  assert.deepEqual(
    sortSearchResults(results, "newest").map(result => result.title),
    [
      "equal-first",
      "equal-second",
      "middle",
      "old",
      "invalid",
      "missing",
    ]
  );
  assert.deepEqual(
    sortSearchResults(results, "oldest").map(result => result.title),
    [
      "old",
      "middle",
      "equal-first",
      "equal-second",
      "invalid",
      "missing",
    ]
  );
});

test("default search ordering preserves SearXNG relevance", async () => {
  const input = normalizeSearchInput({ query: "fixture", numResults: 3 });
  let request: unknown;
  const result = await searchSearXNG(
    "fixture",
    input,
    "/work/project",
    "session-a",
    undefined,
    async (_tool, args) => {
      request = args;
      return {
        content: [],
        details: nativeResponse("fixture", {
          results: [
            {
              title: "most relevant",
              url: "https://first.example/",
              publishedDate: "2024-01-01",
            },
            {
              title: "second most relevant",
              url: "https://second.example/",
              publishedDate: "2026-01-01",
            },
            {
              title: "third most relevant",
              url: "https://third.example/",
            },
          ],
        }),
      };
    }
  );
  assert.deepEqual(request, {
    query: "fixture",
    safeSearch: 1,
    maxResults: 3,
  });
  assert.deepEqual(
    result.results.map(item => item.title),
    ["most relevant", "second most relevant", "third most relevant"]
  );
});

test("recency filtering and result ordering coexist independently", async () => {
  const input = normalizeSearchInput({
    query: "fixture",
    numResults: 2,
    recencyFilter: "month",
    sortOrder: "newest",
  });
  let request: unknown;
  const result = await searchSearXNG(
    "fixture",
    input,
    "/work/project",
    "session-a",
    undefined,
    async (_tool, args) => {
      request = args;
      return {
        content: [],
        details: nativeResponse("fixture", {
          results: [
            {
              title: "undated",
              url: "https://undated.example/",
            },
            {
              title: "older",
              url: "https://older.example/",
              publishedDate: "2026-07-20",
            },
            {
              title: "newer",
              url: "https://newer.example/",
              publishedDate: "2026-08-12",
            },
          ],
        }),
      };
    }
  );
  assert.deepEqual(request, {
    query: "fixture",
    timeRange: "month",
    safeSearch: 1,
    maxResults: 100,
  });
  assert.deepEqual(
    result.results.map(item => item.title),
    ["newer", "older"]
  );
});

test("query batches apply date ordering within each response", async () => {
  const input = normalizeSearchInput({
    queries: ["alpha", "beta"],
    numResults: 3,
    sortOrder: "oldest",
  });
  const result = await searchSearXBatch(
    input.queries,
    input,
    "/work/project",
    "session-a",
    undefined,
    (query, normalized, cwd, sessionId, signal) =>
      searchSearXNG(
        query,
        normalized,
        cwd,
        sessionId,
        signal,
        async (_tool, args) => ({
          content: [],
          details: nativeResponse((args as { query: string }).query, {
            results:
              query === "alpha"
                ? [
                    {
                      title: "alpha-new",
                      url: "https://alpha-new.example/",
                      publishedDate: "2026-08-02",
                    },
                    {
                      title: "alpha-old",
                      url: "https://alpha-old.example/",
                      publishedDate: "2026-08-01",
                    },
                  ]
                : [
                    {
                      title: "beta-undated",
                      url: "https://beta-undated.example/",
                    },
                    {
                      title: "beta-old",
                      url: "https://beta-old.example/",
                      publishedDate: "2025-01-01",
                    },
                    {
                      title: "beta-new",
                      url: "https://beta-new.example/",
                      publishedDate: "2026-01-01",
                    },
                  ],
          }),
        })
      )
  );
  assert.deepEqual(
    result.map(response => response.results.map(item => item.title)),
    [
      ["alpha-old", "alpha-new"],
      ["beta-old", "beta-new", "beta-undated"],
    ]
  );
});

test("native component failures propagate without a fallback", async () => {
  const unavailable = new Error("native_search component is unavailable");
  await assert.rejects(
    searchSearXNG(
      "fixture",
      normalizeSearchInput({ query: "fixture" }),
      "/work/project",
      "session-a",
      undefined,
      async () => {
        throw unavailable;
      }
    ),
    error => error === unavailable
  );
});

test("native search forwards cancellation to the browser bridge", async () => {
  const controller = new AbortController();
  let forwardedSignal: AbortSignal | undefined;
  const pending = searchSearXNG(
    "cancel me",
    normalizeSearchInput({ query: "cancel me" }),
    "/work/project",
    "session-a",
    controller.signal,
    async (_tool, _args, _cwd, _clientId, signal) => {
      forwardedSignal = signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(new Error("Browser tool call was aborted")),
          { once: true }
        );
      });
    }
  );
  controller.abort();
  await assert.rejects(pending, /Web search was cancelled/);
  assert.equal(forwardedSignal, controller.signal);
});

test("query batches preserve order and cancel siblings on first failure", async () => {
  const input = normalizeSearchInput({ queries: ["slow", "fast"] });
  const ordered = await searchSearXBatch(
    input.queries,
    input,
    "/work/project",
    "session-a",
    undefined,
    async query => {
      await new Promise(resolve =>
        setTimeout(resolve, query === "slow" ? 30 : 1)
      );
      return queryResponse(query);
    }
  );
  assert.deepEqual(
    ordered.map(result => result.query),
    ["slow", "fast"]
  );

  let siblingCancelled = false;
  await assert.rejects(
    searchSearXBatch(
      ["fail", "sibling"],
      input,
      "/work/project",
      "session-a",
      undefined,
      async (query, _normalized, _cwd, _sessionId, signal) => {
        if (query === "fail") {
          throw new Error("fixture failure");
        }
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(queryResponse(query)), 5_000);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              siblingCancelled = true;
              reject(new Error("fixture sibling cancelled"));
            },
            { once: true }
          );
        });
      }
    ),
    /fixture failure/
  );
  assert.equal(siblingCancelled, true);
});

test("search implementation has no service filesystem, environment, socket, or HTTP path", () => {
  const directory = dirname(fileURLToPath(import.meta.url));
  const sourceRoot = join(directory, "..");
  const source = readFileSync(join(sourceRoot, "searxng.ts"), "utf8");
  assert.doesNotMatch(
    source,
    /node:(?:fs|http|https|net)|process\.env|\bfetch\s*\(|connection\.ts|http:\/\/127\.0\.0\.1/
  );
  assert.ok(!readdirSync(sourceRoot).includes("connection.ts"));
  assert.match(source, /await call\(\s*"native_search"/);
});
