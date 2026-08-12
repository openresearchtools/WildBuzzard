/* SPDX-License-Identifier: AGPL-3.0-or-later */

import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
  canonicalizeCrawlUrl,
  crawlWithGecko,
  normalizeCrawlInput,
  parseRobots,
  parseSitemap,
  robotsAllows,
  type CrawlProgress,
} from "../crawl.ts";
import { EXTRACTED_NETWORK_BYTES, type ExtractedContent } from "../extract.ts";

function page(
  url: string,
  content: string,
  mimeType = "text/html",
  status = 200,
  finalUrl = url,
  redirectCount = 0
): ExtractedContent {
  return {
    url,
    finalUrl,
    title: "",
    content,
    error: null,
    mimeType,
    status,
    redirectCount,
    provenance: "gecko",
    trust: "untrusted",
  };
}

async function fixtureServer(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>(resolve => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const localHttpFetch: typeof import("../extract.ts").fetchWithGecko = async (
  url,
  _mode,
  _cwd,
  _sessionId,
  signal,
  options
) => {
  let current = url;
  let redirects = 0;
  while (true) {
    const currentUrl = new URL(current);
    const allowedOrigins = options?.allowedOrigins;
    if (allowedOrigins?.length && !allowedOrigins.includes(currentUrl.origin)) {
      return {
        ...page(url, "", "text/plain", 0, current, redirects),
        error: "origin is outside the renderer scope",
      };
    }
    const response = await fetch(current, {
      headers: { "user-agent": "WildBuzzard" },
      redirect: "manual",
      signal,
    });
    if (
      response.status >= 300 &&
      response.status < 400 &&
      response.headers.has("location")
    ) {
      if (redirects >= (options?.maxRedirects ?? 10)) {
        return {
          ...page(url, "", "text/plain", 0, current, redirects),
          error: "resource-limit: redirect count exceeded",
        };
      }
      current = new URL(response.headers.get("location")!, current).toString();
      redirects++;
      continue;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const content = new TextDecoder().decode(bytes);
    return {
      ...page(
        url,
        content,
        response.headers.get("content-type")?.split(";", 1)[0] ?? "",
        response.status,
        current,
        redirects
      ),
      [EXTRACTED_NETWORK_BYTES]: bytes.byteLength,
    };
  }
};

test("robots selects the most specific groups and honors allow, delay, and sitemap directives", () => {
  const policy = parseRobots(`
    User-agent: *
    Disallow: /docs
    Crawl-delay: 1

    User-agent: WildBuzzard
    User-agent: ResearchBot
    Disallow: /docs/*
    Allow: /docs/public$
    Crawl-delay: 0.01
    Sitemap: https://example.test/sitemap-index.xml.gz
  `);
  assert.equal(policy.crawlDelayMs, 10);
  assert.deepEqual(policy.sitemaps, [
    "https://example.test/sitemap-index.xml.gz",
  ]);
  assert.equal(robotsAllows(policy, "/docs/private"), false);
  assert.equal(robotsAllows(policy, "/docs/public"), true);
  assert.equal(robotsAllows(policy, "/docs/public/more"), false);
  assert.equal(robotsAllows(policy, "/elsewhere"), true);
  assert.throws(
    () => parseRobots("User-agent: *\nDisallow: /private\0ignored"),
    /control characters/
  );
});

test("canonicalization normalizes fragments, query order, tracking, and default ports", () => {
  assert.equal(
    canonicalizeCrawlUrl(
      "HTTPS://Example.Test:443/docs/../docs/page?utm_source=x&b=2&a=1&fbclid=y#part",
      false
    ),
    "https://example.test/docs/page?a=1&b=2"
  );
  assert.equal(
    canonicalizeCrawlUrl("https://example.test/page?a=1", true),
    "https://example.test/page"
  );
  assert.equal(canonicalizeCrawlUrl("https://user@example.test/", false), null);
});

test("crawl is exact breadth-first, path-scoped, robots-aware, and deterministic", async () => {
  const calls: string[] = [];
  const fixtures = new Map([
    [
      "https://example.test/robots.txt",
      page(
        "https://example.test/robots.txt",
        "User-agent: *\nDisallow: /docs/blocked\nCrawl-delay: 0",
        "text/plain"
      ),
    ],
    [
      "https://example.test/docs/",
      page(
        "https://example.test/docs/",
        `<html><head><title>Root</title></head><body><main>
          <p>Root research content with enough useful words for extraction.</p>
          <a href="one?b=2&a=1&utm_source=tracker">One</a>
          <a href="one?a=1&b=2#fragment">Duplicate</a>
          <a href="blocked">Blocked by robots</a>
          <a href="/outside">Outside subtree</a>
          <a href="https://evil.test/docs/">External</a>
        </main></body></html>`
      ),
    ],
    [
      "https://example.test/docs/one?a=1&b=2",
      page(
        "https://example.test/docs/one?a=1&b=2",
        "<html><body><main><p>Second page evidence.</p></main></body></html>"
      ),
    ],
  ]);
  const fetchPage = async (url: string) => {
    calls.push(url);
    return (
      fixtures.get(url) ?? {
        ...page(url, ""),
        error: "unexpected URL",
        status: 0,
      }
    );
  };
  const result = await crawlWithGecko(
    {
      url: "https://example.test/docs/",
      sitemap: "skip",
      maxDepth: 2,
      limit: 10,
    },
    "/workspace",
    "session",
    undefined,
    fetchPage
  );
  assert.deepEqual(
    result.documents.map(document => document.url),
    ["https://example.test/docs/", "https://example.test/docs/one?a=1&b=2"]
  );
  assert.equal(
    calls.filter(url => url === "https://example.test/robots.txt").length,
    1
  );
  assert.ok(!calls.includes("https://example.test/outside"));
  assert.ok(!calls.includes("https://evil.test/docs/"));
  assert.ok(!calls.includes("https://example.test/docs/blocked"));
  assert.equal(result.visited, 2);
  assert.equal(result.partial, false);
  assert.equal(result.stoppedReason, null);
});

test("crawl coordinates a deterministic local HTTP graph and emits bounded progress", async () => {
  const externalRequests: string[] = [];
  const external = await fixtureServer((request, response) => {
    externalRequests.push(request.url ?? "");
    response.setHeader("content-type", "text/html");
    response.end("<html><body>external</body></html>");
  });
  const requests: string[] = [];
  const fixture = await fixtureServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    requests.push(url.pathname);
    response.setHeader("content-type", "text/html; charset=utf-8");
    switch (url.pathname) {
      case "/robots.txt":
        response.setHeader("content-type", "text/plain");
        response.end(
          "User-agent: WildBuzzard\nDisallow: /docs/blocked\nCrawl-delay: 0"
        );
        break;
      case "/sitemap.xml":
        response.setHeader("content-type", "application/xml");
        response.end(
          `<urlset><url><loc>${fixture.origin}/docs/from-sitemap</loc></url><url><loc>${fixture.origin}/docs/blocked</loc></url></urlset>`
        );
        break;
      case "/docs/":
        response.end(`<html><body>
          <a href="child?b=2&amp;a=1&amp;utm_source=test">child</a>
          <a href="child?a=1&amp;b=2#fragment">duplicate</a>
          <a href="blocked">blocked</a>
          <a href="/outside">outside</a>
          <a href="canonical-alias">canonical alias</a>
          <a href="external">external redirect</a>
        </body></html>`);
        break;
      case "/docs/from-sitemap":
        response.end("<html><body><p>sitemap page</p></body></html>");
        break;
      case "/docs/child":
        response.end(
          '<html><body><p>child page</p><a href="./">cycle</a><a href="grandchild">too deep</a></body></html>'
        );
        break;
      case "/docs/canonical-alias":
        response.end(
          '<html><head><link rel="canonical" href="canonical"></head><body><p>canonical body</p></body></html>'
        );
        break;
      case "/docs/external":
        response.statusCode = 302;
        response.setHeader("location", `${external.origin}/escaped`);
        response.end();
        break;
      default:
        response.statusCode = 404;
        response.end("not found");
        break;
    }
  });
  const progress: CrawlProgress[] = [];
  try {
    const result = await crawlWithGecko(
      {
        url: `${fixture.origin}/docs/`,
        maxDepth: 1,
        maxConcurrency: 1,
      },
      "/workspace",
      "local-http",
      undefined,
      localHttpFetch,
      update => progress.push(update)
    );
    assert.deepEqual(
      result.documents.map(document => new URL(document.url).pathname),
      ["/docs/", "/docs/from-sitemap", "/docs/child", "/docs/canonical-alias"]
    );
    assert.equal(result.partial, false);
    assert.equal(result.stoppedReason, null);
    assert.equal(requests.filter(path => path === "/robots.txt").length, 1);
    assert.ok(!requests.includes("/docs/blocked"));
    assert.ok(!requests.includes("/docs/grandchild"));
    assert.ok(!requests.includes("/outside"));
    assert.deepEqual(externalRequests, []);
    assert.ok(progress.some(update => update.phase === "sitemap"));
    assert.ok(progress.some(update => update.phase === "crawl"));
    assert.ok(progress.length <= result.visited + 3);
    assert.deepEqual(progress.at(-1), {
      phase: "complete",
      rootUrl: `${fixture.origin}/docs/`,
      visited: result.visited,
      queued: 0,
      documents: result.documents.length,
      errors: result.errors.length,
      totalBytes: result.totalBytes,
      currentDepth: null,
      partial: false,
      stoppedReason: null,
    });

    requests.length = 0;
    const budgetProgress: CrawlProgress[] = [];
    const budgetResult = await crawlWithGecko(
      {
        url: `${fixture.origin}/docs/`,
        limit: 2,
      },
      "/workspace",
      "local-http-budget",
      undefined,
      localHttpFetch,
      update => budgetProgress.push(update)
    );
    assert.equal(budgetResult.visited, 2);
    assert.equal(budgetResult.partial, true);
    assert.equal(budgetResult.stoppedReason, "limit");
    assert.equal(budgetProgress.at(-1)?.partial, true);
    assert.equal(budgetProgress.at(-1)?.stoppedReason, "limit");
    assert.ok(!requests.includes("/docs/child"));
  } finally {
    await fixture.close();
    await external.close();
  }
});

test("local HTTP crawl cancellation closes the active request and reports final progress", async () => {
  const slowStarted = deferred<void>();
  const slowClosed = deferred<void>();
  const fixture = await fixtureServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    response.setHeader("content-type", "text/html");
    if (url.pathname === "/cancel/") {
      response.end('<html><body><a href="slow">slow</a></body></html>');
      return;
    }
    if (url.pathname === "/cancel/slow") {
      slowStarted.resolve(undefined);
      response.on("close", () => slowClosed.resolve(undefined));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
  const controller = new AbortController();
  const progress: CrawlProgress[] = [];
  try {
    const pending = crawlWithGecko(
      {
        url: `${fixture.origin}/cancel/`,
        robots: "ignore",
        sitemap: "skip",
        maxDepth: 1,
        timeoutMs: 10_000,
      },
      "/workspace",
      "local-http-cancel",
      controller.signal,
      localHttpFetch,
      update => progress.push(update)
    );
    await slowStarted.promise;
    controller.abort(new Error("cancelled by local fixture"));
    const result = await pending;
    await Promise.race([
      slowClosed.promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("fixture request leaked")), 1_000)
      ),
    ]);
    assert.equal(result.partial, true);
    assert.equal(result.stoppedReason, "cancelled");
    assert.equal(progress.at(-1)?.phase, "complete");
    assert.equal(progress.at(-1)?.stoppedReason, "cancelled");
  } finally {
    await fixture.close();
  }
});

test("HTML base and canonical URLs produce one deterministic document", async () => {
  const fixtures = new Map([
    [
      "https://example.test/docs/",
      page(
        "https://example.test/docs/",
        `<html><body>
          <a href="alias">Alias</a>
          <a href="canonical">Canonical</a>
        </body></html>`
      ),
    ],
    [
      "https://example.test/docs/alias",
      page(
        "https://example.test/docs/alias",
        `<html><head>
          <base href="https://example.test/docs/nested/">
          <link rel="canonical" href="../canonical">
        </head><body><p>Alias body</p><a href="child">Child</a></body></html>`
      ),
    ],
    [
      "https://example.test/docs/canonical",
      page(
        "https://example.test/docs/canonical",
        "<html><body><p>Canonical duplicate body</p></body></html>"
      ),
    ],
    [
      "https://example.test/docs/nested/child",
      page(
        "https://example.test/docs/nested/child",
        '<html><body><p>Child body</p><a href="../alias">Cycle</a></body></html>'
      ),
    ],
  ]);
  const result = await crawlWithGecko(
    {
      url: "https://example.test/docs/",
      robots: "ignore",
      sitemap: "skip",
      maxDepth: 2,
      limit: 10,
    },
    "/workspace",
    "session",
    undefined,
    async url => fixtures.get(url) ?? { ...page(url, ""), error: "unexpected" }
  );
  assert.deepEqual(
    result.documents.map(document => document.url),
    [
      "https://example.test/docs/",
      "https://example.test/docs/alias",
      "https://example.test/docs/nested/child",
    ]
  );
});

test("ordinary and gzip sitemap indexes are bounded and never fetch robots-disallowed pages", async () => {
  const index = gzipSync(`<?xml version="1.0"?>
    <sitemapindex><sitemap><loc>https://example.test/nested.xml</loc></sitemap></sitemapindex>`);
  const fixtures = new Map([
    [
      "https://example.test/robots.txt",
      page(
        "https://example.test/robots.txt",
        "User-agent: *\nDisallow: /docs/blocked\nCrawl-delay: 0\nSitemap: https://example.test/index.xml.gz",
        "text/plain"
      ),
    ],
    [
      "https://example.test/sitemap.xml",
      page("https://example.test/sitemap.xml", "missing", "text/plain", 404),
    ],
    [
      "https://example.test/index.xml.gz",
      page(
        "https://example.test/index.xml.gz",
        `data:application/gzip;base64,${index.toString("base64")}`,
        "application/gzip"
      ),
    ],
    [
      "https://example.test/nested.xml",
      page(
        "https://example.test/nested.xml",
        `<urlset>
          <url><loc>https://example.test/docs/allowed?utm_medium=test</loc></url>
          <url><loc>https://example.test/docs/blocked</loc></url>
        </urlset>`,
        "application/xml"
      ),
    ],
    [
      "https://example.test/docs/allowed",
      page(
        "https://example.test/docs/allowed",
        "<html><body><p>Sitemap evidence</p></body></html>"
      ),
    ],
  ]);
  const calls: string[] = [];
  const javascript: Array<boolean | undefined> = [];
  const result = await crawlWithGecko(
    {
      url: "https://example.test/docs/",
      sitemap: "only",
      render: "never",
      limit: 10,
    },
    "/workspace",
    "session",
    undefined,
    async (url, _mode, _cwd, _sessionId, _signal, options) => {
      calls.push(url);
      javascript.push(options?.javascript);
      return fixtures.get(url) ?? { ...page(url, ""), error: "unexpected" };
    }
  );
  assert.deepEqual(
    result.documents.map(document => document.url),
    ["https://example.test/docs/allowed"]
  );
  assert.ok(calls.includes("https://example.test/index.xml.gz"));
  assert.ok(calls.includes("https://example.test/nested.xml"));
  assert.ok(!calls.includes("https://example.test/docs/blocked"));
  assert.ok(javascript.every(value => value === false));
});

test("crawl ordering is stable across concurrent origins", async () => {
  const fixtures = new Map([
    [
      "https://example.test/",
      page(
        "https://example.test/",
        '<html><body><a href="https://slow.test/a">A</a><a href="https://fast.test/b">B</a></body></html>'
      ),
    ],
    [
      "https://slow.test/a",
      page("https://slow.test/a", "<html><body><p>Slow</p></body></html>"),
    ],
    [
      "https://fast.test/b",
      page("https://fast.test/b", "<html><body><p>Fast</p></body></html>"),
    ],
  ]);
  const result = await crawlWithGecko(
    {
      url: "https://example.test/",
      allowExternalLinks: true,
      robots: "ignore",
      sitemap: "skip",
      maxDepth: 1,
      maxConcurrency: 2,
    },
    "/workspace",
    "session",
    undefined,
    async url => {
      if (url.includes("slow.test")) {
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      return fixtures.get(url)!;
    }
  );
  assert.deepEqual(
    result.documents.map(document => document.url),
    ["https://example.test/", "https://slow.test/a", "https://fast.test/b"]
  );
});

test("subdomains are opt-in and remain inside the renderer origin scope", async () => {
  const calls: string[] = [];
  const fetchPage = async (
    url: string,
    _mode: "readable" | "raw",
    _cwd: string,
    _sessionId: string,
    _signal?: AbortSignal,
    options?: { allowedOrigins?: string[]; allowSubdomains?: boolean }
  ) => {
    calls.push(url);
    if (url === "https://example.test/docs/") {
      return page(
        url,
        '<html><body><a href="https://sub.example.test/docs/a">Sub</a><a href="https://example.test.attacker.invalid/docs/a">Evil</a></body></html>'
      );
    }
    assert.deepEqual(options?.allowedOrigins, [
      "https://example.test",
      "https://sub.example.test",
    ]);
    assert.equal(options?.allowSubdomains, true);
    return page(url, "<html><body><p>Subdomain</p></body></html>");
  };
  let result = await crawlWithGecko(
    {
      url: "https://example.test/docs/",
      robots: "ignore",
      sitemap: "skip",
      maxDepth: 1,
    },
    "/workspace",
    "session",
    undefined,
    fetchPage
  );
  assert.equal(result.documents.length, 1);
  assert.equal(calls.length, 1);

  calls.length = 0;
  result = await crawlWithGecko(
    {
      url: "https://example.test/docs/",
      robots: "ignore",
      sitemap: "skip",
      maxDepth: 1,
      allowSubdomains: true,
    },
    "/workspace",
    "session",
    undefined,
    fetchPage
  );
  assert.deepEqual(
    result.documents.map(document => document.url),
    ["https://example.test/docs/", "https://sub.example.test/docs/a"]
  );
  assert.ok(!calls.some(url => url.includes("attacker.invalid")));
});

test("robots crawl-delay is enforced between same-origin page requests", async () => {
  const starts: number[] = [];
  await crawlWithGecko(
    {
      url: "https://example.test/",
      sitemap: "skip",
      maxDepth: 1,
      maxConcurrency: 3,
    },
    "/workspace",
    "session",
    undefined,
    async url => {
      if (url.endsWith("/robots.txt")) {
        return page(
          url,
          "User-agent: WildBuzzard\nCrawl-delay: 0.025",
          "text/plain"
        );
      }
      starts.push(Date.now());
      return page(
        url,
        url === "https://example.test/"
          ? '<html><body><a href="/a">A</a><a href="/b">B</a></body></html>'
          : "<html><body><p>Leaf</p></body></html>"
      );
    }
  );
  assert.equal(starts.length, 3);
  assert.ok(starts[1] - starts[0] >= 20);
  assert.ok(starts[2] - starts[1] >= 20);
});

test("cancellation interrupts a pending robots crawl-delay", async () => {
  const controller = new AbortController();
  const calls: string[] = [];
  const started = Date.now();
  const pending = crawlWithGecko(
    {
      url: "https://example.test/",
      sitemap: "skip",
      timeoutMs: 10_000,
    },
    "/workspace",
    "session",
    controller.signal,
    async url => {
      calls.push(url);
      return page(url, "User-agent: WildBuzzard\nCrawl-delay: 5", "text/plain");
    }
  );
  setTimeout(() => controller.abort(new Error("cancelled by test")), 20);
  const result = await pending;
  assert.equal(result.stoppedReason, "cancelled");
  assert.deepEqual(calls, ["https://example.test/robots.txt"]);
  assert.ok(Date.now() - started < 1_000);
});

test("global byte, redirect, page, static-render, and cancellation budgets stop safely", async () => {
  let staticJavascript: boolean | undefined;
  let result = await crawlWithGecko(
    {
      url: "https://example.test/",
      robots: "ignore",
      sitemap: "skip",
      maxBytes: 64 * 1024,
      render: "never",
    },
    "/workspace",
    "session",
    undefined,
    async (url, _mode, _cwd, _sessionId, _signal, options) => {
      staticJavascript = options?.javascript;
      return page(url, "x".repeat(70 * 1024), "text/plain");
    }
  );
  assert.equal(staticJavascript, false);
  assert.equal(result.stoppedReason, "maxBytes");
  assert.equal(result.documents.length, 0);

  result = await crawlWithGecko(
    {
      url: "https://example.test/",
      robots: "ignore",
      sitemap: "skip",
    },
    "/workspace",
    "session",
    undefined,
    async url => page(url, "redirected", "text/plain", 200, url, 33)
  );
  assert.equal(result.stoppedReason, "maxRedirects");

  const controller = new AbortController();
  const started = Date.now();
  const pending = crawlWithGecko(
    {
      url: "https://example.test/",
      robots: "ignore",
      sitemap: "skip",
      timeoutMs: 10_000,
    },
    "/workspace",
    "session",
    controller.signal,
    async (url, _mode, _cwd, _sessionId, activeSignal) =>
      new Promise<ExtractedContent>((resolve, reject) => {
        const timer = setTimeout(() => resolve(page(url, "late")), 5_000);
        activeSignal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("fixture aborted"));
          },
          { once: true }
        );
      })
  );
  setTimeout(() => controller.abort(new Error("cancelled by test")), 20);
  result = await pending;
  assert.equal(result.stoppedReason, "cancelled");
  assert.equal(result.partial, true);
  assert.ok(Date.now() - started < 1_000);
});

test("concurrent page reservations cannot exceed the global byte budget", async () => {
  const budgets: number[] = [];
  const redirectBudgets: number[] = [];
  const maxBytes = 64 * 1024;
  const result = await crawlWithGecko(
    {
      url: "https://example.test/",
      robots: "ignore",
      sitemap: "skip",
      maxDepth: 1,
      maxBytes,
      maxConcurrency: 2,
    },
    "/workspace",
    "session",
    undefined,
    async (url, _mode, _cwd, _sessionId, _signal, options) => {
      const budget = options?.maxBytes ?? 0;
      budgets.push(budget);
      redirectBudgets.push(options?.maxRedirects ?? -1);
      if (url === "https://example.test/") {
        return {
          ...page(
            url,
            '<html><body><a href="/a">A</a><a href="/b">B</a></body></html>',
            "text/html",
            200,
            url,
            10
          ),
          [EXTRACTED_NETWORK_BYTES]: 1024,
        };
      }
      return {
        ...page(url, `<html><body><p>${url}</p></body></html>`),
        [EXTRACTED_NETWORK_BYTES]: budget,
      };
    }
  );
  assert.equal(budgets[0], maxBytes);
  assert.equal(budgets[1] + budgets[2], maxBytes - 1024);
  assert.equal(redirectBudgets[0], 10);
  assert.ok(redirectBudgets[1] + redirectBudgets[2] <= 32 - 10);
  assert.equal(result.totalBytes, maxBytes);
  assert.equal(result.documents.length, 3);
});

test("readability expansion cannot bypass the global byte budget", async () => {
  const root = `https://example.test/${"a".repeat(3_800)}`;
  const declaredLinks = Array.from(
    { length: 20 },
    (_, index) => `<link rel="service-doc" href="?source=${index}">`
  ).join("");
  const result = await crawlWithGecko(
    {
      url: root,
      robots: "ignore",
      sitemap: "skip",
      maxBytes: 64 * 1024,
    },
    "/workspace",
    "session",
    undefined,
    async url => ({
      ...page(
        url,
        `<html><head>${declaredLinks}</head><body><main><p>Evidence body.</p></main></body></html>`
      ),
      [EXTRACTED_NETWORK_BYTES]: 4_096,
    })
  );
  assert.equal(result.stoppedReason, "maxBytes");
  assert.equal(result.documents.length, 0);
});

test("sitemap parser rejects DTDs, malformed XML, and unsupported entities", () => {
  assert.deepEqual(
    parseSitemap("https://example.test/a\nhttps://example.test/b"),
    {
      kind: "text",
      locations: ["https://example.test/a", "https://example.test/b"],
    }
  );
  assert.throws(
    () =>
      parseSitemap(
        '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><urlset/>'
      ),
    /DTDs/
  );
  assert.throws(
    () => parseSitemap("<urlset><url><loc>&unknown;</loc></url></urlset>"),
    /unsupported entity/
  );
  assert.throws(() => parseSitemap("<urlset><url></urlset>"), /malformed/);
  assert.throws(
    () => parseSitemap('<urlset broken="yes" broken="again"/>'),
    /duplicate attributes/
  );
  assert.throws(
    () => parseSitemap("<urlset></urlset><urlset></urlset>"),
    /malformed/
  );
  assert.throws(() => parseSitemap("<urlset></urlset>trailing"), /malformed/);
});

test("crawl reports malformed gzip sitemap bodies without visiting entries", async () => {
  const result = await crawlWithGecko(
    {
      url: "https://example.test/",
      robots: "ignore",
      sitemap: "only",
    },
    "/workspace",
    "session",
    undefined,
    async url =>
      page(url, "data:application/gzip;base64,bm90IGd6aXA=", "application/gzip")
  );
  assert.equal(result.visited, 0);
  assert.equal(result.documents.length, 0);
  assert.match(result.errors[0].error, /gzip sitemap payload is malformed/);
});

test("gzip sitemap output, ratio, encoding, and crawl-byte limits are enforced", async () => {
  const crawlGzip = (compressed: Buffer, maxBytes = 10 * 1024 * 1024) =>
    crawlWithGecko(
      {
        url: "https://example.test/",
        robots: "ignore",
        sitemap: "only",
        maxBytes,
      },
      "/workspace",
      "session",
      undefined,
      async url =>
        url.endsWith("/sitemap.xml")
          ? page(
              url,
              `data:application/gzip;base64,${compressed.toString("base64")}`,
              "application/gzip"
            )
          : page(url, "sitemap leaf", "text/plain")
    );

  let result = await crawlGzip(
    gzipSync(Buffer.alloc(5 * 1024 * 1024 + 1, 0x78))
  );
  assert.match(result.errors[0].error, /decompression failed|exceeded/);

  result = await crawlGzip(gzipSync(Buffer.alloc(2 * 1024 * 1024, 0x78)));
  assert.match(result.errors[0].error, /ratio exceeded/);

  result = await crawlGzip(gzipSync(Buffer.from([0xc3, 0x28])));
  assert.match(result.errors[0].error, /encoding is invalid/);

  const utf16Xml =
    '<?xml version="1.0" encoding="UTF-16"?><urlset><url><loc>https://example.test/utf16</loc></url></urlset>';
  const utf16Bytes = Buffer.alloc(2 + utf16Xml.length * 2);
  utf16Bytes[0] = 0xff;
  utf16Bytes[1] = 0xfe;
  for (let index = 0; index < utf16Xml.length; index++) {
    utf16Bytes.writeUInt16LE(utf16Xml.charCodeAt(index), 2 + index * 2);
  }
  result = await crawlGzip(gzipSync(utf16Bytes));
  assert.deepEqual(
    result.documents.map(document => document.url),
    ["https://example.test/utf16"]
  );

  const locations = Array.from(
    { length: 2_000 },
    (_, index) =>
      `<url><loc>https://example.test/docs/${index.toString().padStart(8, "0")}</loc></url>`
  ).join("");
  result = await crawlGzip(
    gzipSync(`<urlset>${locations}</urlset>`),
    64 * 1024
  );
  assert.equal(result.stoppedReason, "maxBytes");
  assert.equal(result.documents.length, 0);
});

test("unavailable robots policies fail closed before sitemap or page fetches", async () => {
  for (const status of [401, 403, 429, 500]) {
    const calls: string[] = [];
    const result = await crawlWithGecko(
      { url: "https://example.test/", sitemap: "include" },
      "/workspace",
      "session",
      undefined,
      async url => {
        calls.push(url);
        return page(url, "unavailable", "text/plain", status);
      }
    );
    assert.deepEqual(calls, ["https://example.test/robots.txt"]);
    assert.equal(result.documents.length, 0);
    assert.equal(result.visited, 0);
  }

  const calls: string[] = [];
  const result = await crawlWithGecko(
    { url: "https://example.test/", sitemap: "include" },
    "/workspace",
    "session",
    undefined,
    async url => {
      calls.push(url);
      throw new Error("network fixture failed");
    }
  );
  assert.deepEqual(calls, ["https://example.test/robots.txt"]);
  assert.equal(result.documents.length, 0);
  assert.equal(result.visited, 0);
});

test("crawl validates every direct-call resource bound", () => {
  assert.throws(
    () => normalizeCrawlInput({ url: "https://user@example.test/" }),
    /without userinfo/
  );
  assert.throws(
    () => normalizeCrawlInput({ url: "https://example.test/", maxDepth: 9 }),
    /maxDepth/
  );
  assert.throws(
    () =>
      normalizeCrawlInput({
        url: "https://example.test/",
        allowExternalLinks: "false" as unknown as boolean,
      }),
    /allowExternalLinks/
  );
  assert.throws(
    () =>
      normalizeCrawlInput({
        url: "https://example.test/",
        sitemap: "everything" as "include",
      }),
    /sitemap/
  );
  assert.equal(
    normalizeCrawlInput({ url: "https://example.test/", render: "never" })
      .render,
    "never"
  );
  assert.throws(
    () =>
      normalizeCrawlInput({
        url: "https://example.test/",
        includePaths: new Array(51).fill("*"),
      }),
    /at most 50/
  );
});
