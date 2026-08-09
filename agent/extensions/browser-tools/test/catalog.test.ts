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
  "run",
];

test("the public browser-tool API remains stable", () => {
  const names = BROWSER_TOOL_CATALOG.map(tool => tool.name);
  assert.deepEqual(names, EXPECTED_NAMES);
  assert.equal(new Set(names).size, names.length);
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
