/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

export type BrowserContent =
  | { type: "text"; text: string }
  | { type: "image"; path: string; mimeType: string };

export interface BrowserToolResult {
  content: BrowserContent[];
  details?: unknown;
}

interface CliResult extends BrowserToolResult {
  ok: boolean;
  error?: string;
}

function sessionName(clientId: string): string {
  const digest = createHash("sha256").update(clientId).digest("hex").slice(0, 24);
  return `compat-${digest}`;
}

export function callBrowserTool(
  tool: string,
  args: unknown,
  cwd: string,
  clientId: string,
  signal?: AbortSignal
): Promise<BrowserToolResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.env.WILDBUZZARD_COMMAND ?? "/usr/bin/wildbuzzard",
      [
        "--json",
        "--cwd",
        cwd,
        "--session",
        sessionName(clientId),
        "--input",
        JSON.stringify(args ?? {}),
        tool,
      ],
      {
        cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error, result?: BrowserToolResult) => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener("abort", abort);
      if (error) {
        reject(error);
      } else if (result) {
        resolve(result);
      } else {
        reject(new Error(`${tool} returned no result`));
      }
    };
    const abort = () => {
      child.kill("SIGTERM");
      finish(new Error("Browser tool call was aborted"));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > 64 * 1024 * 1024) {
        child.kill("SIGTERM");
        finish(new Error(`${tool} returned an oversized response`));
      }
    });
    child.stderr.on("data", chunk => {
      stderr += chunk;
      if (Buffer.byteLength(stderr) > 1024 * 1024) {
        child.kill("SIGTERM");
        finish(new Error(`${tool} returned oversized diagnostics`));
      }
    });
    child.once("error", error => finish(error));
    child.once("exit", code => {
      if (settled) {
        return;
      }
      let response: CliResult | undefined;
      try {
        response = JSON.parse(stdout.trim()) as CliResult;
      } catch {}
      if (code !== 0 || !response?.ok) {
        let message = stderr.trim();
        try {
          message = (JSON.parse(message) as { error?: string }).error ?? message;
        } catch {}
        finish(new Error(response?.error ?? (message || `${tool} failed`)));
        return;
      }
      finish(undefined, {
        content: response.content,
        details: response.details,
      });
    });
  });
}
