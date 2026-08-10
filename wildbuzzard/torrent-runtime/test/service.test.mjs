import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
  createServer as createHttpServer,
  request as httpRequest,
} from "node:http";
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
let seededTorrent;
let socks;
let tracker;
let seedPath;
const socksTargets = [];
let trackerRequests = 0;
let metadataRequests = 0;
const servicePath = fileURLToPath(new URL("../service.mjs", import.meta.url));

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

async function requestFailure(path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${connection.port}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${connection.token}`,
      "content-type": "application/json",
      ...options.headers,
    },
  });
  const body = await response.json();
  assert.equal(response.ok, false);
  return { status: response.status, body };
}

function createTorrentBytes(input, options = {}) {
  return new Promise((resolve, reject) =>
    createTorrent(input, options, (error, value) =>
      error ? reject(error) : resolve(value)
    )
  );
}

function bencode(value) {
  if (Buffer.isBuffer(value)) {
    return Buffer.concat([Buffer.from(`${value.length}:`), value]);
  }
  if (typeof value === "string") {
    return bencode(Buffer.from(value));
  }
  if (Number.isInteger(value)) {
    return Buffer.from(`i${value}e`);
  }
  if (Array.isArray(value)) {
    return Buffer.concat([
      Buffer.from("l"),
      ...value.map(bencode),
      Buffer.from("e"),
    ]);
  }
  const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  return Buffer.concat([
    Buffer.from("d"),
    ...entries.flatMap(([key, item]) => [bencode(key), bencode(item)]),
    Buffer.from("e"),
  ]);
}

function apiRequest({
  path = "/v1/status",
  method = "GET",
  body,
  headers = {},
  target = connection,
}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: target.port,
        path,
        method,
        headers: {
          authorization: `Bearer ${target.token}`,
          ...(body === undefined
            ? {}
            : {
                "content-length": Buffer.byteLength(body),
                "content-type": "application/json",
              }),
          ...headers,
        },
      },
      response => {
        const chunks = [];
        response.on("data", chunk => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            body: text ? JSON.parse(text) : null,
            status: response.statusCode,
          });
        });
      }
    );
    request.on("error", reject);
    request.end(body);
  });
}

function spawnResult(argumentsList) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, argumentsList, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.on("exit", exitCode =>
      resolve({
        exitCode,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
      })
    );
  });
}

function blockedMutation() {
  const request = httpRequest({
    host: "127.0.0.1",
    port: connection.port,
    path: "/v1/settings",
    method: "PATCH",
    headers: {
      authorization: `Bearer ${connection.token}`,
      "content-length": 2,
      "content-type": "application/json",
    },
  });
  request.on("error", () => {});
  request.flushHeaders();
  return request;
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
  seededTorrent = await new Promise(resolve =>
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
      ownerInstance: "runtime-test-owner-00000001",
      maxActive: 2,
      natUpnp: false,
      natPmp: false,
      lsd: false,
      utp: false,
    })
  );
  service = spawn(
    process.execPath,
    [servicePath, "serve", "--config", configPath],
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
  globalThis.testTorrent = Buffer.from(seededTorrent.torrentFile).toString(
    "base64"
  );
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
    await request("/v1/shutdown", { method: "POST", body: "{}" }).catch(() =>
      service?.kill("SIGTERM")
    );
  }
  if (service?.exitCode === null) {
    await new Promise(resolve => service.once("exit", resolve));
  }
  await new Promise(resolve => seeder?.destroy(resolve));
  await new Promise(resolve => socks?.close(resolve));
  await new Promise(resolve => tracker?.close(resolve));
  await rm(root, { recursive: true, force: true });
});

test("downloads, stops, resumes, and removes a local torrent", async () => {
  const draft = await request("/v1/torrent-drafts", {
    method: "POST",
    body: JSON.stringify({ torrent: globalThis.testTorrent }),
  });
  assert.equal(draft.state, "ready");
  assert.equal(draft.files.length, 1);
  assert.equal(draft.precommitPayloadBytes, 0);
  let status = await request("/v1/status");
  assert.equal(status.torrents.length, 0);
  assert.equal(status.draftCount, 1);
  const record = await request(`/v1/torrent-drafts/${draft.draftId}/commit`, {
    method: "POST",
    body: JSON.stringify({ files: [0] }),
  });
  await request(`/v1/torrents/${record.id}/action`, {
    method: "POST",
    body: JSON.stringify({ action: "pause" }),
  });
  status = await request("/v1/status");
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
  assert.equal(status.torrents[0].private, true);
  assert.deepEqual(status.torrents[0].discovery, {
    private: true,
    dht: false,
    pex: false,
  });
  await request(`/v1/torrents/${record.id}?deleteData=true`, {
    method: "DELETE",
  });
  status = await request("/v1/status");
  assert.equal(status.torrents.length, 0);
});

test("fetches magnet metadata without requesting payload pieces", async () => {
  const magnet = `magnet:?xt=urn:btih:${seededTorrent.infoHash}&dn=Draft+fixture&x.pe=127.0.0.1:${seeder.torrentPort}`;
  const created = await request("/v1/torrent-drafts", {
    method: "POST",
    body: JSON.stringify({ magnet }),
  });
  const draft = await waitFor(async () => {
    const value = await request(`/v1/torrent-drafts/${created.draftId}`);
    if (value.state === "error") {
      throw new Error(value.error);
    }
    return value.state === "ready" ? value : null;
  });
  assert.equal(draft.private, true);
  assert.equal(draft.files.length, 1);
  assert.equal(draft.precommitPayloadBytes, 0);
  const status = await request("/v1/status");
  assert.equal(status.torrents.length, 0);
  await request(`/v1/torrent-drafts/${draft.draftId}`, { method: "DELETE" });
  assert.equal((await request("/v1/status")).draftCount, 0);
});

test("commits exactly the selected files", async () => {
  const directory = join(root, "selection-source");
  await mkdir(directory);
  await writeFile(join(directory, "first.txt"), "first file\n".repeat(2048));
  await writeFile(join(directory, "second.txt"), "second file\n".repeat(2048));
  const torrent = await createTorrentBytes(directory, {
    private: true,
    announce: [],
  });
  const draft = await request("/v1/torrent-drafts", {
    method: "POST",
    body: JSON.stringify({ torrent: Buffer.from(torrent).toString("base64") }),
  });
  assert.equal(draft.files.length, 2);
  assert.equal(draft.precommitPayloadBytes, 0);
  const record = await request(`/v1/torrent-drafts/${draft.draftId}/commit`, {
    method: "POST",
    body: JSON.stringify({ files: [1] }),
  });
  const status = await waitFor(async () => {
    const value = await request("/v1/status");
    const item = value.torrents.find(candidate => candidate.id === record.id);
    return item?.files.length === 2 ? item : null;
  });
  assert.deepEqual(
    status.files.map(file => file.selected),
    [false, true]
  );
  await request(`/v1/torrents/${record.id}?deleteData=true`, {
    method: "DELETE",
  });
});

test("rejects colliding and platform-reserved paths", async () => {
  const collisionDirectory = join(root, "collision-source");
  await mkdir(collisionDirectory);
  await writeFile(join(collisionDirectory, "File.txt"), "one");
  await writeFile(join(collisionDirectory, "file.txt"), "two");
  const collision = await createTorrentBytes(collisionDirectory, {
    private: true,
    announce: [],
  });
  const collisionFailure = await requestFailure("/v1/torrent-drafts", {
    method: "POST",
    body: JSON.stringify({
      torrent: Buffer.from(collision).toString("base64"),
    }),
  });
  assert.equal(collisionFailure.status, 400);
  assert.match(collisionFailure.body.error, /colliding file paths/);

  const prefixCollision = bencode({
    info: {
      files: [
        { length: 1, path: ["a"] },
        { length: 1, path: ["a-b"] },
        { length: 1, path: ["a", "b"] },
      ],
      name: "prefix-fixture",
      "piece length": 16384,
      pieces: createHash("sha1").update("fixture").digest(),
    },
  });
  const prefixFailure = await requestFailure("/v1/torrent-drafts", {
    method: "POST",
    body: JSON.stringify({ torrent: prefixCollision.toString("base64") }),
  });
  assert.equal(prefixFailure.status, 400);
  assert.match(prefixFailure.body.error, /colliding file paths/);

  const reservedPath = join(root, "CON.txt");
  await writeFile(reservedPath, "reserved");
  const reserved = await createTorrentBytes(reservedPath, {
    private: true,
    announce: [],
  });
  const reservedFailure = await requestFailure("/v1/torrent-drafts", {
    method: "POST",
    body: JSON.stringify({
      torrent: Buffer.from(reserved).toString("base64"),
    }),
  });
  assert.equal(reservedFailure.status, 400);
  assert.match(reservedFailure.body.error, /unsafe file path/);
});

test("consumes drafts atomically across commit and cancel races", async () => {
  const first = await request("/v1/torrent-drafts", {
    method: "POST",
    body: JSON.stringify({ torrent: globalThis.testTorrent }),
  });
  const commits = await Promise.all([
    apiRequest({
      path: `/v1/torrent-drafts/${first.draftId}/commit`,
      method: "POST",
      body: "{}",
    }),
    apiRequest({
      path: `/v1/torrent-drafts/${first.draftId}/commit`,
      method: "POST",
      body: "{}",
    }),
  ]);
  assert.deepEqual(commits.map(result => result.status).sort(), [201, 400]);
  const committed = commits.find(result => result.status === 201).body;
  assert.equal(
    (await request("/v1/status")).torrents.filter(
      torrent => torrent.id === committed.id
    ).length,
    1
  );
  await request(`/v1/torrents/${committed.id}`, { method: "DELETE" });

  const second = await request("/v1/torrent-drafts", {
    method: "POST",
    body: JSON.stringify({ torrent: globalThis.testTorrent }),
  });
  const race = await Promise.all([
    apiRequest({
      path: `/v1/torrent-drafts/${second.draftId}/commit`,
      method: "POST",
      body: "{}",
    }),
    apiRequest({
      path: `/v1/torrent-drafts/${second.draftId}`,
      method: "DELETE",
    }),
  ]);
  assert.equal(
    race.filter(result => result.status >= 200 && result.status < 300).length,
    1
  );
  const raceCommit = race.find(result => result.status === 201)?.body;
  if (raceCommit) {
    await request(`/v1/torrents/${raceCommit.id}`, { method: "DELETE" });
  }
  assert.equal((await request("/v1/status")).draftCount, 0);
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
  await waitFor(() =>
    socksTargets.some(target => target.port === trackerPort)
  ).catch(async () => {
    const finalStatus = await request("/v1/status");
    throw new Error(
      `Tracker did not use SOCKS: ${JSON.stringify({ socksTargets, trackerPort, torrent: finalStatus.torrents[0] })}`
    );
  });
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
  const draftMagnet = new URL(magnet.href);
  draftMagnet.searchParams.append("x.pe", `127.0.0.1:${seeder.torrentPort}`);
  const torDraft = await request("/v1/torrent-drafts", {
    method: "POST",
    body: JSON.stringify({ magnet: draftMagnet.href }),
  });
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(
    metadataRequests,
    0,
    "Tor magnet drafts never fetch as/ws/xs URLs directly"
  );
  await request(`/v1/torrent-drafts/${torDraft.draftId}`, {
    method: "DELETE",
  });
  await request(`/v1/torrents/${magnetRecord.id}`, { method: "DELETE" });
  await request(`/v1/torrents/${record.id}?deleteData=true`, {
    method: "DELETE",
  });
});

test("expires a draft atomically while commit and cancel race", async () => {
  const expiryRoot = await mkdtemp(join(tmpdir(), "torrent-expiry-test-"));
  const configPath = join(expiryRoot, "config.json");
  const connectionPath = join(expiryRoot, "connection.json");
  await writeFile(
    configPath,
    JSON.stringify({
      dataDirectory: join(expiryRoot, "data"),
      downloadDirectory: join(expiryRoot, "downloads"),
      connectionPath,
      draftTtlMs: 100,
      ownerInstance: "expiry-test-owner-000000001",
      dht: false,
      lsd: false,
      natPmp: false,
      natUpnp: false,
      utp: false,
    })
  );
  const child = spawn(
    process.execPath,
    [servicePath, "serve", "--config", configPath],
    {
      stdio: "inherit",
    }
  );
  const target = await waitFor(async () => {
    try {
      return JSON.parse(await readFile(connectionPath, "utf8"));
    } catch {
      return null;
    }
  });
  try {
    const draft = (
      await apiRequest({
        path: "/v1/torrent-drafts",
        method: "POST",
        body: JSON.stringify({ torrent: globalThis.testTorrent }),
        target,
      })
    ).body;
    await new Promise(resolve => setTimeout(resolve, 150));
    const results = await Promise.all([
      apiRequest({ path: `/v1/torrent-drafts/${draft.draftId}`, target }),
      apiRequest({
        path: `/v1/torrent-drafts/${draft.draftId}/commit`,
        method: "POST",
        body: "{}",
        target,
      }),
      apiRequest({
        path: `/v1/torrent-drafts/${draft.draftId}`,
        method: "DELETE",
        target,
      }),
    ]);
    assert.deepEqual(
      results.map(result => result.status),
      [400, 400, 400]
    );
    const status = (await apiRequest({ target })).body;
    assert.equal(status.draftCount, 0);
    assert.equal(status.torrents.length, 0);
  } finally {
    await apiRequest({
      path: "/v1/shutdown",
      method: "POST",
      body: "{}",
      target,
    }).catch(() => child.kill("SIGTERM"));
    if (child.exitCode === null) {
      await new Promise(resolve => child.once("exit", resolve));
    }
    await rm(expiryRoot, { recursive: true, force: true });
  }
});

test("serializes launch ownership and refuses a live forged connection", async () => {
  const launchRoot = await mkdtemp(join(tmpdir(), "torrent-launch-test-"));
  const configPath = join(launchRoot, "config.json");
  const connectionPath = join(launchRoot, "connection.json");
  await writeFile(
    configPath,
    JSON.stringify({
      dataDirectory: join(launchRoot, "data"),
      downloadDirectory: join(launchRoot, "downloads"),
      connectionPath,
      ownerInstance: "launch-test-owner-000000001",
      dht: false,
      lsd: false,
      natPmp: false,
      natUpnp: false,
      utp: false,
    })
  );
  const argumentsList = [servicePath, "start", "--config", configPath];
  const starters = await Promise.all([
    spawnResult(argumentsList),
    spawnResult(argumentsList),
  ]);
  assert.deepEqual(
    starters.map(result => result.exitCode),
    [0, 0]
  );
  const target = JSON.parse(await readFile(connectionPath, "utf8"));
  try {
    const status = (await apiRequest({ target })).body;
    assert.equal(target.ownerInstance, "launch-test-owner-000000001");
    assert.match(target.pidStartTime, /^\d+$/);
    assert.match(target.executableSha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(status.serviceIdentity, {
      ownerInstance: target.ownerInstance,
      runtimeDirectory: target.runtimeDirectory,
      executable: target.executable,
      executableSha256: target.executableSha256,
      dataRoot: target.dataRoot,
      instanceId: target.instanceId,
      pid: target.pid,
      pidStartTime: target.pidStartTime,
    });
    const forged = { ...target, token: "0".repeat(64) };
    await writeFile(connectionPath, JSON.stringify(forged));
    const refused = await spawnResult(argumentsList);
    assert.equal(refused.exitCode, 1);
    assert.match(refused.stderr, /unverified live process/);
    assert.deepEqual(
      JSON.parse(await readFile(connectionPath, "utf8")),
      forged
    );
    await writeFile(connectionPath, JSON.stringify(target));
  } finally {
    await apiRequest({
      path: "/v1/shutdown",
      method: "POST",
      body: "{}",
      target,
    }).catch(() => process.kill(target.pid, "SIGTERM"));
    await waitFor(async () => {
      try {
        process.kill(target.pid, 0);
        return false;
      } catch {
        return true;
      }
    });
    await rm(launchRoot, { recursive: true, force: true });
  }
});

test("rejects cross-origin, misdirected, and invalid bearer requests", async () => {
  const wrongHost = await apiRequest({
    headers: { host: `localhost:${connection.port}` },
  });
  assert.equal(wrongHost.status, 421);
  const origin = await apiRequest({
    headers: { origin: "https://example.com" },
  });
  assert.equal(origin.status, 403);
  const wrongBearer = await apiRequest({
    headers: { authorization: `Bearer ${"0".repeat(64)}` },
  });
  assert.equal(wrongBearer.status, 401);
  const shortBearer = await apiRequest({
    headers: { authorization: "Bearer short" },
  });
  assert.equal(shortBearer.status, 401);
});

test("bounds authenticated mutation concurrency and request rate", async () => {
  const blocked = Array.from({ length: 4 }, () => blockedMutation());
  await new Promise(resolve => setTimeout(resolve, 100));
  const busy = await apiRequest({
    path: "/v1/settings",
    method: "PATCH",
    body: "{}",
  });
  assert.equal(busy.status, 503);
  blocked.forEach(request => request.destroy());
  await new Promise(resolve => setTimeout(resolve, 100));

  const responses = [];
  for (let index = 0; index < 140; index++) {
    responses.push(await apiRequest({}));
  }
  assert.equal(
    responses.some(result => result.status === 429),
    true,
    "The authenticated API has a bounded token bucket"
  );
});
