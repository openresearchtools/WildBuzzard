/* SPDX-License-Identifier: AGPL-3.0-or-later */

import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractGitHub, parseGitHubUrl, resolveRefAndPath } from "../github.ts";

test("GitHub URLs reject credentials, lookalike hosts, and encoded traversal", () => {
  assert.equal(
    parseGitHubUrl("https://github.com/mozilla/gecko-dev")?.owner,
    "mozilla"
  );
  assert.equal(
    parseGitHubUrl("https://github.com/mozilla/gecko-dev/")?.repository,
    "gecko-dev"
  );
  assert.equal(
    parseGitHubUrl("https://github.com.evil.test/mozilla/gecko-dev"),
    null
  );
  assert.equal(
    parseGitHubUrl("https://user@github.com/mozilla/gecko-dev"),
    null
  );
  assert.equal(
    parseGitHubUrl(
      "https://github.com/mozilla/gecko-dev/blob/main/%2e%2e/file"
    ),
    null
  );
});

test("GitHub extraction records an immutable commit and strips query secrets", async () => {
  const directory = mkdtempSync(join(tmpdir(), "wildbuzzard-github-test-"));
  const git = join(directory, "git");
  const commit = "0123456789abcdef0123456789abcdef01234567";
  writeFileSync(
    git,
    `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const commands = new Set(["ls-remote", "init", "remote", "sparse-checkout", "fetch", "checkout", "rev-parse", "count-objects"]);
const command = process.argv.slice(2).find(value => commands.has(value));
if (command === "ls-remote") process.stdout.write("${commit}\\trefs/heads/main\\n");
if (command === "init") fs.mkdirSync(process.argv.at(-1), { recursive: true });
if (command === "checkout") fs.writeFileSync(path.join(process.cwd(), "README.md"), "Pinned fixture");
if (command === "rev-parse") process.stdout.write("${commit}\\n");
if (command === "count-objects") process.stdout.write("count: 1\\nin-pack: 0\\n");
`,
    { mode: 0o700 }
  );
  chmodSync(git, 0o700);
  const previous = process.env.WILDBUZZARD_BUNDLED_GIT;
  process.env.WILDBUZZARD_BUNDLED_GIT = git;
  try {
    await assert.rejects(
      extractGitHub(
        "https://github.com/example/repository/blob/main/README.md",
        AbortSignal.abort()
      ),
      /cancelled/
    );
    const result = await extractGitHub(
      "https://github.com/example/repository/blob/main/README.md?access_token=secret#fragment"
    );
    assert.equal(
      result.url,
      "https://github.com/example/repository/blob/main/README.md"
    );
    assert.equal(
      result.finalUrl,
      `https://github.com/example/repository/blob/${commit}/README.md`
    );
    assert.equal(result.commit, commit);
    assert.equal(result.ref, "main");
    assert.equal(result.trust, "untrusted");
    assert.match(result.content, /Pinned fixture/);
    assert.doesNotMatch(JSON.stringify(result), /access_token|secret|fragment/);
    await assert.rejects(
      extractGitHub(
        "https://github.com/example/repository/blob/ffffffffffffffffffffffffffffffffffffffff/README.md"
      ),
      /unexpected commit identity/
    );
  } finally {
    if (previous === undefined) delete process.env.WILDBUZZARD_BUNDLED_GIT;
    else process.env.WILDBUZZARD_BUNDLED_GIT = previous;
    rmSync(directory, { recursive: true });
  }
});

test("GitHub helper failures never expose stderr secrets or local paths", async () => {
  const directory = mkdtempSync(join(tmpdir(), "wildbuzzard-github-test-"));
  const git = join(directory, "git");
  writeFileSync(
    git,
    "#!/bin/sh\nprintf '%s\\n' '/home/user/private Authorization: Bearer secret' >&2\nexit 9\n",
    { mode: 0o700 }
  );
  chmodSync(git, 0o700);
  const previous = process.env.WILDBUZZARD_BUNDLED_GIT;
  process.env.WILDBUZZARD_BUNDLED_GIT = git;
  try {
    await assert.rejects(
      extractGitHub("https://github.com/example/repository"),
      error => {
        assert.equal(
          (error as Error).message,
          "Bundled Git operation failed with status 9"
        );
        return true;
      }
    );
  } finally {
    if (previous === undefined) delete process.env.WILDBUZZARD_BUNDLED_GIT;
    else process.env.WILDBUZZARD_BUNDLED_GIT = previous;
    rmSync(directory, { recursive: true });
  }
});

test("GitHub branch resolution selects the longest slash-containing ref", () => {
  const location = parseGitHubUrl(
    "https://github.com/mozilla/gecko-dev/tree/releases/esr128/browser/components"
  );
  assert.ok(location);
  assert.deepEqual(
    resolveRefAndPath(location, ["releases", "releases/esr128"]),
    { ref: "releases/esr128", path: "browser/components" }
  );
  const blob = parseGitHubUrl(
    "https://github.com/mozilla/gecko-dev/blob/0123456789abcdef0123456789abcdef01234567/README.txt"
  );
  assert.ok(blob);
  assert.deepEqual(resolveRefAndPath(blob, []), {
    ref: "0123456789abcdef0123456789abcdef01234567",
    path: "README.txt",
  });
});
