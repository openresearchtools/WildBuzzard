#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] || "");
if (!process.argv[2] || !fs.statSync(root).isDirectory()) {
  throw new Error("Pi Web source directory is required");
}

const lock = JSON.parse(
  fs.readFileSync(path.join(root, "package-lock.json"), "utf8")
);
if (lock.lockfileVersion !== 3 || typeof lock.packages !== "object") {
  throw new Error("Pi Web requires a package-lock v3 installed-tree inventory");
}

const expected = new Map(
  Object.entries(lock.packages).filter(
    ([relative, metadata]) =>
      relative.includes("node_modules/") &&
      metadata &&
      typeof metadata.version === "string" &&
      metadata.link !== true
  )
);
const actual = new Set();

function packageName(relative) {
  const segments = relative.split("/");
  const index = segments.lastIndexOf("node_modules");
  if (index < 0 || index + 1 >= segments.length) {
    throw new Error(`Invalid package-lock path: ${relative}`);
  }
  return segments[index + 1].startsWith("@")
    ? `${segments[index + 1]}/${segments[index + 2]}`
    : segments[index + 1];
}

function inspectPackage(directory) {
  const relative = path.relative(root, directory).split(path.sep).join("/");
  const metadata = expected.get(relative);
  if (!metadata) {
    throw new Error(`Installed package is absent from package-lock.json: ${relative}`);
  }
  const status = fs.lstatSync(directory);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error(`Installed package is not a real directory: ${relative}`);
  }
  const manifest = JSON.parse(
    fs.readFileSync(path.join(directory, "package.json"), "utf8")
  );
  if (
    manifest.name !== packageName(relative) ||
    manifest.version !== metadata.version
  ) {
    throw new Error(
      `Installed package identity differs from package-lock.json: ${relative}`
    );
  }
  actual.add(relative);
  inspectNodeModules(path.join(directory, "node_modules"));
}

function inspectNodeModules(directory) {
  if (!fs.existsSync(directory)) {
    return;
  }
  const status = fs.lstatSync(directory);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error(`Invalid node_modules directory: ${directory}`);
  }
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    const target = path.join(directory, entry.name);
    if (entry.name.startsWith("@")) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error(`Invalid installed package scope: ${target}`);
      }
      for (const scoped of fs.readdirSync(target, { withFileTypes: true })) {
        if (!scoped.isDirectory() || scoped.isSymbolicLink()) {
          throw new Error(`Invalid installed scoped package: ${scoped.name}`);
        }
        inspectPackage(path.join(target, scoped.name));
      }
      continue;
    }
    inspectPackage(target);
  }
}

inspectNodeModules(path.join(root, "node_modules"));
for (const [relative, metadata] of expected) {
  if (!actual.has(relative) && metadata.optional !== true) {
    throw new Error(`Required locked package is not installed: ${relative}`);
  }
}

process.stdout.write(
  `${JSON.stringify({ installedPackages: actual.size, lockPackages: expected.size })}\n`
);
