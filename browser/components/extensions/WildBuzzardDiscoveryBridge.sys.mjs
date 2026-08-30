/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { AddonManager as AddonManagerModule } from "resource://gre/modules/AddonManager.sys.mjs";
import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { ExtensionUtils } from "resource://gre/modules/ExtensionUtils.sys.mjs";
import { PrivateBrowsingUtils } from "resource://gre/modules/PrivateBrowsingUtils.sys.mjs";
import { Subprocess } from "resource://gre/modules/Subprocess.sys.mjs";
import { isValidBTIHMagnet } from "resource:///modules/TorrentSecurityPolicy.sys.mjs";
import { clearTimeout, setTimeout } from "resource://gre/modules/Timer.sys.mjs";

const LocalFile = Components.Constructor(
  "@mozilla.org/file/local;1",
  "nsIFile",
  "initWithPath"
);
const { ExtensionError } = ExtensionUtils;

const SEARCH_COMMAND = "/usr/bin/buzzard-search";
const TORRENT_COMMAND = "/usr/bin/buzzard-minijtt";
const SEARCH_OWNER = "web-search@extensions.wildbuzzard";
const TORRENT_OWNER = "torrent-search@extensions.wildbuzzard";
const WEB_PROTOCOL = "web";
const TORRENT_PROTOCOL = "torrent";
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_TORRENT_RESOLVE_JSON_BYTES = 17 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
const MAX_TORRENT_BYTES = 12 * 1024 * 1024;
const MAX_ACTIVE_PROCESSES = 6;
const MAX_ACTIVE_PER_OWNER = 2;
const TOKEN_LIFETIME_MS = 5 * 60 * 1000;
const TOKEN_HISTORY_MS = 5 * 60 * 1000;
const MAX_RESULT_TOKENS = 512;
const MAX_CONFIRMATION_TOKENS = 64;
const MAX_RETAINED_PAYLOAD_BYTES = 24 * 1024 * 1024;
const MAX_TOKEN_HISTORY = 1024;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const BACKEND_RESULT_ID = /^[A-Za-z0-9_-]{32}$/;
const TOKEN_ID = /^v1_[A-Za-z0-9_-]{43}$/;
const ACTIVE_PROCESSES = new Set();
const ACTIVE_OPERATIONS = new Map();
const ACTIVE_BY_OWNER = new Map();
const RESULT_TOKENS = new Map();
const CONFIRMATION_TOKENS = new Map();
const TOKEN_HISTORY = new Map();
const TEXT_ENCODER = new TextEncoder();
const TORRENT_L10N = new Localization(
  ["browser/wildbuzzard/discovery.ftl"],
  true
);

function webError(code) {
  const error = new ExtensionError(`[buzzard-search/${code}]`);
  error.wildBuzzardBridge = WEB_PROTOCOL;
  return error;
}

function torrentError(code) {
  const error = new ExtensionError(`torrentSearch.${code}`);
  error.wildBuzzardBridge = TORRENT_PROTOCOL;
  return error;
}

function protocolError(protocol, webCode, torrentCode) {
  return protocol === WEB_PROTOCOL
    ? webError(webCode)
    : torrentError(torrentCode);
}

function normalizeError(protocol, error, webCode, torrentCode) {
  if (error?.wildBuzzardBridge === protocol) {
    return error;
  }
  return protocolError(protocol, webCode, torrentCode);
}

export function isAuthorizedDiscoveryContext(protocol, owner, incognito) {
  let expected;
  if (protocol === WEB_PROTOCOL) {
    expected = SEARCH_OWNER;
  } else if (protocol === TORRENT_PROTOCOL) {
    expected = TORRENT_OWNER;
  }
  return expected !== undefined && incognito !== true && owner === expected;
}

export function isAuthorizedDiscoveryExtension(protocol, extension, incognito) {
  const isTrustedInstall =
    extension?.addonData?.builtIn === true ||
    extension?.addonData?.signedState >= AddonManagerModule.SIGNEDSTATE_SIGNED;
  return (
    isAuthorizedDiscoveryContext(protocol, extension?.id, incognito) &&
    extension.manifest?.incognito === "not_allowed" &&
    extension.temporarilyInstalled !== true &&
    isTrustedInstall
  );
}

function assertAuthorized(protocol, owner) {
  if (!isAuthorizedDiscoveryContext(protocol, owner, false)) {
    throw protocolError(protocol, "bridge_unavailable", "NOT_AUTHORIZED");
  }
}

function executableReady(command) {
  if (AppConstants.platform !== "linux") {
    return false;
  }
  try {
    const file = new LocalFile(command);
    const parent = file.parent;
    return (
      file.path === command &&
      parent?.path === "/usr/bin" &&
      parent.isDirectory() &&
      !parent.isSymlink() &&
      (parent.permissions & 0o022) === 0 &&
      file.isFile() &&
      !file.isSymlink() &&
      file.isExecutable() &&
      (file.permissions & 0o022) === 0
    );
  } catch {
    return false;
  }
}

function safeAbsoluteEnvironmentValue(name) {
  const value = Services.env.get(name);
  if (!value?.startsWith("/") || value.length > 4096 || /\p{Cc}/u.test(value)) {
    return undefined;
  }
  return value;
}

function environment(command) {
  const result = {
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PATH: "/usr/bin:/bin",
    TZ: "UTC",
  };
  if (command !== TORRENT_COMMAND) {
    return result;
  }
  for (const name of [
    "HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_RUNTIME_DIR",
    "XDG_STATE_HOME",
  ]) {
    const value = safeAbsoluteEnvironmentValue(name);
    if (value !== undefined) {
      result[name] = value;
    }
  }
  return result;
}

function operationKey(owner, operationId, protocol) {
  if (!UUID_V4.test(operationId || "")) {
    throw protocolError(protocol, "invalid_request", "INVALID_REQUEST");
  }
  return `${owner}:${operationId.toLowerCase()}`;
}

function reserveProcess(state) {
  if (ACTIVE_PROCESSES.size >= MAX_ACTIVE_PROCESSES) {
    throw protocolError(state.protocol, "busy", "BUSY");
  }
  if (state.owner) {
    const count = ACTIVE_BY_OWNER.get(state.owner) || 0;
    if (count >= MAX_ACTIVE_PER_OWNER) {
      throw protocolError(state.protocol, "busy", "BUSY");
    }
    ACTIVE_BY_OWNER.set(state.owner, count + 1);
  }
  if (state.operationKey) {
    if (ACTIVE_OPERATIONS.has(state.operationKey)) {
      if (state.owner) {
        ACTIVE_BY_OWNER.set(state.owner, ACTIVE_BY_OWNER.get(state.owner) - 1);
      }
      throw protocolError(state.protocol, "busy", "BUSY");
    }
    ACTIVE_OPERATIONS.set(state.operationKey, state);
  }
  ACTIVE_PROCESSES.add(state);
}

function releaseProcess(state) {
  ACTIVE_PROCESSES.delete(state);
  if (state.operationKey) {
    ACTIVE_OPERATIONS.delete(state.operationKey);
  }
  if (state.owner) {
    const count = (ACTIVE_BY_OWNER.get(state.owner) || 1) - 1;
    if (count > 0) {
      ACTIVE_BY_OWNER.set(state.owner, count);
    } else {
      ACTIVE_BY_OWNER.delete(state.owner);
    }
  }
}

async function readPipe(pipe, maximum, state) {
  const chunks = [];
  let bytes = 0;
  for (let chunk; (chunk = await pipe.readString()); ) {
    bytes += TEXT_ENCODER.encode(chunk).length;
    if (bytes > maximum) {
      state.outputTooLarge = true;
      state.process?.kill();
      throw new Error("output limit");
    }
    chunks.push(chunk);
  }
  return chunks.join("");
}

async function writeInput(pipe, input) {
  try {
    if (input !== undefined) {
      await pipe.write(`${JSON.stringify(input)}\n`);
    }
  } finally {
    await pipe.close();
  }
}

async function runJson(
  command,
  args,
  {
    protocol,
    owner,
    operationId,
    input,
    maximumOutputBytes = MAX_JSON_BYTES,
    timeoutMs = 35000,
  }
) {
  if (!executableReady(command)) {
    throw protocolError(protocol, "cli_missing", "CLI_NOT_INSTALLED");
  }
  const state = {
    protocol,
    owner,
    operationKey:
      operationId === undefined
        ? undefined
        : operationKey(owner, operationId, protocol),
    process: null,
    cancelled: false,
    timedOut: false,
    outputTooLarge: false,
  };
  reserveProcess(state);
  let timer;
  try {
    try {
      state.process = await Subprocess.call({
        command,
        arguments: args,
        environmentAppend: false,
        environment: environment(command),
        workdir: "/",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (error) {
      throw normalizeError(protocol, error, "cli_missing", "CLI_NOT_INSTALLED");
    }
    if (state.cancelled) {
      state.process.kill();
    }
    timer = setTimeout(() => {
      state.timedOut = true;
      state.process.kill();
    }, timeoutMs);
    const settled = await Promise.allSettled([
      readPipe(state.process.stdout, maximumOutputBytes, state),
      readPipe(state.process.stderr, MAX_ERROR_BYTES, state),
      writeInput(state.process.stdin, input),
      state.process.wait(),
    ]);
    if (state.cancelled) {
      throw protocolError(protocol, "cancelled", "OPERATION_CANCELLED");
    }
    if (state.timedOut) {
      throw protocolError(protocol, "timeout", "CLI_TIMEOUT");
    }
    if (state.outputTooLarge) {
      throw protocolError(protocol, "output_too_large", "CLI_PROTOCOL_ERROR");
    }
    if (settled.some(item => item.status === "rejected")) {
      throw protocolError(protocol, "cli_failed", "CLI_PROTOCOL_ERROR");
    }
    const [stdout, , , result] = settled.map(item => item.value);
    if (result.exitCode !== 0) {
      if (protocol === TORRENT_PROTOCOL) {
        let value;
        try {
          value = JSON.parse(stdout.trim());
        } catch {
          throw torrentError("CLI_PROTOCOL_ERROR");
        }
        throwTorrentCLIError(value);
      }
      throw protocolError(protocol, "cli_failed", "CLI_PROTOCOL_ERROR");
    }
    try {
      return JSON.parse(stdout.trim());
    } catch {
      throw protocolError(protocol, "invalid_output", "CLI_PROTOCOL_ERROR");
    }
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    releaseProcess(state);
  }
}

function cancelOperation(owner, operationId, protocol) {
  assertAuthorized(protocol, owner);
  const state = ACTIVE_OPERATIONS.get(
    operationKey(owner, operationId, protocol)
  );
  if (!state) {
    return false;
  }
  state.cancelled = true;
  state.process?.kill();
  return true;
}

function scalarLength(value) {
  return [...value].length;
}

function scalarSlice(value, maximum) {
  return [...value].slice(0, maximum).join("");
}

function cleanText(value, maximum, { required = false } = {}) {
  if (typeof value !== "string") {
    throw new Error("invalid text");
  }
  const text = scalarSlice(
    value.normalize("NFC").replace(/[\p{Cc}\p{Cf}]+/gu, " "),
    maximum
  );
  if (required && !text.trim()) {
    throw new Error("invalid text");
  }
  return text;
}

function httpURL(value) {
  if (typeof value !== "string" || value.length > 8192) {
    throw new Error("invalid URL");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("invalid URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error("invalid URL");
  }
  return url.href;
}

function searxngURL(value) {
  if (typeof value !== "string" || value.length > 2048) {
    throw webError("invalid_request");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw webError("invalid_request");
  }
  const host = url.hostname.toLowerCase();
  const ipv4 = host.split(".").map(part => Number(part));
  const loopback =
    host === "localhost" ||
    host === "[::1]" ||
    (ipv4.length === 4 &&
      ipv4[0] === 127 &&
      ipv4.every(part => Number.isInteger(part) && part >= 0 && part <= 255));
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password
  ) {
    throw webError("invalid_request");
  }
  return url.href;
}

function nullableInteger(value, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === null || value === undefined) {
    return null;
  }
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error("invalid integer");
  }
  return value;
}

function validateObject(value, required, optional, error) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw error();
  }
  const allowed = new Set([...required, ...optional]);
  if (
    required.some(key => !Object.hasOwn(value, key)) ||
    Object.keys(value).some(key => !allowed.has(key))
  ) {
    throw error();
  }
}

function normalizeWebSearchRequest(value) {
  validateObject(
    value,
    [
      "schema",
      "requestId",
      "query",
      "provider",
      "maxResults",
      "timeoutSeconds",
      "page",
      "safeSearch",
    ],
    ["language", "searxngUrl", "engines"],
    () => webError("invalid_request")
  );
  const query = typeof value.query === "string" ? value.query.trim() : "";
  if (
    value.schema !== 1 ||
    !UUID_V4.test(value.requestId || "") ||
    !query ||
    scalarLength(query) > 512 ||
    /\p{Cc}/u.test(query) ||
    !["ddgs", "searxng"].includes(value.provider) ||
    !Number.isInteger(value.maxResults) ||
    value.maxResults < 1 ||
    value.maxResults > 20 ||
    !Number.isInteger(value.timeoutSeconds) ||
    value.timeoutSeconds < 1 ||
    value.timeoutSeconds > 60 ||
    !Number.isInteger(value.page) ||
    value.page < 1 ||
    value.page > 10 ||
    !Number.isInteger(value.safeSearch) ||
    value.safeSearch < 0 ||
    value.safeSearch > 2
  ) {
    throw webError("invalid_request");
  }
  let language;
  if (value.language != null) {
    if (!/^[A-Za-z0-9-]{1,20}$/u.test(value.language)) {
      throw webError("invalid_request");
    }
    language = value.language;
  }
  let engines;
  if (value.engines != null) {
    if (
      !Array.isArray(value.engines) ||
      value.engines.length > 10 ||
      new Set(value.engines).size !== value.engines.length ||
      value.engines.some(
        engine =>
          typeof engine !== "string" || !/^[A-Za-z0-9 ._-]{1,64}$/u.test(engine)
      )
    ) {
      throw webError("invalid_request");
    }
    engines = value.engines;
  }
  let configuredSearxngURL;
  if (value.provider === "searxng") {
    configuredSearxngURL = searxngURL(value.searxngUrl);
  }
  const input = {
    schemaVersion: 1,
    query,
    provider: value.provider,
    maxResults: value.maxResults,
    timeoutSeconds: value.timeoutSeconds,
    page: value.page,
    safeSearch: value.safeSearch,
  };
  if (value.provider === "searxng") {
    input.searxngUrl = configuredSearxngURL;
    if (engines !== undefined) {
      input.engines = engines;
    }
  }
  if (language !== undefined) {
    input.language = language;
  }
  return {
    args: ["call", "web_search", "-"],
    input,
    request: {
      schema: 1,
      requestId: value.requestId,
      query,
      provider: value.provider,
      maxResults: value.maxResults,
    },
    timeoutMs: value.timeoutSeconds * 1000 + 2000,
  };
}

function sanitizeWebSearch(value, request) {
  try {
    validateObject(
      value,
      ["schemaVersion", "ok", "provider", "query", "results"],
      [],
      () => webError("invalid_output")
    );
    const results = value.results;
    if (
      value.schemaVersion !== 1 ||
      value.ok !== true ||
      value.provider !== request.provider ||
      value.query !== request.query ||
      !Array.isArray(results) ||
      results.length > request.maxResults ||
      results.length > 20
    ) {
      throw webError("invalid_output");
    }
    return {
      schema: 1,
      requestId: request.requestId,
      implementation: "buzzard-search",
      kind: "search",
      provider: request.provider,
      query: request.query,
      results: results.map(result => {
        validateObject(
          result,
          ["title", "url", "snippet", "provider"],
          ["engines", "score", "date"],
          () => webError("invalid_output")
        );
        const normalized = {
          title: cleanText(result.title, 512, { required: true }),
          url: httpURL(result.url),
          snippet: cleanText(result.snippet, 16384),
          provider: result.provider,
        };
        if (result.provider !== request.provider) {
          throw new Error("invalid provider");
        }
        if (result.engines !== undefined) {
          if (!Array.isArray(result.engines) || result.engines.length > 10) {
            throw new Error("invalid engines");
          }
          normalized.engines = result.engines.map(engine =>
            cleanText(engine, 64, { required: true })
          );
        }
        if (result.score !== undefined) {
          if (
            typeof result.score !== "number" ||
            !Number.isFinite(result.score)
          ) {
            throw new Error("invalid score");
          }
          normalized.score = result.score;
        }
        if (result.date !== undefined && result.date !== null) {
          normalized.date = cleanText(result.date, 64, { required: true });
        }
        return normalized;
      }),
    };
  } catch (error) {
    throw normalizeError(WEB_PROTOCOL, error, "invalid_output");
  }
}

async function webStatus(owner) {
  assertAuthorized(WEB_PROTOCOL, owner);
  if (AppConstants.platform !== "linux") {
    return {
      schema: 1,
      available: false,
      protocolVersion: 1,
      errorCode: "unsupported_platform",
    };
  }
  if (!executableReady(SEARCH_COMMAND)) {
    return {
      schema: 1,
      available: false,
      protocolVersion: 1,
      errorCode: "cli_missing",
    };
  }
  try {
    const value = await runJson(SEARCH_COMMAND, ["version"], {
      protocol: WEB_PROTOCOL,
      owner,
      timeoutMs: 5000,
    });
    validateObject(
      value,
      ["package", "version", "protocolVersion", "schemaVersion", "operations"],
      [],
      () => webError("protocol_mismatch")
    );
    if (
      value.package !== "buzzard-search" ||
      typeof value.version !== "string" ||
      !value.version ||
      scalarLength(value.version) > 64 ||
      value.protocolVersion !== 1 ||
      value.schemaVersion !== 1 ||
      !Array.isArray(value.operations) ||
      value.operations.length !== 1 ||
      value.operations[0] !== "web_search"
    ) {
      throw new Error("version mismatch");
    }
    return {
      schema: 1,
      available: true,
      protocolVersion: 1,
      packageVersion: cleanText(value.version, 64, { required: true }),
    };
  } catch {
    return {
      schema: 1,
      available: false,
      protocolVersion: 1,
      errorCode: "protocol_mismatch",
    };
  }
}

class BuzzardSearchBridgeImpl {
  getStatus(owner) {
    return webStatus(owner);
  }

  async search(value, owner) {
    assertAuthorized(WEB_PROTOCOL, owner);
    const normalized = normalizeWebSearchRequest(value);
    try {
      const output = await runJson(SEARCH_COMMAND, normalized.args, {
        protocol: WEB_PROTOCOL,
        owner,
        operationId: normalized.request.requestId,
        input: normalized.input,
        timeoutMs: normalized.timeoutMs,
      });
      return sanitizeWebSearch(output, normalized.request);
    } catch (error) {
      throw normalizeError(WEB_PROTOCOL, error, "cli_failed");
    }
  }

  cancel(requestId, owner) {
    return cancelOperation(owner, requestId, WEB_PROTOCOL);
  }

  shutdown(owner) {
    shutdownOwner(owner);
  }
}

async function callTorrent(tool, value, options = {}) {
  return runJson(TORRENT_COMMAND, ["call", tool, "-"], {
    protocol: TORRENT_PROTOCOL,
    input: value,
    ...options,
  });
}

function throwTorrentCLIError(value) {
  if (value?.ok !== false) {
    return;
  }
  try {
    validateObject(value, ["schemaVersion", "ok", "error"], [], () =>
      torrentError("CLI_PROTOCOL_ERROR")
    );
    validateObject(value.error, ["code", "message"], [], () =>
      torrentError("CLI_PROTOCOL_ERROR")
    );
    if (
      value.schemaVersion !== 1 ||
      value.ok !== false ||
      ![
        "INVALID_REQUEST",
        "SOURCE_UNAVAILABLE",
        "NOT_FOUND",
        "TIMEOUT",
        "PROTOCOL_ERROR",
        "INTERNAL",
      ].includes(value.error.code) ||
      typeof value.error.message !== "string" ||
      !value.error.message.trim() ||
      scalarLength(value.error.message) > 256
    ) {
      throw torrentError("CLI_PROTOCOL_ERROR");
    }
  } catch (error) {
    throw normalizeError(
      TORRENT_PROTOCOL,
      error,
      undefined,
      "CLI_PROTOCOL_ERROR"
    );
  }
  if (value.error.code === "NOT_FOUND") {
    throw torrentError("RESULT_NOT_FOUND");
  }
  if (value.error.code === "TIMEOUT") {
    throw torrentError("CLI_TIMEOUT");
  }
  throw torrentError("CLI_PROTOCOL_ERROR");
}

function boundedCLIText(value, maximum) {
  if (typeof value !== "string" || scalarLength(value) > maximum) {
    throw new Error("invalid text");
  }
  return cleanText(value, maximum, { required: true });
}

function sanitizeTorrentSources(value) {
  throwTorrentCLIError(value);
  try {
    validateObject(value, ["schemaVersion", "ok", "sources"], [], () =>
      torrentError("CLI_PROTOCOL_ERROR")
    );
    if (
      value.schemaVersion !== 1 ||
      value.ok !== true ||
      !Array.isArray(value.sources) ||
      value.sources.length > 64
    ) {
      throw new Error("invalid sources response");
    }
    const seen = new Set();
    const sources = value.sources.map(source => {
      validateObject(source, ["id", "name"], [], () =>
        torrentError("CLI_PROTOCOL_ERROR")
      );
      if (!SOURCE_ID.test(source.id || "") || seen.has(source.id)) {
        throw new Error("invalid source");
      }
      seen.add(source.id);
      return {
        id: source.id,
        name: boundedCLIText(source.name, 128),
      };
    });
    return { schemaVersion: 1, sources };
  } catch (error) {
    throw normalizeError(
      TORRENT_PROTOCOL,
      error,
      undefined,
      "CLI_PROTOCOL_ERROR"
    );
  }
}

function normalizeTorrentSearchRequest(value) {
  validateObject(
    value,
    ["schemaVersion", "operationId", "query", "limit"],
    ["source"],
    () => torrentError("INVALID_REQUEST")
  );
  const query = typeof value.query === "string" ? value.query.trim() : "";
  if (
    value.schemaVersion !== 1 ||
    !UUID_V4.test(value.operationId || "") ||
    !query ||
    scalarLength(query) > 256 ||
    /\p{Cc}/u.test(query) ||
    !Number.isInteger(value.limit) ||
    value.limit < 1 ||
    value.limit > 50 ||
    (value.source !== undefined && !SOURCE_ID.test(value.source))
  ) {
    throw torrentError("INVALID_REQUEST");
  }
  return {
    body: {
      schemaVersion: 1,
      query,
      limit: value.limit,
      ...(value.source === undefined ? {} : { source: value.source }),
    },
    limit: value.limit,
    operationId: value.operationId,
    query,
    source: value.source,
  };
}

function newToken() {
  return `v1_${ChromeUtils.base64URLEncode(
    crypto.getRandomValues(new Uint8Array(32)),
    { pad: false }
  )}`;
}

function rememberToken(token, status, expiresAt) {
  TOKEN_HISTORY.set(token, {
    status,
    expiresAt: Math.max(expiresAt, Date.now() + TOKEN_HISTORY_MS),
  });
  while (TOKEN_HISTORY.size > MAX_TOKEN_HISTORY) {
    TOKEN_HISTORY.delete(TOKEN_HISTORY.keys().next().value);
  }
}

function cleanupTokens() {
  const now = Date.now();
  for (const store of [RESULT_TOKENS, CONFIRMATION_TOKENS]) {
    for (const [token, item] of store) {
      if (item.expiresAt <= now) {
        store.delete(token);
        rememberToken(token, "expired", item.expiresAt);
      }
    }
  }
  for (const [token, item] of TOKEN_HISTORY) {
    if (item.expiresAt <= now) {
      TOKEN_HISTORY.delete(token);
    }
  }
}

function storeToken(store, maximum, token, value) {
  cleanupTokens();
  while (store.size >= maximum) {
    const oldest = store.keys().next().value;
    const item = store.get(oldest);
    store.delete(oldest);
    rememberToken(oldest, "expired", item.expiresAt);
  }
  store.set(token, value);
}

function retainedPayloadBytes() {
  let bytes = 0;
  for (const item of CONFIRMATION_TOKENS.values()) {
    bytes +=
      item.resolved.kind === "torrent"
        ? item.resolved.torrent.byteLength
        : item.resolved.magnet.length * 2;
  }
  return bytes;
}

function storeConfirmationToken(token, value) {
  cleanupTokens();
  const valueBytes =
    value.resolved.kind === "torrent"
      ? value.resolved.torrent.byteLength
      : value.resolved.magnet.length * 2;
  while (
    CONFIRMATION_TOKENS.size >= MAX_CONFIRMATION_TOKENS ||
    retainedPayloadBytes() + valueBytes > MAX_RETAINED_PAYLOAD_BYTES
  ) {
    const oldest = CONFIRMATION_TOKENS.keys().next().value;
    const item = CONFIRMATION_TOKENS.get(oldest);
    CONFIRMATION_TOKENS.delete(oldest);
    rememberToken(oldest, "expired", item.expiresAt);
  }
  CONFIRMATION_TOKENS.set(token, value);
}

function consumeToken(store, token, owner) {
  cleanupTokens();
  const history = TOKEN_HISTORY.get(token);
  if (history) {
    throw torrentError(
      history.status === "consumed" ? "TOKEN_CONSUMED" : "TOKEN_EXPIRED"
    );
  }
  const item = store.get(token);
  if (!item || item.owner !== owner) {
    throw torrentError("RESULT_NOT_FOUND");
  }
  store.delete(token);
  rememberToken(token, "consumed", item.expiresAt);
  return item;
}

function normalizePublishedAt(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(
      value
    )
  ) {
    throw new Error("invalid date");
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error("invalid date");
  }
  return new Date(timestamp).toISOString();
}

function sanitizeTorrentSearch(value, request, owner) {
  throwTorrentCLIError(value);
  try {
    validateObject(
      value,
      ["schemaVersion", "ok", "query", "results", "truncated"],
      [],
      () => torrentError("CLI_PROTOCOL_ERROR")
    );
    if (
      value.schemaVersion !== 1 ||
      value.ok !== true ||
      value.query !== request.query ||
      !Array.isArray(value.results) ||
      value.results.length > request.limit ||
      value.results.length > 50 ||
      typeof value.truncated !== "boolean"
    ) {
      throw new Error("invalid search response");
    }
    const backendIds = new Set();
    const records = value.results.map(result => {
      validateObject(
        result,
        [
          "resultId",
          "sourceId",
          "sourceName",
          "title",
          "sizeBytes",
          "seeders",
          "leechers",
          "publishedAt",
        ],
        [],
        () => torrentError("CLI_PROTOCOL_ERROR")
      );
      if (
        !BACKEND_RESULT_ID.test(result.resultId || "") ||
        backendIds.has(result.resultId) ||
        !SOURCE_ID.test(result.sourceId || "") ||
        (request.source !== undefined && result.sourceId !== request.source)
      ) {
        throw new Error("invalid result");
      }
      backendIds.add(result.resultId);
      return {
        backendId: result.resultId,
        sourceName: boundedCLIText(result.sourceName, 128),
        title: boundedCLIText(result.title, 512),
        sizeBytes: nullableInteger(result.sizeBytes),
        seeders: nullableInteger(result.seeders, 2147483647),
        leechers: nullableInteger(result.leechers, 2147483647),
        publishedAt: normalizePublishedAt(result.publishedAt),
      };
    });
    const results = records.map(record => {
      let resultToken;
      do {
        resultToken = newToken();
      } while (
        RESULT_TOKENS.has(resultToken) ||
        TOKEN_HISTORY.has(resultToken)
      );
      const expiresAt = Date.now() + TOKEN_LIFETIME_MS;
      storeToken(RESULT_TOKENS, MAX_RESULT_TOKENS, resultToken, {
        owner,
        backendId: record.backendId,
        sourceName: record.sourceName,
        expiresAt,
      });
      return {
        resultToken,
        sourceName: record.sourceName,
        title: record.title,
        sizeBytes: record.sizeBytes,
        seeders: record.seeders,
        leechers: record.leechers,
        publishedAt: record.publishedAt,
      };
    });
    return {
      schemaVersion: 1,
      operationId: request.operationId,
      results,
      truncated: value.truncated,
    };
  } catch (error) {
    throw normalizeError(
      TORRENT_PROTOCOL,
      error,
      undefined,
      "CLI_PROTOCOL_ERROR"
    );
  }
}

function validateBencodedTorrent(bytes) {
  let index = 0;
  let nodes = 0;

  function digits(until) {
    const start = index;
    let number = 0;
    while (index < bytes.length && bytes[index] !== until) {
      if (bytes[index] < 0x30 || bytes[index] > 0x39) {
        throw new Error("invalid bencode");
      }
      number = number * 10 + bytes[index] - 0x30;
      if (!Number.isSafeInteger(number)) {
        throw new Error("invalid bencode");
      }
      index++;
    }
    if (index === start || index >= bytes.length) {
      throw new Error("invalid bencode");
    }
    if (index - start > 1 && bytes[start] === 0x30) {
      throw new Error("invalid bencode");
    }
    index++;
    return number;
  }

  function string() {
    const length = digits(0x3a);
    if (length > bytes.length - index) {
      throw new Error("invalid bencode");
    }
    const stringBytes = bytes.subarray(index, index + length);
    index += length;
    return stringBytes;
  }

  function value(depth, top = false) {
    if (++nodes > 200000 || depth > 64 || index >= bytes.length) {
      throw new Error("invalid bencode");
    }
    if (bytes[index] >= 0x30 && bytes[index] <= 0x39) {
      string();
      return { dictionary: false, hasInfo: false };
    }
    const marker = bytes[index++];
    if (marker === 0x69) {
      let negative = false;
      if (bytes[index] === 0x2d) {
        negative = true;
        index++;
      }
      const start = index;
      const number = digits(0x65);
      if (
        (negative && number === 0) ||
        (index - start > 2 && bytes[start] === 0x30)
      ) {
        throw new Error("invalid bencode");
      }
      return { dictionary: false, hasInfo: false };
    }
    if (marker === 0x6c) {
      while (index < bytes.length && bytes[index] !== 0x65) {
        value(depth + 1);
      }
      if (bytes[index++] !== 0x65) {
        throw new Error("invalid bencode");
      }
      return { dictionary: false, hasInfo: false };
    }
    if (marker !== 0x64) {
      throw new Error("invalid bencode");
    }
    let hasInfo = false;
    while (index < bytes.length && bytes[index] !== 0x65) {
      if (bytes[index] < 0x30 || bytes[index] > 0x39) {
        throw new Error("invalid bencode");
      }
      const key = string();
      const parsed = value(depth + 1);
      if (
        top &&
        key.length === 4 &&
        key[0] === 0x69 &&
        key[1] === 0x6e &&
        key[2] === 0x66 &&
        key[3] === 0x6f &&
        parsed.dictionary
      ) {
        hasInfo = true;
      }
    }
    if (bytes[index++] !== 0x65) {
      throw new Error("invalid bencode");
    }
    return { dictionary: true, hasInfo };
  }

  try {
    const parsed = value(0, true);
    return parsed.dictionary && parsed.hasInfo && index === bytes.length;
  } catch {
    return false;
  }
}

function sanitizeResolved(value, result) {
  throwTorrentCLIError(value);
  let name;
  let sourceName;
  let sizeBytes;
  try {
    validateObject(
      value,
      ["schemaVersion", "ok", "name", "sourceName", "sizeBytes", "payload"],
      [],
      () => torrentError("CLI_PROTOCOL_ERROR")
    );
    if (value.schemaVersion !== 1 || value.ok !== true) {
      throw new Error("invalid resolve response");
    }
    name = boundedCLIText(value.name, 512);
    sourceName = boundedCLIText(value.sourceName, 128);
    sizeBytes = nullableInteger(value.sizeBytes);
    if (sourceName !== result.sourceName) {
      throw new Error("source mismatch");
    }
    if (value.payload?.kind === "magnet") {
      validateObject(value.payload, ["kind", "value"], [], () =>
        torrentError("CLI_PROTOCOL_ERROR")
      );
    } else if (value.payload?.kind === "torrent") {
      validateObject(value.payload, ["kind", "dataBase64"], [], () =>
        torrentError("CLI_PROTOCOL_ERROR")
      );
    } else {
      throw new Error("invalid resolve payload");
    }
  } catch (error) {
    throw normalizeError(
      TORRENT_PROTOCOL,
      error,
      undefined,
      "CLI_PROTOCOL_ERROR"
    );
  }

  let resolved;
  if (value.payload.kind === "magnet") {
    if (
      typeof value.payload.value !== "string" ||
      scalarLength(value.payload.value) < 20 ||
      !isValidBTIHMagnet(value.payload.value)
    ) {
      throw torrentError("TORRENT_INVALID");
    }
    resolved = { kind: "magnet", magnet: value.payload.value };
  } else {
    const encoded = value.payload.dataBase64;
    if (
      typeof encoded !== "string" ||
      encoded.length < 4 ||
      encoded.length > Math.ceil((MAX_TORRENT_BYTES * 4) / 3) ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
        encoded
      )
    ) {
      throw torrentError("TORRENT_INVALID");
    }
    let binary;
    try {
      binary = atob(encoded);
    } catch {
      throw torrentError("TORRENT_INVALID");
    }
    const torrent = Uint8Array.from(binary, character =>
      character.charCodeAt(0)
    );
    if (
      !torrent.length ||
      torrent.length > MAX_TORRENT_BYTES ||
      !validateBencodedTorrent(torrent)
    ) {
      throw torrentError("TORRENT_INVALID");
    }
    resolved = { kind: "torrent", torrent };
  }
  return { resolved, name, sourceName, sizeBytes };
}

function torrentRequest(value, tokenName) {
  validateObject(value, ["schemaVersion", tokenName], [], () =>
    torrentError("INVALID_REQUEST")
  );
  if (value.schemaVersion !== 1 || !TOKEN_ID.test(value[tokenName] || "")) {
    throw torrentError("INVALID_REQUEST");
  }
  return value[tokenName];
}

function isTorrentVersion(value) {
  try {
    validateObject(
      value,
      ["package", "version", "protocolVersion", "schemaVersion"],
      [],
      () => torrentError("CLI_PROTOCOL_ERROR")
    );
    return (
      value.package === "buzzard-minijtt" &&
      typeof value.version === "string" &&
      /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u.test(value.version) &&
      value.version.length <= 64 &&
      value.protocolVersion === 1 &&
      value.schemaVersion === 1
    );
  } catch {
    return false;
  }
}

async function torrentStatus(owner) {
  assertAuthorized(TORRENT_PROTOCOL, owner);
  if (!executableReady(TORRENT_COMMAND)) {
    return { schemaVersion: 1, available: false };
  }
  try {
    const value = await runJson(TORRENT_COMMAND, ["version"], {
      protocol: TORRENT_PROTOCOL,
      owner,
      timeoutMs: 5000,
    });
    return {
      schemaVersion: 1,
      available: isTorrentVersion(value),
    };
  } catch {
    return { schemaVersion: 1, available: false };
  }
}

function shutdownOwner(owner) {
  for (const state of ACTIVE_PROCESSES) {
    if (state.owner === owner) {
      state.cancelled = true;
      state.process?.kill();
    }
  }
  for (const store of [RESULT_TOKENS, CONFIRMATION_TOKENS]) {
    for (const [token, item] of store) {
      if (item.owner === owner) {
        store.delete(token);
        rememberToken(token, "consumed", item.expiresAt);
      }
    }
  }
}

function isActiveTorrentImportContext(callContext) {
  try {
    return (
      callContext?.isHandlingUserInput === true &&
      callContext.isPrivate !== true &&
      callContext.window &&
      !callContext.window.closed &&
      Services.focus.activeWindow === callContext.window &&
      callContext.window.document.hasFocus() &&
      !PrivateBrowsingUtils.isWindowPrivate(callContext.window)
    );
  } catch {
    return false;
  }
}

class TorrentSearchBridgeImpl {
  getStatus(owner) {
    return torrentStatus(owner);
  }

  async listSources(owner) {
    assertAuthorized(TORRENT_PROTOCOL, owner);
    try {
      return sanitizeTorrentSources(
        await callTorrent(
          "torrent_sources",
          { schemaVersion: 1 },
          { owner, timeoutMs: 15000 }
        )
      );
    } catch (error) {
      throw normalizeError(
        TORRENT_PROTOCOL,
        error,
        undefined,
        "CLI_PROTOCOL_ERROR"
      );
    }
  }

  async search(value, owner) {
    assertAuthorized(TORRENT_PROTOCOL, owner);
    const request = normalizeTorrentSearchRequest(value);
    try {
      const output = await callTorrent("torrent_search", request.body, {
        owner,
        operationId: request.operationId,
        timeoutMs: 65000,
      });
      return sanitizeTorrentSearch(output, request, owner);
    } catch (error) {
      throw normalizeError(
        TORRENT_PROTOCOL,
        error,
        undefined,
        "CLI_PROTOCOL_ERROR"
      );
    }
  }

  cancel(value, owner) {
    assertAuthorized(TORRENT_PROTOCOL, owner);
    validateObject(value, ["schemaVersion", "operationId"], [], () =>
      torrentError("INVALID_REQUEST")
    );
    if (value.schemaVersion !== 1) {
      throw torrentError("INVALID_REQUEST");
    }
    return {
      schemaVersion: 1,
      cancelled: cancelOperation(owner, value.operationId, TORRENT_PROTOCOL),
    };
  }

  async prepareImport(value, owner) {
    assertAuthorized(TORRENT_PROTOCOL, owner);
    const resultToken = torrentRequest(value, "resultToken");
    const result = consumeToken(RESULT_TOKENS, resultToken, owner);
    let output;
    try {
      output = await callTorrent(
        "torrent_resolve",
        { schemaVersion: 1, resultId: result.backendId },
        {
          owner,
          maximumOutputBytes: MAX_TORRENT_RESOLVE_JSON_BYTES,
          timeoutMs: 35000,
        }
      );
    } catch (error) {
      throw normalizeError(
        TORRENT_PROTOCOL,
        error,
        undefined,
        "CLI_PROTOCOL_ERROR"
      );
    }
    const prepared = sanitizeResolved(output, result);
    let confirmationToken;
    do {
      confirmationToken = newToken();
    } while (
      CONFIRMATION_TOKENS.has(confirmationToken) ||
      TOKEN_HISTORY.has(confirmationToken)
    );
    const expiresAt = Date.now() + TOKEN_LIFETIME_MS;
    storeConfirmationToken(confirmationToken, {
      owner,
      ...prepared,
      expiresAt,
    });
    return {
      schemaVersion: 1,
      confirmationToken,
      expiresAt: new Date(expiresAt).toISOString(),
      name: prepared.name,
      sourceName: prepared.sourceName,
      kind: prepared.resolved.kind,
      sizeBytes: prepared.sizeBytes,
    };
  }

  discardPrepared(value, owner) {
    assertAuthorized(TORRENT_PROTOCOL, owner);
    const confirmationToken = torrentRequest(value, "confirmationToken");
    consumeToken(CONFIRMATION_TOKENS, confirmationToken, owner);
    return { schemaVersion: 1, discarded: true };
  }

  async importPrepared(value, owner, callContext) {
    assertAuthorized(TORRENT_PROTOCOL, owner);
    const confirmationToken = torrentRequest(value, "confirmationToken");
    if (!isActiveTorrentImportContext(callContext)) {
      throw torrentError("NOT_AUTHORIZED");
    }
    const prepared = consumeToken(
      CONFIRMATION_TOKENS,
      confirmationToken,
      owner
    );
    const kind = prepared.resolved.kind === "magnet" ? "magnet" : "torrent";
    const size =
      prepared.sizeBytes === null ? "unknown" : String(prepared.sizeBytes);
    const [title, message] = await TORRENT_L10N.formatValues([
      { id: "wildbuzzard-torrent-extension-confirm-title" },
      {
        id: "wildbuzzard-torrent-extension-confirm-message",
        args: {
          name: `\u2068${prepared.name}\u2069`,
          source: `\u2068${prepared.sourceName}\u2069`,
          kind,
          size,
        },
      },
    ]);
    if (!isActiveTorrentImportContext(callContext)) {
      throw torrentError("NOT_AUTHORIZED");
    }
    if (!Services.prompt.confirm(callContext.window, title, message)) {
      return { schemaVersion: 1, accepted: false };
    }
    if (!isActiveTorrentImportContext(callContext)) {
      throw torrentError("NOT_AUTHORIZED");
    }
    try {
      const { TorrentManager } = ChromeUtils.importESModule(
        "resource:///modules/TorrentManager.sys.mjs"
      );
      await TorrentManager.initialize();
      if (!isActiveTorrentImportContext(callContext)) {
        throw torrentError("NOT_AUTHORIZED");
      }
      const result =
        prepared.resolved.kind === "magnet"
          ? await TorrentManager.addMagnet(prepared.resolved.magnet)
          : await TorrentManager.addTorrentBytes(prepared.resolved.torrent);
      callContext.window.gBrowser?.loadOneTab("about:torrents", {
        inBackground: false,
        triggeringPrincipal:
          Services.scriptSecurityManager.getSystemPrincipal(),
      });
      const response = { schemaVersion: 1, accepted: true };
      if (Array.isArray(result?.ids) && result.ids.length === 1) {
        response.downloadId = String(result.ids[0]).slice(0, 256);
      }
      return response;
    } catch (error) {
      if (error?.wildBuzzardBridge === TORRENT_PROTOCOL) {
        throw error;
      }
      throw torrentError("IMPORT_FAILED");
    }
  }

  shutdown(owner) {
    shutdownOwner(owner);
  }
}

export const BuzzardSearchBridge = new BuzzardSearchBridgeImpl();
export const TorrentSearchBridge = new TorrentSearchBridgeImpl();

export const WildBuzzardDiscoveryBridgeTestUtils = Object.freeze({
  isAuthorizedDiscoveryContext,
  isAuthorizedDiscoveryExtension,
  isTorrentVersion,
  normalizeTorrentSearchRequest,
  normalizeWebSearchRequest,
  sanitizeResolved,
  sanitizeTorrentSearch,
  sanitizeTorrentSources,
  sanitizeWebSearch,
  resetTokens() {
    RESULT_TOKENS.clear();
    CONFIRMATION_TOKENS.clear();
    TOKEN_HISTORY.clear();
  },
});
