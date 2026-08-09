import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Server as TrackerServer } from "bittorrent-tracker";
import WebTorrent from "webtorrent";

async function waitFor(predicate, attempts = 300) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Timed out");
}

async function startService(root, update = {}) {
  const configPath = join(root, "config.json");
  const connectionPath = join(root, "connection.json");
  await writeFile(
    configPath,
    JSON.stringify({
      dataDirectory: join(root, "data"),
      downloadDirectory: join(root, "downloads"),
      connectionPath,
      maxActive: 2,
      dht: false,
      natUpnp: false,
      natPmp: false,
      lsd: false,
      ...update,
    })
  );
  const process = spawn(
    globalThis.process.execPath,
    [
      fileURLToPath(new URL("../service.mjs", import.meta.url)),
      "serve",
      "--config",
      configPath,
    ],
    { stdio: "inherit" }
  );
  const connection = await waitFor(async () => {
    try {
      return JSON.parse(await readFile(connectionPath, "utf8"));
    } catch {
      return null;
    }
  });
  const request = async (path, options = {}) => {
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
  };
  return { process, request };
}

async function seed(root, options, announce = []) {
  const path = join(root, "seed.bin");
  await writeFile(path, Buffer.alloc(2 * 1024 * 1024, 0x57));
  const client = new WebTorrent(options);
  const torrent = await new Promise(resolve =>
    client.seed(path, { announce, private: true }, resolve)
  );
  return { client, torrent };
}

async function stop({ service, seeder, tracker, root }) {
  await service
    .request("/v1/shutdown", {
      method: "POST",
      body: "{}",
    })
    .catch(() => {});
  const [code, signal] = await new Promise(resolve =>
    service.process.once("exit", (exitCode, exitSignal) =>
      resolve([exitCode, exitSignal])
    )
  );
  assert.equal(signal, null);
  assert.equal(code, 0);
  if (seeder) {
    await new Promise(resolve => seeder.destroy(resolve));
  }
  if (tracker) {
    await new Promise(resolve => tracker.close(resolve));
  }
  await rm(root, { recursive: true, force: true });
}

async function addTorrent(service, torrent) {
  return service.request("/v1/torrents", {
    method: "POST",
    body: JSON.stringify({
      torrent: Buffer.from(torrent.torrentFile).toString("base64"),
    }),
  });
}

test("uses a real µTP peer connection", async () => {
  const root = await mkdtemp(join(tmpdir(), "wildbuzzard-utp-test-"));
  const seeded = await seed(root, {
    dht: false,
    tracker: false,
    lsd: false,
    natUpnp: false,
    natPmp: false,
    utp: true,
  });
  const service = await startService(root, { utp: true });
  try {
    const record = await addTorrent(service, seeded.torrent);
    await waitFor(async () => {
      try {
        await service.request(`/v1/torrents/${record.id}/action`, {
          method: "POST",
          body: JSON.stringify({
            action: "add-peer",
            peer: `127.0.0.1:${seeded.client.torrentPort}`,
          }),
        });
        return true;
      } catch {
        return false;
      }
    });
    const status = await waitFor(async () => {
      const value = await service.request("/v1/status");
      return value.torrents[0]?.connections.some(
        connection => connection.transport === "µTP"
      )
        ? value
        : null;
    });
    assert.equal(status.capabilities.utp, true);
    assert.equal(status.torrents[0].connections[0].source, "manual");
    await waitFor(async () => {
      const value = await service.request("/v1/status");
      return value.torrents[0]?.progress === 1;
    });
  } finally {
    await stop({ service, seeder: seeded.client, root });
  }
});

test("discovers TCP peers through a UDP tracker", async () => {
  const root = await mkdtemp(join(tmpdir(), "wildbuzzard-udp-test-"));
  const tracker = new TrackerServer({ http: false, udp: true, ws: false });
  tracker.on("error", error => {
    throw error;
  });
  await new Promise(resolve =>
    tracker.listen(0, { udp: "127.0.0.1", udp6: "::1" }, resolve)
  );
  const announce = `udp://127.0.0.1:${tracker.udp.address().port}`;
  const seeded = await seed(
    root,
    {
      dht: false,
      lsd: false,
      natUpnp: false,
      natPmp: false,
      utp: false,
    },
    [announce]
  );
  const service = await startService(root, { utp: false });
  try {
    await addTorrent(service, seeded.torrent);
    const status = await waitFor(async () => {
      const value = await service.request("/v1/status");
      return value.torrents[0]?.connections.some(
        connection =>
          connection.source === "tracker" && connection.transport === "TCP"
      )
        ? value
        : null;
    });
    assert.equal(status.capabilities.udpTrackers, true);
    await waitFor(async () => {
      const value = await service.request("/v1/status");
      return value.torrents[0]?.progress === 1;
    });
  } finally {
    await stop({ service, seeder: seeded.client, tracker, root });
  }
});
