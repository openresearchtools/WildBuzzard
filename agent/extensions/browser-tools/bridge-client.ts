/* SPDX-License-Identifier: AGPL-3.0-or-later */
/*
 * Derived from BrowserOS browser-core transport concepts.
 * Copyright (C) BrowserOS contributors.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createConnection } from "node:net";
import { join } from "node:path";

export type BrowserContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface BrowserToolResult {
  content: BrowserContent[];
  details?: unknown;
}

interface BridgeResponse {
  id: string;
  ok: boolean;
  result?: BrowserToolResult;
  error?: string;
}

let sequence = 0;

function browserControlConnection():
  | { port: number; token: string }
  | undefined {
  const xdgRuntimeDir = process.env.XDG_RUNTIME_DIR;
  const defaultConnectionFile =
    xdgRuntimeDir === undefined || xdgRuntimeDir === ""
      ? join(
          homedir(),
          ".local",
          "share",
          "wildbuzzard",
          "agent",
          "run",
          "wildbuzzard-agent",
          "browser-control.json"
        )
      : join(xdgRuntimeDir, "wildbuzzard-agent", "browser-control.json");
  const connectionFile =
    process.env.WILDBUZZARD_BROWSER_CONTROL_FILE ?? defaultConnectionFile;
  try {
    const value = JSON.parse(readFileSync(connectionFile, "utf8")) as {
      port?: unknown;
      token?: unknown;
    };
    const port = Number(value.port);
    if (
      Number.isInteger(port) &&
      port > 0 &&
      port <= 65535 &&
      typeof value.token === "string" &&
      value.token !== ""
    ) {
      return { port, token: value.token };
    }
  } catch {}

  const port = Number.parseInt(
    process.env.WILDBUZZARD_BROWSER_CONTROL_PORT ?? "",
    10
  );
  const token = process.env.WILDBUZZARD_BROWSER_CONTROL_TOKEN;
  return Number.isInteger(port) && port > 0 && port <= 65535 && token
    ? { port, token }
    : undefined;
}

export function callBrowserTool(
  tool: string,
  args: unknown,
  cwd: string,
  clientId: string,
  signal?: AbortSignal
): Promise<BrowserToolResult> {
  const connection = browserControlConnection();
  if (!connection) {
    return Promise.reject(
      new Error("WildBuzzard browser control is unavailable")
    );
  }
  const { port, token } = connection;

  const id = `browser-${process.pid}-${++sequence}`;
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let buffer = "";
    let settled = false;

    const finish = (error?: Error, result?: BrowserToolResult) => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      if (error) {
        reject(error);
      } else if (result) {
        resolve(result);
      } else {
        reject(new Error("WildBuzzard browser control returned no result"));
      }
    };
    const abort = () => {
      socket.write(`${JSON.stringify({ token, id, cancel: true })}\n`, () => {
        finish(new Error("Browser tool call was aborted"));
      });
    };

    if (signal?.aborted) {
      finish(new Error("Browser tool call was aborted"));
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    socket.setEncoding("utf8");
    socket.setTimeout(65_000, () =>
      finish(new Error(`${tool} timed out waiting for Gecko`))
    );
    socket.on("connect", () => {
      socket.write(
        `${JSON.stringify({
          token,
          id,
          tool,
          args,
          cwd,
          clientId,
        })}\n`
      );
    });
    socket.on("data", chunk => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }
      let response: BridgeResponse;
      try {
        response = JSON.parse(buffer.slice(0, newline)) as BridgeResponse;
      } catch {
        finish(new Error("Gecko returned an invalid browser-control response"));
        return;
      }
      if (response.id !== id) {
        finish(
          new Error("Gecko returned a mismatched browser-control response")
        );
      } else if (!response.ok) {
        finish(new Error(response.error ?? `${tool} failed`));
      } else {
        finish(undefined, response.result);
      }
    });
    socket.on("error", error => finish(error));
    socket.on("end", () =>
      finish(new Error("Gecko closed the browser-control connection"))
    );
  });
}
