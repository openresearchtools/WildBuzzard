/* SPDX-License-Identifier: AGPL-3.0-or-later */

import assert from "node:assert/strict";
import test from "node:test";
import {
  crawlWithGecko,
  normalizeCrawlInput,
} from "../crawl.ts";
import type { ExtractedContent } from "../extract.ts";

function page(
  url: string,
  content: string,
  mimeType = "text/html"
): ExtractedContent {
  return {
    url,
    finalUrl: url,
    title: "",
    content,
    error: null,
    mimeType,
    status: 200,
    provenance: "gecko",
  };
}

test("crawl is breadth-first, path-scoped, robots-aware, and deduplicated", async () => {
  const calls: string[] = [];
  const fixtures = new Map([
    [
      "https://example.test/robots.txt",
      page(
        "https://example.test/robots.txt",
        "User-agent: *\nDisallow: /docs/blocked",
        "text/plain"
      ),
    ],
    [
      "https://example.test/docs/",
      page(
        "https://example.test/docs/",
        `<html><head><title>Root</title></head><body><main>
          <p>Root research content with enough useful words for extraction.</p>
          <a href="one?b=2&a=1">One</a>
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
    const fixture = fixtures.get(url);
    return (
      fixture ?? {
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
    [
      "https://example.test/docs/",
      "https://example.test/docs/one?a=1&b=2",
    ]
  );
  assert.equal(
    calls.filter(url => url === "https://example.test/robots.txt").length,
    1
  );
  assert.ok(!calls.includes("https://example.test/outside"));
  assert.ok(!calls.includes("https://evil.test/docs/"));
  assert.ok(!calls.includes("https://example.test/docs/blocked"));
  assert.equal(result.partial, false);
  assert.equal(result.stoppedReason, null);
});

test("crawl validates resource bounds and unsupported static mode", () => {
  assert.throws(
    () => normalizeCrawlInput({ url: "https://user@example.test/" }),
    /without userinfo/
  );
  assert.throws(
    () => normalizeCrawlInput({ url: "https://example.test/", maxDepth: 9 }),
    /maxDepth/
  );
  assert.throws(
    () => normalizeCrawlInput({ url: "https://example.test/", render: "never" }),
    /static Gecko channel/
  );
});
