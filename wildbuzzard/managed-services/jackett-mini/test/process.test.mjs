// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ensureJackettMini,
  inspectJackettMini,
  stopJackettMini,
} from "../process.mjs";

const runtimeDirectory = process.env.JACKETT_MINI_TEST_RUNTIME;
const runtimeManifestPath = process.env.JACKETT_MINI_TEST_MANIFEST;

function request(
  record,
  pathname,
  { method = "GET", capability = record.capability, headers = {}, body } = {}
) {
  return new Promise((resolve, reject) => {
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request(
      {
        host: "127.0.0.1",
        port: record.port,
        path: pathname,
        method,
        headers: {
          Authorization: `Bearer ${capability}`,
          ...(serialized
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(serialized),
              }
            : {}),
          ...headers,
        },
      },
      response => {
        const chunks = [];
        response.on("data", chunk => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            text: Buffer.concat(chunks).toString("utf8"),
          })
        );
      }
    );
    request.on("error", reject);
    if (serialized) {
      request.write(serialized);
    }
    request.end();
  });
}

test(
  "Jackett Mini lifecycle, authentication, and forbidden routes",
  { skip: !runtimeDirectory || !runtimeManifestPath },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "jackett-mini-contract-"));
    const dataDirectory = path.join(root, "data");
    const runtimeStateDirectory = path.join(root, "run");
    const options = { runtimeDirectory, runtimeManifestPath, dataDirectory, runtimeStateDirectory };
    const [record, concurrentRecord] = await Promise.all([
      ensureJackettMini(options),
      ensureJackettMini(options),
    ]);
    try {
      assert.equal(concurrentRecord.pid, record.pid);
      assert.equal(record.address, "127.0.0.1");
      assert.equal(record.protocolVersion, 1);
      assert.equal((await stat(dataDirectory)).mode & 0o777, 0o700);
      assert.equal((await stat(runtimeStateDirectory)).mode & 0o777, 0o700);
      assert.equal(
        (await stat(path.join(runtimeStateDirectory, "connection.json"))).mode &
          0o777,
        0o600
      );
      assert.equal((await stat(record.capabilityPath)).mode & 0o777, 0o600);
      assert.equal((await ensureJackettMini(options)).pid, record.pid);
      assert.equal((await inspectJackettMini({ runtimeStateDirectory })).pid, record.pid);

      assert.equal((await request(record, "/v1/health", { capability: "invalid" })).status, 401);
      assert.equal((await request(record, "/v1/health?apikey=forbidden")).status, 400);
      assert.equal(
        (
          await request(record, "/v1/health", {
            headers: { Origin: "https://example.test" },
          })
        ).status,
        403
      );
      assert.equal(
        (
          await request(record, "/v1/health", {
            headers: { Host: `localhost:${record.port}` },
          })
        ).status,
        403
      );
      assert.equal(
        (
          await request(record, "/v1/health", {
            headers: { Host: "127.0.0.1:1" },
          })
        ).status,
        403
      );
      assert.equal((await request(record, "/UI/Dashboard")).status, 404);
      assert.equal(
        (await request(record, "/api/v2.0/indexers/all/results/torznab/api"))
          .status,
        404
      );
      assert.equal((await request(record, "/v1/search")).status, 404);
      assert.equal(
        (
          await request(record, "/v1/search", {
            method: "POST",
            body: { query: "x", adult: true },
          })
        ).status,
        400
      );
      assert.equal(
        (
          await request(record, "/v1/search", {
            method: "POST",
            headers: { "Content-Type": "text/plain" },
            body: { query: "x" },
          })
        ).status,
        400
      );
      assert.equal(
        (
          await request(record, "/v1/search", {
            method: "POST",
            body: { query: "x", sourceIds: ["nekobt"] },
          })
        ).status,
        400
      );
      assert.equal(
        (
          await request(record, "/v1/search", {
            method: "POST",
            body: { query: "x", sourceIds: [null] },
          })
        ).status,
        400
      );
      assert.equal(
        (
          await request(
            record,
            "/v1/results/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/resolve",
            { method: "POST" }
          )
        ).status,
        404
      );
      const sources = JSON.parse((await request(record, "/v1/sources")).text);
      assert.equal(sources.immutable, true);
      assert.equal(sources.sources.length, 60);
      assert.ok(
        sources.sources.every(
          source =>
            source.access === "public" && source.contentClass !== "adult-only"
        )
      );

      const otherRecord = await ensureJackettMini({
        runtimeDirectory,
        runtimeManifestPath,
        dataDirectory: path.join(root, "other-data"),
        runtimeStateDirectory: path.join(root, "other-run"),
      });
      try {
        assert.notEqual(otherRecord.dataRootId, record.dataRootId);
        assert.equal(
          (await request(otherRecord, "/v1/health", { capability: record.capability })).status,
          401
        );
      } finally {
        assert.equal(
          await stopJackettMini({ runtimeStateDirectory: path.join(root, "other-run") }),
          true
        );
      }
    } finally {
      assert.equal(await stopJackettMini({ runtimeStateDirectory }), true);
      assert.equal(await inspectJackettMini({ runtimeStateDirectory }), null);
    }

    const connectionPath = path.join(runtimeStateDirectory, "connection.json");
    const staleLockDirectory = path.join(runtimeStateDirectory, "launch.lock");
    await mkdir(staleLockDirectory, { mode: 0o700 });
    await writeFile(
      path.join(staleLockDirectory, "owner.json"),
      `${JSON.stringify({ pid: process.pid, linuxProcessStartTime: "0", token: "stale" })}\n`,
      { mode: 0o600 }
    );
    await writeFile(
      connectionPath,
      `${JSON.stringify({
        pid: process.pid,
        linuxProcessStartTime: "0",
        executablePath: process.execPath,
        executableSha256: "0".repeat(64),
      })}\n`,
      { mode: 0o600 }
    );
    assert.equal(await stopJackettMini({ runtimeStateDirectory }), false);
    assert.ok((await readFile(`/proc/${process.pid}/stat`, "utf8")).length > 0);
    await rm(root, { recursive: true });
  }
);

test(
  "Jackett Mini rejects an incomplete runtime inventory",
  { skip: !runtimeDirectory || !runtimeManifestPath },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "jackett-mini-manifest-"));
    const incompleteRuntime = path.join(root, "runtime");
    const dataDirectory = path.join(root, "data");
    const runtimeStateDirectory = path.join(root, "run");
    await mkdir(incompleteRuntime);
    await copyFile(
      path.join(runtimeDirectory, "jackett-mini"),
      path.join(incompleteRuntime, "jackett-mini")
    );
    await chmod(path.join(incompleteRuntime, "jackett-mini"), 0o755);
    await assert.rejects(
      ensureJackettMini({
        runtimeDirectory: incompleteRuntime,
        runtimeManifestPath,
        dataDirectory,
        runtimeStateDirectory,
      }),
      /runtime inventory or digest mismatch/
    );
    await rm(root, { recursive: true });
  }
);
