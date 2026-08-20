import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

export interface WildBuzzardServiceIdentity {
  schema: 1;
  identityId: string;
  pid: number;
  executablePath: string;
  configPath: string;
  dataRoot: string;
  host: string;
  port: number;
  runtimeIdentity: string;
  proof: string;
}

interface IdentityFile {
  schema: 1;
  secret: string;
  runtimeIdentity: string;
}

const O_CLOEXEC = 0x80000;

export function canonicalServiceIdentity(challenge: string, identity: Omit<WildBuzzardServiceIdentity, "proof">): string {
  return JSON.stringify([
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
}

export function verifyServiceIdentityProof(challenge: string, identity: WildBuzzardServiceIdentity, secret: Buffer): boolean {
  const { proof, ...fields } = identity;
  const expected = createHmac("sha256", secret)
    .update(canonicalServiceIdentity(challenge, fields))
    .digest();
  const actual = Buffer.from(proof, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function wildbuzzardServiceIdentity(
  challenge: string | undefined,
  socket: { localAddress?: string; localPort?: number },
  env: NodeJS.ProcessEnv = process.env,
): WildBuzzardServiceIdentity | undefined {
  const path = env["WILDBUZZARD_PI_WEB_IDENTITY_FILE"];
  const configPath = env["PI_WEB_CONFIG"];
  const dataRoot = env["PI_WEB_DATA_DIR"];
  if (path === undefined || configPath === undefined || dataRoot === undefined || challenge === undefined || !/^[a-f0-9]{64}$/u.test(challenge)) {
    return undefined;
  }
  try {
    const parsed = readIdentityFile(path);
    if (!isIdentityFile(parsed)) return undefined;
    const secret = Buffer.from(parsed.secret, "hex");
    const identity = {
      schema: 1 as const,
      identityId: createHash("sha256").update(secret).digest("hex"),
      pid: process.pid,
      executablePath: realpathSync(process.execPath),
      configPath: resolve(configPath),
      dataRoot: resolve(dataRoot),
      host: socket.localAddress === "::ffff:127.0.0.1" ? "127.0.0.1" : (socket.localAddress ?? ""),
      port: socket.localPort ?? 0,
      runtimeIdentity: parsed.runtimeIdentity,
    };
    return {
      ...identity,
      proof: createHmac("sha256", secret).update(canonicalServiceIdentity(challenge, identity)).digest("hex"),
    };
  } catch {
    return undefined;
  }
}

export function readIdentityFile(path: string, afterOpen?: () => void): unknown {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | O_CLOEXEC | constants.O_NOFOLLOW);
    afterOpen?.();
    const info = fstatSync(descriptor);
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.size < 2 || info.size > 4_096 || (process.getuid !== undefined && info.uid !== process.getuid())) return undefined;
    return JSON.parse(readFileSync(descriptor, "utf8"));
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function isIdentityFile(value: unknown): value is IdentityFile {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if (!("schema" in value) || !("secret" in value) || !("runtimeIdentity" in value)) return false;
  const { schema, secret, runtimeIdentity } = value;
  return schema === 1
    && typeof secret === "string"
    && /^[a-f0-9]{64}$/u.test(secret)
    && typeof runtimeIdentity === "string"
    && /^[0-9A-Za-z._-]{1,256}$/u.test(runtimeIdentity);
}
