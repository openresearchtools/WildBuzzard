/* SPDX-License-Identifier: AGPL-3.0-or-later */

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
} from "node:fs";
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { request as httpRequest } from "node:http";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

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
  privateSocket: string;
  privateSocketDevice: number;
  privateSocketInode: number;
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
  "privateSocket",
  "privateSocketDevice",
  "privateSocketInode",
  "runtimeVersion",
  "token",
  "version",
]);

const AUTHORIZATION_SCHEME = "WildBuzzard-HMAC-SHA256";
const REQUEST_AUTH_DOMAIN = "wildbuzzard-searxng-request-v1";
const RESPONSE_AUTH_DOMAIN = "wildbuzzard-searxng-response-v1";
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const SOCKET_PATH = /^\/tmp\/wb-sx-g-\d+-[a-f0-9]{24}-[a-f0-9]{32}\/s$/;

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

function hmac(token: string, parts: Array<string | number>): string {
  return createHmac("sha256", token)
    .update(parts.map(String).join("\0"), "utf8")
    .digest("hex");
}

function requestAuthentication(
  token: string,
  method: string,
  path: string,
  body: Buffer,
  nonce: string
): string {
  return hmac(token, [
    REQUEST_AUTH_DOMAIN,
    method,
    path,
    nonce,
    createHash("sha256").update(body).digest("hex"),
  ]);
}

function responseAuthentication(
  token: string,
  nonce: string,
  status: number,
  contentType: string,
  body: Buffer
): string {
  return hmac(token, [
    RESPONSE_AUTH_DOMAIN,
    nonce,
    status,
    contentType,
    createHash("sha256").update(body).digest("hex"),
  ]);
}

function privateSocketIdentity(record: SearchConnection): void {
  if (!SOCKET_PATH.test(record.privateSocket)) {
    throw new Error("WildBuzzard search private socket path is invalid");
  }
  const socket = lstatSync(record.privateSocket, { bigint: false });
  const parent = lstatSync(dirname(record.privateSocket), { bigint: false });
  const expectedUid =
    typeof process.getuid === "function" ? process.getuid() : null;
  if (
    !socket.isSocket() ||
    socket.isSymbolicLink() ||
    (socket.mode & 0o777) !== 0o600 ||
    socket.dev !== record.privateSocketDevice ||
    socket.ino !== record.privateSocketInode ||
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    (parent.mode & 0o777) !== 0o700 ||
    (expectedUid !== null &&
      (socket.uid !== expectedUid || parent.uid !== expectedUid))
  ) {
    throw new Error("WildBuzzard search private socket identity changed");
  }
}

function processIdentity(record: SearchConnection): void {
  let stat: string;
  let executable: string;
  let executableSha256: string;
  try {
    stat = readFileSync(`/proc/${record.pid}/stat`, "ascii");
    executable = readlinkSync(`/proc/${record.pid}/exe`);
    executableSha256 = createHash("sha256")
      .update(readFileSync(`/proc/${record.pid}/exe`))
      .digest("hex");
  } catch {
    throw new Error("WildBuzzard search process is unavailable");
  }
  const closingParenthesis = stat.lastIndexOf(")");
  const fields = stat
    .slice(closingParenthesis + 2)
    .trim()
    .split(/\s+/);
  if (
    closingParenthesis < 0 ||
    fields.length < 20 ||
    fields[19] !== record.processStartTime ||
    executable !== record.executablePath ||
    executableSha256 !== record.executableSha256
  ) {
    throw new Error("WildBuzzard search process identity changed");
  }
}

function requestBody(body: BodyInit | null | undefined): Buffer {
  if (body === undefined || body === null) {
    return Buffer.alloc(0);
  }
  if (typeof body === "string") {
    return Buffer.from(body, "utf8");
  }
  if (body instanceof URLSearchParams) {
    return Buffer.from(body.toString(), "utf8");
  }
  if (body instanceof ArrayBuffer) {
    return Buffer.from(body);
  }
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  throw new Error("Unsupported WildBuzzard search request body");
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
    typeof record.privateSocket !== "string" ||
    !SOCKET_PATH.test(record.privateSocket) ||
    Buffer.byteLength(record.privateSocket) > 107 ||
    !Number.isSafeInteger(record.privateSocketDevice) ||
    Number(record.privateSocketDevice) < 0 ||
    !Number.isSafeInteger(record.privateSocketInode) ||
    Number(record.privateSocketInode) < 1 ||
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
  if (!path.startsWith("/") || path.startsWith("//") || /[\r\n]/.test(path)) {
    throw new Error("Invalid WildBuzzard search service path");
  }
  processIdentity(connection);
  privateSocketIdentity(connection);
  const timeout = AbortSignal.timeout(30_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const method = (init.method ?? "GET").toUpperCase();
  if (!/^(?:GET|POST)$/.test(method)) {
    throw new Error("Invalid WildBuzzard search service method");
  }
  const body = requestBody(init.body);
  const nonce = randomBytes(24).toString("base64url");
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  headers.set(
    "Authorization",
    `${AUTHORIZATION_SCHEME} ${requestAuthentication(
      connection.token,
      method,
      path,
      body,
      nonce
    )}`
  );
  headers.set("Cache-Control", "no-store");
  headers.set("Connection", "close");
  headers.set("Content-Length", String(body.length));
  headers.set("Host", "localhost");
  headers.set("Sec-Fetch-Site", "none");
  headers.set("X-WildBuzzard-Nonce", nonce);
  headers.delete("Transfer-Encoding");
  try {
    const response = await new Promise<Response>((resolve, reject) => {
      const request = httpRequest({
        headers: Object.fromEntries(headers),
        method,
        path,
        signal: combined,
        socketPath: connection.privateSocket,
      });
      request.on("error", reject);
      request.on("response", incoming => {
        const chunks: Buffer[] = [];
        let size = 0;
        incoming.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            incoming.destroy(new Error("response-too-large"));
            return;
          }
          chunks.push(chunk);
        });
        incoming.on("error", reject);
        incoming.on("end", () => {
          try {
            const payload = Buffer.concat(chunks);
            const status = incoming.statusCode ?? 0;
            const contentType = String(incoming.headers["content-type"] ?? "");
            const signature = String(
              incoming.headers["x-wildbuzzard-response-authentication"] ?? ""
            );
            const expected = responseAuthentication(
              connection.token,
              nonce,
              status,
              contentType,
              payload
            );
            const declaredLength = String(
              incoming.headers["content-length"] ?? ""
            );
            if (
              !/^[1-5]\d\d$/.test(String(status)) ||
              !/^\d+$/.test(declaredLength) ||
              Number(declaredLength) !== payload.length ||
              !/^[a-f0-9]{64}$/.test(signature) ||
              !timingSafeEqual(
                Buffer.from(signature, "hex"),
                Buffer.from(expected, "hex")
              )
            ) {
              throw new Error("invalid-private-response");
            }
            const responseHeaders = new Headers();
            for (const [name, value] of Object.entries(incoming.headers)) {
              if (
                value !== undefined &&
                name !== "x-wildbuzzard-response-authentication"
              ) {
                responseHeaders.set(
                  name,
                  Array.isArray(value) ? value.join(", ") : value
                );
              }
            }
            resolve(
              new Response(payload, {
                headers: responseHeaders,
                status,
                statusText: incoming.statusMessage,
              })
            );
          } catch (error) {
            reject(error);
          }
        });
      });
      request.end(body);
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`WildBuzzard search service returned ${response.status}`);
    }
    return response;
  } catch (error) {
    if (
      error instanceof Error &&
      /^WildBuzzard search service returned \d+$/.test(error.message)
    ) {
      throw error;
    }
    if (signal?.aborted) {
      throw new Error("WildBuzzard search service request was cancelled");
    }
    if (timeout.aborted) {
      throw new Error("WildBuzzard search service request timed out");
    }
    throw new Error("WildBuzzard search service is unavailable");
  }
}

export const SearchConnectionTestUtils = {
  requestAuthentication,
  responseAuthentication,
};
