/* SPDX-License-Identifier: AGPL-3.0-or-later */

const pending = new Map();
let nextCallId = 1;
let logBytes = 0;
const logs = [];

function safeValue(value) {
  if (value === undefined) {
    return undefined;
  }
  const seen = new WeakSet();
  try {
    return JSON.parse(
      JSON.stringify(value, (_key, next) => {
        if (typeof next === "bigint") {
          return next.toString();
        }
        if (typeof next === "function" || typeof next === "symbol") {
          return String(next);
        }
        if (typeof next === "number" && !Number.isFinite(next)) {
          return null;
        }
        if (typeof next === "object" && next !== null) {
          if (seen.has(next)) {
            return "[Circular]";
          }
          seen.add(next);
        }
        return next;
      })
    );
  } catch {
    return String(value);
  }
}

function display(value) {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined) {
    return "undefined";
  }
  try {
    return JSON.stringify(safeValue(value), null, 2);
  } catch {
    return String(value);
  }
}

function pushLog(level, parts) {
  if (logs.length >= 1000 || logBytes >= 1000000) {
    return;
  }
  const value = `${level}${parts.map(display).join(" ")}`;
  const remaining = 1000000 - logBytes;
  const text = value.slice(0, remaining);
  logs.push(text);
  logBytes += text.length;
}

function call(method, args) {
  const id = nextCallId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    postMessage({ type: "call", id, method, args });
  });
}

function scoped(prefix, pageId) {
  return (name, args) => call(`${prefix}.${name}`, [pageId, ...args]);
}

const browser = {
  pages: {
    list: () => call("pages.list", []),
    newPage: (url, options) => call("pages.newPage", [url, options]),
    close: pageId => call("pages.close", [pageId]),
    activate: pageId => call("pages.activate", [pageId]),
    claim: pageId => call("pages.claim", [pageId]),
    getInfo: pageId => call("pages.getInfo", [pageId]),
  },
  observe: pageId => {
    const run = scoped("observe", pageId);
    return {
      snapshot: () => run("snapshot", []),
      diff: () => run("diff", []),
      resolveRef: ref => run("resolveRef", [ref]),
    };
  },
  input: pageId => {
    const run = scoped("input", pageId);
    return {
      click: ref => run("click", [ref]),
      fill: (ref, value) => run("fill", [ref, value]),
      type: text => run("type", [text]),
      press: key => run("press", [key]),
      hover: ref => run("hover", [ref]),
      selectOption: (ref, value) => run("selectOption", [ref, value]),
      scroll: (direction, amount, ref) =>
        run("scroll", [direction, amount, ref]),
    };
  },
  nav: pageId => {
    const run = scoped("nav", pageId);
    return {
      goto: url => run("goto", [url]),
      back: () => run("back", []),
      forward: () => run("forward", []),
      reload: () => run("reload", []),
    };
  },
  cdp: (method, params, sessionId) => call("cdp", [method, params, sessionId]),
  cdpJsonForPage: (pageId, method, paramsJson) =>
    call("cdpJsonForPage", [pageId, method, paramsJson]),
  read: (pageId, options) => call("tool:read", [pageId, options]),
  grep: (pageId, options) => call("tool:grep", [pageId, options]),
  wait: (pageId, options) => call("tool:wait", [pageId, options]),
  screenshot: (pageId, options) => call("tool:screenshot", [pageId, options]),
  evaluate: (pageId, options) => call("tool:evaluate", [pageId, options]),
  download: (pageId, options) => call("tool:download", [pageId, options]),
  pdf: (pageId, options) => call("tool:pdf", [pageId, options]),
  upload: (pageId, options) => call("tool:upload", [pageId, options]),
  tabGroups: options => call("tool:tab_groups", [options]),
  history: options => call("tool:history", [options]),
  bookmarks: options => call("tool:bookmarks", [options]),
  windows: options => call("tool:windows", [options]),
};

const workflowConsole = {
  log: (...parts) => pushLog("", parts),
  info: (...parts) => pushLog("", parts),
  warn: (...parts) => pushLog("warn: ", parts),
  error: (...parts) => pushLog("error: ", parts),
  debug: (...parts) => pushLog("", parts),
};

self.onmessage = async event => {
  const message = event.data;
  if (message.type === "result") {
    const item = pending.get(message.id);
    if (!item) {
      return;
    }
    pending.delete(message.id);
    if (message.ok) {
      item.resolve(message.undefined ? undefined : message.value);
    } else {
      item.reject(new Error(message.error));
    }
    return;
  }
  if (message.type !== "start") {
    return;
  }
  try {
    const AsyncFunction = Object.getPrototypeOf(
      async function () {}
    ).constructor;
    const run = new AsyncFunction(
      "browser",
      "console",
      `"use strict";\n${message.code}`
    );
    const value = await run(browser, workflowConsole);
    postMessage({ type: "done", ok: true, value: safeValue(value), logs });
  } catch (error) {
    postMessage({
      type: "done",
      ok: false,
      error: `${error?.name || "Error"}: ${error?.message || String(error)}${
        error?.stack ? `\n${error.stack}` : ""
      }`,
      logs,
    });
  }
};
