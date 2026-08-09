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
