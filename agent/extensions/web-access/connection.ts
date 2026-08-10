/* SPDX-License-Identifier: AGPL-3.0-or-later */

import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface SearchConnection {
  version: 1;
  protocolVersion: 1;
  runtimeVersion: string;
  address: "127.0.0.1";
  port: number;
  token: string;
  pid: number;
  processStartTime: string;
  executablePath: string;
  executableSha256: string;
  dataRootId: string;
  ownerInstanceId: string;
  createdAt: number;
  lastHealthAt: number;
}

const CONNECTION_FIELDS = new Set([
  "address",
  "createdAt",
  "dataRootId",
  "executablePath",
  "executableSha256",
  "lastHealthAt",
  "ownerInstanceId",
  "pid",
  "port",
  "processStartTime",
  "protocolVersion",
  "runtimeVersion",
  "token",
  "version",
]);

function connectionPath(): string {
  if (process.env.WILDBUZZARD_SEARCH_CONNECTION_FILE) {
    return process.env.WILDBUZZARD_SEARCH_CONNECTION_FILE;
  }
  const runtime = process.env.XDG_RUNTIME_DIR;
  const root = runtime?.trim()
    ? runtime
    : join(homedir(), ".local", "share", "wildbuzzard", "search", "run");
  return join(root, "wildbuzzard-search", "connection.json");
}

function isHexDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isTimestamp(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= 8_640_000_000_000_000
  );
}

function validateConnection(value: unknown): SearchConnection {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("WildBuzzard search connection record is invalid");
  }
  const record = value as Partial<SearchConnection>;
  const fields = Object.keys(record);
  if (
    fields.length !== CONNECTION_FIELDS.size ||
    fields.some(field => !CONNECTION_FIELDS.has(field)) ||
    record.version !== 1 ||
    record.protocolVersion !== 1 ||
    record.address !== "127.0.0.1" ||
    !Number.isSafeInteger(record.port) ||
    Number(record.port) < 1024 ||
    Number(record.port) > 65535 ||
    typeof record.token !== "string" ||
    record.token.length < 32 ||
    record.token.length > 512 ||
    !/^[A-Za-z0-9_-]+$/.test(record.token) ||
    !Number.isSafeInteger(record.pid) ||
    Number(record.pid) < 1 ||
    typeof record.processStartTime !== "string" ||
    !/^\d+$/.test(record.processStartTime) ||
    typeof record.runtimeVersion !== "string" ||
    !record.runtimeVersion ||
    record.runtimeVersion.length > 128 ||
    typeof record.executablePath !== "string" ||
    !isAbsolute(record.executablePath) ||
    record.executablePath.length > 4_096 ||
    record.executablePath.includes("\0") ||
    !isHexDigest(record.executableSha256) ||
    typeof record.dataRootId !== "string" ||
    !record.dataRootId ||
    record.dataRootId.length > 512 ||
    typeof record.ownerInstanceId !== "string" ||
    !record.ownerInstanceId ||
    record.ownerInstanceId.length > 512 ||
    !isTimestamp(record.createdAt) ||
    !isTimestamp(record.lastHealthAt) ||
    record.lastHealthAt < record.createdAt
  ) {
    throw new Error("WildBuzzard search connection record is invalid");
  }
  return record as SearchConnection;
}

export function readSearchConnection(): SearchConnection {
  const path = connectionPath();
  if (!isAbsolute(path)) {
    throw new Error("WildBuzzard search connection record path is invalid");
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size < 2 || stat.size > 16_384) {
      throw new Error("WildBuzzard search connection record is invalid");
    }
    if ((stat.mode & 0o077) !== 0) {
      throw new Error("WildBuzzard search connection record is not private");
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error("WildBuzzard search connection record has another owner");
    }
    return validateConnection(
      JSON.parse(readFileSync(descriptor, "utf8")) as unknown
    );
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("WildBuzzard search connection record is invalid");
    }
    throw error;
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

export async function requestSearchService(
  path: string,
  init: RequestInit,
  signal?: AbortSignal
): Promise<Response> {
  const connection = readSearchConnection();
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error("Invalid WildBuzzard search service path");
  }
  const timeout = AbortSignal.timeout(30_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  headers.set("Authorization", `Bearer ${connection.token}`);
  headers.set("Cache-Control", "no-store");
  const endpoint = `http://${connection.address}:${connection.port}${path}`;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      ...init,
      redirect: "error",
      signal: combined,
      headers,
    });
  } catch {
    if (signal?.aborted) {
      throw new Error("WildBuzzard search service request was cancelled");
    }
    if (timeout.aborted) {
      throw new Error("WildBuzzard search service request timed out");
    }
    throw new Error("WildBuzzard search service is unavailable");
  }
  const responseUrl = new URL(response.url);
  if (
    responseUrl.origin !== `http://${connection.address}:${connection.port}` ||
    responseUrl.username ||
    responseUrl.password
  ) {
    await response.body?.cancel().catch(() => {});
    throw new Error(
      "WildBuzzard search service returned an invalid response URL"
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`WildBuzzard search service returned ${response.status}`);
  }
  return response;
}
