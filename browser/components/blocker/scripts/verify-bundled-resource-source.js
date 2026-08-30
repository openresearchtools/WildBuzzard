#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { pathToFileURL } = require("node:url");
const {
  buildScriptletResources,
  buildUblockRedirectResources,
} = require("./update-bundled-assets.js");

function render(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function verifyFile(pathname, value) {
  const actual = await fs.readFile(pathname, "utf8");
  const expected = render(value);
  if (actual === expected) {
    return null;
  }
  const digest = input => createHash("sha256").update(input).digest("hex");
  return `${pathname} (expected ${digest(expected)}, found ${digest(actual)})`;
}

async function main() {
  const [uBlockRoot, braveResourcesPath, assetsRoot, mode] =
    process.argv.slice(2);
  if (!uBlockRoot || !braveResourcesPath || !assetsRoot) {
    throw new Error(
      "usage: verify-bundled-resource-source.js UBLOCK_ROOT BRAVE_RESOURCES ASSETS_ROOT"
    );
  }

  const braveResources = JSON.parse(
    await fs.readFile(braveResourcesPath, "utf8")
  );
  if (!Array.isArray(braveResources)) {
    throw new Error("Brave resources source is not an array");
  }

  const redirectResources = await buildUblockRedirectResources(uBlockRoot);
  const mismatches = [];
  const resourcesPath = path.join(assetsRoot, "resources.json");
  const resources = braveResources.concat(redirectResources);

  const scriptletModule = path.join(
    uBlockRoot,
    "src",
    "js",
    "resources",
    "scriptlets.js"
  );
  const { builtinScriptlets } = await import(pathToFileURL(scriptletModule).href);
  if (!Array.isArray(builtinScriptlets)) {
    throw new Error("uBlock scriptlets source is not an array");
  }
  const scriptletsPath = path.join(assetsRoot, "ubo-scriptlets.json");
  const scriptlets = buildScriptletResources(builtinScriptlets);
  if (mode === "--write") {
    await fs.mkdir(assetsRoot, { recursive: true });
    await fs.writeFile(resourcesPath, render(resources));
    await fs.writeFile(scriptletsPath, render(scriptlets));
    return;
  }
  if (mode) {
    throw new Error(`unknown mode: ${mode}`);
  }
  const resourcesMismatch = await verifyFile(resourcesPath, resources);
  if (resourcesMismatch) {
    mismatches.push(resourcesMismatch);
  }
  const scriptletsMismatch = await verifyFile(scriptletsPath, scriptlets);
  if (scriptletsMismatch) {
    mismatches.push(scriptletsMismatch);
  }
  if (mismatches.length) {
    throw new Error(
      `bundled resources differ from locked upstream source: ${mismatches.join(
        ", "
      )}`
    );
  }
}

main().catch(error => {
  console.error(`error: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
