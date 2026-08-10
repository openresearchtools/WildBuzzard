/* SPDX-License-Identifier: AGPL-3.0-or-later */

import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import test, { type TestContext } from "node:test";
import { normalizeSearchInput } from "../contracts.ts";
import {
  readSearchConnection,
  requestSearchService,
  SearchConnectionTestUtils,
} from "../connection.ts";
import { searchSearXBatch, searchSearXNG } from "../searxng.ts";

const token = "a".repeat(64);
const syntheticPrivateSocket = `/tmp/wb-sx-g-${
  typeof process.getuid === "function" ? process.getuid() : 0
}-${"0".repeat(24)}-${"1".repeat(32)}/s`;

function processStartTime(pid = process.pid): string {
  const source = readFileSync(`/proc/${pid}/stat`, "ascii");
  return source
    .slice(source.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/)[19];
}

function record(privateSocket: string, port = 54321) {
  let socketIdentity = { dev: 1, ino: 1 };
  try {
    const socket = lstatSync(privateSocket);
    socketIdentity = { dev: socket.dev, ino: socket.ino };
  } catch {}
  return {
    version: 1,
    protocolVersion: 1,
    runtimeVersion: "test-runtime",
    address: "127.0.0.1",
    port,
    token,
    pid: process.pid,
    processStartTime: processStartTime(),
    executablePath: process.execPath,
    executableSha256: createHash("sha256")
      .update(readFileSync(process.execPath))
      .digest("hex"),
    dataRootId: "test-data-root",
    ownerInstanceId: "test-owner",
    createdAt: 1_775_990_400_000,
    lastHealthAt: 1_775_990_401_000,
    privateSocket,
    privateSocketDevice: socketIdentity.dev,
    privateSocketInode: socketIdentity.ino,
  };
}

function installConnection(
  t: TestContext,
  privateSocket: string,
  value: Record<string, unknown> = record(privateSocket)
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

function privateSocketDirectory(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const directory = join(
    tmpdir(),
    `wb-sx-g-${uid}-${randomBytes(12).toString("hex")}-${randomBytes(16).toString("hex")}`
  );
  mkdirSync(directory, { mode: 0o700 });
  chmodSync(directory, 0o700);
  return directory;
}

function signedResponse(
  response: ServerResponse,
  nonce: string,
  status: number,
  value: string,
  contentType = "application/json"
): void {
  const body = Buffer.from(value);
  response.writeHead(status, {
    "Content-Length": String(body.length),
    "Content-Type": contentType,
    "X-WildBuzzard-Response-Authentication":
      SearchConnectionTestUtils.responseAuthentication(
        token,
        nonce,
        status,
        contentType,
        body
      ),
  });
  response.end(body);
}

async function listenPrivate(
  t: TestContext,
  server: ReturnType<typeof createServer>
): Promise<string> {
  const directory = privateSocketDirectory();
  const socketPath = join(directory, "s");
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  chmodSync(socketPath, 0o600);
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>(resolve =>
      server.close(() => {
        rmSync(directory, { recursive: true });
        resolve();
      })
    );
  });
  return socketPath;
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
      const payload = Buffer.concat(chunks);
      const nonce = String(request.headers["x-wildbuzzard-nonce"] ?? "");
      const expected = SearchConnectionTestUtils.requestAuthentication(
        token,
        request.method ?? "",
        request.url ?? "",
        payload,
        nonce
      );
      seen = {
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        accept: request.headers.accept,
        contentType: request.headers["content-type"],
        body: payload.toString("utf8"),
      };
      assert.equal(seen.authorization, `WildBuzzard-HMAC-SHA256 ${expected}`);
      assert.doesNotMatch(seen.authorization ?? "", new RegExp(token));
      signedResponse(
        response,
        nonce,
        200,
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
  const privateSocket = await listenPrivate(t, server);
  let publicConnections = 0;
  const publicCapture = createServer((_request, response) => {
    publicConnections++;
    response.end();
  });
  await new Promise<void>(resolve =>
    publicCapture.listen(0, "127.0.0.1", resolve)
  );
  t.after(
    () => new Promise<void>(resolve => publicCapture.close(() => resolve()))
  );
  const publicAddress = publicCapture.address();
  assert.ok(publicAddress && typeof publicAddress === "object");
  installConnection(
    t,
    privateSocket,
    record(privateSocket, publicAddress.port)
  );

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
  assert.match(seen.authorization ?? "", /^WildBuzzard-HMAC-SHA256 /);
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
    provenance: "searxng",
    trust: "untrusted",
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
  assert.match(seen.authorization ?? "", /^WildBuzzard-HMAC-SHA256 /);
  assert.equal(seen.accept, "application/json");
  assert.equal(publicConnections, 0);
});

test("client rejects malformed and oversized responses without exposing error bodies", async t => {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      const nonce = String(request.headers["x-wildbuzzard-nonce"] ?? "");
      const query = new URLSearchParams(Buffer.concat(chunks).toString()).get(
        "q"
      );
      if (query === "http-error") {
        signedResponse(
          response,
          nonce,
          502,
          '{"error":"Bearer top-secret private-query"}'
        );
      } else if (query === "malformed") {
        signedResponse(response, nonce, 200, "{");
      } else if (query === "typed") {
        signedResponse(
          response,
          nonce,
          200,
          JSON.stringify({ results: [], answers: { answer: 1 } })
        );
      } else if (query === "non-json") {
        signedResponse(
          response,
          nonce,
          200,
          "<title>not JSON</title>",
          "text/html"
        );
      } else {
        signedResponse(response, nonce, 200, "x".repeat(4 * 1024 * 1024 + 1));
      }
    });
  });
  const privateSocket = await listenPrivate(t, server);
  installConnection(t, privateSocket);
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
      const nonce = String(request.headers["x-wildbuzzard-nonce"] ?? "");
      const query =
        new URLSearchParams(Buffer.concat(chunks).toString()).get("q") ?? "";
      if (query === "cancel-body") {
        const complete = Buffer.from('{"results":[]}');
        response.writeHead(200, {
          "Content-Length": String(complete.length),
          "Content-Type": "application/json",
          "X-WildBuzzard-Response-Authentication":
            SearchConnectionTestUtils.responseAuthentication(
              token,
              nonce,
              200,
              "application/json",
              complete
            ),
        });
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
          signedResponse(
            response,
            nonce,
            200,
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
  const privateSocket = await listenPrivate(t, server);
  installConnection(t, privateSocket);

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

test("live wrong PID records fail before the private socket is contacted", async t => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.end();
  });
  const privateSocket = await listenPrivate(t, server);
  const child = spawn("/bin/sleep", ["30"], {
    stdio: "ignore",
  });
  t.after(() => {
    child.kill("SIGTERM");
  });
  installConnection(t, privateSocket, {
    ...record(privateSocket),
    pid: child.pid,
    processStartTime: processStartTime(child.pid),
  });
  await assert.rejects(
    requestSearchService("/search", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "q=wrong-pid&format=json",
    }),
    /process identity changed/
  );
  assert.equal(requests, 0);
});

test("private socket peer swaps expose no capability and cannot forge a response", async t => {
  const directory = privateSocketDirectory();
  const privateSocket = join(directory, "s");
  const script = String.raw`
const fs = require("node:fs");
const net = require("node:net");
const path = process.argv[1];
const server = net.createServer(socket => {
  let request = Buffer.alloc(0);
  socket.on("data", chunk => {
    request = Buffer.concat([request, chunk]);
    const headerEnd = request.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const match = /\r\nContent-Length: (\d+)\r\n/i.exec(request.subarray(0, headerEnd + 4).toString());
    const length = match ? Number(match[1]) : 0;
    if (request.length < headerEnd + 4 + length) return;
    process.stdout.write(request.toString("base64") + "\n");
    socket.end("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}");
    server.close();
  });
});
server.listen(path, () => {
  fs.chmodSync(path, 0o600);
  process.stdout.write("ready\n");
});
`;
  const peer = spawn(process.execPath, ["-e", script, privateSocket], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  let buffered = "";
  peer.stdout.setEncoding("utf8");
  peer.stdout.on("data", chunk => {
    buffered += chunk;
    for (let newline; (newline = buffered.indexOf("\n")) >= 0; ) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      const waiter = waiters.shift();
      if (waiter) {
        waiter(line);
      } else {
        lines.push(line);
      }
    }
  });
  const readLine = () =>
    lines.length
      ? Promise.resolve(lines.shift() as string)
      : new Promise<string>(resolve => waiters.push(resolve));
  assert.equal(await readLine(), "ready");
  t.after(() => {
    peer.kill("SIGTERM");
    rmSync(directory, { recursive: true });
  });
  installConnection(t, privateSocket);
  await assert.rejects(
    requestSearchService("/search", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "q=peer-swap&format=json",
    }),
    /unavailable/
  );
  const captured = Buffer.from(await readLine(), "base64").toString("utf8");
  assert.match(captured, /WildBuzzard-HMAC-SHA256/);
  assert.doesNotMatch(captured, /Bearer/);
  assert.doesNotMatch(captured, new RegExp(token));
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
  const expected = record(syntheticPrivateSocket, 30000);
  installConnection(t, syntheticPrivateSocket, expected);
  assert.deepEqual(readSearchConnection(), expected);
});

test("connection reader rejects invalid epoch timestamp ordering", t => {
  installConnection(t, syntheticPrivateSocket, {
    ...record(syntheticPrivateSocket, 30000),
    lastHealthAt: 1_775_990_399_999,
  });
  assert.throws(() => readSearchConnection(), /invalid/);
});

test("connection reader rejects fields outside the managed schema", t => {
  installConnection(t, syntheticPrivateSocket, {
    ...record(syntheticPrivateSocket, 30000),
    unexpected: true,
  });
  assert.throws(() => readSearchConnection(), /invalid/);
});

test("connection reader rejects a group-readable capability record", () => {
  const directory = mkdtempSync(join(tmpdir(), "wildbuzzard-search-mode-"));
  const connectionFile = join(directory, "connection.json");
  writeFileSync(
    connectionFile,
    JSON.stringify(record(syntheticPrivateSocket, 30000)),
    { mode: 0o640 }
  );
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
