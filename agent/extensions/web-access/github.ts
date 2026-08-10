/* SPDX-License-Identifier: AGPL-3.0-or-later */
/* Derived from pi-web-access. Copyright (c) 2025 Nico Bailon. */

import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";

const MAX_COMMAND_OUTPUT = 1024 * 1024;
const MAX_REPOSITORY_BYTES = 100 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 2_000;
const MAX_TREES = 10_000;
const MAX_OBJECTS = 100_000;
const COMMAND_TIMEOUT_MS = 45_000;
const TEMP_PREFIX = "wildbuzzard-github-";

export interface GitHubLocation {
  owner: string;
  repository: string;
  kind: "repository" | "tree" | "blob";
  tail: string[];
}

export interface GitHubExtractedContent {
  url: string;
  finalUrl: string;
  title: string;
  content: string;
  error: string | null;
  mimeType: "text/markdown";
  status: number;
  provenance: "github-clone";
  trust: "untrusted";
  ref: string;
  path: string;
  commit: string;
}

function safeSegment(value: string, label: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new Error(`GitHub ${label} contains invalid encoding`);
  }
  if (
    !decoded ||
    decoded === "." ||
    decoded === ".." ||
    decoded.includes("/") ||
    decoded.includes("\\") ||
    decoded.includes("\0")
  ) {
    throw new Error(`GitHub ${label} is invalid`);
  }
  return decoded;
}

export function parseGitHubUrl(raw: string): GitHubLocation | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.username ||
    url.password ||
    url.port
  ) {
    return null;
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2) {
    return null;
  }
  const owner = safeSegment(segments[0], "owner");
  const repository = safeSegment(
    segments[1].replace(/\.git$/i, ""),
    "repository"
  );
  if (
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner) ||
    !/^[A-Za-z0-9._-]{1,100}$/.test(repository) ||
    repository === "." ||
    repository === ".."
  ) {
    return null;
  }
  if (segments.length === 2) {
    return { owner, repository, kind: "repository", tail: [] };
  }
  if (segments[2] !== "tree" && segments[2] !== "blob") {
    return null;
  }
  const tail = segments
    .slice(3)
    .map((segment, index) => safeSegment(segment, `path segment ${index + 1}`));
  if (
    !tail.length ||
    tail.length > 256 ||
    (segments[2] === "blob" && tail.length < 2)
  ) {
    return null;
  }
  return {
    owner,
    repository,
    kind: segments[2],
    tail,
  };
}

function validRef(value: string): boolean {
  return (
    Boolean(value) &&
    value.length <= 255 &&
    /^[A-Za-z0-9._/-]+$/.test(value) &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.startsWith(".") &&
    !value.endsWith(".") &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value.includes("@{") &&
    !value.endsWith(".lock")
  );
}

export function resolveRefAndPath(
  location: GitHubLocation,
  advertisedRefs: string[]
): { ref: string; path: string } {
  if (location.kind === "repository") {
    return { ref: "HEAD", path: "" };
  }
  if (/^[a-f0-9]{40}$/i.test(location.tail[0])) {
    return {
      ref: location.tail[0].toLowerCase(),
      path: location.tail.slice(1).join("/"),
    };
  }
  const refs = new Set(advertisedRefs.filter(validRef));
  for (let length = location.tail.length; length >= 1; length--) {
    const candidate = location.tail.slice(0, length).join("/");
    if (refs.has(candidate)) {
      const path = location.tail.slice(length).join("/");
      if (location.kind === "blob" && !path) {
        throw new Error("A GitHub blob URL must include a file path");
      }
      return { ref: candidate, path };
    }
  }
  throw new Error("Could not resolve the GitHub branch or tag");
}

function requireBundledGit(): string {
  const value = process.env.WILDBUZZARD_BUNDLED_GIT;
  if (!value || !value.startsWith("/") || basename(value) !== "git") {
    throw new Error("WildBuzzard's bundled Git runtime is unavailable");
  }
  const stat = statSync(value);
  if (!stat.isFile() || (stat.mode & 0o111) === 0) {
    throw new Error("WildBuzzard's bundled Git runtime is unavailable");
  }
  return realpathSync(value);
}

function gitEnvironment(git: string): NodeJS.ProcessEnv {
  return {
    PATH: dirname(git),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    GIT_LFS_SKIP_SMUDGE: "1",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
  };
}

const gitConfig = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "credential.helper=",
  "-c",
  "filter.lfs.smudge=",
  "-c",
  "filter.lfs.required=false",
  "-c",
  "submodule.recurse=false",
  "-c",
  "protocol.file.allow=never",
  "-c",
  "protocol.ext.allow=never",
];

function runGit(
  git: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  timeoutMs = COMMAND_TIMEOUT_MS
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(git, [...gitConfig, ...args], {
      cwd,
      detached: true,
      env: gitEnvironment(git),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let closed = false;
    let pendingError: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const terminate = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {}
        killTimer = setTimeout(() => {
          if (!closed) {
            try {
              process.kill(-child.pid!, "SIGKILL");
            } catch {}
          }
        }, 1_000);
        killTimer.unref();
      }
    };
    const finish = (error?: Error, output?: string) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      clearInterval(diskMonitor);
      signal?.removeEventListener("abort", abort);
      if (error) {
        reject(error);
      } else {
        resolvePromise(output ?? "");
      }
    };
    const abort = () => {
      pendingError ??= new Error("GitHub extraction was cancelled");
      terminate();
    };
    const collect = (destination: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_COMMAND_OUTPUT) {
        pendingError ??= new Error("Bundled Git produced too much output");
        terminate();
        return;
      }
      destination.push(chunk);
    };
    const timeout = setTimeout(() => {
      pendingError ??= new Error("Bundled Git operation timed out");
      terminate();
    }, timeoutMs);
    const diskMonitor = setInterval(() => {
      try {
        repositoryUsage(cwd);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("exceeds extraction limits")
        ) {
          pendingError ??= error;
          terminate();
        }
      }
    }, 100);
    diskMonitor.unref();
    child.stdout.on("data", chunk => collect(stdout, chunk));
    child.stderr.on("data", chunk => collect(stderr, chunk));
    child.on("error", () => {
      closed = true;
      finish(new Error("Bundled Git could not be started"));
    });
    child.on("close", code => {
      closed = true;
      if (killTimer) {
        clearTimeout(killTimer);
      }
      if (pendingError) {
        finish(pendingError);
      } else if (code === 0) {
        finish(undefined, Buffer.concat(stdout).toString("utf8"));
      } else {
        finish(new Error(`Bundled Git operation failed with status ${code}`));
      }
    });
    if (signal?.aborted) {
      abort();
    } else {
      signal?.addEventListener("abort", abort, { once: true });
    }
  });
}

function safeRemove(directory: string): void {
  const root = `${realpathSync(tmpdir())}${sep}`;
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Refusing unsafe GitHub extraction cleanup");
  }
  const target = realpathSync(directory);
  if (!target.startsWith(root) || !basename(target).startsWith(TEMP_PREFIX)) {
    throw new Error("Refusing unsafe GitHub extraction cleanup");
  }
  rmSync(target, { recursive: true });
}

function cleanupStaleDirectories(): void {
  const root = realpathSync(tmpdir());
  const now = Date.now();
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(TEMP_PREFIX)) {
      continue;
    }
    const path = join(root, entry.name);
    try {
      const stat = lstatSync(path);
      if (
        !stat.isSymbolicLink() &&
        (stat.mode & 0o077) === 0 &&
        (!process.getuid || stat.uid === process.getuid()) &&
        now - stat.mtimeMs > 60 * 60 * 1_000
      ) {
        safeRemove(path);
      }
    } catch {}
  }
}

function repositoryUsage(root: string): {
  bytes: number;
  files: number;
  trees: number;
} {
  let bytes = 0;
  let files = 0;
  let trees = 0;
  const pending = [root];
  const canonicalRoot = `${realpathSync(root)}${sep}`;
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        files++;
      } else if (stat.isDirectory()) {
        trees++;
        if (trees > MAX_TREES) {
          throw new Error("GitHub repository exceeds extraction limits");
        }
        const canonical = `${realpathSync(path)}${sep}`;
        if (!canonical.startsWith(canonicalRoot)) {
          throw new Error("Repository path escaped the extraction directory");
        }
        pending.push(path);
      } else if (stat.isFile()) {
        files++;
        bytes += stat.size;
      }
      if (files > MAX_FILES * 10 || bytes > MAX_REPOSITORY_BYTES) {
        throw new Error("GitHub repository exceeds extraction limits");
      }
    }
  }
  return { bytes, files, trees };
}

function readBoundedFile(path: string): {
  content: string;
  truncated: boolean;
} {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) {
      return { content: "[non-regular file omitted]", truncated: false };
    }
    const length = Math.min(stat.size, MAX_FILE_BYTES + 1);
    const buffer = Buffer.alloc(length);
    const bytes = readSync(descriptor, buffer, 0, length, 0);
    const value = buffer.subarray(0, bytes);
    if (value.subarray(0, 8_192).includes(0)) {
      return { content: "[binary file omitted]", truncated: stat.size > bytes };
    }
    return {
      content: new TextDecoder("utf-8", { fatal: false }).decode(
        value.subarray(0, MAX_FILE_BYTES)
      ),
      truncated: stat.size > MAX_FILE_BYTES,
    };
  } finally {
    closeSync(descriptor);
  }
}

function checkedTarget(root: string, requestedPath: string): string {
  const target = resolve(root, requestedPath || ".");
  const rootPrefix = `${resolve(root)}${sep}`;
  if (target !== resolve(root) && !target.startsWith(rootPrefix)) {
    throw new Error("GitHub path escaped the repository checkout");
  }
  return target;
}

function renderCheckout(root: string, requestedPath: string): string {
  const target = checkedTarget(root, requestedPath);
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) {
    throw new Error("GitHub extraction does not follow symbolic links");
  }
  const files: string[] = [];
  if (stat.isFile()) {
    files.push(target);
  } else if (stat.isDirectory()) {
    const pending = [target];
    while (pending.length && files.length <= MAX_FILES) {
      const directory = pending.pop()!;
      const entries = readdirSync(directory, { withFileTypes: true }).sort(
        (left, right) => left.name.localeCompare(right.name)
      );
      for (const entry of entries) {
        if (entry.name === ".git") {
          continue;
        }
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          pending.push(path);
        } else if (entry.isFile()) {
          files.push(path);
        }
        if (files.length > MAX_FILES) {
          throw new Error("GitHub checkout contains too many files");
        }
      }
    }
  } else {
    throw new Error("GitHub path is not a regular file or directory");
  }
  const tree = files.map(path => relative(root, path).split(sep).join("/"));
  const sections = [
    `Files (${tree.length}):\n${tree.map(path => `- ${path}`).join("\n")}`,
  ];
  for (const [index, path] of files.entries()) {
    const display = tree[index];
    const file = readBoundedFile(path);
    const fence = file.content.includes("````") ? "`````" : "````";
    sections.push(
      `## ${display}\n\n${fence}\n${file.content}${
        file.truncated ? "\n[truncated]" : ""
      }\n${fence}`
    );
  }
  return sections.join("\n\n");
}

function advertisedRefs(output: string): string[] {
  const refs: string[] = [];
  for (const line of output.split("\n")) {
    const match =
      /^[a-f0-9]{40}\trefs\/(?:heads|tags)\/(.+?)(?:\^\{\})?$/i.exec(line);
    if (match && validRef(match[1]) && !refs.includes(match[1])) {
      refs.push(match[1]);
    }
  }
  return refs;
}

export async function extractGitHub(
  rawUrl: string,
  signal?: AbortSignal
): Promise<GitHubExtractedContent> {
  const location = parseGitHubUrl(rawUrl);
  if (!location) {
    throw new Error(
      "A public github.com repository, tree, or blob URL is required"
    );
  }
  cleanupStaleDirectories();
  const git = requireBundledGit();
  const remote = `https://github.com/${location.owner}/${location.repository}.git`;
  const cleanSourceUrl = `https://github.com/${location.owner}/${location.repository}${
    location.kind === "repository"
      ? ""
      : `/${location.kind}/${location.tail.map(encodeURIComponent).join("/")}`
  }`;
  const directory = mkdtempSync(join(realpathSync(tmpdir()), TEMP_PREFIX));
  chmodSync(directory, 0o700);
  try {
    let refs: string[] = [];
    if (
      location.kind !== "repository" &&
      !/^[a-f0-9]{40}$/i.test(location.tail[0])
    ) {
      refs = advertisedRefs(
        await runGit(
          git,
          ["ls-remote", "--heads", "--tags", remote],
          directory,
          signal
        )
      );
    }
    const selected = resolveRefAndPath(location, refs);
    const checkout = join(directory, "repository");
    await runGit(
      git,
      ["init", "--initial-branch=wildbuzzard", checkout],
      directory,
      signal
    );
    await runGit(git, ["remote", "add", "origin", remote], checkout, signal);
    if (selected.path) {
      await runGit(
        git,
        ["sparse-checkout", "init", "--no-cone"],
        checkout,
        signal
      );
      await runGit(
        git,
        ["sparse-checkout", "set", "--no-cone", "--", selected.path],
        checkout,
        signal
      );
    }
    await runGit(
      git,
      [
        "fetch",
        "--depth=1",
        "--filter=blob:none",
        "--no-tags",
        "--no-recurse-submodules",
        "origin",
        selected.ref,
      ],
      checkout,
      signal
    );
    await runGit(git, ["checkout", "--detach", "FETCH_HEAD"], checkout, signal);
    const commit = (
      await runGit(
        git,
        ["rev-parse", "--verify", "HEAD^{commit}"],
        checkout,
        signal
      )
    )
      .trim()
      .toLowerCase();
    if (!/^[a-f0-9]{40}$/.test(commit)) {
      throw new Error("Bundled Git returned an invalid commit identity");
    }
    if (/^[a-f0-9]{40}$/i.test(selected.ref) && selected.ref !== commit) {
      throw new Error("Bundled Git returned an unexpected commit identity");
    }
    const objectSummary = await runGit(
      git,
      ["count-objects", "-v"],
      checkout,
      signal
    );
    const count = Number(/^count:\s+(\d+)$/m.exec(objectSummary)?.[1] ?? 0);
    const packed = Number(/^in-pack:\s+(\d+)$/m.exec(objectSummary)?.[1] ?? 0);
    if (count + packed > MAX_OBJECTS) {
      throw new Error("GitHub repository contains too many Git objects");
    }
    repositoryUsage(checkout);
    const content = renderCheckout(checkout, selected.path);
    const pinnedPath = selected.path
      ? `/${location.kind}/${commit}/${selected.path
          .split("/")
          .map(encodeURIComponent)
          .join("/")}`
      : `/tree/${commit}`;
    return {
      url: cleanSourceUrl,
      finalUrl: `https://github.com/${location.owner}/${location.repository}${pinnedPath}`,
      title: `${location.owner}/${location.repository}${selected.path ? `: ${selected.path}` : ""}`,
      content,
      error: null,
      mimeType: "text/markdown",
      status: 200,
      provenance: "github-clone",
      trust: "untrusted",
      ref: selected.ref,
      path: selected.path,
      commit,
    };
  } finally {
    safeRemove(directory);
  }
}
