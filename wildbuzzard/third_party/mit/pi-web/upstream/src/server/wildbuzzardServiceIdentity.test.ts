import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readIdentityFile, verifyServiceIdentityProof, wildbuzzardServiceIdentity } from "./wildbuzzardServiceIdentity.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(secret = "11".repeat(32), runtimeIdentity = "runtime-current") {
  const directory = mkdtempSync(join(tmpdir(), "pi-web-identity-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "identity.json");
  writeFileSync(path, JSON.stringify({ schema: 1, secret, runtimeIdentity }));
  chmodSync(path, 0o600);
  return {
    path,
    env: {
      WILDBUZZARD_PI_WEB_IDENTITY_FILE: path,
      PI_WEB_CONFIG: join(directory, "config.json"),
      PI_WEB_DATA_DIR: join(directory, "data"),
    },
  };
}

describe("WildBuzzard service identity", () => {
  it("preserves generic health behavior when identity is not configured", () => {
    expect(wildbuzzardServiceIdentity("aa".repeat(32), { localAddress: "127.0.0.1", localPort: 54321 }, {})).toBeUndefined();
  });

  it("signs a fresh challenge and exact service fields without exposing the secret", () => {
    const value = fixture();
    const challenge = "aa".repeat(32);
    const identity = wildbuzzardServiceIdentity(challenge, { localAddress: "127.0.0.1", localPort: 54321 }, value.env);
    if (identity === undefined) throw new Error("Missing service identity");
    expect(identity).toMatchObject({ schema: 1, host: "127.0.0.1", port: 54321, runtimeIdentity: "runtime-current" });
    expect(JSON.stringify(identity)).not.toContain("11".repeat(32));
    expect(verifyServiceIdentityProof(challenge, identity, Buffer.from("11".repeat(32), "hex"))).toBe(true);
  });

  it("rejects symlinks and reads from one descriptor across a path swap", () => {
    const value = fixture();
    const symlink = `${value.path}.link`;
    symlinkSync(value.path, symlink);
    expect(readIdentityFile(symlink)).toBeUndefined();
    const replacement = `${value.path}.replacement`;
    const moved = `${value.path}.moved`;
    writeFileSync(replacement, JSON.stringify({ schema: 1, secret: "33".repeat(32), runtimeIdentity: "replacement" }), { mode: 0o600 });
    const read = readIdentityFile(value.path, () => {
      renameSync(value.path, moved);
      renameSync(replacement, value.path);
    });
    expect(read).toEqual({ schema: 1, secret: "11".repeat(32), runtimeIdentity: "runtime-current" });
  });

  it("rejects missing challenges, insecure files, and malformed secrets", () => {
    const value = fixture("invalid");
    expect(wildbuzzardServiceIdentity(undefined, { localPort: 54321 }, value.env)).toBeUndefined();
    expect(wildbuzzardServiceIdentity("aa".repeat(32), { localPort: 54321 }, value.env)).toBeUndefined();
    writeFileSync(value.path, JSON.stringify({ schema: 1, secret: "22".repeat(32), runtimeIdentity: "runtime-current" }));
    chmodSync(value.path, 0o644);
    expect(wildbuzzardServiceIdentity("aa".repeat(32), { localPort: 54321 }, value.env)).toBeUndefined();
  });

  it("fails verification for a wrong secret, stale challenge, or changed signed field", () => {
    const value = fixture();
    const challenge = "aa".repeat(32);
    const identity = wildbuzzardServiceIdentity(challenge, { localAddress: "127.0.0.1", localPort: 54321 }, value.env);
    if (identity === undefined) throw new Error("Missing service identity");
    expect(verifyServiceIdentityProof(challenge, identity, Buffer.from("22".repeat(32), "hex"))).toBe(false);
    expect(verifyServiceIdentityProof("bb".repeat(32), identity, Buffer.from("11".repeat(32), "hex"))).toBe(false);
    for (const patch of [
      { port: 54322 },
      { runtimeIdentity: "runtime-stale" },
      { configPath: "/wrong/config" },
      { dataRoot: "/wrong/data" },
    ]) {
      expect(verifyServiceIdentityProof(challenge, { ...identity, ...patch }, Buffer.from("11".repeat(32), "hex"))).toBe(false);
    }
  });
});
