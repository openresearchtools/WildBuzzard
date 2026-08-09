/* SPDX-License-Identifier: AGPL-3.0-or-later */
/*
 * Derived from BrowserOS browseros-mcp run tool.
 * Copyright (C) BrowserOS contributors.
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { BrowserToolResult } from "./bridge-client.ts";

type ToolCaller = (
  tool: string,
  args: unknown,
  signal?: AbortSignal
) => Promise<BrowserToolResult>;

type RunnerCall = {
  type: "call";
  id: number;
  method: string;
  args: unknown[];
};

type RunnerDone = {
  type: "done";
  ok: boolean;
  value?: unknown;
  logs: string[];
  error?: string;
};

const MAX_RESULT_LINES = 2_000;
const MAX_RESULT_BYTES = 50 * 1024;

function resultValue(result: BrowserToolResult): unknown {
  if (
    result.details &&
    typeof result.details === "object" &&
    "value" in result.details
  ) {
    return (result.details as { value: unknown }).value;
  }
  return result.details;
}

function resultText(result: BrowserToolResult): string {
  const text = result.content.find(item => item.type === "text");
  return text?.type === "text" ? text.text : "";
}

function normalizePage(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }
  const page = value as Record<string, unknown>;
  const { page: legacyPage, ...rest } = page;
  return {
    pageId: legacyPage,
    ...rest,
  };
}

function page(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error("pageId argument is required");
  }
  return value;
}

function options(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

async function dispatchBrowserCall(
  method: string,
  args: unknown[],
  call: ToolCaller,
  signal: AbortSignal
): Promise<{ undefined?: true; value?: unknown }> {
  const input = (
    pageId: number,
    kind: string,
    values: Record<string, unknown> = {}
  ) => call("__sdk_input", { page: pageId, kind, ...values }, signal);
  const nav = (pageId: number, action: string, url?: string) =>
    call(
      "__sdk_nav",
      { page: pageId, action, ...(url === undefined ? {} : { url }) },
      signal
    );
  switch (method) {
    case "pages.list": {
      const result = await call("tabs", { action: "list" }, signal);
      const pages = (result.details as { pages: unknown[] }).pages;
      return { value: pages.map(normalizePage) };
    }
    case "pages.newPage": {
      const pageOptions = options(args[1]);
      if ("hidden" in pageOptions) {
        throw new Error("pages.newPage: hidden is no longer supported");
      }
      const result = await call(
        "tabs",
        {
          action: "new",
          url: args[0] ?? "about:blank",
          ...pageOptions,
        },
        signal
      );
      return { value: (result.details as { page: number }).page };
    }
    case "pages.close":
      await call("tabs", { action: "close", page: page(args[0]) }, signal);
      return { undefined: true };
    case "pages.activate":
      await call("tabs", { action: "activate", page: page(args[0]) }, signal);
      return { undefined: true };
    case "pages.claim":
      await call("tabs", { action: "claim", page: page(args[0]) }, signal);
      return { undefined: true };
    case "pages.getInfo": {
      const pages = await call("tabs", { action: "list" }, signal).then(
        result =>
          (result.details as { pages: unknown[] }).pages.map(normalizePage)
      );
      return {
        value:
          (pages as Array<Record<string, unknown>>).find(
            item => item.pageId === page(args[0])
          ) ?? null,
      };
    }
    case "observe.snapshot":
      return {
        value: resultValue(
          await call("__sdk_snapshot", { page: page(args[0]) }, signal)
        ),
      };
    case "observe.diff":
      return {
        value: resultValue(
          await call("__sdk_diff", { page: page(args[0]) }, signal)
        ),
      };
    case "observe.resolveRef":
      return {
        value: resultValue(
          await call(
            "__resolve_ref",
            { page: page(args[0]), ref: String(args[1]) },
            signal
          )
        ),
      };
    case "input.click":
    case "input.hover":
      await input(page(args[0]), method.slice(6), { ref: String(args[1]) });
      return { undefined: true };
    case "input.fill":
      await input(page(args[0]), "fill", {
        ref: String(args[1]),
        value: String(args[2] ?? ""),
        clear: true,
      });
      return { undefined: true };
    case "input.type":
      await input(page(args[0]), "type", { text: String(args[1] ?? "") });
      return { undefined: true };
    case "input.press":
      await input(page(args[0]), "press", { key: String(args[1] ?? "") });
      return { undefined: true };
    case "input.selectOption": {
      const result = await input(page(args[0]), "select", {
        ref: String(args[1]),
        value: String(args[2] ?? ""),
      });
      const selectedValues = (
        result.details as { selectedValues?: unknown } | undefined
      )?.selectedValues;
      if (
        !Array.isArray(selectedValues) ||
        !selectedValues.every(value => typeof value === "string")
      ) {
        throw new Error("selectOption did not return the selected values");
      }
      return { value: selectedValues };
    }
    case "input.scroll":
      await input(page(args[0]), "scroll", {
        direction: String(args[1]),
        ...(args[2] === undefined || args[2] === null
          ? {}
          : { amount: args[2] }),
        ...(args[3] === undefined || args[3] === null
          ? {}
          : { ref: String(args[3]) }),
      });
      return { undefined: true };
    case "nav.goto":
      await nav(page(args[0]), "url", String(args[1]));
      return { undefined: true };
    case "nav.back":
    case "nav.forward":
    case "nav.reload":
      await nav(page(args[0]), method.slice(4));
      return { undefined: true };
    case "cdp":
      return {
        value: resultValue(
          await call(
            "__raw_protocol",
            {
              method: String(args[0]),
              params: options(args[1]),
              ...(args[2] === undefined || args[2] === null
                ? {}
                : { sessionId: args[2] }),
            },
            signal
          )
        ),
      };
    case "cdpJsonForPage":
      return {
        value: resultValue(
          await call(
            "__raw_protocol",
            {
              page: page(args[0]),
              method: String(args[1]),
              params: JSON.parse(String(args[2] ?? "{}")),
            },
            signal
          )
        ),
      };
    default:
      if (method.startsWith("tool:")) {
        const tool = method.slice(5);
        const toolArgs =
          typeof args[0] === "number"
            ? { page: page(args[0]), ...options(args[1]) }
            : options(args[0]);
        const result = await call(tool, toolArgs, signal);
        if (tool === "read" || tool === "grep") {
          return { value: resultText(result) };
        }
        if (result.details !== undefined) {
          return { value: result.details };
        }
        const text = resultText(result);
        if (text) {
          return { value: text };
        }
        return {
          undefined: true,
        };
      }
      throw new Error(`Unknown browser method ${method}`);
  }
}

function safeStringify(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function runResult(logs: string[], value?: unknown): BrowserToolResult {
  const sections = ["ok"];
  if (value !== undefined) {
    sections.push(`return: ${safeStringify(value)}`);
  }
  if (logs.length) {
    sections.push(`logs:\n${logs.join("\n")}`);
  }
  const output = truncateResultText(sections.join("\n"));
  return {
    content: [{ type: "text", text: output.text }],
    details: {
      ok: true,
      ...(value === undefined ? {} : { value }),
      logs,
      ...(output.truncated
        ? {
            outputTruncated: true,
            outputBytes: output.originalBytes,
            outputLines: output.originalLines,
          }
        : {}),
    },
  };
}

function truncateResultText(text: string): {
  text: string;
  truncated: boolean;
  originalBytes: number;
  originalLines: number;
} {
  const originalBytes = Buffer.byteLength(text, "utf8");
  const lines = text.split("\n");
  if (originalBytes <= MAX_RESULT_BYTES && lines.length <= MAX_RESULT_LINES) {
    return {
      text,
      truncated: false,
      originalBytes,
      originalLines: lines.length,
    };
  }
  const notice = `\n[truncated: original output was ${lines.length} lines and ${originalBytes} bytes]`;
  const byteLimit = MAX_RESULT_BYTES - Buffer.byteLength(notice, "utf8");
  const kept: string[] = [];
  let bytes = 0;
  for (const line of lines.slice(0, MAX_RESULT_LINES - 1)) {
    const separatorBytes = kept.length ? 1 : 0;
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (bytes + separatorBytes + lineBytes <= byteLimit) {
      kept.push(line);
      bytes += separatorBytes + lineBytes;
      continue;
    }
    let partial = "";
    let partialBytes = 0;
    for (const character of line) {
      const characterBytes = Buffer.byteLength(character, "utf8");
      if (bytes + separatorBytes + partialBytes + characterBytes > byteLimit) {
        break;
      }
      partial += character;
      partialBytes += characterBytes;
    }
    if (partial) {
      kept.push(partial);
    }
    break;
  }
  return {
    text: `${kept.join("\n")}${notice}`,
    truncated: true,
    originalBytes,
    originalLines: lines.length,
  };
}

function runnerPath(): string {
  return (
    process.env.WILDBUZZARD_BROWSER_RUNNER ??
    join(dirname(fileURLToPath(import.meta.url)), "wildbuzzard-browser-runner")
  );
}

export async function runBrowserScript(
  code: string,
  timeout: number,
  call: ToolCaller,
  outerSignal?: AbortSignal
): Promise<BrowserToolResult> {
  if (outerSignal?.aborted) {
    throw new Error("run cancelled");
  }
  const timeoutMs =
    !Number.isFinite(timeout) || timeout <= 0
      ? 1
      : Math.min(30_000, Math.ceil(timeout));
  const controller = new AbortController();
  const abort = () => controller.abort(outerSignal?.reason);
  outerSignal?.addEventListener("abort", abort, { once: true });
  const child = spawn(runnerPath(), [], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {},
  });
  child.stdin.on("error", () => {});
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => {
    if (stderr.length < 16_384) {
      stderr += String(chunk).slice(0, 16_384 - stderr.length);
    }
  });
  const lines = createInterface({ input: child.stdout });
  let settled = false;
  let acceptingResults = true;
  const inFlight = new Set<Promise<void>>();
  const terminate = () => {
    acceptingResults = false;
    if (!child.killed) {
      child.kill("SIGKILL");
    }
  };
  const send = (message: unknown) => {
    if (
      !acceptingResults ||
      child.killed ||
      child.stdin.destroyed ||
      child.stdin.writableEnded ||
      !child.stdin.writable
    ) {
      return;
    }
    child.stdin.write(`${JSON.stringify(message)}\n`, () => {});
  };
  const abortChild = () => terminate();
  controller.signal.addEventListener("abort", abortChild, { once: true });
  try {
    const done = await new Promise<RunnerDone>((resolve, reject) => {
      const guard = setTimeout(() => {
        controller.abort(new Error(`run exceeded ${timeoutMs}ms`));
        terminate();
        reject(new Error(`run exceeded ${timeoutMs}ms`));
      }, timeoutMs + 2_000);
      lines.on("line", line => {
        let message: RunnerCall | RunnerDone;
        try {
          message = JSON.parse(line) as RunnerCall | RunnerDone;
        } catch {
          return;
        }
        if (message.type === "done") {
          settled = true;
          acceptingResults = false;
          clearTimeout(guard);
          resolve(message);
          return;
        }
        let pending: Promise<void>;
        pending = dispatchBrowserCall(
          message.method,
          message.args,
          call,
          controller.signal
        )
          .then(
            result => {
              send({
                type: "result",
                id: message.id,
                ok: true,
                ...result,
              });
            },
            error => {
              send({
                type: "result",
                id: message.id,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          )
          .finally(() => inFlight.delete(pending));
        inFlight.add(pending);
      });
      child.once("error", error => {
        clearTimeout(guard);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        if (!settled) {
          clearTimeout(guard);
          reject(
            new Error(
              `browser runner exited before returning a result (${signal ?? code})${stderr ? `: ${stderr.trim()}` : ""}`
            )
          );
        }
      });
      send({
        type: "start",
        code,
        timeout: timeoutMs,
      });
    });
    if (!done.ok) {
      const logs = done.logs.length ? `\nlogs:\n${done.logs.join("\n")}` : "";
      throw new Error(`run: ${done.error ?? "unknown error"}${logs}`);
    }
    return runResult(done.logs, done.value);
  } catch (error) {
    const message =
      controller.signal.aborted && outerSignal?.aborted
        ? "run cancelled"
        : error instanceof Error
          ? error.message
          : String(error);
    throw new Error(message);
  } finally {
    if (!controller.signal.aborted) {
      controller.abort(new Error("run finished"));
    }
    terminate();
    await Promise.allSettled([...inFlight]);
    lines.close();
    controller.signal.removeEventListener("abort", abortChild);
    outerSignal?.removeEventListener("abort", abort);
  }
}
