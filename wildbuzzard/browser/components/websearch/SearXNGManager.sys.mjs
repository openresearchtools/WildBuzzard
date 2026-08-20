/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { Subprocess } from "resource://gre/modules/Subprocess.sys.mjs";
import { requestSearXNGUDS } from "resource:///modules/SearXNGUDSTransport.sys.mjs";
import { synchronizeManagedSearXNGEngine } from "resource:///modules/ManagedSearXNGEngine.sys.mjs";

const LocalFile = Components.Constructor(
  "@mozilla.org/file/local;1",
  "nsIFile",
  "initWithPath"
);
const CryptoHash = Components.Constructor(
  "@mozilla.org/security/hash;1",
  "nsICryptoHash",
  "initWithString"
);

const RUNTIME_VERSION = "2026.8.6+b023a28ba";
const UPSTREAM_COMMIT = "b023a28bab8839dba9eac96e9a51cc91bbd0a267";
const DEFAULT_COMMAND = "/usr/bin/buzzard-search";
const CATALOG_SHA256 =
  "7d054c87f25e2925f71c1a12fdff6973ffc735e2cfff71df744d2d3b14d786f1";
const MAX_LIFECYCLE_OUTPUT = 32 * 1024;
const MAX_RECORD_BYTES = 32 * 1024;
const MAX_QUERY_BYTES = 2048;
const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;
const SEARCH_CONCURRENCY = 4;
const TOTAL_ENTRIES = 343;
const ELIGIBLE_ENTRIES = 332;
const TOTAL_MODULES = 222;
const ELIGIBLE_MODULES = 211;
const PROFILE_DOMAIN = "wildbuzzard-searxng-executable-profile-v1\0";
const ALLOWED_DOCUMENT_PATH =
  /^\/(?:|search|preferences|manifest\.json|favicon\.ico|rss\.xsl|logo\/[A-Za-z0-9._-]+|info\/[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+|static\/[A-Za-z0-9_./-]+|client[A-Za-z0-9_-]+\.css)$/;
const RECORD_FIELDS = new Set([
  "catalogSha256",
  "createdAt",
  "executablePath",
  "installedRoot",
  "instanceToken",
  "pid",
  "processStartTime",
  "runtimeVersion",
  "schema",
  "settingsPath",
  "socketPath",
  "upstreamCommit",
]);

function digestBytes(bytes) {
  const hash = new CryptoHash("sha256");
  hash.update(bytes, bytes.length);
  return Array.from(hash.finish(false), character =>
    character.charCodeAt(0).toString(16).padStart(2, "0")
  ).join("");
}

function canonicalDirectory(path) {
  const directory = new LocalFile(path);
  directory.normalize();
  if (!directory.isDirectory() || directory.isSymlink()) {
    throw new Error("The Firefox profile directory is unavailable");
  }
  return directory.path;
}

export function searXNGProfileKey(profilePath) {
  return digestBytes(
    new TextEncoder().encode(PROFILE_DOMAIN + canonicalDirectory(profilePath))
  ).slice(0, 24);
}

export function searXNGManagerPaths({
  profilePath,
  dataHome,
  cacheHome,
  runtimeHome,
}) {
  const profileKey = searXNGProfileKey(profilePath);
  const rootDirectory = PathUtils.join(dataHome, "buzzard", "search");
  const cacheDirectory = PathUtils.join(cacheHome, "buzzard", "search");
  const stateDirectory = PathUtils.join(
    runtimeHome || "/tmp",
    "buzzard",
    "search"
  );
  const socketPath = PathUtils.join(stateDirectory, "s");
  if (new TextEncoder().encode(socketPath).length > 107) {
    throw new Error("The private SearXNG socket path exceeds the Linux limit");
  }
  return {
    artifactInstallDirectory: PathUtils.join(
      rootDirectory,
      "runtime",
      RUNTIME_VERSION
    ),
    cacheDirectory,
    connectionPath: PathUtils.join(stateDirectory, "connection.json"),
    profileKey,
    rootDirectory,
    socketPath,
    stateDirectory,
  };
}

function exactFields(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const fields = Object.keys(value);
  return (
    fields.length === expected.size &&
    fields.every(field => expected.has(field))
  );
}

function isDigest(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

async function readBoundedText(path, maximum) {
  if (path.startsWith("/proc/")) {
    const bytes = await IOUtils.read(path, { maxBytes: maximum + 1 });
    if (bytes.length < 1 || bytes.length > maximum) {
      throw new Error("SearXNG identity file exceeds its limit");
    }
    return new TextDecoder().decode(bytes);
  }
  const info = await IOUtils.stat(path);
  if (info.size < 1 || info.size > maximum) {
    throw new Error("SearXNG identity file exceeds its limit");
  }
  return IOUtils.readUTF8(path);
}

async function readPrivateRecord(path) {
  const file = new LocalFile(path);
  if (
    !file.isFile() ||
    file.isSymlink() ||
    (file.permissions & 0o777) !== 0o600
  ) {
    throw new Error("Unsafe SearXNG connection record");
  }
  const source = await readBoundedText(path, MAX_RECORD_BYTES);
  let record;
  try {
    record = JSON.parse(source);
  } catch (error) {
    throw new Error("Invalid SearXNG connection record", { cause: error });
  }
  if (!exactFields(record, RECORD_FIELDS)) {
    throw new Error("Invalid SearXNG connection record fields");
  }
  const canonical = Object.fromEntries(
    Object.keys(record)
      .sort()
      .map(field => [field, record[field]])
  );
  if (source !== `${JSON.stringify(canonical)}\n`) {
    throw new Error("Non-canonical SearXNG connection record");
  }
  return record;
}

async function processIdentity(pid) {
  const [stat, status, ownStatus] = await Promise.all([
    readBoundedText(`/proc/${pid}/stat`, 16 * 1024),
    readBoundedText(`/proc/${pid}/status`, 64 * 1024),
    readBoundedText("/proc/self/status", 64 * 1024),
  ]);
  const closingParenthesis = stat.lastIndexOf(")");
  const fields = stat
    .slice(closingParenthesis + 2)
    .trim()
    .split(/\s+/);
  const uid = /^Uid:\s+(\d+)/m.exec(status)?.[1];
  const ownUid = /^Uid:\s+(\d+)/m.exec(ownStatus)?.[1];
  if (
    closingParenthesis < 0 ||
    fields.length < 20 ||
    !/^\d+$/.test(fields[19]) ||
    !uid ||
    uid !== ownUid
  ) {
    throw new Error("Invalid SearXNG process identity");
  }
  const executable = new LocalFile(`/proc/${pid}/exe`).target;
  return { executable, processStartTime: fields[19] };
}

function validatePrivateFile(path, expectedPath, kind, permissions) {
  if (path !== expectedPath) {
    throw new Error(`Invalid SearXNG ${kind} path`);
  }
  const file = new LocalFile(path);
  if (
    !file.exists() ||
    file.isSymlink() ||
    (kind === "socket" ? !file.isSpecial() : !file.isFile()) ||
    (file.permissions & 0o777) !== permissions
  ) {
    throw new Error(`Invalid private SearXNG ${kind}`);
  }
  return file;
}

export async function validateSearXNGConnectionRecord(record, paths) {
  const expectedExecutable = PathUtils.join(
    paths.artifactInstallDirectory,
    "python",
    "bin",
    "python3"
  );
  if (
    !exactFields(record, RECORD_FIELDS) ||
    record.schema !== 1 ||
    record.runtimeVersion !== RUNTIME_VERSION ||
    record.upstreamCommit !== UPSTREAM_COMMIT ||
    record.installedRoot !== paths.artifactInstallDirectory ||
    record.executablePath !== expectedExecutable ||
    !Number.isSafeInteger(record.pid) ||
    record.pid < 1 ||
    typeof record.processStartTime !== "string" ||
    !/^\d+$/.test(record.processStartTime) ||
    !Number.isSafeInteger(record.createdAt) ||
    record.createdAt < 1 ||
    record.createdAt > Date.now() + 5 * 60 * 1000 ||
    !isDigest(record.catalogSha256) ||
    record.catalogSha256 !== CATALOG_SHA256 ||
    typeof record.instanceToken !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.instanceToken)
  ) {
    throw new Error("SearXNG connection identity mismatch");
  }
  const stateDirectory = new LocalFile(paths.stateDirectory);
  if (
    !stateDirectory.isDirectory() ||
    stateDirectory.isSymlink() ||
    (stateDirectory.permissions & 0o777) !== 0o700
  ) {
    throw new Error("Invalid private SearXNG state directory");
  }
  validatePrivateFile(record.socketPath, paths.socketPath, "socket", 0o600);
  validatePrivateFile(
    record.settingsPath,
    PathUtils.join(paths.stateDirectory, "settings.yml"),
    "settings",
    0o600
  );
  const executable = new LocalFile(expectedExecutable);
  executable.normalize();
  if (
    !executable.isFile() ||
    executable.isSymlink() ||
    executable.path !== expectedExecutable
  ) {
    throw new Error("Invalid installed SearXNG executable");
  }
  const identity = await processIdentity(record.pid);
  if (
    identity.executable !== record.executablePath ||
    identity.processStartTime !== record.processStartTime
  ) {
    throw new Error("SearXNG process identity mismatch");
  }
  return record;
}

function recordsEqual(left, right) {
  return [...RECORD_FIELDS].every(field => left[field] === right[field]);
}

async function readPipe(pipe) {
  let output = "";
  for (let chunk; (chunk = await pipe.readString()); ) {
    output += chunk;
    if (output.length > MAX_LIFECYCLE_OUTPUT) {
      throw new Error("SearXNG lifecycle output exceeded its limit");
    }
  }
  return output;
}

function validateString(value, maximum) {
  return (
    typeof value === "string" &&
    Boolean(value.length) &&
    value.length <= maximum
  );
}

export function validateNativeSearchRequest(value) {
  const fields = new Set([
    "engines",
    "language",
    "maxResults",
    "page",
    "query",
    "safeSearch",
    "sortOrder",
    "timeRange",
  ]);
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some(field => !fields.has(field)) ||
    !validateString(value.query, 512) ||
    new TextEncoder().encode(value.query).length > MAX_QUERY_BYTES
  ) {
    throw new TypeError("native_search: invalid query");
  }
  if (value.engines !== undefined) {
    if (
      !Array.isArray(value.engines) ||
      value.engines.length > ELIGIBLE_ENTRIES ||
      value.engines.some(engine => !validateString(engine, 128)) ||
      new Set(value.engines).size !== value.engines.length
    ) {
      throw new TypeError("native_search: invalid engines");
    }
  }
  if (
    (value.language !== undefined &&
      (typeof value.language !== "string" ||
        !/^[A-Za-z0-9-]{1,35}$/.test(value.language))) ||
    (value.page !== undefined &&
      (!Number.isInteger(value.page) || value.page < 1 || value.page > 10)) ||
    (value.timeRange !== undefined &&
      !["day", "week", "month", "year"].includes(value.timeRange)) ||
    (value.safeSearch !== undefined && value.safeSearch !== 1) ||
    (value.sortOrder !== undefined &&
      !["relevance", "newest", "oldest"].includes(value.sortOrder)) ||
    (value.maxResults !== undefined &&
      (!Number.isInteger(value.maxResults) ||
        value.maxResults < 1 ||
        value.maxResults > 100))
  ) {
    throw new TypeError("native_search: invalid arguments");
  }
  return value;
}

function boundedString(value, maximum) {
  return typeof value === "string" && value.length <= maximum
    ? value
    : undefined;
}

function normalizedResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const url = boundedString(value.url, 4096);
  if (!url) {
    return null;
  }
  const engines = Array.isArray(value.engines)
    ? [
        ...new Set(
          value.engines
            .filter(engine => validateString(engine, 128))
            .slice(0, 16)
        ),
      ]
    : [];
  return {
    url,
    ...(boundedString(value.title, 500) !== undefined
      ? { title: value.title }
      : {}),
    ...(boundedString(value.content, 4000) !== undefined
      ? { content: value.content }
      : {}),
    ...(engines.length ? { engines } : {}),
    ...(value.score === null ||
    (typeof value.score === "number" && Number.isFinite(value.score))
      ? { score: value.score }
      : {}),
    ...(boundedString(value.publishedDate, 128) !== undefined
      ? { publishedDate: value.publishedDate }
      : {}),
  };
}

function structuredItems(value, maximum) {
  return Array.isArray(value) ? value.slice(0, maximum) : [];
}

export function normalizeNativeSearchResponse(
  raw,
  request,
  { catalogSha256, attemptedEngines }
) {
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    raw.query !== request.query ||
    !Array.isArray(raw.results)
  ) {
    throw new Error("SearXNG returned an invalid search response");
  }
  const unresponsiveEngines = structuredItems(
    raw.unresponsive_engines,
    ELIGIBLE_ENTRIES
  );
  const failed = new Set(
    unresponsiveEngines
      .map(value => (Array.isArray(value) ? value[0] : undefined))
      .filter(value => typeof value === "string")
  );
  let results = raw.results.map(normalizedResult).filter(Boolean);
  const sortOrder = request.sortOrder ?? "relevance";
  if (sortOrder !== "relevance") {
    results = results
      .map((result, index) => ({
        index,
        result,
        timestamp:
          typeof result.publishedDate === "string"
            ? Date.parse(result.publishedDate)
            : NaN,
      }))
      .sort((left, right) => {
        const leftMissing = !Number.isFinite(left.timestamp);
        const rightMissing = !Number.isFinite(right.timestamp);
        if (leftMissing !== rightMissing) {
          return leftMissing ? 1 : -1;
        }
        if (!leftMissing && left.timestamp !== right.timestamp) {
          return sortOrder === "newest"
            ? right.timestamp - left.timestamp
            : left.timestamp - right.timestamp;
        }
        return left.index - right.index;
      })
      .map(entry => entry.result);
  }
  return {
    schema: 1,
    implementation: "buzzard-search",
    query: request.query,
    results: results.slice(0, request.maxResults ?? 20),
    answers: structuredItems(raw.answers, 50),
    corrections: structuredItems(raw.corrections, 50),
    suggestions: structuredItems(raw.suggestions, 50),
    infoboxes: structuredItems(raw.infoboxes, 50),
    unresponsiveEngines,
    diagnostics: {
      catalogSha256,
      totalEntries: TOTAL_ENTRIES,
      eligibleEntries: ELIGIBLE_ENTRIES,
      totalModules: TOTAL_MODULES,
      eligibleModules: ELIGIBLE_MODULES,
      attemptedEngines,
      completedEngines: attemptedEngines.filter(engine => !failed.has(engine)),
    },
  };
}

/** Bounds concurrent native search requests. */
class SearchPermitPool {
  active = 0;
  pending = [];

  acquire(signal) {
    if (signal?.aborted) {
      return Promise.reject(
        Components.Exception("Search was cancelled", Cr.NS_ERROR_ABORT)
      );
    }
    if (this.active < SEARCH_CONCURRENCY) {
      this.active++;
      return Promise.resolve(() => this.release());
    }
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, signal };
      entry.abort = () => {
        const index = this.pending.indexOf(entry);
        if (index >= 0) {
          this.pending.splice(index, 1);
        }
        reject(Components.Exception("Search was cancelled", Cr.NS_ERROR_ABORT));
      };
      signal?.addEventListener("abort", entry.abort, { once: true });
      this.pending.push(entry);
    });
  }

  release() {
    const next = this.pending.shift();
    if (!next) {
      this.active--;
      return;
    }
    next.signal?.removeEventListener("abort", next.abort);
    next.resolve(() => this.release());
  }
}

/** Connects the browser to the independently installed Buzzard Search package. */
export class SearXNGManagerImpl {
  constructor({
    profilePath,
    dataHome,
    cacheHome,
    runtimeHome,
    commandPath,
    request = requestSearXNGUDS,
    synchronizeEngine = synchronizeManagedSearXNGEngine,
  } = {}) {
    const home = Services.dirsvc.get("Home", Ci.nsIFile).path;
    profilePath ??= Services.dirsvc.get("ProfD", Ci.nsIFile).path;
    dataHome ??=
      Services.env.get("XDG_DATA_HOME") ||
      PathUtils.join(home, ".local", "share");
    cacheHome ??=
      Services.env.get("XDG_CACHE_HOME") || PathUtils.join(home, ".cache");
    runtimeHome ??= Services.env.get("XDG_RUNTIME_DIR") || null;
    this.paths = searXNGManagerPaths({
      cacheHome,
      dataHome,
      profilePath,
      runtimeHome,
    });
    this.configuredCommandPath = commandPath;
    this.request = request;
    this.synchronizeEngine = synchronizeEngine;
    this.initializationTask = null;
    this.connection = null;
    this.readyState = null;
    this.loadedEngines = new Set();
    this.defaultEngines = [];
    this.permits = new SearchPermitPool();
  }

  commandPath() {
    return (
      this.configuredCommandPath ||
      Services.prefs.getStringPref(
        "wildbuzzard.search.command",
        ""
      ) ||
      Services.env.get("BUZZARD_SEARCH_COMMAND") ||
      DEFAULT_COMMAND
    );
  }

  isAvailable() {
    if (AppConstants.platform !== "linux") {
      return false;
    }
    try {
      const command = new LocalFile(this.commandPath());
      return command.isFile() && !command.isSymlink() && command.isExecutable();
    } catch {
      return false;
    }
  }

  validateCommand() {
    const path = this.commandPath();
    const command = new LocalFile(path);
    if (!command.isFile() || command.isSymlink() || !command.isExecutable()) {
      throw new Error("The buzzard-search package is not installed");
    }
    return path;
  }

  async prepareDirectories() {
    return undefined;
  }

  lifecycleArguments(action) {
    return [action];
  }

  async runLifecycle(action) {
    const command = this.validateCommand();
    const process = await Subprocess.call({
      command,
      arguments: this.lifecycleArguments(action),
      environmentAppend: true,
      environment: {
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        TZ: "UTC",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const settled = await Promise.allSettled([
      readPipe(process.stdout),
      readPipe(process.stderr),
      process.wait(),
    ]);
    const failure = settled.find(entry => entry.status === "rejected");
    if (failure) {
      throw failure.reason;
    }
    const [stdout, stderr, result] = settled.map(entry => entry.value);
    return { exitCode: result.exitCode, stderr, stdout };
  }

  async initialize() {
    if (this.connection && this.readyState) {
      try {
        await validateSearXNGConnectionRecord(this.connection, this.paths);
        await this.verifyHealth(this.connection);
        return this.readyState;
      } catch {
        this.connection = null;
        this.readyState = null;
        this.loadedEngines.clear();
        this.defaultEngines = [];
      }
    }
    if (this.initializationTask) {
      return this.initializationTask;
    }
    const task = this.ensure();
    this.initializationTask = task;
    try {
      return await task;
    } finally {
      if (this.initializationTask === task) {
        this.initializationTask = null;
      }
    }
  }

  async ensure() {
    if (AppConstants.platform !== "linux") {
      throw new Error(
        "The Buzzard Search package currently supports Linux"
      );
    }
    await this.prepareDirectories();
    let started = false;
    try {
      const result = await this.runLifecycle("start");
      if (result.exitCode !== 0 || result.stderr.trim()) {
        throw new Error(result.stderr.trim() || "SearXNG start failed");
      }
      started = true;
      let published;
      try {
        published = JSON.parse(result.stdout);
      } catch (error) {
        throw new Error("SearXNG start returned invalid JSON", {
          cause: error,
        });
      }
      const record = await readPrivateRecord(this.paths.connectionPath);
      if (!recordsEqual(published, record)) {
        throw new Error("SearXNG lifecycle and connection records differ");
      }
      await validateSearXNGConnectionRecord(record, this.paths);
      await this.verifyHealth(record);
      const config = await this.requestJSON(record, "/config", 1024 * 1024);
      this.updateEngineConfiguration(config);
      this.connection = record;
      await this.synchronizeEngine();
      this.readyState = {
        catalogSha256: record.catalogSha256,
        connectionPath: this.paths.connectionPath,
        pid: record.pid,
        ready: true,
        runtimeVersion: record.runtimeVersion,
        socket: "private",
      };
      return this.readyState;
    } catch (error) {
      if (started) {
        await this.runLifecycle("stop").catch(() => {});
      }
      throw error;
    }
  }

  async verifyHealth(record) {
    const health = await this.request(new LocalFile(record.socketPath), {
      method: "GET",
      target: "/healthz",
      accept: "text/plain",
      maximum: 16,
      timeout: 3000,
    });
    if (
      health.status !== 200 ||
      new TextDecoder("utf-8", { fatal: true }).decode(health.body) !== "OK"
    ) {
      throw new Error("SearXNG health verification failed");
    }
  }

  updateEngineConfiguration(config) {
    if (
      !config ||
      typeof config !== "object" ||
      !Array.isArray(config.engines)
    ) {
      throw new Error("SearXNG returned invalid configuration");
    }
    const loaded = new Set();
    const defaults = [];
    for (const engine of config.engines) {
      if (
        !engine ||
        typeof engine !== "object" ||
        !validateString(engine.name, 128) ||
        typeof engine.enabled !== "boolean" ||
        loaded.has(engine.name)
      ) {
        throw new Error("SearXNG returned invalid engine configuration");
      }
      loaded.add(engine.name);
      if (engine.enabled) {
        defaults.push(engine.name);
      }
    }
    if (
      loaded.size < 1 ||
      loaded.size > ELIGIBLE_ENTRIES ||
      defaults.length < 1
    ) {
      throw new Error("SearXNG engine configuration is empty or oversized");
    }
    this.loadedEngines = loaded;
    this.defaultEngines = defaults;
  }

  async requestJSON(record, target, maximum, options = {}) {
    const response = await this.request(new LocalFile(record.socketPath), {
      method: "GET",
      target,
      accept: "application/json",
      maximum,
      ...options,
    });
    if (
      response.status !== 200 ||
      !/^application\/json(?:\s*;|$)/i.test(
        response.headers.get("content-type") ?? ""
      )
    ) {
      throw new Error(`SearXNG request failed with status ${response.status}`);
    }
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(response.body)
      );
    } catch (error) {
      throw new Error("SearXNG returned invalid JSON", { cause: error });
    }
  }

  async search(value, signal) {
    const request = validateNativeSearchRequest(value);
    const release = await this.permits.acquire(signal);
    try {
      await this.initialize();
      const attemptedEngines = request.engines ?? this.defaultEngines;
      const unavailable = attemptedEngines.filter(
        engine => !this.loadedEngines.has(engine)
      );
      if (unavailable.length) {
        throw new Error("native_search: requested engine is unavailable");
      }
      const form = new URLSearchParams({
        q: request.query,
        format: "json",
        safesearch: "1",
        ...(request.engines ? { engines: request.engines.join(",") } : {}),
        ...(request.language ? { language: request.language } : {}),
        ...(request.page ? { pageno: String(request.page) } : {}),
        ...(request.timeRange ? { time_range: request.timeRange } : {}),
      }).toString();
      const response = await this.request(
        new LocalFile(this.connection.socketPath),
        {
          method: "POST",
          target: "/search",
          body: new TextEncoder().encode(form),
          accept: "application/json",
          contentType: "application/x-www-form-urlencoded",
          maximum: 4 * 1024 * 1024,
          signal,
        }
      );
      if (
        response.status !== 200 ||
        !/^application\/json(?:\s*;|$)/i.test(
          response.headers.get("content-type") ?? ""
        )
      ) {
        throw new Error(`SearXNG search failed with status ${response.status}`);
      }
      let raw;
      try {
        raw = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(response.body)
        );
      } catch (error) {
        throw new Error("SearXNG search returned invalid JSON", {
          cause: error,
        });
      }
      return normalizeNativeSearchResponse(raw, request, {
        attemptedEngines,
        catalogSha256: this.connection.catalogSha256,
      });
    } finally {
      release();
    }
  }

  async requestDocument(target, signal) {
    const separator = target.indexOf("?");
    const path = separator < 0 ? target : target.slice(0, separator);
    if (
      typeof target !== "string" ||
      target.length > 65536 ||
      !ALLOWED_DOCUMENT_PATH.test(path) ||
      target.includes("..")
    ) {
      throw new Error("Invalid internal SearXNG document path");
    }
    await this.initialize();
    return this.request(new LocalFile(this.connection.socketPath), {
      method: "GET",
      target,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      maximum: MAX_DOCUMENT_BYTES,
      signal,
    });
  }

  async status() {
    const result = await this.runLifecycle("status");
    if (result.exitCode !== 0 || result.stderr.trim()) {
      throw new Error(result.stderr.trim() || "SearXNG status failed");
    }
    return JSON.parse(result.stdout);
  }

  async stop() {
    const result = await this.runLifecycle("stop");
    if (result.exitCode !== 0 || result.stderr.trim()) {
      throw new Error(result.stderr.trim() || "SearXNG stop failed");
    }
    this.connection = null;
    this.readyState = null;
    this.loadedEngines.clear();
    this.defaultEngines = [];
    return { running: false };
  }
}

let defaultManager;

function manager() {
  defaultManager ??= new SearXNGManagerImpl();
  return defaultManager;
}

export const SearXNGManager = {
  initialize() {
    return manager().initialize();
  },

  isAvailable() {
    return manager().isAvailable();
  },

  requestDocument(target, signal) {
    return manager().requestDocument(target, signal);
  },

  search(request, signal) {
    return manager().search(request, signal);
  },

  status() {
    return manager().status();
  },

  stop() {
    return manager().stop();
  },
};

export const SearXNGManagerTestUtils = {
  DEFAULT_COMMAND,
  RECORD_FIELDS,
  RUNTIME_VERSION,
  UPSTREAM_COMMIT,
};
