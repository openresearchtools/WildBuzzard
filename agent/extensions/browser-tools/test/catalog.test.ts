/* SPDX-License-Identifier: AGPL-3.0-or-later */

import assert from "node:assert/strict";
import test from "node:test";
import {
  BROWSER_TOOL_CATALOG,
  BROWSER_TOOL_PROMPT_GUIDELINES,
  BROWSER_TOOL_PROMPT_SNIPPETS,
} from "../catalog.ts";

const EXPECTED_NAMES = [
  "tabs",
  "tab_groups",
  "history",
  "bookmarks",
  "navigate",
  "snapshot",
  "diff",
  "act",
  "download",
  "upload",
  "read",
  "grep",
  "list_console_messages",
  "clear_console_messages",
  "list_network_requests",
  "get_network_request",
  "enable_debugger",
  "list_scripts",
  "get_script_source",
  "set_logpoint",
  "remove_logpoint",
  "get_logpoint_results",
  "screenshot",
  "pdf",
  "wait",
  "windows",
  "evaluate",
  "native_search",
  "gecko_render",
  "run",
];

test("the public browser-tool API remains stable", () => {
  const names = BROWSER_TOOL_CATALOG.map(tool => tool.name);
  assert.deepEqual(names, EXPECTED_NAMES);
  assert.equal(new Set(names).size, names.length);
});

test("native search exposes the exact parent-process request contract", () => {
  const definition = BROWSER_TOOL_CATALOG.find(
    tool => tool.name === "native_search"
  );
  assert.ok(definition);
  assert.equal(definition.readOnly, true);
  assert.deepEqual(JSON.parse(JSON.stringify(definition.parameters)), {
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string", minLength: 1, maxLength: 512 },
      engines: {
        type: "array",
        items: { type: "string", minLength: 1, maxLength: 128 },
        maxItems: 332,
        uniqueItems: true,
      },
      language: {
        type: "string",
        minLength: 1,
        maxLength: 35,
        pattern: "^[A-Za-z0-9-]+$",
      },
      page: { type: "integer", minimum: 1, maximum: 10 },
      timeRange: {
        anyOf: ["day", "week", "month", "year"].map(value => ({
          type: "string",
          const: value,
        })),
      },
      safeSearch: { type: "number", const: 1 },
      maxResults: { type: "integer", minimum: 1, maximum: 100 },
    },
    additionalProperties: false,
  });
});

test("browser lifecycle and stored-data actions stay exposed", () => {
  const byName = new Map(BROWSER_TOOL_CATALOG.map(tool => [tool.name, tool]));
  const actions = (name: string) => {
    const schema = byName.get(name)?.parameters as {
      properties?: { action?: { anyOf?: Array<{ const?: string }> } };
    };
    return schema.properties?.action?.anyOf?.map(value => value.const);
  };

  assert.deepEqual(actions("tabs"), [
    "list",
    "active",
    "new",
    "activate",
    "claim",
    "close",
  ]);
  assert.deepEqual(actions("history"), ["list", "open"]);
  assert.deepEqual(actions("bookmarks"), ["list", "create", "remove", "open"]);
  assert.deepEqual(actions("windows"), ["list", "create", "activate", "close"]);
  const tabs = byName.get("tabs")?.parameters as {
    properties?: { tor?: { type?: string } };
  };
  assert.equal(tabs.properties?.tor?.type, "boolean");
});

test("every browser tool has concise prompt metadata", () => {
  assert.deepEqual(Object.keys(BROWSER_TOOL_PROMPT_SNIPPETS), EXPECTED_NAMES);
  for (const snippet of Object.values(BROWSER_TOOL_PROMPT_SNIPPETS)) {
    assert.ok(!snippet.includes("\n"));
    assert.ok(snippet.length <= 90, snippet);
  }
  assert.ok(
    Object.values(BROWSER_TOOL_PROMPT_SNIPPETS).join("\n").length < 1_800
  );
  assert.ok(BROWSER_TOOL_PROMPT_GUIDELINES.length <= 8);
});
