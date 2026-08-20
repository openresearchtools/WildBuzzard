// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export const VERSION = "0.1.0";
export const PROTOCOL_VERSION = 1;
const HOST = "127.0.0.1";

function xdg(variable, fallback) {
  return process.env[variable] || fallback;
}

export function servicePaths() {
  const home = os.homedir();
  const data = path.join(
    xdg("XDG_DATA_HOME", path.join(home, ".local", "share")),
    "buzzard",
    "torrent-search"
  );
  const runtimeBase = process.env.XDG_RUNTIME_DIR;
  return {
    data,
    state: runtimeBase
      ? path.join(runtimeBase, "buzzard", "torrent-search")
      : path.join("/tmp", `buzzard-${process.getuid()}`, "torrent-search"),
    runtime:
      process.env.BUZZARD_TORRENT_SEARCH_RUNTIME ||
      "/usr/lib/buzzard-torrent-search/runtime",
  };
}

async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`unsafe torrent-search directory: ${directory}`);
  }
  await chmod(directory, 0o700);
  return realpath(directory);
}

async function processStartTime(pid) {
  const value = await readFile(`/proc/${pid}/stat`, "utf8");
  const fields = value.slice(value.lastIndexOf(")") + 2).trim().split(/\s+/);
  if (!/^\d+$/.test(fields[19] || "")) {
    throw new Error("torrent-search process identity is unavailable");
  }
  return fields[19];
}

async function processMatches(record) {
  try {
    return (
      (await processStartTime(record.pid)) === record.processStartTime &&
      (await realpath(`/proc/${record.pid}/exe`)) === record.executablePath
    );
  } catch {
    return false;
  }
}

async function withLaunchLock(state, operation) {
  const file = path.join(state, "launch.lock");
  const token = randomBytes(24).toString("base64url");
  const deadline = Date.now() + 30_000;
  let handle;
  while (!handle && Date.now() < deadline) {
    try {
      handle = await open(file, "wx", 0o600);
      await handle.writeFile(
        `${JSON.stringify({ pid: process.pid, processStartTime: await processStartTime(process.pid), token })}\n`,
        "utf8"
      );
      await handle.sync();
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let owner;
      let info;
      try {
        info = await lstat(file);
        owner = JSON.parse(await readFile(file, "utf8"));
      } catch {
        owner = null;
      }
      if (owner && !(await processMatches({
        pid: owner.pid,
        processStartTime: owner.processStartTime,
        executablePath: await realpath(`/proc/${owner.pid}/exe`).catch(() => ""),
      }))) {
        await unlink(file).catch(() => {});
        continue;
      }
      if (!owner && info && Date.now() - info.mtimeMs > 30_000) {
        await unlink(file).catch(() => {});
        continue;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  if (!handle) throw new Error("torrent-search launch lock timed out");
  try {
    return await operation();
  } finally {
    await handle.close();
    try {
      const owner = JSON.parse(await readFile(file, "utf8"));
      if (owner.token === token) await unlink(file);
    } catch {}
  }
}

async function atomicJson(file, value) {
  const temporary = `${file}.new-${randomBytes(12).toString("hex")}`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await chmod(temporary, 0o600);
  await rename(temporary, file);
}

async function readRecord(state) {
  const file = path.join(state, "connection.json");
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
      return null;
    }
    const value = JSON.parse(await readFile(file, "utf8"));
    if (
      value.schema !== 1 ||
      value.protocolVersion !== PROTOCOL_VERSION ||
      value.address !== HOST ||
      !Number.isInteger(value.port) ||
      typeof value.capability !== "string"
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function request(record, method, pathname, body, timeout = 35_000) {
  return new Promise((resolve, reject) => {
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request(
      {
        host: HOST,
        port: record.port,
        path: pathname,
        method,
        timeout,
        headers: {
          Authorization: `Bearer ${record.capability}`,
          "Cache-Control": "no-store",
          ...(serialized
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(serialized),
              }
            : {}),
        },
      },
      response => {
        const chunks = [];
        let length = 0;
        response.on("data", chunk => {
          length += chunk.length;
          if (length > 12 * 1024 * 1024) {
            request.destroy(new Error("torrent-search response exceeded its limit"));
          } else {
            chunks.push(chunk);
          }
        });
        response.on("end", () => {
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (response.statusCode < 200 || response.statusCode >= 300) {
              reject(new Error(value.error || `torrent-search failed (${response.statusCode})`));
            } else {
              resolve(value);
            }
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    request.on("timeout", () => request.destroy(new Error("torrent-search request timed out")));
    request.on("error", reject);
    if (serialized) {
      request.end(serialized);
    } else {
      request.end();
    }
  });
}

async function healthy(record) {
  try {
    const value = await request(record, "GET", "/v1/health", undefined, 2_000);
    return value.status === "ok" && value.protocolVersion === PROTOCOL_VERSION;
  } catch {
    return false;
  }
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForHealth(record, child) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && child.exitCode === null) {
    if (await healthy(record)) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("torrent-search service did not become healthy");
}

export async function ensureService() {
  const owned = servicePaths();
  const data = await privateDirectory(owned.data);
  const state = await privateDirectory(owned.state);
  const existing = await readRecord(state);
  if (existing && (await processMatches(existing)) && (await healthy(existing))) {
    return existing;
  }
  return withLaunchLock(state, async () => {
    const published = await readRecord(state);
    if (published && (await processMatches(published)) && (await healthy(published))) {
      return published;
    }
    const executablePath = await realpath(path.join(owned.runtime, "jackett-mini"));
    if (path.dirname(executablePath) !== path.resolve(owned.runtime)) {
      throw new Error("torrent-search executable leaves its package runtime");
    }
    const capability = randomBytes(32).toString("base64url");
    const capabilityPath = path.join(state, `capability-${randomBytes(8).toString("hex")}`);
    const pidPath = path.join(state, `process-${randomBytes(8).toString("hex")}.pid`);
    await writeFile(capabilityPath, `${capability}\n`, { flag: "wx", mode: 0o600 });
    const port = await freePort();
    const child = spawn(
      executablePath,
      [
        "--ListenPrivate",
        "--Port",
        String(port),
        "--PIDFile",
        pidPath,
        "--NoUpdates",
        "--NoRestart",
        "--DataFolder",
        data,
        "--CapabilityFile",
        capabilityPath,
      ],
      {
        detached: true,
        stdio: "ignore",
        env: {
          DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: "1",
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
          TZ: "UTC",
        },
      }
    );
    child.unref();
    const record = {
      schema: 1,
      protocolVersion: PROTOCOL_VERSION,
      address: HOST,
      port,
      capability,
      capabilityPath,
      pid: child.pid,
      pidPath,
      processStartTime: await processStartTime(child.pid),
      executablePath,
      dataRoot: data,
      createdAt: new Date().toISOString(),
    };
    try {
      await waitForHealth(record, child);
      await atomicJson(path.join(state, "connection.json"), record);
      return record;
    } catch (error) {
      child.kill("SIGTERM");
      await unlink(capabilityPath).catch(() => {});
      await unlink(pidPath).catch(() => {});
      throw error;
    }
  });
}

export async function serviceStatus() {
  const state = await privateDirectory(servicePaths().state);
  const record = await readRecord(state);
  return record && (await processMatches(record)) && (await healthy(record))
    ? { running: true, healthy: true, pid: record.pid }
    : { running: false };
}

export async function stopService() {
  const state = await privateDirectory(servicePaths().state);
  return withLaunchLock(state, async () => {
    const record = await readRecord(state);
    if (record && (await processMatches(record))) {
      process.kill(record.pid, "SIGTERM");
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && (await processMatches(record))) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (await processMatches(record)) {
        process.kill(record.pid, "SIGKILL");
      }
    }
    await unlink(path.join(state, "connection.json")).catch(() => {});
    if (record) {
      await unlink(record.capabilityPath).catch(() => {});
      await unlink(record.pidPath).catch(() => {});
    }
    return { running: false };
  });
}

function searchArguments(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("torrent_search arguments must be an object");
  }
  const query = String(value.query || "").trim();
  const limit = value.limit ?? 100;
  if (!query || query.length > 256 || /\p{Cc}/u.test(query)) {
    throw new Error("torrent_search query must contain 1 to 256 characters");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("torrent_search limit must be between 1 and 200");
  }
  const body = { query, limit };
  if (value.sourceIds !== undefined) {
    if (
      !Array.isArray(value.sourceIds) ||
      !value.sourceIds.length ||
      value.sourceIds.length > 100 ||
      new Set(value.sourceIds).size !== value.sourceIds.length ||
      value.sourceIds.some(item => typeof item !== "string" || !item || item.length > 128)
    ) {
      throw new Error("torrent_search sourceIds are invalid");
    }
    body.sourceIds = value.sourceIds;
  }
  return body;
}

export async function invoke(tool, args = {}) {
  if (tool === "torrent_search_status") {
    return serviceStatus();
  }
  const record = await ensureService();
  if (tool === "torrent_sources") {
    return request(record, "GET", "/v1/sources");
  }
  if (tool === "torrent_search") {
    return request(record, "POST", "/v1/search", searchArguments(args));
  }
  if (tool === "torrent_resolve") {
    if (!/^[A-Za-z0-9_-]{32}$/.test(args.resultId || "")) {
      throw new Error("torrent_resolve resultId is invalid or expired");
    }
    return request(
      record,
      "POST",
      `/v1/results/${encodeURIComponent(args.resultId)}/resolve`,
      {}
    );
  }
  throw new Error(`unknown torrent-search tool: ${tool}`);
}
