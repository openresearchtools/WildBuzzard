import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import {
  connect as netConnect,
  createServer as createNetServer,
} from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import createTorrent from "create-torrent";
import WebTorrent from "webtorrent";

let root;
let connection;
let service;
let seeder;
let socks;
let tracker;
let seedPath;
const socksTargets = [];
let trackerRequests = 0;
let metadataRequests = 0;

function socksServer() {
  return createNetServer(socket => {
    let buffer = Buffer.alloc(0);
    let phase = "greeting";
    const read = () => {
      if (phase === "greeting") {
        if (buffer.length < 2 + buffer[1]) {
          return;
        }
        buffer = buffer.subarray(2 + buffer[1]);
        socket.write(Buffer.from([5, 2]));
        phase = "auth";
      }
      if (phase === "auth") {
        if (buffer.length < 2) {
          return;
        }
        const userLength = buffer[1];
        if (buffer.length < 3 + userLength) {
          return;
        }
        const passwordLength = buffer[2 + userLength];
        if (buffer.length < 3 + userLength + passwordLength) {
          return;
        }
        buffer = buffer.subarray(3 + userLength + passwordLength);
        socket.write(Buffer.from([1, 0]));
        phase = "connect";
      }
      if (phase !== "connect" || buffer.length < 7) {
        return;
      }
      const addressType = buffer[3];
      let host;
      let offset;
      if (addressType === 1) {
        if (buffer.length < 10) {
          return;
        }
        host = [...buffer.subarray(4, 8)].join(".");
        offset = 8;
      } else if (addressType === 3) {
        const length = buffer[4];
        if (buffer.length < 7 + length) {
          return;
        }
        host = buffer.subarray(5, 5 + length).toString();
        offset = 5 + length;
      } else {
        socket.destroy(new Error("Unsupported SOCKS address"));
        return;
      }
      const port = buffer.readUInt16BE(offset);
      const remainder = buffer.subarray(offset + 2);
      phase = "relay";
      socksTargets.push({ host, port });
      const upstream = netConnect({ host, port }, () => {
        socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        if (remainder.length) {
          upstream.write(remainder);
        }
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
      upstream.on("error", () => socket.destroy());
    };
    socket.on("data", chunk => {
      if (phase === "relay") {
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      read();
    });
  });
}

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
  seedPath = join(root, "seed.txt");
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
  socks = socksServer();
  await new Promise(resolve => socks.listen(0, "127.0.0.1", resolve));
  tracker = createHttpServer((request, response) => {
    trackerRequests++;
    if (request.url.startsWith("/metadata.torrent")) {
      metadataRequests++;
    }
    const body = Buffer.from("d8:intervali60e5:peers0:e");
    response.writeHead(200, {
      "content-length": body.length,
      "content-type": "text/plain",
    });
    response.end(body);
  });
  await new Promise(resolve => tracker.listen(0, "127.0.0.1", resolve));
});

after(async () => {
  if (connection) {
    await request("/v1/shutdown", { method: "POST", body: "{}" }).catch(
      () => {}
    );
  }
  await new Promise(resolve => service?.once("exit", resolve));
  await new Promise(resolve => seeder?.destroy(resolve));
  await new Promise(resolve => socks?.close(resolve));
  await new Promise(resolve => tracker?.close(resolve));
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
  assert.equal(status.torrents[0].connections[0].transport, "TCP");
  assert.equal(status.torrents[0].connections[0].source, "manual");
  assert.equal(status.torrents[0].connections[0].route, "Direct");
  await request(`/v1/torrents/${record.id}?deleteData=true`, {
    method: "DELETE",
  });
  status = await request("/v1/status");
  assert.equal(status.torrents.length, 0);
});

test("routes TCP peers through SOCKS and disables direct-only transports", async () => {
  const port = socks.address().port;
  const trackerPort = tracker.address().port;
  const settings = await request("/v1/settings", {
    method: "PATCH",
    body: JSON.stringify({
      torEnabled: true,
      torProxy: { host: "127.0.0.1", port },
    }),
  });
  assert.equal(settings.torEnabled, true);
  const torTorrent = await new Promise((resolve, reject) =>
    createTorrent(
      seedPath,
      {
        private: true,
        announceList: [[`http://127.0.0.1:${trackerPort}/announce`]],
      },
      (error, value) => (error ? reject(error) : resolve(value))
    )
  );
  const record = await request("/v1/torrents", {
    method: "POST",
    body: JSON.stringify({
      torrent: Buffer.from(torTorrent).toString("base64"),
    }),
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
  const status = await waitFor(async () => {
    const value = await request("/v1/status");
    return value.torrents[0]?.connections.length ? value : null;
  });
  assert.deepEqual(status.capabilities, {
    tcp: true,
    udpTrackers: false,
    dht: false,
    utp: false,
    pex: true,
    lsd: false,
    inbound: false,
    tor: true,
  });
  assert.equal(status.torrents[0].connections[0].transport, "TCP");
  assert.equal(status.torrents[0].connections[0].route, "Tor");
  assert.equal(
    socksTargets.some(target => target.port === seeder.torrentPort),
    true
  );
  await waitFor(() => socksTargets.some(target => target.port === trackerPort));
  await waitFor(() => trackerRequests > 0);
  const magnet = new URL(
    "magnet:?xt=urn:btih:0123456789012345678901234567890123456789"
  );
  for (const name of ["as", "ws", "xs"]) {
    magnet.searchParams.append(
      name,
      `http://127.0.0.1:${trackerPort}/metadata.torrent`
    );
  }
  const magnetRecord = await request("/v1/torrents", {
    method: "POST",
    body: JSON.stringify({ source: magnet.href }),
  });
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(metadataRequests, 0);
  await request(`/v1/torrents/${magnetRecord.id}`, { method: "DELETE" });
  await request(`/v1/torrents/${record.id}?deleteData=true`, {
    method: "DELETE",
  });
});
