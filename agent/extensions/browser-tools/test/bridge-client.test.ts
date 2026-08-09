/* SPDX-License-Identifier: AGPL-3.0-or-later */

import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import test from "node:test";
import { callBrowserTool } from "../bridge-client.ts";

test("bridge sends the explicit Pi session identity", async () => {
  let request: Record<string, unknown> | undefined;
  const server = createServer(socket => {
    socket.setEncoding("utf8");
    socket.once("data", chunk => {
      request = JSON.parse(String(chunk).trim()) as Record<string, unknown>;
      socket.end(
        `${JSON.stringify({
          id: request.id,
          ok: true,
          result: { content: [{ type: "text", text: "ok" }] },
        })}\n`
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const previous = {
    file: process.env.WILDBUZZARD_BROWSER_CONTROL_FILE,
    port: process.env.WILDBUZZARD_BROWSER_CONTROL_PORT,
    token: process.env.WILDBUZZARD_BROWSER_CONTROL_TOKEN,
  };
  process.env.WILDBUZZARD_BROWSER_CONTROL_FILE = "/does/not/exist";
  process.env.WILDBUZZARD_BROWSER_CONTROL_PORT = String(address.port);
  process.env.WILDBUZZARD_BROWSER_CONTROL_TOKEN = "test-token";
  try {
    await callBrowserTool("tabs", { action: "list" }, "/tmp", "session-42");
    assert.equal(request?.clientId, "session-42");
  } finally {
    server.close();
    for (const [name, value] of Object.entries({
      WILDBUZZARD_BROWSER_CONTROL_FILE: previous.file,
      WILDBUZZARD_BROWSER_CONTROL_PORT: previous.port,
      WILDBUZZARD_BROWSER_CONTROL_TOKEN: previous.token,
    })) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});
