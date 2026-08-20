/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { Subprocess } from "resource://gre/modules/Subprocess.sys.mjs";

const LocalFile = Components.Constructor(
  "@mozilla.org/file/local;1",
  "nsIFile",
  "initWithPath"
);

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TORRENT_BYTES = 12 * 1024 * 1024;
const OPAQUE_ID = /^[A-Za-z0-9_-]{32}$/;
const BTIH_MAGNET =
  /^magnet:\?xt=urn:btih:(?:[A-Fa-f0-9]{40}|[A-Za-z2-7]{32})(?:&|$)/;
const DEFAULT_COMMAND = "/usr/bin/buzzard-torrent-search";
const MAX_LIFECYCLE_OUTPUT = 64 * 1024;

async function readPipe(pipe, maximum = MAX_LIFECYCLE_OUTPUT) {
  let output = "";
  for (let chunk; (chunk = await pipe.readString()); ) {
    output += chunk;
    if (output.length > maximum) {
      throw new Error("buzzard-torrent-search output exceeded its limit");
    }
  }
  return output;
}

function torrentSearchCommand() {
  const command =
    Services.prefs.getStringPref("wildbuzzard.torrent.searchCommand", "") ||
    Services.env.get("BUZZARD_TORRENT_SEARCH_COMMAND") ||
    DEFAULT_COMMAND;
  const executable = new LocalFile(command);
  if (
    !executable.isFile() ||
    executable.isSymlink() ||
    !executable.isExecutable()
  ) {
    throw new Error("The buzzard-torrent-search package is not installed");
  }
  return command;
}

async function callTorrentSearchPackage(tool, args, signal, activeProcesses) {
  const command = torrentSearchCommand();
  const process = await Subprocess.call({
    command,
    arguments: ["call", tool, JSON.stringify(args)],
    environmentAppend: true,
    environment: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "UTC" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let cancelled = false;
  const onAbort = () => {
    cancelled = true;
    process.kill();
  };
  const activeProcess = { cancel: onAbort };
  activeProcesses?.add(activeProcess);
  if (signal?.aborted) {
    onAbort();
  } else {
    signal?.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const settled = await Promise.allSettled([
      readPipe(process.stdout, MAX_RESPONSE_BYTES),
      readPipe(process.stderr),
      process.wait(),
    ]);
    if (cancelled) {
      throw Object.assign(new Error("Torrent search cancelled"), {
        cancelled: true,
      });
    }
    const failure = settled.find(entry => entry.status === "rejected");
    if (failure) {
      throw failure.reason;
    }
    const [stdout, stderr, result] = settled.map(entry => entry.value);
    if (result.exitCode !== 0 || stderr.trim()) {
      throw new Error("buzzard-torrent-search command failed");
    }
    try {
      return JSON.parse(stdout);
    } catch {
      throw invalidResponse();
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    activeProcesses?.delete(activeProcess);
  }
}

function invalidResponse() {
  return new Error("Torrent search returned an invalid response");
}

function cleanText(value, maximum) {
  if (typeof value !== "string") {
    throw invalidResponse();
  }
  return [...value.normalize("NFC")]
    .filter(character => !/\p{Cc}/u.test(character))
    .join("")
    .slice(0, maximum);
}

function nullableInteger(value) {
  if (value === null) {
    return null;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalidResponse();
  }
  return value;
}

function sanitizeSources(response) {
  if (response?.immutable !== true || !Array.isArray(response.sources)) {
    throw invalidResponse();
  }
  return {
    immutable: true,
    sources: response.sources.map(source => {
      if (
        typeof source?.id !== "string" ||
        !source.id ||
        source.id.length > 128 ||
        !["ready", "unavailable"].includes(source.state) ||
        source.access !== "public" ||
        !["general", "mixed-general"].includes(source.contentClass)
      ) {
        throw invalidResponse();
      }
      return {
        id: source.id,
        name: cleanText(source.name, 160),
        state: source.state,
        access: "public",
        contentClass: source.contentClass,
        reasons: Array.isArray(source.reasons)
          ? source.reasons.slice(0, 16).map(reason => cleanText(reason, 256))
          : [],
      };
    }),
  };
}

function sanitizeSearch(response) {
  if (
    !OPAQUE_ID.test(response?.searchId || "") ||
    typeof response.partial !== "boolean" ||
    !Array.isArray(response.providers) ||
    !Array.isArray(response.results) ||
    response.providers.length > 100 ||
    response.results.length > 200
  ) {
    throw invalidResponse();
  }
  const providers = response.providers.map(provider => {
    if (
      typeof provider?.id !== "string" ||
      !provider.id ||
      provider.id.length > 128 ||
      !["ok", "unavailable", "unsupported", "timeout", "error"].includes(
        provider.state
      ) ||
      !Number.isSafeInteger(provider.elapsedMs) ||
      provider.elapsedMs < 0
    ) {
      throw invalidResponse();
    }
    return {
      id: provider.id,
      state: provider.state,
      elapsedMs: provider.elapsedMs,
    };
  });
  const results = response.results.map(result => {
    if (
      !OPAQUE_ID.test(result?.resultId || "") ||
      typeof result.providerId !== "string" ||
      !result.providerId ||
      result.providerId.length > 128 ||
      result.access !== "public" ||
      !["magnet", "torrent"].includes(result.acquisition) ||
      !Array.isArray(result.categoryIds) ||
      result.categoryIds.some(
        category => !Number.isSafeInteger(category) || category < 0
      )
    ) {
      throw invalidResponse();
    }
    let publishedAt = null;
    if (result.publishedAt !== null) {
      const time = Date.parse(result.publishedAt);
      if (!Number.isFinite(time)) {
        throw invalidResponse();
      }
      publishedAt = new Date(time).toISOString();
    }
    return {
      resultId: result.resultId,
      providerId: result.providerId,
      providerName: cleanText(result.providerName, 160),
      name: cleanText(result.name, 512),
      sizeBytes: nullableInteger(result.sizeBytes),
      seeders: nullableInteger(result.seeders),
      leechers: nullableInteger(result.leechers),
      publishedAt,
      categoryIds: [...new Set(result.categoryIds)].sort((a, b) => a - b),
      access: "public",
      acquisition: result.acquisition,
    };
  });
  return {
    searchId: response.searchId,
    partial: response.partial,
    providers,
    results,
  };
}

/** Connects the browser to the independently packaged torrent search CLI. */
class TorrentDiscoveryManagerImpl {
  async getSources() {
    return sanitizeSources(
      await callTorrentSearchPackage("torrent_sources", {})
    );
  }

  async search({ query, sourceIds, limit = 200, isPrivate = false, signal }) {
    if (isPrivate) {
      throw new Error("Torrent search is disabled in private windows");
    }
    query = String(query || "").trim();
    if (!query || query.length > 256 || /\p{Cc}/u.test(query)) {
      throw new Error("Enter a search query of 256 characters or fewer");
    }
    const body = { query, limit };
    if (sourceIds !== undefined) {
      if (
        !Array.isArray(sourceIds) ||
        !sourceIds.length ||
        sourceIds.length > 100 ||
        new Set(sourceIds).size !== sourceIds.length ||
        sourceIds.some(id => typeof id !== "string" || !id || id.length > 128)
      ) {
        throw new Error("Choose one or more valid torrent sources");
      }
      body.sourceIds = sourceIds;
    }
    return sanitizeSearch(
      await callTorrentSearchPackage(
        "torrent_search",
        body,
        signal,
        (this.activeProcesses ??= new Set())
      )
    );
  }

  cancelSearch() {
    for (const process of this.activeProcesses ?? []) {
      process.cancel();
    }
  }

  async resolve(resultId, signal) {
    if (!OPAQUE_ID.test(resultId || "")) {
      throw new Error("The torrent result identifier is invalid");
    }
    const response = await callTorrentSearchPackage(
      "torrent_resolve",
      { resultId },
      signal
    );
    if (
      response?.kind === "magnet" &&
      BTIH_MAGNET.test(response.magnet || "") &&
      response.torrentBase64 === null &&
      response.torrentBytes === null
    ) {
      return { kind: "magnet", magnet: response.magnet };
    }
    if (
      response?.kind === "torrent" &&
      response.magnet === null &&
      typeof response.torrentBase64 === "string" &&
      Number.isInteger(response.torrentBytes) &&
      response.torrentBytes > 0 &&
      response.torrentBytes <= MAX_TORRENT_BYTES
    ) {
      const binary = atob(response.torrentBase64);
      if (binary.length !== response.torrentBytes) {
        throw invalidResponse();
      }
      return {
        kind: "torrent",
        torrent: Uint8Array.from(binary, character => character.charCodeAt(0)),
      };
    }
    throw invalidResponse();
  }
}

export const TorrentDiscoveryManager = new TorrentDiscoveryManagerImpl();
