/* SPDX-License-Identifier: AGPL-3.0-or-later */

import assert from "node:assert/strict";
import test from "node:test";
import { WEB_TOOL_NAMES, webToolsForPrompt } from "../activation.ts";

test("web tools remain available for autonomous agent decisions", () => {
  assert.deepEqual(webToolsForPrompt("Refactor the local module"), [
    ...WEB_TOOL_NAMES,
  ]);
  assert.deepEqual(webToolsForPrompt("Show me the second result", true), [
    ...WEB_TOOL_NAMES,
  ]);
  assert.deepEqual(webToolsForPrompt("Crawl and scrape this website"), [
    ...WEB_TOOL_NAMES,
  ]);
});
