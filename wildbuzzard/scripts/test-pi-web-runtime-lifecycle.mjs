#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHmac, randomBytes, randomInt } from "node:crypto";
import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { argv, env, stdout } from "node:process";

function parseArguments(values) {
  if (values.length !== 2 || values[0] !== "--runtime") {
    throw new Error("usage: test-pi-web-runtime-lifecycle.mjs --runtime DIR");
  }
  return resolve(values[1]);
}

async function allocateHighPort() {
  for (let attempt = 0; attempt < 200; attempt++) {
    const server = createServer();
    const port = randomInt(49152, 65536);
    const available = await new Promise(resolveAvailable => {
      server.once("error", () => resolveAvailable(false));
      server.listen(port, "127.0.0.1", () => resolveAvailable(true));
    });
    if (available) {
      await new Promise(resolveClose => server.close(resolveClose));
      return port;
    }
  }
  throw new Error("could not allocate a high loopback port");
}

async function privateJSON(path, value) {
  const temporary = `${path}.${randomBytes(16).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

async function requestJSON(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: "application/json",
      Connection: "close",
      ...(options.body === undefined
        ? {}
        : { "Content-Type": "application/json" }),
      ...options.headers,
    },
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!response.ok) {
    throw new Error(
      `${options.method ?? "GET"} ${url}: ${response.status} ${text}`
    );
  }
  return body;
}

function expectedProof(identity, challenge, secret) {
  const payload = JSON.stringify([
    identity.schema,
    challenge,
    identity.identityId,
    identity.pid,
    identity.executablePath,
    identity.configPath,
    identity.dataRoot,
    identity.host,
    identity.port,
    identity.runtimeIdentity,
  ]);
  return createHmac("sha256", secret).update(payload).digest("hex");
}

async function authenticatedHealth(baseURL, secret, runtimeIdentity) {
  const challenge = randomBytes(32).toString("hex");
  const body = await requestJSON(`${baseURL}api/machines/local/health`, {
    headers: { "X-WildBuzzard-Agent-Challenge": challenge },
  });
  const identity = body.serviceIdentity;
  if (
    body.ok !== true ||
    identity?.runtimeIdentity !== runtimeIdentity ||
    identity.proof !== expectedProof(identity, challenge, secret)
  ) {
    throw new Error(
      "Pi Web returned an invalid authenticated service identity"
    );
  }
  return identity;
}

async function waitForHealth(baseURL, secret, runtimeIdentity, children) {
  let lastError;
  for (let attempt = 0; attempt < 200; attempt++) {
    for (const child of children) {
      if (child.exitCode !== null) {
        throw new Error(
          `${child.name} exited with ${child.exitCode}: ${child.logs()}`
        );
      }
    }
    try {
      return await authenticatedHealth(baseURL, secret, runtimeIdentity);
    } catch (error) {
      lastError = error;
      await new Promise(resolveWait => setTimeout(resolveWait, 50));
    }
  }
  throw lastError;
}

async function waitForPath(path, children) {
  for (let attempt = 0; attempt < 200; attempt++) {
    for (const child of children) {
      if (child.exitCode !== null) {
        throw new Error(
          `${child.name} exited with ${child.exitCode}: ${child.logs()}`
        );
      }
    }
    try {
      await access(path);
      return;
    } catch {
      await new Promise(resolveWait => setTimeout(resolveWait, 50));
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

function start(serviceName, node, entrypoint, environment) {
  const child = spawn(node, [entrypoint], {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", chunk => {
      output = `${output}${chunk}`.slice(-65536);
    });
  }
  child.name = serviceName;
  child.logs = () => output;
  return child;
}

async function stopChild(child) {
  if (child.exitCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await Promise.race([
    new Promise(resolveExit => child.once("exit", resolveExit)),
    new Promise(resolveWait => setTimeout(resolveWait, 5000)),
  ]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
  }
}

async function main() {
  const runtime = parseArguments(argv.slice(2));
  const node = join(runtime, "node", "bin", "node");
  const packageRoot = join(runtime, "node_modules", "@jmfederico", "pi-web");
  const serverEntrypoint = join(packageRoot, "dist", "server", "index.js");
  const sessiondEntrypoint = join(packageRoot, "dist", "server", "sessiond.js");
  for (const path of [node, serverEntrypoint, sessiondEntrypoint]) {
    await readFile(path);
  }

  const root = await mkdtemp(join(tmpdir(), "wildbuzzard-pi-web-lifecycle-"));
  const dataRoot = join(root, "data");
  const agentDir = join(root, "agent");
  const projectDir = join(root, "project");
  const configPath = join(root, "config.json");
  const identityPath = join(root, "identity.json");
  const runtimeIdentity = `lifecycle-${basename(runtime)}`;
  const port = await allocateHighPort();
  const baseURL = `http://127.0.0.1:${port}/`;
  const children = [];
  try {
    for (const path of [dataRoot, agentDir, projectDir]) {
      await mkdir(path, { recursive: true, mode: 0o700 });
      await chmod(path, 0o700);
    }
    await privateJSON(configPath, {
      version: 1,
      host: "127.0.0.1",
      port,
      agent: { command: join(runtime, "bin", "pi"), dir: agentDir },
    });
    let secret = randomBytes(32);
    await privateJSON(identityPath, {
      schema: 1,
      secret: secret.toString("hex"),
      runtimeIdentity,
    });
    const environment = {
      ...env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
      PI_WEB_CONFIG: configPath,
      PI_WEB_DATA_DIR: dataRoot,
      PI_WEB_OFFLINE: "1",
      WILDBUZZARD_AGENT_LOCAL_ONLY: "1",
      WILDBUZZARD_PI_WEB_IDENTITY_FILE: identityPath,
    };
    const sessiond = start("sessiond", node, sessiondEntrypoint, environment);
    const web = start("web", node, serverEntrypoint, environment);
    children.push(sessiond, web);

    const firstIdentity = await waitForHealth(
      baseURL,
      secret,
      runtimeIdentity,
      children
    );
    await waitForPath(join(dataRoot, "sessiond.sock"), children);
    if (firstIdentity.pid !== web.pid) {
      throw new Error(
        "authenticated web PID does not match the spawned runtime"
      );
    }
    const project = await requestJSON(`${baseURL}api/projects`, {
      method: "POST",
      body: JSON.stringify({ name: "Lifecycle", path: projectDir }),
    });
    const session = await requestJSON(`${baseURL}api/sessions`, {
      method: "POST",
      body: JSON.stringify({ cwd: projectDir }),
    });
    if (typeof session.id !== "string" || session.id === "") {
      throw new Error("Pi Web did not create a real session");
    }

    const originalPids = { web: web.pid, sessiond: sessiond.pid };
    secret = randomBytes(32);
    await privateJSON(identityPath, {
      schema: 1,
      secret: secret.toString("hex"),
      runtimeIdentity,
    });
    const secondIdentity = await authenticatedHealth(
      baseURL,
      secret,
      runtimeIdentity
    );
    const sessionAfterReconnect = await requestJSON(
      `${baseURL}api/sessions/${encodeURIComponent(
        session.id
      )}/status?cwd=${encodeURIComponent(projectDir)}`
    );
    const projectsAfterReconnect = await requestJSON(`${baseURL}api/projects`);
    const checks = {
      authenticatedPid: secondIdentity.pid === originalPids.web,
      webPid: web.pid === originalPids.web && web.exitCode === null,
      sessiondPid:
        sessiond.pid === originalPids.sessiond && sessiond.exitCode === null,
      identityRotated: secondIdentity.identityId !== firstIdentity.identityId,
      sessionRetained:
        sessionAfterReconnect !== null &&
        typeof sessionAfterReconnect === "object",
      projectRetained:
        Array.isArray(projectsAfterReconnect) &&
        projectsAfterReconnect.some(item => item.id === project.id),
    };
    if (Object.values(checks).some(value => !value)) {
      throw new Error(
        `Pi Web reconnect checks failed: ${JSON.stringify({
          checks,
          createdSession: session,
          sessionAfterReconnect,
        })}`
      );
    }
    stdout.write(
      `${JSON.stringify({
        ok: true,
        pids: originalPids,
        projectId: project.id,
        sessionId: session.id,
        identityRotated: true,
        sessionRetained: true,
      })}\n`
    );
  } finally {
    await Promise.all(children.map(stopChild));
    await rm(root, { recursive: true, force: true });
  }
}

await main();
