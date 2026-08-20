#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFile } from "node:fs/promises";
import {
  ensureService,
  invoke,
  PROTOCOL_VERSION,
  serviceStatus,
  stopService,
  VERSION,
} from "./service.mjs";

async function input(source) {
  return JSON.parse(source === "-" ? await readFile("/dev/stdin", "utf8") : source || "{}");
}

async function main() {
  const [command, first, second] = process.argv.slice(2);
  let value;
  if (command === "version") {
    value = { package: "buzzard-torrent-search", version: VERSION, protocolVersion: PROTOCOL_VERSION };
  } else if (command === "start") {
    await ensureService();
    value = await serviceStatus();
  } else if (command === "status") {
    value = await serviceStatus();
  } else if (command === "stop") {
    value = await stopService();
  } else if (command === "search") {
    value = await invoke("torrent_search", await input(first));
  } else if (command === "call" && first) {
    value = await invoke(first, await input(second));
  } else {
    throw new Error("Usage: buzzard-torrent-search <version|start|status|stop|search JSON|call TOOL [JSON]>");
  }
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

main().catch(error => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message || String(error) })}\n`);
  process.exitCode = 1;
});
