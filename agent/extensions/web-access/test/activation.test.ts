/* SPDX-License-Identifier: AGPL-3.0-or-later */

import assert from "node:assert/strict";
import test from "node:test";
import { WEB_TOOL_NAMES, webToolsForPrompt } from "../activation.ts";

test("web tools remain compact while stored-result follow-ups stay usable", () => {
  assert.deepEqual(webToolsForPrompt("Refactor the local module"), []);
  assert.deepEqual(webToolsForPrompt("Show me the second result", true), [
    "fetch_content",
    "get_search_content",
  ]);
  assert.deepEqual(webToolsForPrompt("Crawl and scrape this website"), [
    ...WEB_TOOL_NAMES,
  ]);
});
