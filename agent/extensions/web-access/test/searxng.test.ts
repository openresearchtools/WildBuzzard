/* SPDX-License-Identifier: AGPL-3.0-or-later */

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { normalizeSearchInput } from "../contracts.ts";
import { readSearchConnection, requestSearchService } from "../connection.ts";
import { searchSearXBatch, searchSearXNG } from "../searxng.ts";

const token = "a".repeat(64);

function record(port: number) {
  return {
    version: 1,
    protocolVersion: 1,
    runtimeVersion: "test-runtime",
    address: "127.0.0.1",
    port,
    token,
    pid: process.pid,
    processStartTime: "12345",
    executablePath: "/opt/wildbuzzard/search-gateway",
    executableSha256: "0".repeat(64),
    dataRootId: "test-data-root",
    ownerInstanceId: "test-owner",
    createdAt: 1_775_990_400_000,
    lastHealthAt: 1_775_990_401_000,
  };
}

function installConnection(
  t: TestContext,
  port: number,
  value: Record<string, unknown> = record(port)
): void {
  const directory = mkdtempSync(join(tmpdir(), "wildbuzzard-search-test-"));
  const connectionFile = join(directory, "connection.json");
  writeFileSync(connectionFile, JSON.stringify(value), { mode: 0o600 });
  chmodSync(connectionFile, 0o600);
  const previous = process.env.WILDBUZZARD_SEARCH_CONNECTION_FILE;
  process.env.WILDBUZZARD_SEARCH_CONNECTION_FILE = connectionFile;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.WILDBUZZARD_SEARCH_CONNECTION_FILE;
    } else {
      process.env.WILDBUZZARD_SEARCH_CONNECTION_FILE = previous;
    }
    rmSync(directory, { recursive: true });
  });
}

test("managed SearXNG client uses private capability-authenticated POST", async t => {
  let seen: {
    method?: string;
    url?: string;
    authorization?: string;
    accept?: string;
    contentType?: string;
    body?: string;
  } = {};
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      seen = {
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        accept: request.headers.accept,
        contentType: request.headers["content-type"],
        body: Buffer.concat(chunks).toString("utf8"),
      };
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          answers: [{ answer: "typed", source: "calculator" }],
          corrections: [{ correction: "corrected" }],
          suggestions: ["suggestion"],
          unresponsive_engines: [["engine", "timeout"]],
          results: [
            {
              title: "Allowed",
              url: "https://docs.example.com/allowed",
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
            {
              title: "Credential URL",
              url: "https://user:secret@docs.example.com/private",
            },
          ],
        })
      );
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const directory = mkdtempSync(join(tmpdir(), "wildbuzzard-search-test-"));
  const connectionFile = join(directory, "connection.json");
  writeFileSync(connectionFile, JSON.stringify(record(address.port)), {
    mode: 0o600,
  });
  chmodSync(connectionFile, 0o600);
  const previous = process.env.WILDBUZZARD_SEARCH_CONNECTION_FILE;
  process.env.WILDBUZZARD_SEARCH_CONNECTION_FILE = connectionFile;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.WILDBUZZARD_SEARCH_CONNECTION_FILE;
    } else {
      process.env.WILDBUZZARD_SEARCH_CONNECTION_FILE = previous;
    }
    rmSync(directory, { recursive: true });
  });

  const result = await searchSearXNG(
    "gecko renderer",
    normalizeSearchInput({
      query: "gecko renderer",
      numResults: 10,
      includeContent: true,
      recencyFilter: "week",
      domainFilter: ["example.com"],
    })
  );
  assert.equal(seen.method, "POST");
  assert.equal(seen.url, "/search");
  assert.equal(seen.authorization, `Bearer ${token}`);
  assert.equal(seen.contentType, "application/x-www-form-urlencoded");
  assert.doesNotMatch(seen.url ?? "", /gecko|token|aaaa/);
  const body = new URLSearchParams(seen.body);
  assert.equal(body.get("q"), "gecko renderer site:example.com");
  assert.equal(body.get("format"), "json");
  assert.equal(body.get("time_range"), "week");
  assert.deepEqual(result.answers, [{ answer: "typed", source: "calculator" }]);
  assert.equal(result.results.length, 1);
  assert.deepEqual(result.results[0], {
    title: "Allowed",
    url: "https://docs.example.com/allowed",
    snippet: "Evidence",
    engines: ["duckduckgo", "wikipedia"],
    score: 2.5,
    date: "2026-08-10",
    contentPreview: "Evidence",
  });

  const overrideResponse = await requestSearchService("/search", {
    method: "POST",
    headers: {
      Accept: "text/html",
      Authorization: "Bearer attacker-controlled",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "q=override&format=json",
  });
  await overrideResponse.body?.cancel();
  assert.equal(seen.authorization, `Bearer ${token}`);
  assert.equal(seen.accept, "application/json");
});

test("client rejects malformed and oversized responses without exposing error bodies", async t => {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      const query = new URLSearchParams(Buffer.concat(chunks).toString()).get(
        "q"
      );
      if (query === "http-error") {
        response.writeHead(502, { "Content-Type": "application/json" });
        response.end('{"error":"Bearer top-secret private-query"}');
      } else if (query === "malformed") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end("{");
      } else if (query === "typed") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ results: [], answers: { answer: 1 } }));
      } else if (query === "non-json") {
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end("<title>not JSON</title>");
      } else {
        response.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Length": String(4 * 1024 * 1024 + 1),
        });
        response.end();
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  installConnection(t, address.port);
  const inputFor = (query: string) => normalizeSearchInput({ query });

  await assert.rejects(
    searchSearXNG("malformed", inputFor("malformed")),
    /invalid JSON/
  );
  await assert.rejects(
    searchSearXNG("typed", inputFor("typed")),
    /invalid answers/
  );
  await assert.rejects(
    searchSearXNG("non-json", inputFor("non-json")),
    /non-JSON/
  );
  await assert.rejects(
    searchSearXNG("oversized", inputFor("oversized")),
    /byte limit/
  );
  const error = (await searchSearXNG(
    "http-error",
    inputFor("http-error")
  ).catch(value => value as Error)) as Error;
  assert.match(error.message, /returned 502/);
  assert.doesNotMatch(error.message, /top-secret|private-query|Bearer/i);
});

test("client supports concurrent calls and prompt cancellation", async t => {
  let active = 0;
  let maximumActive = 0;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      const query =
        new URLSearchParams(Buffer.concat(chunks).toString()).get("q") ?? "";
      if (query === "cancel-body") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.write('{"results":[');
        const timer = setTimeout(() => response.end("]}"), 2_000);
        response.on("close", () => clearTimeout(timer));
        return;
      }
      active++;
      maximumActive = Math.max(maximumActive, active);
      const timer = setTimeout(
        () => {
          active--;
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(
            JSON.stringify({
              results: [
                {
                  title: query,
                  url: `https://example.test/${encodeURIComponent(query)}`,
                },
              ],
            })
          );
        },
        query === "cancel-me" ? 2_000 : 50
      );
      response.on("close", () => {
        clearTimeout(timer);
      });
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>(resolve => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  installConnection(t, address.port);

  const [first, second] = await Promise.all(
    ["first", "second"].map(query =>
      searchSearXNG(query, normalizeSearchInput({ query }))
    )
  );
  assert.equal(maximumActive, 2);
  assert.equal(first.results[0].title, "first");
  assert.equal(second.results[0].title, "second");

  const controller = new AbortController();
  const pending = searchSearXNG(
    "cancel-me",
    normalizeSearchInput({ query: "cancel-me" }),
    controller.signal
  );
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, /cancelled/);

  const bodyController = new AbortController();
  const bodyPending = searchSearXNG(
    "cancel-body",
    normalizeSearchInput({ query: "cancel-body" }),
    bodyController.signal
  );
  setTimeout(() => bodyController.abort(), 20);
  await assert.rejects(bodyPending, /cancelled/);
});

test("query batches preserve input order and cancel siblings on failure", async () => {
  const input = normalizeSearchInput({ queries: ["slow", "fast"] });
  const responseFor = (query: string) => ({
    query,
    answers: [],
    corrections: [],
    suggestions: [],
    unresponsiveEngines: [],
    results: [],
  });
  const ordered = await searchSearXBatch(
    input.queries,
    input,
    undefined,
    async query => {
      await new Promise(resolve =>
        setTimeout(resolve, query === "slow" ? 30 : 1)
      );
      return responseFor(query);
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
      undefined,
      async (query, _normalized, signal) => {
        if (query === "fail") {
          throw new Error("fixture failure");
        }
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(responseFor(query)), 5_000);
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

test("connection reader follows the exact managed service record schema", t => {
  const expected = record(30000);
  installConnection(t, 30000, expected);
  assert.deepEqual(readSearchConnection(), expected);
});

test("connection reader rejects invalid epoch timestamp ordering", t => {
  installConnection(t, 30000, {
    ...record(30000),
    lastHealthAt: 1_775_990_399_999,
  });
  assert.throws(() => readSearchConnection(), /invalid/);
});

test("connection reader rejects fields outside the managed schema", t => {
  installConnection(t, 30000, {
    ...record(30000),
    unexpected: true,
  });
  assert.throws(() => readSearchConnection(), /invalid/);
});

test("connection reader rejects a group-readable capability record", () => {
  const directory = mkdtempSync(join(tmpdir(), "wildbuzzard-search-mode-"));
  const connectionFile = join(directory, "connection.json");
  writeFileSync(connectionFile, JSON.stringify(record(30000)), { mode: 0o640 });
  chmodSync(connectionFile, 0o640);
  const previous = process.env.WILDBUZZARD_SEARCH_CONNECTION_FILE;
  process.env.WILDBUZZARD_SEARCH_CONNECTION_FILE = connectionFile;
  try {
    assert.throws(() => readSearchConnection(), /not private/);
  } finally {
    if (previous === undefined) {
      delete process.env.WILDBUZZARD_SEARCH_CONNECTION_FILE;
    } else {
      process.env.WILDBUZZARD_SEARCH_CONNECTION_FILE = previous;
    }
    rmSync(directory, { recursive: true });
  }
});
