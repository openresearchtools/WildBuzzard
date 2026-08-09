/* SPDX-License-Identifier: AGPL-3.0-or-later */

import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import browserTools from "../index.ts";
import { BROWSER_TOOL_CATALOG } from "../catalog.ts";

test("the Pi extension registers every tool and its skill", async () => {
  const registered: Array<Record<string, unknown>> = [];
  let discover: (() => Promise<{ skillPaths?: string[] }>) | undefined;
  const pi = {
    registerTool(definition: Record<string, unknown>) {
      registered.push(definition);
    },
    on(event: string, handler: () => Promise<{ skillPaths?: string[] }>) {
      if (event === "resources_discover") {
        discover = handler;
      }
    },
  } as unknown as ExtensionAPI;

  browserTools(pi);

  assert.deepEqual(
    registered.map(tool => tool.name),
    BROWSER_TOOL_CATALOG.map(tool => tool.name)
  );
  assert.ok(registered.every(tool => typeof tool.execute === "function"));
  assert.ok(registered.every(tool => tool.executionMode === "sequential"));
  assert.ok(discover);
  const resources = await discover();
  assert.equal(resources.skillPaths?.length, 1);
  assert.match(resources.skillPaths?.[0] ?? "", /\/skills$/);
});
