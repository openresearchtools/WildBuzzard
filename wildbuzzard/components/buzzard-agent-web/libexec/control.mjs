#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const webUnit = "buzzard-agent-web.service";
const sessiondUnit = "buzzard-agent-web-sessiond.service";
const serviceUnits = [sessiondUnit, webUnit];
const runtimeRoot = "/usr/lib/buzzard-agent-web";
const upstreamCli = join(runtimeRoot, "app/node_modules/@jmfederico/pi-web/dist/cli.js");
const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${String(process.getuid())}`;
const controlDir = join(runtimeDir, "buzzard-agent-web");
const statePath = join(controlDir, "state.json");
const environmentPath = join(controlDir, "environment");
const systemctl = process.env.BUZZARD_AGENT_WEB_SYSTEMCTL || "systemctl";

function optionValue(args, index, name) {
  const value = args[index + 1];
  if (value === undefined || value === "") throw new Error(`${name} requires a value`);
  return value;
}

function parseOptions(args) {
  const options = { json: false, localOnly: undefined, offline: undefined };
  const valueOptions = new Map([
    ["--host", "host"],
    ["--port", "port"],
    ["--config", "configPath"],
    ["--data-dir", "dataDir"],
    ["--agent-dir", "agentDir"],
    ["--agent-command", "agentCommand"],
    ["--identity-file", "identityFile"],
    ["--origin", "origin"],
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      options.json = true;
    } else if (argument === "--local-only") {
      options.localOnly = true;
    } else if (argument === "--allow-remote-machines") {
      options.localOnly = false;
    } else if (argument === "--offline") {
      options.offline = true;
    } else if (argument === "--online") {
      options.offline = false;
    } else if (valueOptions.has(argument)) {
      options[valueOptions.get(argument)] = optionValue(args, index, argument);
      index += 1;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return options;
}

function nonEmpty(value, fallback) {
  return typeof value === "string" && value !== "" ? value : fallback;
}

function defaultConfiguration() {
  const home = nonEmpty(process.env.HOME, homedir());
  const dataHome = nonEmpty(process.env.XDG_DATA_HOME, join(home, ".local/share"));
  const configHome = nonEmpty(process.env.XDG_CONFIG_HOME, join(home, ".config"));
  const agentDir = nonEmpty(process.env.BUZZARD_AGENT_DIR, nonEmpty(process.env.PI_CODING_AGENT_DIR, join(home, ".buzzard-agent/agent")));
  return {
    host: nonEmpty(process.env.BUZZARD_AGENT_WEB_HOST, nonEmpty(process.env.PI_WEB_HOST, "127.0.0.1")),
    port: Number(nonEmpty(process.env.BUZZARD_AGENT_WEB_PORT, nonEmpty(process.env.PI_WEB_PORT, "8765"))),
    configPath: nonEmpty(process.env.BUZZARD_AGENT_WEB_CONFIG, nonEmpty(process.env.PI_WEB_CONFIG, join(configHome, "wildbuzzard/agent/config.json"))),
    dataDir: nonEmpty(process.env.BUZZARD_AGENT_WEB_DATA_DIR, nonEmpty(process.env.PI_WEB_DATA_DIR, join(dataHome, "wildbuzzard/agent"))),
    agentDir,
    agentCommand: nonEmpty(process.env.BUZZARD_AGENT_WEB_AGENT_COMMAND, nonEmpty(process.env.PI_WEB_AGENT_COMMAND, "/usr/bin/buzzard-agent")),
    identityFile: nonEmpty(process.env.BUZZARD_AGENT_WEB_IDENTITY_FILE, nonEmpty(process.env.WILDBUZZARD_PI_WEB_IDENTITY_FILE, null)),
    localOnly: process.env.BUZZARD_AGENT_WEB_LOCAL_ONLY === "1" || process.env.WILDBUZZARD_AGENT_LOCAL_ONLY === "1",
    offline: process.env.BUZZARD_AGENT_WEB_OFFLINE === "1" || process.env.PI_OFFLINE === "1",
    origin: nonEmpty(process.env.BUZZARD_AGENT_WEB_ORIGIN, null),
  };
}

async function readState() {
  try {
    const value = JSON.parse(await readFile(statePath, "utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

function validatePath(value, label, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== "string" || !isAbsolute(value) || /[\n\r\0]/u.test(value)) throw new Error(`${label} must be an absolute path`);
}

function configuration(state, options) {
  const config = { ...defaultConfiguration(), ...state };
  for (const key of ["host", "port", "configPath", "dataDir", "agentDir", "agentCommand", "identityFile", "localOnly", "offline", "origin"]) {
    if (options[key] !== undefined) config[key] = key === "port" ? Number(options[key]) : options[key];
  }
  if (typeof config.host !== "string" || config.host === "" || /[\s\0]/u.test(config.host)) throw new Error("host must be a non-empty address");
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error("port must be an integer from 1 to 65535");
  for (const [key, label] of [["configPath", "config"], ["dataDir", "data directory"], ["agentDir", "agent directory"], ["agentCommand", "agent command"]]) validatePath(config[key], label);
  validatePath(config.identityFile, "identity file", true);
  if (config.origin !== null && (typeof config.origin !== "string" || !/^https?:\/\/[^\s]+$/u.test(config.origin))) throw new Error("origin must be an HTTP(S) URL");
  config.localOnly = config.localOnly === true;
  config.offline = config.offline === true;
  return config;
}

function clientHost(host) {
  if (host === "0.0.0.0" || host === "::" || host === "[::]") return "127.0.0.1";
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function serviceUrl(config) {
  return (config.origin || `http://${clientHost(config.host)}:${String(config.port)}`).replace(/\/+$/u, "");
}

function environmentValue(value) {
  if (/[\n\r\0]/u.test(value)) throw new Error("service environment values cannot contain control characters");
  return JSON.stringify(value);
}

async function persistConfiguration(config) {
  await mkdir(controlDir, { recursive: true, mode: 0o700 });
  await chmod(controlDir, 0o700);
  const environment = {
    BUZZARD_AGENT_DIR: config.agentDir,
    PI_CODING_AGENT_DIR: config.agentDir,
    BUZZARD_AGENT_WEB_HOST: config.host,
    BUZZARD_AGENT_WEB_PORT: String(config.port),
    BUZZARD_AGENT_WEB_CONFIG: config.configPath,
    BUZZARD_AGENT_WEB_DATA_DIR: config.dataDir,
    BUZZARD_AGENT_WEB_AGENT_COMMAND: config.agentCommand,
    BUZZARD_AGENT_WEB_LOCAL_ONLY: config.localOnly ? "1" : "0",
    BUZZARD_AGENT_WEB_OFFLINE: config.offline ? "1" : "0",
    ...(config.origin === null ? {} : { BUZZARD_AGENT_WEB_ORIGIN: config.origin }),
    ...(config.identityFile === null ? {} : { BUZZARD_AGENT_WEB_IDENTITY_FILE: config.identityFile }),
  };
  const environmentText = Object.entries(environment).map(([key, value]) => `${key}=${environmentValue(value)}`).join("\n") + "\n";
  const environmentTemp = `${environmentPath}.${String(process.pid)}`;
  const stateTemp = `${statePath}.${String(process.pid)}`;
  await writeFile(environmentTemp, environmentText, { encoding: "utf8", mode: 0o600 });
  await writeFile(stateTemp, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(environmentTemp, environmentPath);
  await rename(stateTemp, statePath);
}

async function runSystemctl(args, allowFailure = false) {
  try {
    const { stdout } = await execFile(systemctl, ["--user", ...args], { encoding: "utf8" });
    return { ok: true, stdout: stdout.trim() };
  } catch (error) {
    if (!allowFailure) throw new Error(String(error.stderr || error.message).trim());
    return { ok: false, stdout: String(error.stdout || "").trim() };
  }
}

async function unitActive(unit) {
  const result = await runSystemctl(["is-active", unit], true);
  return result.ok && result.stdout === "active";
}

async function unitEnabled(unit) {
  const result = await runSystemctl(["is-enabled", unit], true);
  return result.ok && result.stdout === "enabled";
}

async function serviceStatus(config) {
  const [webActive, sessiondActive, webEnabled, sessiondEnabled] = await Promise.all([
    unitActive(webUnit),
    unitActive(sessiondUnit),
    unitEnabled(webUnit),
    unitEnabled(sessiondUnit),
  ]);
  const url = serviceUrl(config);
  let ready = false;
  if (webActive && sessiondActive) {
    try {
      const response = await fetch(`${url}/api/machines/local/health`, { signal: AbortSignal.timeout(1500) });
      ready = response.ok;
    } catch {}
  }
  return {
    schema: 1,
    service: "buzzard-agent-web",
    enabled: webEnabled && sessiondEnabled,
    running: webActive && sessiondActive,
    ready,
    url,
    host: config.host,
    port: config.port,
    healthUrl: `${url}/api/machines/local/health`,
    configPath: config.configPath,
    dataDir: config.dataDir,
    agentDir: config.agentDir,
    agentCommand: config.agentCommand,
    identityFile: config.identityFile,
    offline: config.offline,
    services: {
      web: { unit: webUnit, active: webActive },
      sessiond: { unit: sessiondUnit, active: sessiondActive },
    },
  };
}

async function waitUntilReady(config) {
  const deadline = Date.now() + 15_000;
  let status;
  do {
    status = await serviceStatus(config);
    if (status.ready) return status;
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  return status;
}

function outputStatus(status, json) {
  if (json) {
    console.log(JSON.stringify(status));
    return;
  }
  console.log(`Buzzard Agent Web: ${status.ready ? "ready" : status.running ? "starting" : "stopped"}`);
  console.log(`URL: ${status.url}`);
  console.log(`Web service: ${status.services.web.active ? "active" : "inactive"}`);
  console.log(`Session daemon: ${status.services.sessiond.active ? "active" : "inactive"}`);
}

async function serviceCommand(command, args) {
  const options = parseOptions(args);
  const config = configuration(await readState(), options);
  if (["start", "restart", "enable"].includes(command)) await persistConfiguration(config);
  if (command === "start") {
    await runSystemctl(["daemon-reload"]);
    await runSystemctl(["start", ...serviceUnits]);
  } else if (command === "restart") {
    await runSystemctl(["daemon-reload"]);
    await runSystemctl(["restart", ...serviceUnits]);
  } else if (command === "stop") {
    await runSystemctl(["stop", webUnit, sessiondUnit]);
  } else if (command === "enable") {
    await runSystemctl(["daemon-reload"]);
    await runSystemctl(["enable", "--now", ...serviceUnits]);
  } else if (command === "disable") {
    await runSystemctl(["disable", "--now", webUnit, sessiondUnit]);
  }
  const status = ["start", "restart", "enable"].includes(command) ? await waitUntilReady(config) : await serviceStatus(config);
  outputStatus(status, options.json);
  if (["start", "restart", "enable"].includes(command) && !status.ready) process.exitCode = 1;
}

async function pluginCommand(args) {
  const restart = args.includes("--restart");
  const forwarded = args.filter(argument => argument !== "--restart");
  const { stdout, stderr } = await execFile(process.execPath, [upstreamCli, "plugins", ...forwarded], { encoding: "utf8" });
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  if (restart) await runSystemctl(["restart", ...serviceUnits]);
}

const command = process.argv[2];
const args = process.argv.slice(3);
try {
  if (command === "endpoint") {
    const options = parseOptions(args);
    const config = configuration(await readState(), options);
    const url = serviceUrl(config);
    console.log(options.json ? JSON.stringify({ schema: 1, url, host: config.host, port: config.port, healthUrl: `${url}/api/machines/local/health` }) : url);
  } else if (["start", "stop", "restart", "status", "enable", "disable"].includes(command)) {
    await serviceCommand(command, args);
  } else if (command === "plugins") {
    await pluginCommand(args);
  } else {
    throw new Error(`Unknown control command: ${String(command)}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
