// SPDX-License-Identifier: AGPL-3.0-or-later

/* global Buffer, process */

import { createHash, randomBytes, randomInt } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open as openFile,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";

const HOST = "127.0.0.1";
const CAPABILITY_BYTES = 32;
const START_ATTEMPTS = 8;

async function sha256(filePath) {
  const hash = createHash("sha256");
  const file = await openFile(filePath, "r");
  try {
    for await (const chunk of file.createReadStream()) {
      hash.update(chunk);
    }
  } finally {
    await file.close();
  }
  return hash.digest("hex");
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function runtimeInventory(runtimeDirectory, relativeDirectory = "") {
  const directory = path.join(runtimeDirectory, relativeDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  const inventory = [];
  for (const entry of entries) {
    const relativePath = relativeDirectory
      ? `${relativeDirectory}/${entry.name}`
      : entry.name;
    const fullPath = path.join(runtimeDirectory, relativePath);
    const info = await lstat(fullPath);
    if (info.isSymbolicLink()) {
      throw new Error(
        `Jackett Mini runtime contains a symbolic link: ${relativePath}`
      );
    }
    if (info.isDirectory()) {
      inventory.push(
        ...(await runtimeInventory(runtimeDirectory, relativePath))
      );
    } else if (info.isFile()) {
      inventory.push({
        executable: Boolean(info.mode & 0o111),
        path: relativePath,
        sha256: await sha256(fullPath),
        size: info.size,
      });
    } else {
      throw new Error(
        `Jackett Mini runtime contains a special file: ${relativePath}`
      );
    }
  }
  return inventory;
}

async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Unsafe Jackett Mini directory: ${directory}`);
  }
  await chmod(directory, 0o700);
  return realpath(directory);
}

async function atomicPrivateJson(filePath, value) {
  const temporary = `${filePath}.new-${randomBytes(12).toString("hex")}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await chmod(temporary, 0o600);
  await rename(temporary, filePath);
}

async function readProcessStartTime(pid) {
  const value = await readFile(`/proc/${pid}/stat`, "utf8");
  const closingParenthesis = value.lastIndexOf(")");
  if (closingParenthesis < 0) {
    throw new Error("Malformed Linux process identity");
  }
  const fields = value
    .slice(closingParenthesis + 2)
    .trim()
    .split(/\s+/);
  if (fields.length < 20 || !/^\d+$/.test(fields[19])) {
    throw new Error("Linux process start time is unavailable");
  }
  return fields[19];
}

async function processMatches(record) {
  try {
    if (
      (await readProcessStartTime(record.pid)) !== record.linuxProcessStartTime
    ) {
      return false;
    }
    const executable = await realpath(`/proc/${record.pid}/exe`);
    return (
      executable === record.executablePath &&
      (await sha256(executable)) === record.executableSha256
    );
  } catch {
    return false;
  }
}

function requestJson({ port, capability, pathname, method = "GET", body }) {
  return new Promise((resolve, reject) => {
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request(
      {
        host: HOST,
        port,
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
        },
        timeout: 1000,
      },
      response => {
        const chunks = [];
        let responseLength = 0;
        response.on("data", chunk => {
          responseLength += chunk.length;
          if (responseLength > 1024 * 1024) {
            request.destroy(new Error("Jackett Mini response exceeded limit"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          try {
            resolve({
              status: response.statusCode,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
            });
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    request.on("timeout", () =>
      request.destroy(new Error("Jackett Mini request timed out"))
    );
    request.on("error", reject);
    if (serialized) {
      request.write(serialized);
    }
    request.end();
  });
}

async function healthMatches(record) {
  try {
    const response = await requestJson({
      port: record.port,
      capability: record.capability,
      pathname: "/v1/health",
    });
    const health = response.body;
    return (
      response.status === 200 &&
      health.status === "ok" &&
      health.protocolVersion === record.protocolVersion &&
      health.runtimeVersion === record.runtimeVersion &&
      health.processId === record.pid &&
      health.instanceId === record.ownerInstanceId &&
      health.executablePath === record.executablePath &&
      health.executableSha256 === record.executableSha256 &&
      health.dataRootId === record.dataRootId
    );
  } catch {
    return false;
  }
}

async function choosePort() {
  for (let attempt = 0; attempt < 32; attempt++) {
    const port = randomInt(49152, 65536);
    const available = await new Promise(resolve => {
      const server = http.createServer();
      server.once("error", () => resolve(false));
      server.listen(port, HOST, () => server.close(() => resolve(true)));
    });
    if (available) {
      return port;
    }
  }
  throw new Error("No private Jackett Mini port was available");
}

async function waitForHealth(
  port,
  capability,
  child,
  expected,
  timeoutMs = 15000
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      const response = await requestJson({
        port,
        capability,
        pathname: "/v1/health",
      });
      const health = response.body;
      if (
        response.status === 200 &&
        health.status === "ok" &&
        health.protocolVersion === 1 &&
        health.runtimeVersion === expected.runtimeVersion &&
        health.executablePath === expected.executablePath &&
        health.executableSha256 === expected.executableSha256
      ) {
        return health;
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Jackett Mini did not become identity-verified and healthy");
}

async function loadManifest(manifestPath, runtimeDirectory) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (
    manifest.component !== "jackett-mini" ||
    manifest.protocolVersion !== 1 ||
    manifest.platform !== "linux" ||
    manifest.architecture !== "x86_64" ||
    manifest.libc !== "glibc" ||
    manifest.upstreamVersion !== "v0.24.2360" ||
    manifest.upstreamCommit !== "0cd8622b735922a909a128d8d6943bb8565a640f" ||
    manifest.enabledProviderCount !== 60 ||
    manifest.license !== "GPL-2.0-only" ||
    manifest.correspondingSource !== "source/jackett" ||
    manifest.sbom !== "jackett-mini.spdx.json" ||
    !Array.isArray(manifest.licenseLocations) ||
    manifest.executableName !== "jackett-mini" ||
    manifest.updaterIncluded !== false ||
    manifest.dashboardIncluded !== false ||
    !Array.isArray(manifest.files)
  ) {
    throw new Error("Jackett Mini runtime manifest is incompatible");
  }
  const inventory = await runtimeInventory(runtimeDirectory);
  const relativeManifest = path.relative(
    runtimeDirectory,
    await realpath(manifestPath)
  );
  const files = inventory
    .filter(entry => entry.path !== relativeManifest)
    .sort((left, right) => {
      if (left.path < right.path) {
        return -1;
      }
      if (left.path > right.path) {
        return 1;
      }
      return 0;
    });
  if (
    inventory.length !==
      files.length + (relativeManifest.startsWith("..") ? 0 : 1) ||
    JSON.stringify(files) !== JSON.stringify(manifest.files) ||
    sha256Bytes(JSON.stringify(files)) !== manifest.runtimeSha256
  ) {
    throw new Error("Jackett Mini runtime inventory or digest mismatch");
  }
  if (
    !files.some(entry =>
      entry.path.startsWith(`${manifest.correspondingSource}/`)
    ) ||
    !files.some(entry => entry.path === manifest.sbom) ||
    manifest.licenseLocations.some(
      license => !files.some(entry => entry.path === license)
    )
  ) {
    throw new Error(
      "Jackett Mini source, SBOM, or license inventory is incomplete"
    );
  }
  const executablePath = await realpath(
    path.join(runtimeDirectory, manifest.executableName)
  );
  if (path.dirname(executablePath) !== runtimeDirectory) {
    throw new Error("Jackett Mini executable leaves the immutable runtime");
  }
  const fileEntry = files.find(entry => entry.path === manifest.executableName);
  if (!fileEntry || !fileEntry.executable) {
    throw new Error("Jackett Mini executable digest mismatch");
  }
  return { manifest, executablePath, executableSha256: fileEntry.sha256 };
}

async function readConnection(connectionPath) {
  try {
    const info = await lstat(connectionPath);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
      return null;
    }
    return JSON.parse(await readFile(connectionPath, "utf8"));
  } catch {
    return null;
  }
}

async function acquireLock(stateDirectory) {
  const lockDirectory = path.join(stateDirectory, "launch.lock");
  const ownerPath = path.join(lockDirectory, "owner.json");
  const token = randomBytes(16).toString("hex");
  const deadline = Date.now() + 130000;
  while (Date.now() < deadline) {
    try {
      await mkdir(lockDirectory, { mode: 0o700 });
      await atomicPrivateJson(ownerPath, {
        pid: process.pid,
        linuxProcessStartTime: await readProcessStartTime(process.pid),
        token,
      });
      return async () => {
        try {
          const owner = JSON.parse(await readFile(ownerPath, "utf8"));
          if (owner.token === token) {
            await rm(lockDirectory, { recursive: true });
          }
        } catch {}
      };
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
    }
    let stale = false;
    try {
      const info = await lstat(lockDirectory);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error("Unsafe Jackett Mini launch lock");
      }
      try {
        const owner = JSON.parse(await readFile(ownerPath, "utf8"));
        stale =
          (await readProcessStartTime(owner.pid)) !==
          owner.linuxProcessStartTime;
      } catch {
        stale = Date.now() - info.mtimeMs > 2000;
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
    if (stale) {
      await rm(lockDirectory, { recursive: true }).catch(() => {});
      continue;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for the Jackett Mini launch lock");
}

export async function ensureJackettMini({
  runtimeDirectory,
  runtimeManifestPath,
  dataDirectory,
  runtimeStateDirectory,
}) {
  runtimeDirectory = await realpath(runtimeDirectory);
  dataDirectory = await ensurePrivateDirectory(dataDirectory);
  runtimeStateDirectory = await ensurePrivateDirectory(runtimeStateDirectory);
  const releaseLock = await acquireLock(runtimeStateDirectory);
  const connectionPath = path.join(runtimeStateDirectory, "connection.json");
  try {
    const runtime = await loadManifest(runtimeManifestPath, runtimeDirectory);
    const existing = await readConnection(connectionPath);
    if (
      existing &&
      (await processMatches(existing)) &&
      (await healthMatches(existing))
    ) {
      return existing;
    }
    if (existing) {
      await unlink(connectionPath).catch(() => {});
    }
    for (let attempt = 0; attempt < START_ATTEMPTS; attempt++) {
      const port = await choosePort();
      const capability = randomBytes(CAPABILITY_BYTES).toString("base64url");
      const capabilityPath = path.join(
        runtimeStateDirectory,
        `capability-${randomBytes(8).toString("hex")}`
      );
      const pidPath = path.join(
        runtimeStateDirectory,
        `jackett-${randomBytes(8).toString("hex")}.pid`
      );
      await writeFile(capabilityPath, `${capability}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      await chmod(capabilityPath, 0o600);
      const child = spawn(
        runtime.executablePath,
        [
          "--ListenPrivate",
          "--Port",
          String(port),
          "--PIDFile",
          pidPath,
          "--NoUpdates",
          "--NoRestart",
          "--DataFolder",
          dataDirectory,
          "--CapabilityFile",
          capabilityPath,
        ],
        {
          detached: true,
          stdio: "ignore",
          env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "UTC" },
        }
      );
      child.unref();
      try {
        const health = await waitForHealth(port, capability, child, {
          runtimeVersion: runtime.manifest.upstreamVersion,
          executablePath: runtime.executablePath,
          executableSha256: runtime.executableSha256,
        });
        const record = {
          schemaVersion: 1,
          protocolVersion: 1,
          runtimeVersion: health.runtimeVersion,
          address: HOST,
          port,
          capability,
          capabilityPath,
          pid: child.pid,
          pidPath,
          linuxProcessStartTime: await readProcessStartTime(child.pid),
          executablePath: runtime.executablePath,
          executableSha256: runtime.executableSha256,
          dataRoot: dataDirectory,
          dataRootId: health.dataRootId,
          ownerInstanceId: health.instanceId,
          createdAt: new Date().toISOString(),
          lastHealthAt: new Date().toISOString(),
        };
        await atomicPrivateJson(connectionPath, record);
        return record;
      } catch (error) {
        if (child.exitCode === null) {
          child.kill("SIGTERM");
        }
        await unlink(capabilityPath).catch(() => {});
        await unlink(pidPath).catch(() => {});
        if (attempt === START_ATTEMPTS - 1) {
          throw error;
        }
      }
    }
    throw new Error("Jackett Mini startup attempts were exhausted");
  } finally {
    await releaseLock();
  }
}

async function waitForExit(record, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await processMatches(record))) {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
}

export async function stopJackettMini({ runtimeStateDirectory }) {
  runtimeStateDirectory = await ensurePrivateDirectory(runtimeStateDirectory);
  const releaseLock = await acquireLock(runtimeStateDirectory);
  const connectionPath = path.join(runtimeStateDirectory, "connection.json");
  try {
    const record = await readConnection(connectionPath);
    if (!record) {
      return false;
    }
    if (!(await processMatches(record))) {
      await unlink(connectionPath).catch(() => {});
      return false;
    }
    process.kill(record.pid, "SIGTERM");
    if (!(await waitForExit(record, 5000)) && (await processMatches(record))) {
      process.kill(record.pid, "SIGKILL");
      await waitForExit(record, 2000);
    }
    await unlink(connectionPath).catch(() => {});
    await unlink(record.capabilityPath).catch(() => {});
    await unlink(record.pidPath).catch(() => {});
    return true;
  } finally {
    await releaseLock();
  }
}

export async function inspectJackettMini({ runtimeStateDirectory }) {
  const connectionPath = path.join(runtimeStateDirectory, "connection.json");
  const record = await readConnection(connectionPath);
  if (
    !record ||
    !(await processMatches(record)) ||
    !(await healthMatches(record))
  ) {
    return null;
  }
  return record;
}
