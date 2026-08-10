/* SPDX-License-Identifier: AGPL-3.0-or-later */

import assert from "node:assert/strict";
import test from "node:test";
import {
  parseGitHubUrl,
  resolveRefAndPath,
} from "../github.ts";

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
