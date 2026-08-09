/* SPDX-License-Identifier: AGPL-3.0-or-later */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runBrowserScript } from "../run-sdk.ts";

async function withRunner<T>(
  source: string,
  action: () => Promise<T>
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "wildbuzzard-runner-test-"));
  const runner = join(directory, "runner");
  await writeFile(runner, `#!${process.execPath}\n${source}`, { mode: 0o700 });
  const previous = process.env.WILDBUZZARD_BROWSER_RUNNER;
  process.env.WILDBUZZARD_BROWSER_RUNNER = runner;
  try {
    return await action();
  } finally {
    if (previous === undefined) {
      delete process.env.WILDBUZZARD_BROWSER_RUNNER;
    } else {
      process.env.WILDBUZZARD_BROWSER_RUNNER = previous;
    }
    await rm(directory, { recursive: true });
  }
}

const noBrowserCalls = async () => {
  throw new Error("unexpected browser call");
};

const singleCallRunner = (method: string, args: unknown[]) => `
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk;
  while (buffer.includes("\\n")) {
    const split = buffer.indexOf("\\n");
    const line = buffer.slice(0, split);
    buffer = buffer.slice(split + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.type === "start") {
      console.log(JSON.stringify({type:"call",id:1,method:${JSON.stringify(method)},args:${JSON.stringify(args)}}));
    } else if (message.type === "result") {
      console.log(JSON.stringify(message.ok
        ? {type:"done",ok:true,value:message.value,logs:[]}
        : {type:"done",ok:false,error:message.error,logs:[]}));
    }
  }
});`;

test("run returns successful structured output", async () => {
  await withRunner(
    `process.stdin.once("data", () => console.log(JSON.stringify({type:"done",ok:true,value:{answer:42},logs:["captured"]})));`,
    async () => {
      const result = await runBrowserScript("return 42", 1_000, noBrowserCalls);
      assert.equal((result.details as { ok: boolean }).ok, true);
      assert.match(
        result.content[0].type === "text" ? result.content[0].text : "",
        /answer/
      );
    }
  );
});

test("run failures reject so Pi records a tool error", async () => {
  await withRunner(
    `process.stdin.once("data", () => console.log(JSON.stringify({type:"done",ok:false,logs:["before"],error:"boom"})));`,
    () =>
      assert.rejects(
        runBrowserScript("throw new Error()", 1_000, noBrowserCalls),
        /run: boom[\s\S]*before/
      )
  );
});

test("run caps model-visible output at 50 KiB and 2000 lines", async () => {
  await withRunner(
    `process.stdin.once("data", () => console.log(JSON.stringify({type:"done",ok:true,value:"x".repeat(100000),logs:[]})));`,
    async () => {
      const result = await runBrowserScript("", 1_000, noBrowserCalls);
      const text =
        result.content[0].type === "text" ? result.content[0].text : "";
      assert.ok(Buffer.byteLength(text, "utf8") <= 50 * 1024);
      assert.ok(text.split("\n").length <= 2_000);
      assert.match(text, /\[truncated:/);
      assert.equal(
        (result.details as { outputTruncated?: boolean }).outputTruncated,
        true
      );
    }
  );
});

test("run rejects the removed hidden-page option", async () => {
  await withRunner(
    singleCallRunner("pages.newPage", [
      "https://example.com",
      { hidden: true },
    ]),
    () =>
      assert.rejects(
        runBrowserScript("", 1_000, noBrowserCalls),
        /pages\.newPage: hidden is no longer supported/
      )
  );
});

test("run exposes the BrowserOS snapshot value without model wrappers", async () => {
  const snapshot = {
    text: '- button "Go" [ref=e1]',
    refs: [{ ref: "e1", backendNodeId: 7, role: "button", name: "Go", nth: 0 }],
    url: "https://example.com/",
  };
  await withRunner(singleCallRunner("observe.snapshot", [4]), async () => {
    const result = await runBrowserScript("", 1_000, async tool => {
      assert.equal(tool, "__sdk_snapshot");
      return {
        content: [{ type: "text", text: snapshot.text }],
        details: { value: snapshot },
      };
    });
    assert.deepEqual((result.details as { value: unknown }).value, snapshot);
  });
});

test("run cancellation rejects", async () => {
  await withRunner(
    `process.stdin.resume(); setInterval(() => {}, 1000);`,
    async () => {
      const controller = new AbortController();
      const pending = runBrowserScript(
        "",
        1_000,
        noBrowserCalls,
        controller.signal
      );
      controller.abort();
      await assert.rejects(pending, /run cancelled/);
    }
  );
});

test("run rejects an already-aborted signal before spawning", async () => {
  const previous = process.env.WILDBUZZARD_BROWSER_RUNNER;
  process.env.WILDBUZZARD_BROWSER_RUNNER = "/does/not/exist";
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      runBrowserScript("", 1_000, noBrowserCalls, controller.signal),
      /run cancelled/
    );
  } finally {
    if (previous === undefined) {
      delete process.env.WILDBUZZARD_BROWSER_RUNNER;
    } else {
      process.env.WILDBUZZARD_BROWSER_RUNNER = previous;
    }
  }
});

test("run ignores a browser result that resolves after cancellation", async () => {
  await withRunner(
    `process.stdin.once("data", () => { console.log(JSON.stringify({type:"call",id:1,method:"pages.list",args:[]})); setInterval(() => {}, 1000); });`,
    async () => {
      const controller = new AbortController();
      let called!: () => void;
      const started = new Promise<void>(resolve => {
        called = resolve;
      });
      const pending = runBrowserScript(
        "",
        1_000,
        async () => {
          called();
          await new Promise(resolve => setTimeout(resolve, 50));
          return { content: [], details: { pages: [] } };
        },
        controller.signal
      );
      await started;
      controller.abort();
      await assert.rejects(pending, /run cancelled/);
      await new Promise(resolve => setTimeout(resolve, 75));
    }
  );
});
