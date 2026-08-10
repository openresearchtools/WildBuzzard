/* SPDX-License-Identifier: AGPL-3.0-or-later */

import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

function validateConnection(value: unknown): SearchConnection {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("WildBuzzard search connection record is invalid");
  }
  const record = value as Partial<SearchConnection>;
  if (
    record.version !== 1 ||
    record.protocolVersion !== 1 ||
    record.address !== "127.0.0.1" ||
    !Number.isInteger(record.port) ||
    Number(record.port) < 1024 ||
    Number(record.port) > 65535 ||
    typeof record.token !== "string" ||
    record.token.length < 32 ||
    record.token.length > 512 ||
    !Number.isInteger(record.pid) ||
    Number(record.pid) < 1 ||
    typeof record.processStartTime !== "string" ||
    !/^\d+$/.test(record.processStartTime) ||
    typeof record.runtimeVersion !== "string" ||
    !record.runtimeVersion ||
    typeof record.executablePath !== "string" ||
    !record.executablePath.startsWith("/") ||
    !isHexDigest(record.executableSha256) ||
    typeof record.dataRootId !== "string" ||
    !record.dataRootId ||
    typeof record.ownerInstanceId !== "string" ||
    !record.ownerInstanceId ||
    !Number.isFinite(record.createdAt) ||
    !Number.isFinite(record.lastHealthAt)
  ) {
    throw new Error("WildBuzzard search connection record is invalid");
  }
  return record as SearchConnection;
}

export function readSearchConnection(): SearchConnection {
  const path = connectionPath();
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
  let response: Response;
  try {
    response = await fetch(
      `http://${connection.address}:${connection.port}${path}`,
      {
        ...init,
        redirect: "error",
        signal: combined,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${connection.token}`,
          "Cache-Control": "no-store",
          ...(init.headers ?? {}),
        },
      }
    );
  } catch (error) {
    if (combined.aborted) {
      throw new Error(
        "WildBuzzard search service request was cancelled or timed out"
      );
    }
    throw new Error(
      `WildBuzzard search service is unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.text()).slice(0, 500).trim();
    } catch {}
    throw new Error(
      `WildBuzzard search service returned ${response.status}${
        detail ? `: ${detail}` : ""
      }`
    );
  }
  return response;
}
