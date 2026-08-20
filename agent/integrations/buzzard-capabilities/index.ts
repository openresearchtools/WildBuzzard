/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

type JsonObject = Record<string, unknown>;

type McpTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: JsonObject;
  annotations?: { readOnlyHint?: boolean };
};

type McpResult = {
  content?: Array<Record<string, unknown>>;
  structuredContent?: unknown;
  isError?: boolean;
};

type PendingRequest = {
  resolve(value: JsonObject): void;
  reject(error: Error): void;
};

type ServerDefinition = {
  id: string;
  command: string;
  args: string[];
  aliases?: Record<string, string>;
  optional?: boolean;
};

const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;

const SERVER_DEFINITIONS: ServerDefinition[] = [
  {
    id: "searx",
    command: process.env.BUZZARD_SEARCH_MCP_COMMAND || "buzzard-search-mcp",
    args: [],
  },
  {
    id: "quick-search",
    command:
      process.env.BUZZARD_QUICK_SEARCH_MCP_COMMAND ||
      "buzzard-quick-search-mcp",
    args: [],
    aliases: { web_search: "quick_web_search" },
  },
  {
    id: "torrent-search",
    command:
      process.env.BUZZARD_TORRENT_SEARCH_MCP_COMMAND ||
      "buzzard-torrent-search-mcp",
    args: [],
  },
  {
    id: "torrent",
    command: process.env.BUZZARD_TORRENT_MCP_COMMAND || "buzzard-torrent-mcp",
    args: [],
  },
];

function errorText(result: McpResult): string {
  const text = result.content
    ?.filter(item => item.type === "text" && typeof item.text === "string")
    .map(item => item.text)
    .join("\n");
  return text || "MCP tool call failed";
}

export class StdioMcpClient {
  readonly definition: ServerDefinition;
  readonly child: ChildProcessWithoutNullStreams;
  readonly tools: McpTool[] = [];
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private stderr = "";
  private closed = false;

  constructor(definition: ServerDefinition) {
    this.definition = definition;
    this.child = spawn(definition.command, definition.args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.on("data", chunk => {
      if (this.stderr.length < 64 * 1024) {
        this.stderr += chunk.toString("utf8").slice(0, 64 * 1024 - this.stderr.length);
      }
    });
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on("line", line => this.receive(line));
    this.child.on("error", error => this.fail(error));
    this.child.on("exit", (code, signal) => {
      if (!this.closed) {
        const detail = this.stderr.trim();
        this.fail(
          new Error(
            detail ||
              `${definition.command} exited before completing the request (${signal || code})`
          )
        );
      }
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "buzzard-agent", version: "0.84.1" },
    });
    this.notify("notifications/initialized", {});
    const result = await this.request("tools/list", {});
    if (!Array.isArray(result.tools)) {
      throw new Error(`${this.definition.command} returned an invalid tool catalog`);
    }
    for (const value of result.tools) {
      if (
        value &&
        typeof value === "object" &&
        typeof value.name === "string" &&
        value.inputSchema &&
        typeof value.inputSchema === "object"
      ) {
        this.tools.push(value as McpTool);
      }
    }
  }

  async call(
    name: string,
    args: unknown,
    signal?: AbortSignal
  ): Promise<McpResult> {
    const result = (await this.request(
      "tools/call",
      { name, arguments: args },
      signal
    )) as McpResult;
    if (result.isError) throw new Error(errorText(result));
    return result;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin.end();
    this.child.kill("SIGTERM");
    this.fail(new Error(`${this.definition.command} connection closed`));
  }

  private request(
    method: string,
    params: JsonObject,
    signal?: AbortSignal
  ): Promise<JsonObject> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error(`${this.definition.command} connection is closed`));
        return;
      }
      const abort = () => {
        this.pending.delete(id);
        this.notify("notifications/cancelled", { requestId: id });
        reject(new Error(`${method} was aborted`));
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        resolve(value) {
          signal?.removeEventListener("abort", abort);
          resolve(value);
        },
        reject(error) {
          signal?.removeEventListener("abort", abort);
          reject(error);
        },
      });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: JsonObject): void {
    if (!this.closed) this.write({ jsonrpc: "2.0", method, params });
  }

  private write(message: JsonObject): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(line: string): void {
    if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES) {
      this.fail(new Error(`${this.definition.command} returned an oversized message`));
      this.child.kill("SIGTERM");
      return;
    }
    let message: JsonObject;
    try {
      message = JSON.parse(line) as JsonObject;
    } catch {
      this.fail(new Error(`${this.definition.command} returned invalid JSON`));
      this.child.kill("SIGTERM");
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error && typeof message.error === "object") {
      const error = message.error as JsonObject;
      pending.reject(
        new Error(
          typeof error.message === "string"
            ? error.message
            : `${this.definition.command} request failed`
        )
      );
      return;
    }
    if (!message.result || typeof message.result !== "object") {
      pending.reject(new Error(`${this.definition.command} returned an invalid response`));
      return;
    }
    pending.resolve(message.result as JsonObject);
  }

  private fail(error: Error): void {
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

function selectedServers(): ServerDefinition[] {
  const configured = process.env.BUZZARD_AGENT_CAPABILITIES;
  if (!configured) return SERVER_DEFINITIONS;
  const enabled = new Set(
    configured
      .split(",")
      .map(value => value.trim())
      .filter(Boolean)
  );
  return SERVER_DEFINITIONS.filter(server => enabled.has(server.id));
}

export default async function buzzardCapabilities(pi: ExtensionAPI) {
  const clients: StdioMcpClient[] = [];
  const names = new Set<string>();
  const definitions = selectedServers();
  const starts = await Promise.allSettled(
    definitions.map(async definition => {
      const client = new StdioMcpClient(definition);
      try {
        await client.initialize();
        return client;
      } catch (error) {
        client.close();
        throw error;
      }
    })
  );

  starts.forEach((result, index) => {
    const definition = definitions[index];
    if (result.status === "rejected") {
      if (!definition.optional) {
        process.stderr.write(
          `buzzard-agent: ${definition.id} MCP unavailable: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}\n`
        );
      }
      return;
    }
    const client = result.value;
    clients.push(client);
    for (const tool of client.tools) {
      const name = definition.aliases?.[tool.name] || tool.name;
      if (names.has(name)) {
        process.stderr.write(
          `buzzard-agent: ignored duplicate MCP tool ${name} from ${definition.id}\n`
        );
        continue;
      }
      names.add(name);
      pi.registerTool({
        name,
        label: tool.title || name.replaceAll("_", " "),
        description: tool.description || `${definition.id} MCP tool ${tool.name}`,
        parameters: tool.inputSchema as TSchema,
        executionMode: tool.annotations?.readOnlyHint ? "parallel" : "sequential",
        async execute(_id, params, signal) {
          const result = await client.call(tool.name, params, signal);
          return {
            content: (result.content || []) as Array<{ type: "text"; text: string }>,
            details: result.structuredContent,
          };
        },
      });
    }
  });

  pi.on("session_shutdown", async () => {
    for (const client of clients) client.close();
  });
}
