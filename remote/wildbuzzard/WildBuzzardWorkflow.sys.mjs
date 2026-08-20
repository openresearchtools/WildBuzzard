/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { clearTimeout, setTimeout } from "resource://gre/modules/Timer.sys.mjs";

const MAX_RESULT_LINES = 2000;
const MAX_RESULT_BYTES = 50 * 1024;
const SYSTEM_EVAL_PREF = "security.allow_eval_with_system_principal";
let systemEvalUsers = 0;
let previousSystemEval;

function enableSystemEval() {
  if (systemEvalUsers++ === 0) {
    previousSystemEval = Services.prefs.prefHasUserValue(SYSTEM_EVAL_PREF)
      ? Services.prefs.getBoolPref(SYSTEM_EVAL_PREF)
      : null;
    Services.prefs.setBoolPref(SYSTEM_EVAL_PREF, true);
  }
}

function disableSystemEval() {
  if (--systemEvalUsers !== 0) {
    return;
  }
  if (previousSystemEval === null) {
    Services.prefs.clearUserPref(SYSTEM_EVAL_PREF);
  } else {
    Services.prefs.setBoolPref(SYSTEM_EVAL_PREF, previousSystemEval);
  }
}

function text(result) {
  return result.content.find(item => item.type === "text")?.text ?? "";
}

function value(result) {
  return result.details?.value ?? result.details;
}

function pageId(candidate) {
  if (!Number.isInteger(candidate) || candidate < 0) {
    throw new Error("pageId argument is required");
  }
  return candidate;
}

function options(candidate) {
  return candidate && typeof candidate === "object" ? candidate : {};
}

function normalizePage(candidate) {
  if (!candidate || typeof candidate !== "object") {
    return candidate;
  }
  const { page, ...rest } = candidate;
  return { pageId: page, ...rest };
}

// eslint-disable-next-line complexity
async function dispatchWorkflowCall(
  method,
  args,
  dispatch,
  cwd,
  clientId,
  signal
) {
  const call = (tool, values) => dispatch(tool, values, cwd, clientId, signal);
  const input = (page, kind, values = {}) =>
    call("act", { page, kind, ...values });
  const navigate = (page, action, url) =>
    call("navigate", { page, action, ...(url === undefined ? {} : { url }) });
  switch (method) {
    case "pages.list": {
      const result = await call("tabs", { action: "list" });
      return { value: result.details.pages.map(normalizePage) };
    }
    case "pages.newPage": {
      const pageOptions = options(args[1]);
      if ("hidden" in pageOptions) {
        throw new Error("pages.newPage: hidden is no longer supported");
      }
      const result = await call("tabs", {
        action: "new",
        url: args[0] ?? "about:blank",
        ...pageOptions,
      });
      return { value: result.details.page };
    }
    case "pages.close":
      await call("tabs", { action: "close", page: pageId(args[0]) });
      return { undefined: true };
    case "pages.activate":
    case "pages.claim":
      await call("tabs", {
        action: method.slice(6),
        page: pageId(args[0]),
      });
      return { undefined: true };
    case "pages.getInfo": {
      const result = await call("tabs", { action: "list" });
      return {
        value:
          result.details.pages
            .map(normalizePage)
            .find(item => item.pageId === pageId(args[0])) ?? null,
      };
    }
    case "observe.snapshot":
    case "observe.diff": {
      const tool = method.slice(8);
      const result = await call(tool, { page: pageId(args[0]) });
      return { value: { ...result.details, text: text(result) } };
    }
    case "observe.resolveRef":
      return {
        value: value(
          await call("__resolve_ref", {
            page: pageId(args[0]),
            ref: String(args[1]),
          })
        ),
      };
    case "input.click":
    case "input.hover":
      await input(pageId(args[0]), method.slice(6), {
        ref: String(args[1]),
      });
      return { undefined: true };
    case "input.fill":
      await input(pageId(args[0]), "fill", {
        ref: String(args[1]),
        value: String(args[2] ?? ""),
        clear: true,
      });
      return { undefined: true };
    case "input.type":
      await input(pageId(args[0]), "type", { text: String(args[1] ?? "") });
      return { undefined: true };
    case "input.press":
      await input(pageId(args[0]), "press", { key: String(args[1] ?? "") });
      return { undefined: true };
    case "input.selectOption": {
      const result = await input(pageId(args[0]), "select", {
        ref: String(args[1]),
        value: String(args[2] ?? ""),
      });
      return { value: result.details.selectedValues };
    }
    case "input.scroll":
      await input(pageId(args[0]), "scroll", {
        direction: String(args[1]),
        ...(args[2] == null ? {} : { amount: args[2] }),
        ...(args[3] == null ? {} : { ref: String(args[3]) }),
      });
      return { undefined: true };
    case "nav.goto":
      await navigate(pageId(args[0]), "url", String(args[1]));
      return { undefined: true };
    case "nav.back":
    case "nav.forward":
    case "nav.reload":
      await navigate(pageId(args[0]), method.slice(4));
      return { undefined: true };
    case "cdp":
      return {
        value: value(
          await call("__raw_protocol", {
            method: String(args[0]),
            params: options(args[1]),
            ...(args[2] == null ? {} : { sessionId: args[2] }),
          })
        ),
      };
    case "cdpJsonForPage":
      return {
        value: value(
          await call("__raw_protocol", {
            page: pageId(args[0]),
            method: String(args[1]),
            params: JSON.parse(String(args[2] ?? "{}")),
          })
        ),
      };
    default: {
      if (!method.startsWith("tool:")) {
        throw new Error(`Unknown browser method ${method}`);
      }
      const tool = method.slice(5);
      const toolArgs =
        typeof args[0] === "number"
          ? { page: pageId(args[0]), ...options(args[1]) }
          : options(args[0]);
      const result = await call(tool, toolArgs);
      if (tool === "read" || tool === "grep") {
        return { value: text(result) };
      }
      if (result.details !== undefined) {
        return { value: result.details };
      }
      const output = text(result);
      return output ? { value: output } : { undefined: true };
    }
  }
}

function truncate(source) {
  const encoder = new TextEncoder();
  const lines = source.split("\n");
  const originalBytes = encoder.encode(source).length;
  if (lines.length <= MAX_RESULT_LINES && originalBytes <= MAX_RESULT_BYTES) {
    return { text: source };
  }
  const notice = `\n[truncated: original output was ${lines.length} lines and ${originalBytes} bytes]`;
  const maximum = MAX_RESULT_BYTES - encoder.encode(notice).length;
  const kept = [];
  let size = 0;
  for (const line of lines.slice(0, MAX_RESULT_LINES - 1)) {
    const candidate = `${kept.length ? "\n" : ""}${line}`;
    const bytes = encoder.encode(candidate);
    if (size + bytes.length > maximum) {
      break;
    }
    kept.push(line);
    size += bytes.length;
  }
  return {
    text: `${kept.join("\n")}${notice}`,
    details: {
      outputTruncated: true,
      outputBytes: originalBytes,
      outputLines: lines.length,
    },
  };
}

export function runWildBuzzardWorkflow(
  code,
  timeout,
  dispatch,
  cwd,
  clientId,
  outerSignal
) {
  const timeoutMs = Math.max(1, Math.min(30000, Math.ceil(timeout || 30000)));
  return new Promise((resolve, reject) => {
    if (outerSignal?.aborted) {
      reject(new Error("run cancelled"));
      return;
    }
    enableSystemEval();
    let worker;
    try {
      worker = new ChromeWorker(
        "chrome://remote/content/wildbuzzard/WildBuzzardWorkflowWorker.js"
      );
    } catch (error) {
      disableSystemEval();
      reject(error);
      return;
    }
    const controller = new AbortController();
    const inFlight = new Set();
    let settled = false;
    const finish = (callback, result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      outerSignal?.removeEventListener("abort", abort);
      controller.abort();
      worker.terminate();
      disableSystemEval();
      callback(result);
    };
    const abort = () => finish(reject, new Error("run cancelled"));
    outerSignal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => finish(reject, new Error(`run exceeded ${timeoutMs}ms`)),
      timeoutMs
    );
    worker.onerror = event =>
      finish(reject, new Error(event.message || "workflow worker failed"));
    worker.onmessage = event => {
      const message = event.data;
      if (message.type === "done") {
        if (!message.ok) {
          const logs = message.logs?.length
            ? `\nlogs:\n${message.logs.join("\n")}`
            : "";
          finish(reject, new Error(`run: ${message.error}${logs}`));
          return;
        }
        const sections = ["ok"];
        if (message.value !== undefined) {
          sections.push(`return: ${JSON.stringify(message.value, null, 2)}`);
        }
        if (message.logs?.length) {
          sections.push(`logs:\n${message.logs.join("\n")}`);
        }
        const output = truncate(sections.join("\n"));
        finish(resolve, {
          content: [{ type: "text", text: output.text }],
          details: {
            ok: true,
            ...(message.value === undefined ? {} : { value: message.value }),
            logs: message.logs ?? [],
            ...output.details,
          },
        });
        return;
      }
      if (message.type !== "call" || inFlight.size >= 32) {
        worker.postMessage({
          type: "result",
          id: message.id,
          ok: false,
          error: "browser call limit exceeded",
        });
        return;
      }
      const pending = dispatchWorkflowCall(
        message.method,
        message.args,
        dispatch,
        cwd,
        clientId,
        controller.signal
      )
        .then(
          result =>
            worker.postMessage({
              type: "result",
              id: message.id,
              ok: true,
              ...result,
            }),
          error =>
            worker.postMessage({
              type: "result",
              id: message.id,
              ok: false,
              error: error?.message || String(error),
            })
        )
        .finally(() => inFlight.delete(pending));
      inFlight.add(pending);
    };
    worker.postMessage({ type: "start", code });
  });
}
