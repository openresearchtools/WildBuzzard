import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import WebTorrent from "webtorrent";

let root;
let connection;
let service;
let seeder;

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Timed out");
}

async function request(path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${connection.port}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${connection.token}`,
      "content-type": "application/json",
      ...options.headers,
    },
  });
  const body = await response.json();
  assert.equal(response.ok, true, body.error);
  return body;
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "wildbuzzard-torrent-test-"));
  const seedPath = join(root, "seed.txt");
  await writeFile(seedPath, "WildBuzzard local torrent test\n".repeat(4096));
  seeder = new WebTorrent({
    dht: false,
    tracker: false,
    lsd: false,
    natUpnp: false,
    natPmp: false,
  });
  const seeded = await new Promise(resolve =>
    seeder.seed(seedPath, { private: true, announce: [] }, resolve)
  );
  const configPath = join(root, "config.json");
  const connectionPath = join(root, "connection.json");
  await writeFile(
    configPath,
    JSON.stringify({
      dataDirectory: join(root, "data"),
      downloadDirectory: join(root, "downloads"),
      connectionPath,
      maxActive: 2,
      natUpnp: false,
      natPmp: false,
      lsd: false,
      utp: false,
    })
  );
  service = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("../service.mjs", import.meta.url)),
      "serve",
      "--config",
      configPath,
    ],
    {
      stdio: "inherit",
    }
  );
  connection = await waitFor(async () => {
    try {
      return JSON.parse(await readFile(connectionPath, "utf8"));
    } catch {
      return null;
    }
  });
  globalThis.testTorrent = Buffer.from(seeded.torrentFile).toString("base64");
  globalThis.seeded = seeded;
});

after(async () => {
  if (connection) {
    await request("/v1/shutdown", { method: "POST", body: "{}" }).catch(
      () => {}
    );
  }
  await new Promise(resolve => service?.once("exit", resolve));
  await new Promise(resolve => seeder?.destroy(resolve));
  await rm(root, { recursive: true, force: true });
});

test("downloads, stops, resumes, and removes a local torrent", async () => {
  const record = await request("/v1/torrents", {
    method: "POST",
    body: JSON.stringify({ torrent: globalThis.testTorrent }),
  });
  await request(`/v1/torrents/${record.id}/action`, {
    method: "POST",
    body: JSON.stringify({ action: "pause" }),
  });
  let status = await request("/v1/status");
  assert.equal(status.torrents[0].state, "paused");
  assert.equal(status.torrents[0].numPeers, 0);
  await request(`/v1/torrents/${record.id}/action`, {
    method: "POST",
    body: JSON.stringify({ action: "force-start" }),
  });
  await waitFor(async () => {
    try {
      await request(`/v1/torrents/${record.id}/action`, {
        method: "POST",
        body: JSON.stringify({
          action: "add-peer",
          peer: `127.0.0.1:${seeder.torrentPort}`,
        }),
      });
      return true;
    } catch {
      return false;
    }
  });
  status = await waitFor(async () => {
    const value = await request("/v1/status");
    return value.torrents[0].state === "seeding" ? value : null;
  });
  assert.equal(status.torrents[0].progress, 1);
  await request(`/v1/torrents/${record.id}?deleteData=true`, {
    method: "DELETE",
  });
  status = await request("/v1/status");
  assert.equal(status.torrents.length, 0);
});
