/* SPDX-License-Identifier: AGPL-3.0-or-later */
/*
 * WildBuzzard browser tools for Pi.
 * Derived from BrowserOS browseros-core and browseros-mcp.
 * Copyright (C) BrowserOS contributors.
 */

import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BROWSER_TOOL_NAMES, browserToolsForPrompt } from "./activation.ts";
import {
  BROWSER_TOOL_CATALOG,
  BROWSER_TOOL_PROMPT_GUIDELINES,
  BROWSER_TOOL_PROMPT_SNIPPETS,
} from "./catalog.ts";
import { runBrowserScript } from "./run-sdk.ts";
import { SnapshotEngine } from "./snapshot-engine.ts";
import { assertBrowserToolParameters } from "./validation.ts";

export default function browserTools(pi: ExtensionAPI) {
  const engines = new Map<string, SnapshotEngine>();
  const extensionDirectory = dirname(fileURLToPath(import.meta.url));
  const definitions = new Map(
    BROWSER_TOOL_CATALOG.map(definition => [definition.name, definition])
  );
  const engineFor = (sessionId: string) => {
    let engine = engines.get(sessionId);
    if (!engine) {
      engine = new SnapshotEngine(sessionId);
      engines.set(sessionId, engine);
    }
    return engine;
  };
  const call = (
    engine: SnapshotEngine,
    tool: string,
    args: unknown,
    cwd: string,
    signal?: AbortSignal
  ) => {
    const definition = definitions.get(tool);
    if (definition) {
      assertBrowserToolParameters(tool, definition.parameters, args);
    }
    return engine.call(tool, args as Record<string, unknown>, cwd, signal);
  };
  pi.on("resources_discover", async () => ({
    skillPaths: [join(extensionDirectory, "skills")],
  }));
  const activate = (prompt: string) => {
    const browserToolNames = new Set(BROWSER_TOOL_NAMES);
    const nonBrowserTools = pi
      .getActiveTools()
      .filter(name => !browserToolNames.has(name));
    pi.setActiveTools([...nonBrowserTools, ...browserToolsForPrompt(prompt)]);
  };
  pi.on("session_start", () => activate(""));
  pi.on("session_shutdown", (_event, context) => {
    const sessionId = context.sessionManager.getSessionId();
    if (sessionId) {
      engines.delete(sessionId);
    }
  });
  pi.on("before_agent_start", event => activate(event.prompt));
  for (const definition of BROWSER_TOOL_CATALOG) {
    pi.registerTool(
      defineTool({
        name: definition.name,
        label: definition.label,
        description: definition.description,
        promptSnippet: BROWSER_TOOL_PROMPT_SNIPPETS[definition.name],
        promptGuidelines:
          definition.name === "snapshot"
            ? [...BROWSER_TOOL_PROMPT_GUIDELINES]
            : undefined,
        parameters: definition.parameters,
        executionMode: "sequential",
        async execute(_toolCallId, params, signal, _onUpdate, context) {
          const sessionId = context.sessionManager.getSessionId();
          if (!sessionId) {
            throw new Error("Pi session identity is unavailable");
          }
          const engine = engineFor(sessionId);
          if (definition.name === "run") {
            const values = params as { code: string; timeout?: number };
            return runBrowserScript(
              values.code,
              values.timeout ?? 30_000,
              (tool, args, runSignal) =>
                call(engine, tool, args, context.cwd, runSignal),
              signal
            );
          }
          return engine.call(
            definition.name,
            params as Record<string, unknown>,
            context.cwd,
            signal
          );
        },
      })
    );
  }
}
