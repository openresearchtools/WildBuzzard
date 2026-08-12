/* SPDX-License-Identifier: AGPL-3.0-or-later */

import assert from "node:assert/strict";
import test from "node:test";
import { BROWSER_TOOL_CATALOG } from "../catalog.ts";
import { assertBrowserToolParameters } from "../validation.ts";

const definitions = new Map(
  BROWSER_TOOL_CATALOG.map(definition => [definition.name, definition])
);

test("nested SDK calls use the public tool schemas", () => {
  const tabs = definitions.get("tabs");
  assert.ok(tabs);
  assert.doesNotThrow(() =>
    assertBrowserToolParameters("tabs", tabs.parameters, {
      action: "activate",
      page: 1,
    })
  );
  assert.throws(
    () =>
      assertBrowserToolParameters("tabs", tabs.parameters, {
        action: "teleport",
        page: 1,
      }),
    /tabs: invalid arguments/
  );
  assert.throws(
    () =>
      assertBrowserToolParameters("tabs", tabs.parameters, {
        action: "activate",
        page: -1,
      }),
    /tabs: invalid arguments/
  );
  assert.doesNotThrow(() =>
    assertBrowserToolParameters("tabs", tabs.parameters, {
      action: "new",
      url: "https://example.com",
      windowId: 12,
      tabGroupId: "group-1",
    })
  );
});

test("history result count is bounded", () => {
  const history = definitions.get("history");
  assert.ok(history);
  assert.throws(
    () =>
      assertBrowserToolParameters("history", history.parameters, {
        maxResults: 501,
      }),
    /history: invalid arguments/
  );
});

test("native search arguments enforce the audited native boundary", () => {
  const search = definitions.get("native_search");
  assert.ok(search);
  assert.doesNotThrow(() =>
    assertBrowserToolParameters("native_search", search.parameters, {
      query: "x".repeat(512),
      engines: Array.from({ length: 332 }, (_, index) => `engine-${index}`),
      language: "en-GB",
      page: 10,
      timeRange: "year",
      safeSearch: 1,
      maxResults: 100,
    })
  );
  assert.doesNotThrow(() =>
    assertBrowserToolParameters("native_search", search.parameters, {
      query: "all eligible engines",
      language: "all",
    })
  );
  assert.doesNotThrow(() =>
    assertBrowserToolParameters("native_search", search.parameters, {
      query: "💡".repeat(512),
      language: "en--GB",
    })
  );
  for (const invalid of [
    { query: "x".repeat(513) },
    {
      query: "x",
      engines: Array.from({ length: 333 }, (_, index) => `engine-${index}`),
    },
    { query: "x", engines: ["wikipedia", "wikipedia"] },
    { query: "x", categories: ["general"] },
    { query: "x", language: "en_GB" },
    { query: "x", page: 11 },
    { query: "x", safeSearch: 0 },
    { query: "x", maxResults: 101 },
    { query: "x", unexpected: true },
  ]) {
    assert.throws(
      () =>
        assertBrowserToolParameters(
          "native_search",
          search.parameters,
          invalid
        ),
      /native_search: invalid arguments/
    );
  }
});
