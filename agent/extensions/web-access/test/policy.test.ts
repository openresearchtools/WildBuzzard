/* SPDX-License-Identifier: AGPL-3.0-or-later */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceRoot =
  process.env.WILDBUZZARD_SOURCE_ROOT || join(root, "..", "..", "..");

test("web-access has only the audited deterministic dependency surface", () => {
  const packageJson = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8")
  ) as { dependencies: Record<string, string> };
  assert.deepEqual(Object.keys(packageJson.dependencies).sort(), [
    "@earendil-works/pi-ai",
    "@mozilla/readability",
    "linkedom",
    "p-limit",
    "promise.try",
    "turndown",
    "typebox",
    "unpdf",
  ]);
  const bannedModules =
    /(?:exa|brave|firecrawl|gemini|jina|kagi|ollama|parallel|perplexity|search1api|tavily|tinyfish)/i;
  assert.deepEqual(
    readdirSync(root).filter(
      name => name.endsWith(".ts") && bannedModules.test(name)
    ),
    []
  );
});

test("Pi tool schemas reject undeclared properties and discover bundled skills", () => {
  const source = readFileSync(join(root, "index.ts"), "utf8");
  assert.equal(source.match(/additionalProperties:\s*false/g)?.length, 5);
  assert.match(source, /pi\.on\("resources_discover"/);
  assert.match(
    source,
    /skillPaths:\s*\[join\(extensionDirectory, "skills"\)\]/
  );
  assert.doesNotMatch(source, /truthVerdict/);
});

test("Pi runtime bundles, validates, and attributes the web-access extension", () => {
  const buildScript = readFileSync(
    join(sourceRoot, "wildbuzzard", "scripts", "build-pi-web-runtime.sh"),
    "utf8"
  );
  assert.match(buildScript, /seed\/web-access/);
  assert.match(buildScript, /web-access-validation\.log/);
  assert.match(buildScript, /seed\/web-access\/LICENSE\.pi-web-access/);
  assert.match(buildScript, /seed\/web-access\/UPSTREAM\.toml/);
});

test("credential-bearing documents do not receive durable response handles", () => {
  const source = readFileSync(join(root, "index.ts"), "utf8");
  assert.match(source, /hasSensitiveUrlCredentials\(document\.url\)/);
  assert.match(source, /hasSensitiveUrlCredentials\(document\.finalUrl\)/);
  assert.match(source, /persistence:\s*"suppressed-sensitive-url"/);
  assert.match(source, /responseId:\s*null/);
});
