#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createInterface } from "node:readline";
import { invoke, VERSION } from "./service.mjs";

const tools = [
  {
    name: "torrent_sources",
    description: "List the immutable public torrent-search sources.",
    inputSchema: { type: "object", additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "torrent_search",
    description: "Search public torrent indexes and return opaque result handles.",
    inputSchema: {
      type: "object",
      required: ["query"],
      additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 1, maxLength: 256 },
        sourceIds: { type: "array", minItems: 1, maxItems: 100, uniqueItems: true, items: { type: "string" } },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "torrent_resolve",
    description: "Resolve one opaque torrent-search handle to a magnet or torrent payload.",
    inputSchema: {
      type: "object",
      required: ["resultId"],
      additionalProperties: false,
      properties: { resultId: { type: "string", pattern: "^[A-Za-z0-9_-]{32}$" } },
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "torrent_search_status",
    description: "Report whether the per-user torrent-search service is healthy.",
    inputSchema: { type: "object", additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
];

function send(id, result, error) {
  process.stdout.write(`${JSON.stringify(error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result })}\n`);
}

createInterface({ input: process.stdin }).on("line", async line => {
  try {
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      send(message.id, {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "buzzard-torrent-search", version: VERSION },
      });
    } else if (message.method === "ping") {
      send(message.id, {});
    } else if (message.method === "tools/list") {
      send(message.id, { tools });
    } else if (message.method === "tools/call") {
      try {
        const result = await invoke(message.params?.name, message.params?.arguments || {});
        send(message.id, {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        });
      } catch (error) {
        send(message.id, { content: [{ type: "text", text: error.message || String(error) }], isError: true });
      }
    } else if (message.id !== undefined) {
      send(message.id, undefined, { code: -32601, message: "Method not found" });
    }
  } catch (error) {
    process.stderr.write(`buzzard-torrent-search-mcp: ${error.message || String(error)}\n`);
  }
});
