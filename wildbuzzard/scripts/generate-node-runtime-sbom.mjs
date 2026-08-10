#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { argv } from "node:process";

function argumentsMap(values) {
  const result = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const option = values[index];
    const value = values[index + 1];
    if (!option?.startsWith("--") || value === undefined) {
      throw new Error("Invalid SBOM generator arguments");
    }
    result.set(option.slice(2), value);
  }
  return result;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function compare(left, right) {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

function packagePurl(packageId, version) {
  if (packageId.startsWith("@")) {
    const [scope, packageName] = packageId.split("/");
    return `pkg:npm/${encodeURIComponent(scope)}/${encodeURIComponent(packageName)}@${encodeURIComponent(version)}`;
  }
  return `pkg:npm/${encodeURIComponent(packageId)}@${encodeURIComponent(version)}`;
}

function declaredLicenses(value) {
  let values = [];
  if (Array.isArray(value)) {
    values = value;
  } else if (value) {
    values = [value];
  }
  return values
    .map(item => {
      if (typeof item !== "object") {
        return String(item);
      }
      return String(item.type || item.name || "");
    })
    .filter(Boolean)
    .map(licenseName => ({ license: { name: licenseName } }));
}

async function childDirectories(directory) {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort();
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      return [];
    }
    throw error;
  }
}

async function packageDirectories(nodeModules) {
  const pending = [nodeModules];
  const result = [];
  while (pending.length) {
    const modules = pending.pop();
    for (const entryName of await childDirectories(modules)) {
      if (entryName === ".bin") {
        continue;
      }
      if (entryName.startsWith("@")) {
        const scope = join(modules, entryName);
        for (const child of await childDirectories(scope)) {
          const directory = join(scope, child);
          result.push(directory);
          pending.push(join(directory, "node_modules"));
        }
        continue;
      }
      const directory = join(modules, entryName);
      result.push(directory);
      pending.push(join(directory, "node_modules"));
    }
  }
  return result.sort();
}

async function main() {
  const options = argumentsMap(argv.slice(2));
  const required = [
    "app-root",
    "commit",
    "node-archive-sha256",
    "node-version",
    "output",
    "package-lock-sha256",
    "source-date-epoch",
    "source-sha256",
    "webtorrent-commit",
  ];
  if (required.some(option => !options.get(option))) {
    throw new Error("Missing SBOM generator argument");
  }
  for (const option of [
    "node-archive-sha256",
    "package-lock-sha256",
    "source-sha256",
  ]) {
    if (!/^[0-9a-f]{64}$/.test(options.get(option))) {
      throw new Error(`Invalid ${option}`);
    }
  }
  for (const option of ["commit", "webtorrent-commit"]) {
    if (!/^[0-9a-f]{40}$/.test(options.get(option))) {
      throw new Error(`Invalid ${option}`);
    }
  }
  if (!/^\d+(?:\.\d+){2}$/.test(options.get("node-version"))) {
    throw new Error("Invalid node-version");
  }
  const sourceDateEpoch = Number(options.get("source-date-epoch"));
  if (!Number.isSafeInteger(sourceDateEpoch) || sourceDateEpoch <= 0) {
    throw new Error("Invalid source-date-epoch");
  }
  const appRoot = options.get("app-root");
  const lockBytes = await readFile(join(appRoot, "package-lock.json"));
  if (sha256(lockBytes) !== options.get("package-lock-sha256")) {
    throw new Error("The package lock digest does not match");
  }
  const packages = new Map();
  for (const directory of await packageDirectories(
    join(appRoot, "node_modules")
  )) {
    const manifestPath = join(directory, "package.json");
    let bytes;
    let manifest;
    try {
      bytes = await readFile(manifestPath);
      manifest = JSON.parse(bytes);
    } catch {
      continue;
    }
    if (
      typeof manifest.name !== "string" ||
      typeof manifest.version !== "string"
    ) {
      continue;
    }
    const purl = packagePurl(manifest.name, manifest.version);
    const manifestSha256 = sha256(bytes);
    const installedPath = relative(appRoot, directory).split(sep).join("/");
    const existing = packages.get(purl);
    if (existing) {
      if (existing.manifestSha256 !== manifestSha256) {
        throw new Error(`Conflicting installed package manifests for ${purl}`);
      }
      existing.paths.push(installedPath);
      continue;
    }
    packages.set(purl, {
      licenses: declaredLicenses(manifest.license || manifest.licenses),
      manifestSha256,
      name: manifest.name,
      paths: [installedPath],
      purl,
      version: manifest.version,
    });
  }
  const components = [...packages.values()].map(item => {
    const component = {
      type: "library",
      name: item.name,
      version: item.version,
      purl: item.purl,
      properties: [
        {
          name: "wildbuzzard:installed-package-paths",
          value: JSON.stringify(item.paths.sort()),
        },
        {
          name: "wildbuzzard:package-manifest-sha256",
          value: item.manifestSha256,
        },
      ],
    };
    if (item.licenses.length) {
      component.licenses = item.licenses;
    }
    return component;
  });
  if (!components.length) {
    throw new Error("The production dependency tree is empty");
  }
  const application = {
    type: "application",
    name: "wildbuzzard-torrent-runtime",
    version: "1.0.0",
    hashes: [{ alg: "SHA-256", content: options.get("source-sha256") }],
    licenses: [{ license: { id: "AGPL-3.0-or-later" } }],
    properties: [
      { name: "wildbuzzard:commit", value: options.get("commit") },
      {
        name: "wildbuzzard:package-lock-sha256",
        value: options.get("package-lock-sha256"),
      },
      {
        name: "wildbuzzard:webtorrent-commit",
        value: options.get("webtorrent-commit"),
      },
    ],
  };
  const node = {
    type: "framework",
    name: "Node.js",
    version: options.get("node-version"),
    purl: `pkg:generic/node@${options.get("node-version")}`,
    hashes: [
      {
        alg: "SHA-256",
        content: options.get("node-archive-sha256"),
      },
    ],
    licenses: [{ license: { id: "MIT" } }],
  };
  const listed = [node, ...components].sort((left, right) =>
    compare(left.purl || left.name, right.purl || right.name)
  );
  const serial = sha256(
    [
      options.get("source-sha256"),
      options.get("package-lock-sha256"),
      ...listed.map(item => `${item.purl || item.name}\0${item.version}`),
    ].join("\n")
  );
  const sbom = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    serialNumber: `urn:uuid:${serial.slice(0, 8)}-${serial.slice(8, 12)}-5${serial.slice(13, 16)}-8${serial.slice(17, 20)}-${serial.slice(20, 32)}`,
    version: 1,
    metadata: {
      timestamp: new Date(sourceDateEpoch * 1000).toISOString(),
      component: application,
    },
    components: listed,
  };
  await writeFile(options.get("output"), `${JSON.stringify(sbom, null, 2)}\n`, {
    mode: 0o644,
  });
}

await main();
