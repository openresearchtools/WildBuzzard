import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

async function waitForConnection(path) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw new Error("Torrent service did not publish its connection");
}

test("detached launcher exits successfully while the service stays healthy", async () => {
  const root = await mkdtemp(join(tmpdir(), "wildbuzzard-launcher-test-"));
  const configPath = join(root, "config.json");
  const connectionPath = join(root, "run", "connection.json");
  await writeFile(
    configPath,
    JSON.stringify({
      dataDirectory: join(root, "data"),
      downloadDirectory: join(root, "downloads"),
      connectionPath,
      ownerInstance: "launcher-test-owner-0000001",
      dht: false,
      lsd: false,
      natPmp: false,
      natUpnp: false,
      utp: true,
    })
  );
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("../service.mjs", import.meta.url)),
      "start",
      "--config",
      configPath,
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => {
    stderr += chunk;
  });
  const [code, signal] = await new Promise(resolve =>
    child.once("close", (exitCode, exitSignal) =>
      resolve([exitCode, exitSignal])
    )
  );
  assert.equal(signal, null, stderr);
  assert.equal(code, 0, stderr);
  const connection = await waitForConnection(connectionPath);
  const response = await fetch(
    `http://127.0.0.1:${connection.port}/v1/status`,
    { headers: { authorization: `Bearer ${connection.token}` } }
  );
  assert.equal(response.ok, true);
  await fetch(`http://127.0.0.1:${connection.port}/v1/shutdown`, {
    method: "POST",
    headers: { authorization: `Bearer ${connection.token}` },
  });
  let stopped = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      process.kill(connection.pid, 0);
      await new Promise(resolve => setTimeout(resolve, 50));
    } catch {
      stopped = true;
      break;
    }
  }
  assert.equal(stopped, true, "The detached service did not remain orphaned");
  await assert.rejects(readFile(connectionPath));
  await rm(root, { recursive: true, force: true });
});
