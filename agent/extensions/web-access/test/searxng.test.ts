/* SPDX-License-Identifier: AGPL-3.0-or-later */

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeSearchInput } from "../contracts.ts";
import { readSearchConnection } from "../connection.ts";
import { searchSearXNG } from "../searxng.ts";

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
    createdAt: Date.now(),
    lastHealthAt: Date.now(),
  };
}

test("managed SearXNG client uses private capability-authenticated POST", async t => {
  let seen: {
    method?: string;
    url?: string;
    authorization?: string;
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
  assert.deepEqual(result.answers, [
    { answer: "typed", source: "calculator" },
  ]);
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
