/* SPDX-License-Identifier: AGPL-3.0-or-later */

import assert from "node:assert/strict";
import test from "node:test";
import { BROWSER_TOOL_NAMES, browserToolsForPrompt } from "../activation.ts";
import { BROWSER_TOOL_CATALOG } from "../catalog.ts";

test("all registered browser tools participate in activation", () => {
  assert.deepEqual(
    BROWSER_TOOL_NAMES,
    BROWSER_TOOL_CATALOG.map(tool => tool.name)
  );
});

test("non-browser prompts keep only the compact browser SDK", () => {
  assert.deepEqual(browserToolsForPrompt("Refactor this local module"), [
    "tabs",
    "run",
  ]);
});

test("browser prompts activate interaction tools without every diagnostic", () => {
  const tools = browserToolsForPrompt(
    "Open https://example.com, fill the form, and take a screenshot"
  );
  for (const name of [
    "tabs",
    "navigate",
    "snapshot",
    "act",
    "read",
    "screenshot",
    "run",
  ]) {
    assert.ok(tools.includes(name), name);
  }
  assert.ok(!tools.includes("enable_debugger"));
  assert.ok(tools.length < BROWSER_TOOL_NAMES.length / 2);
});

test("specialized prompts activate stored-data, file, and diagnostic tools", () => {
  const tools = browserToolsForPrompt(
    "Bookmark this tab, inspect network responses, upload a file, then download and print it to PDF"
  );
  for (const name of [
    "bookmarks",
    "upload",
    "download",
    "list_network_requests",
    "get_network_request",
    "enable_debugger",
    "pdf",
  ]) {
    assert.ok(tools.includes(name), name);
  }
});
