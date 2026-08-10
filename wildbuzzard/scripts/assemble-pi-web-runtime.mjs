#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  realpath,
  readdir,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { argv } from "node:process";

function options(values) {
  const parsed = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || value === undefined || parsed.has(key)) {
      throw new Error("Invalid runtime assembler arguments");
    }
    parsed.set(key, value);
  }
  return parsed;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function packagePath(packageName) {
  if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(packageName)) {
    throw new Error(`Invalid package name: ${packageName}`);
  }
  return packageName.split("/");
}

async function exists(path) {
  try {
    return (await lstat(path)).isFile();
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      return false;
    }
    throw error;
  }
}

async function directoryEntries(path) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      return [];
    }
    throw error;
  }
}

async function resolveDependency(sourceRoot, from, packageName) {
  let current = from;
  while (true) {
    const manifest = join(
      current,
      "node_modules",
      ...packagePath(packageName),
      "package.json"
    );
    if (await exists(manifest)) {
      return dirname(manifest);
    }
    const parts = relative(sourceRoot, current).split(sep).filter(Boolean);
    const nodeModules = parts.lastIndexOf("node_modules");
    if (nodeModules < 0) {
      break;
    }
    current = join(sourceRoot, ...parts.slice(0, nodeModules));
  }
  throw new Error(`Locked runtime dependency is missing: ${packageName}`);
}

async function rejectLinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      throw new Error(`Runtime dependency contains a symbolic link: ${path}`);
    }
    if (info.isDirectory() && entry.name !== "node_modules") {
      await rejectLinks(path);
    } else if (!info.isDirectory() && !info.isFile()) {
      throw new Error(
        `Runtime dependency contains an unsupported entry: ${path}`
      );
    }
  }
}

function declaredLicenses(value) {
  let values = [];
  if (Array.isArray(value)) {
    values = value;
  } else if (value) {
    values = [value];
  }
  return values
    .map(item => (typeof item === "object" ? item.type || item.name : item))
    .filter(Boolean)
    .map(licenseName => ({ license: { name: String(licenseName) } }));
}

function purl(packageName, version) {
  if (packageName.startsWith("@")) {
    const [scope, unscopedName] = packageName.split("/");
    return `pkg:npm/${encodeURIComponent(scope)}/${encodeURIComponent(unscopedName)}@${encodeURIComponent(version)}`;
  }
  return `pkg:npm/${encodeURIComponent(packageName)}@${encodeURIComponent(version)}`;
}

// eslint-disable-next-line complexity
async function main() {
  const parsed = options(argv.slice(2));
  const required = [
    "commit",
    "cargo-lock-sha256",
    "cargo-metadata",
    "lock-sha256",
    "node-sha256",
    "node-version",
    "output-inventory",
    "output-sbom",
    "output-spdx",
    "pi-web-name",
    "pi-web-version",
    "runtime-root",
    "source-date-epoch",
    "source-root",
    "web-access-lock-sha256",
    "web-access-root",
  ];
  if (required.some(key => !parsed.get(`--${key}`))) {
    throw new Error("Missing runtime assembler argument");
  }
  for (const key of [
    "commit",
    "lock-sha256",
    "node-sha256",
    "cargo-lock-sha256",
    "web-access-lock-sha256",
  ]) {
    const expectedLength = key === "commit" ? 40 : 64;
    if (
      !new RegExp(`^[0-9a-f]{${expectedLength}}$`).test(parsed.get(`--${key}`))
    ) {
      throw new Error(`Invalid ${key}`);
    }
  }
  const sourceRoot = await realpath(parsed.get("--source-root"));
  const runtimeRoot = await realpath(parsed.get("--runtime-root"));
  const manifestBytes = await readFile(join(sourceRoot, "package.json"));
  const lockBytes = await readFile(join(sourceRoot, "package-lock.json"));
  if (sha256(lockBytes) !== parsed.get("--lock-sha256")) {
    throw new Error("Pi Web package lock digest drift");
  }
  const manifest = JSON.parse(manifestBytes);
  const lock = JSON.parse(lockBytes);
  if (
    manifest.name !== parsed.get("--pi-web-name") ||
    manifest.version !== parsed.get("--pi-web-version") ||
    lock.lockfileVersion !== 3 ||
    JSON.stringify(lock.packages?.[""]?.dependencies) !==
      JSON.stringify(manifest.dependencies)
  ) {
    throw new Error("Pi Web package metadata drift");
  }
  const roots = [
    ...Object.keys(manifest.dependencies || {}),
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
  ];
  const pending = [];
  for (const packageName of roots) {
    pending.push(await resolveDependency(sourceRoot, sourceRoot, packageName));
  }
  const selected = new Map();
  while (pending.length) {
    const directory = await realpath(pending.pop());
    const relativePath = relative(sourceRoot, directory).split(sep).join("/");
    if (
      relativePath.startsWith("../") ||
      (!relativePath.startsWith("node_modules/") &&
        relativePath !== "node_modules")
    ) {
      throw new Error("Runtime dependency escaped the locked install tree");
    }
    if (selected.has(relativePath)) {
      continue;
    }
    const bytes = await readFile(join(directory, "package.json"));
    const item = JSON.parse(bytes);
    if (typeof item.name !== "string" || typeof item.version !== "string") {
      throw new Error(`Invalid installed package manifest: ${relativePath}`);
    }
    const locked = lock.packages?.[relativePath];
    if (!locked || locked.version !== item.version) {
      throw new Error(`Installed package differs from lock: ${relativePath}`);
    }
    if (
      locked.resolved &&
      (!locked.resolved.startsWith("https://registry.npmjs.org/") ||
        !String(locked.integrity || "").startsWith("sha512-"))
    ) {
      throw new Error(`Untrusted package resolution: ${relativePath}`);
    }
    selected.set(relativePath, {
      directory,
      integrity: locked.integrity || null,
      licenses: declaredLicenses(item.license || item.licenses),
      manifestSha256: sha256(bytes),
      name: item.name,
      resolved: locked.resolved || null,
      version: item.version,
    });
    const dependencies = {
      ...(item.dependencies || {}),
      ...(item.optionalDependencies || {}),
      ...(item.peerDependencies || {}),
    };
    for (const packageName of Object.keys(dependencies)) {
      const optional =
        Object.hasOwn(item.optionalDependencies || {}, packageName) ||
        item.peerDependenciesMeta?.[packageName]?.optional === true;
      try {
        pending.push(
          await resolveDependency(sourceRoot, directory, packageName)
        );
      } catch (error) {
        if (!optional) {
          throw error;
        }
      }
    }
  }
  for (const [relativePath, item] of [...selected].sort()) {
    await rejectLinks(item.directory);
    const destination = join(runtimeRoot, ...relativePath.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await cp(item.directory, destination, {
      recursive: true,
      force: false,
      errorOnExist: true,
      filter: source => {
        const nested = relative(item.directory, source).split(sep);
        return nested[0] !== "node_modules";
      },
    });
  }
  const packages = [...selected.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, item]) => ({
      path,
      name: item.name,
      version: item.version,
      resolved: item.resolved,
      integrity: item.integrity,
      manifestSha256: item.manifestSha256,
    }));
  const webAccessRoot = await realpath(parsed.get("--web-access-root"));
  const webAccessLockBytes = await readFile(
    join(webAccessRoot, "package-lock.json")
  );
  if (sha256(webAccessLockBytes) !== parsed.get("--web-access-lock-sha256")) {
    throw new Error("Web-access package lock digest drift");
  }
  const webAccessLock = JSON.parse(webAccessLockBytes);
  const webAccessPackages = [];
  const pendingModules = [join(webAccessRoot, "node_modules")];
  while (pendingModules.length) {
    const modules = pendingModules.pop();
    for (const entry of await directoryEntries(modules)) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) {
        continue;
      }
      if (entry.name.startsWith("@")) {
        for (const scoped of await readdir(join(modules, entry.name), {
          withFileTypes: true,
        })) {
          if (scoped.isDirectory()) {
            pendingModules.push(
              join(modules, entry.name, scoped.name, "node_modules")
            );
          }
          if (scoped.isDirectory()) {
            await addWebPackage(join(modules, entry.name, scoped.name));
          }
        }
      } else {
        await addWebPackage(join(modules, entry.name));
        pendingModules.push(join(modules, entry.name, "node_modules"));
      }
    }
  }
  async function addWebPackage(directory) {
    if (!(await exists(join(directory, "package.json")))) {
      return;
    }
    await rejectLinks(directory);
    const path = relative(webAccessRoot, directory).split(sep).join("/");
    const bytes = await readFile(join(directory, "package.json"));
    const item = JSON.parse(bytes);
    const locked = webAccessLock.packages?.[path];
    if (!locked || locked.version !== item.version || locked.dev === true) {
      throw new Error(`Shipped web-access package differs from lock: ${path}`);
    }
    if (
      locked.resolved &&
      (!locked.resolved.startsWith("https://registry.npmjs.org/") ||
        !String(locked.integrity || "").startsWith("sha512-"))
    ) {
      throw new Error(`Untrusted web-access package resolution: ${path}`);
    }
    webAccessPackages.push({
      path: `seed/web-access/${path}`,
      name: item.name,
      version: item.version,
      resolved: locked.resolved || null,
      integrity: locked.integrity || null,
      manifestSha256: sha256(bytes),
      licenses: declaredLicenses(item.license || item.licenses),
    });
  }
  webAccessPackages.sort((left, right) => left.path.localeCompare(right.path));
  const cargoMetadata = JSON.parse(
    await readFile(parsed.get("--cargo-metadata"), "utf8")
  );
  const cargoPackages = (cargoMetadata.packages || [])
    .map(item => ({
      name: item.name,
      version: item.version,
      source: item.source || "workspace",
      license: item.license || "NOASSERTION",
    }))
    .sort((left, right) =>
      `${left.name}@${left.version}`.localeCompare(
        `${right.name}@${right.version}`
      )
    );
  const inventory = {
    schema: 1,
    piWebCommit: parsed.get("--commit"),
    packageLockSha256: parsed.get("--lock-sha256"),
    packages,
    webAccessPackageLockSha256: parsed.get("--web-access-lock-sha256"),
    webAccessPackages: webAccessPackages.map(
      ({ licenses: _licenses, ...item }) => item
    ),
    cargoLockSha256: parsed.get("--cargo-lock-sha256"),
    cargoPackages,
  };
  await writeFile(
    parsed.get("--output-inventory"),
    `${JSON.stringify(inventory, null, 2)}\n`,
    { mode: 0o644 }
  );
  const components = packages.map(item => {
    const selectedItem = selected.get(item.path);
    const component = {
      type: "library",
      name: item.name,
      version: item.version,
      purl: purl(item.name, item.version),
      properties: [
        { name: "wildbuzzard:installed-path", value: item.path },
        {
          name: "wildbuzzard:package-manifest-sha256",
          value: item.manifestSha256,
        },
      ],
    };
    if (selectedItem.licenses.length) {
      component.licenses = selectedItem.licenses;
    }
    if (item.integrity) {
      component.properties.push({
        name: "wildbuzzard:npm-integrity",
        value: item.integrity,
      });
    }
    return component;
  });
  for (const item of webAccessPackages) {
    components.push({
      type: "library",
      name: item.name,
      version: item.version,
      purl: purl(item.name, item.version),
      ...(item.licenses.length ? { licenses: item.licenses } : {}),
      properties: [
        { name: "wildbuzzard:installed-path", value: item.path },
        {
          name: "wildbuzzard:package-manifest-sha256",
          value: item.manifestSha256,
        },
        ...(item.integrity
          ? [{ name: "wildbuzzard:npm-integrity", value: item.integrity }]
          : []),
      ],
    });
  }
  for (const item of cargoPackages) {
    components.push({
      type: "library",
      name: item.name,
      version: item.version,
      purl: `pkg:cargo/${encodeURIComponent(item.name)}@${encodeURIComponent(item.version)}`,
      licenses: [{ license: { name: item.license } }],
      properties: [{ name: "wildbuzzard:cargo-source", value: item.source }],
    });
  }
  const sourceDateEpoch = Number(parsed.get("--source-date-epoch"));
  if (!Number.isSafeInteger(sourceDateEpoch) || sourceDateEpoch <= 0) {
    throw new Error("Invalid source-date-epoch");
  }
  const application = {
    type: "application",
    name: parsed.get("--pi-web-name"),
    version: parsed.get("--pi-web-version"),
    purl: purl(parsed.get("--pi-web-name"), parsed.get("--pi-web-version")),
    licenses: [{ license: { id: "MIT" } }],
    properties: [
      { name: "wildbuzzard:commit", value: parsed.get("--commit") },
      {
        name: "wildbuzzard:package-lock-sha256",
        value: parsed.get("--lock-sha256"),
      },
    ],
  };
  const node = {
    type: "framework",
    name: "Node.js",
    version: parsed.get("--node-version"),
    purl: `pkg:generic/node@${parsed.get("--node-version")}`,
    licenses: [{ license: { id: "MIT" } }],
    hashes: [{ alg: "SHA-256", content: parsed.get("--node-sha256") }],
  };
  const serial = sha256(
    [
      parsed.get("--commit"),
      parsed.get("--lock-sha256"),
      ...components.map(component => `${component.purl}\0${component.version}`),
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
    components: [node, ...components],
  };
  await writeFile(
    parsed.get("--output-sbom"),
    `${JSON.stringify(sbom, null, 2)}\n`,
    { mode: 0o644 }
  );
  const allSpdxPackages = [
    ...packages.map(item => ({ ...item, ecosystem: "npm" })),
    ...webAccessPackages.map(item => ({ ...item, ecosystem: "npm" })),
    ...cargoPackages.map(item => ({
      ...item,
      ecosystem: "cargo",
      resolved: item.source,
    })),
  ];
  const spdxPackages = allSpdxPackages.map((item, index) => ({
    SPDXID: `SPDXRef-Package-${index + 1}`,
    name: item.name,
    versionInfo: item.version,
    downloadLocation: item.resolved || "NOASSERTION",
    filesAnalyzed: false,
    licenseConcluded: "NOASSERTION",
    licenseDeclared: "NOASSERTION",
    copyrightText: "NOASSERTION",
    externalRefs: [
      {
        referenceCategory: "PACKAGE-MANAGER",
        referenceType: "purl",
        referenceLocator:
          item.ecosystem === "cargo"
            ? `pkg:cargo/${encodeURIComponent(item.name)}@${encodeURIComponent(item.version)}`
            : purl(item.name, item.version),
      },
    ],
  }));
  const spdx = {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `${parsed.get("--pi-web-name")}-${parsed.get("--pi-web-version")}`,
    documentNamespace: `https://wildbuzzard.invalid/spdx/pi-web/${serial}`,
    creationInfo: {
      created: new Date(sourceDateEpoch * 1000).toISOString(),
      creators: ["Tool: WildBuzzard Pi Web runtime assembler"],
    },
    packages: [
      {
        SPDXID: "SPDXRef-Package-PiWeb",
        name: parsed.get("--pi-web-name"),
        versionInfo: parsed.get("--pi-web-version"),
        downloadLocation: "NOASSERTION",
        filesAnalyzed: false,
        licenseConcluded: "MIT",
        licenseDeclared: "MIT",
        copyrightText: "NOASSERTION",
        externalRefs: [
          {
            referenceCategory: "PACKAGE-MANAGER",
            referenceType: "purl",
            referenceLocator: purl(
              parsed.get("--pi-web-name"),
              parsed.get("--pi-web-version")
            ),
          },
        ],
      },
      {
        SPDXID: "SPDXRef-Package-Node",
        name: "Node.js",
        versionInfo: parsed.get("--node-version"),
        downloadLocation: "NOASSERTION",
        filesAnalyzed: false,
        licenseConcluded: "MIT",
        licenseDeclared: "MIT",
        copyrightText: "NOASSERTION",
        checksums: [
          {
            algorithm: "SHA256",
            checksumValue: parsed.get("--node-sha256"),
          },
        ],
      },
      ...spdxPackages,
    ],
    relationships: [
      {
        spdxElementId: "SPDXRef-DOCUMENT",
        relationshipType: "DESCRIBES",
        relatedSpdxElement: "SPDXRef-Package-PiWeb",
      },
      {
        spdxElementId: "SPDXRef-Package-PiWeb",
        relationshipType: "DEPENDS_ON",
        relatedSpdxElement: "SPDXRef-Package-Node",
      },
      ...spdxPackages.map(item => ({
        spdxElementId: "SPDXRef-Package-PiWeb",
        relationshipType: "DEPENDS_ON",
        relatedSpdxElement: item.SPDXID,
      })),
    ],
  };
  await writeFile(
    parsed.get("--output-spdx"),
    `${JSON.stringify(spdx, null, 2)}\n`,
    { mode: 0o644 }
  );
}

await main();
