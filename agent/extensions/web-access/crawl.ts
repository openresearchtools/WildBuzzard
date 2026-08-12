/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { gunzipSync } from "node:zlib";
import { parseHTML } from "linkedom";
import pLimit from "p-limit";
import {
  EXTRACTED_NETWORK_BYTES,
  fetchWithGecko,
  readableHTML,
  type ExtractedContent,
} from "./extract.ts";
import {
  MAX_GECKO_RENDER_BYTES,
  MAX_GECKO_RENDER_REDIRECTS,
} from "./gecko-client.ts";

export interface CrawlInput {
  url: string;
  includePaths?: string[];
  excludePaths?: string[];
  maxDepth?: number;
  limit?: number;
  timeoutMs?: number;
  maxBytes?: number;
  maxConcurrency?: number;
  allowSubdomains?: boolean;
  allowExternalLinks?: boolean;
  robots?: "respect" | "ignore";
  sitemap?: "include" | "skip" | "only";
  ignoreQueryParameters?: boolean;
  render?: "auto" | "never" | "always";
}

export interface CrawlResult {
  rootUrl: string;
  documents: ExtractedContent[];
  errors: Array<{ url: string; error: string }>;
  visited: number;
  totalBytes: number;
  partial: boolean;
  stoppedReason: string | null;
}

export interface CrawlProgress {
  phase: "sitemap" | "crawl" | "complete";
  rootUrl: string;
  visited: number;
  queued: number;
  documents: number;
  errors: number;
  totalBytes: number;
  currentDepth: number | null;
  partial: boolean;
  stoppedReason: string | null;
}

export type CrawlProgressCallback = (progress: CrawlProgress) => void;

interface NormalizedCrawlInput {
  root: URL;
  include: RegExp[];
  exclude: RegExp[];
  maxDepth: number;
  limit: number;
  timeoutMs: number;
  maxBytes: number;
  maxConcurrency: number;
  allowSubdomains: boolean;
  allowExternalLinks: boolean;
  robots: "respect" | "ignore";
  sitemap: "include" | "skip" | "only";
  ignoreQueryParameters: boolean;
  render: "auto" | "never" | "always";
}

interface QueueItem {
  url: string;
  depth: number;
}

interface RobotsRule {
  allow: boolean;
  pattern: string;
}

export interface RobotsPolicy {
  rules: RobotsRule[];
  crawlDelayMs: number;
  sitemaps: string[];
  unavailable: boolean;
}

interface SitemapResult {
  kind: "index" | "urlset" | "text";
  locations: string[];
}

const DEFAULT_CRAWL_DELAY_MS = 100;
const MAX_CRAWL_DELAY_MS = 60_000;
const MAX_CRAWL_REDIRECTS = 32;
const MAX_SITEMAP_BYTES = 5 * 1024 * 1024;
const MAX_SITEMAP_DOCUMENTS = 20;
const MAX_SITEMAP_DEPTH = 3;
const MAX_SITEMAP_LOCATIONS = 10_000;
const TRACKING_PARAMETERS = new Set([
  "_ga",
  "dclid",
  "fbclid",
  "gclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "msclkid",
]);

function integer(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string
): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < minimum || result > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return result;
}

function booleanOption(
  value: boolean | undefined,
  fallback: boolean,
  name: string
): boolean {
  if (value !== undefined && typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean`);
  }
  return value ?? fallback;
}

function choice<T extends string>(
  value: T | undefined,
  fallback: T,
  allowed: readonly T[],
  name: string
): T {
  if (value !== undefined && !allowed.includes(value)) {
    throw new Error(`${name} has an unsupported value`);
  }
  return value ?? fallback;
}

function glob(pattern: string): RegExp {
  if (
    typeof pattern !== "string" ||
    !pattern ||
    pattern.length > 1_000 ||
    /[\0-\x1f\x7f]/.test(pattern)
  ) {
    throw new Error(
      "Crawl path filters must be non-empty and at most 1000 characters"
    );
  }
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^${escaped
      .replaceAll("**", "\u0000")
      .replaceAll("*", "[^?]*")
      .replaceAll("\u0000", ".*")}$`
  );
}

function filters(values: string[] | undefined, name: string): RegExp[] {
  if (values !== undefined && (!Array.isArray(values) || values.length > 50)) {
    throw new Error(`${name} accepts at most 50 path filters`);
  }
  return (values ?? []).map(glob);
}

export function normalizeCrawlInput(input: CrawlInput): NormalizedCrawlInput {
  if (
    typeof input.url !== "string" ||
    !input.url.trim() ||
    input.url.length > 4_096
  ) {
    throw new Error("crawl_content requires a valid URL");
  }
  let root: URL;
  try {
    root = new URL(input.url.trim());
  } catch {
    throw new Error("crawl_content requires a valid URL");
  }
  if (
    (root.protocol !== "http:" && root.protocol !== "https:") ||
    root.username ||
    root.password
  ) {
    throw new Error("crawl_content requires an HTTP(S) URL without userinfo");
  }
  return {
    root,
    include: filters(input.includePaths, "includePaths"),
    exclude: filters(input.excludePaths, "excludePaths"),
    maxDepth: integer(input.maxDepth, 2, 0, 8, "maxDepth"),
    limit: integer(input.limit, 20, 1, 100, "limit"),
    timeoutMs: integer(input.timeoutMs, 60_000, 1_000, 300_000, "timeoutMs"),
    maxBytes: integer(
      input.maxBytes,
      10 * 1024 * 1024,
      64 * 1024,
      100 * 1024 * 1024,
      "maxBytes"
    ),
    maxConcurrency: integer(input.maxConcurrency, 3, 1, 8, "maxConcurrency"),
    allowSubdomains: booleanOption(
      input.allowSubdomains,
      false,
      "allowSubdomains"
    ),
    allowExternalLinks: booleanOption(
      input.allowExternalLinks,
      false,
      "allowExternalLinks"
    ),
    robots: choice(input.robots, "respect", ["respect", "ignore"], "robots"),
    sitemap: choice(
      input.sitemap,
      "include",
      ["include", "skip", "only"],
      "sitemap"
    ),
    ignoreQueryParameters: booleanOption(
      input.ignoreQueryParameters,
      false,
      "ignoreQueryParameters"
    ),
    render: choice(input.render, "auto", ["auto", "never", "always"], "render"),
  };
}

function isTrackingParameter(name: string): boolean {
  const value = name.toLowerCase();
  return value.startsWith("utm_") || TRACKING_PARAMETERS.has(value);
}

export function canonicalizeCrawlUrl(
  raw: string,
  ignoreQuery: boolean
): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    !url.hostname
  ) {
    return null;
  }
  url.hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  url.hash = "";
  if (ignoreQuery) {
    url.search = "";
  } else {
    for (const name of [...url.searchParams.keys()]) {
      if (isTrackingParameter(name)) {
        url.searchParams.delete(name);
      }
    }
    url.searchParams.sort();
  }
  const result = url.toString();
  return result.length <= 4_096 ? result : null;
}

function pathRoot(root: URL): string {
  if (root.pathname.endsWith("/")) {
    return root.pathname;
  }
  const slash = root.pathname.lastIndexOf("/");
  return root.pathname.slice(0, slash + 1) || "/";
}

function inScope(url: URL, options: NormalizedCrawlInput): boolean {
  const root = options.root;
  const sameOrigin = url.origin === root.origin;
  const childHost =
    options.allowSubdomains &&
    url.hostname.endsWith(`.${root.hostname}`) &&
    url.protocol === root.protocol &&
    url.port === root.port;
  if (!options.allowExternalLinks && !sameOrigin && !childHost) {
    return false;
  }
  if (
    !options.allowExternalLinks &&
    (sameOrigin || childHost) &&
    !url.pathname.startsWith(pathRoot(root))
  ) {
    return false;
  }
  const full = url.toString();
  if (options.exclude.some(pattern => pattern.test(full))) {
    return false;
  }
  return (
    !options.include.length ||
    options.include.some(pattern => pattern.test(full))
  );
}

function safeHttpUrl(raw: string, base: string): string | null {
  try {
    const url = new URL(raw, base);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function htmlDiscovery(
  html: string,
  responseUrl: string
): { canonical: string | null; links: string[] } {
  const { document } = parseHTML(html);
  const baseHref = document.querySelector("base[href]")?.getAttribute("href");
  const base = baseHref ? safeHttpUrl(baseHref, responseUrl) : responseUrl;
  const effectiveBase = base ?? responseUrl;
  let canonical: string | null = null;
  for (const link of document.querySelectorAll("link[href][rel]")) {
    const relations = (link.getAttribute("rel") ?? "")
      .toLowerCase()
      .split(/\s+/);
    if (relations.includes("canonical")) {
      canonical = safeHttpUrl(link.getAttribute("href") ?? "", effectiveBase);
      break;
    }
  }
  const links: string[] = [];
  for (const anchor of document.querySelectorAll("a[href]")) {
    if (links.length === 2_000) {
      break;
    }
    const target = safeHttpUrl(
      anchor.getAttribute("href") ?? "",
      effectiveBase
    );
    if (target) {
      links.push(target);
    }
  }
  return { canonical, links };
}

function readableDocument(document: ExtractedContent): ExtractedContent {
  if (
    document.error ||
    (document.mimeType !== "text/html" &&
      document.mimeType !== "application/xhtml+xml")
  ) {
    return document;
  }
  try {
    return {
      ...document,
      ...readableHTML(document.content, document.finalUrl),
    };
  } catch (error) {
    return {
      ...document,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function emptyRobots(unavailable = false): RobotsPolicy {
  return {
    rules: [],
    crawlDelayMs: DEFAULT_CRAWL_DELAY_MS,
    sitemaps: [],
    unavailable,
  };
}

export function parseRobots(
  content: string,
  userAgent = "WildBuzzard"
): RobotsPolicy {
  if (new TextEncoder().encode(content).byteLength > MAX_SITEMAP_BYTES) {
    throw new Error("robots.txt exceeded the byte limit");
  }
  if (/[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content)) {
    throw new Error("robots.txt contains invalid control characters");
  }
  const groups: Array<{
    agents: string[];
    rules: RobotsRule[];
    crawlDelayMs: number | null;
  }> = [];
  const sitemaps: string[] = [];
  let agents: string[] = [];
  let rules: RobotsRule[] = [];
  let crawlDelayMs: number | null = null;
  let directivesStarted = false;
  const flush = () => {
    if (agents.length) {
      groups.push({ agents, rules, crawlDelayMs });
    }
    agents = [];
    rules = [];
    crawlDelayMs = null;
    directivesStarted = false;
  };
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) {
      if (agents.length) {
        flush();
      }
      continue;
    }
    const separator = line.indexOf(":");
    if (separator < 0) {
      continue;
    }
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (name === "sitemap") {
      if (value && value.length <= 4_096 && sitemaps.length < 100) {
        sitemaps.push(value);
      }
      continue;
    }
    if (name === "user-agent") {
      if (directivesStarted) {
        flush();
      }
      if (value && value.length <= 256) {
        agents.push(value.toLowerCase());
      }
      continue;
    }
    if (!agents.length) {
      continue;
    }
    if (name === "allow" || name === "disallow") {
      directivesStarted = true;
      if (value && value.length <= 4_096) {
        rules.push({ allow: name === "allow", pattern: value });
      }
    } else if (name === "crawl-delay") {
      directivesStarted = true;
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) {
        crawlDelayMs = Math.min(MAX_CRAWL_DELAY_MS, Math.ceil(seconds * 1_000));
      }
    }
  }
  flush();
  const product = userAgent.toLowerCase();
  const scored = groups.map(group => ({
    group,
    specificity: Math.max(
      ...group.agents.map(agent =>
        agent === "*" ? 0 : product.startsWith(agent) ? agent.length : -1
      )
    ),
  }));
  const specificity = Math.max(-1, ...scored.map(item => item.specificity));
  const selected = scored
    .filter(item => item.specificity === specificity && specificity >= 0)
    .map(item => item.group);
  const declaredDelays = selected
    .map(group => group.crawlDelayMs)
    .filter((value): value is number => value !== null);
  return {
    rules: selected.flatMap(group => group.rules).slice(0, 10_000),
    crawlDelayMs: declaredDelays.length
      ? Math.max(...declaredDelays)
      : DEFAULT_CRAWL_DELAY_MS,
    sitemaps: [...new Set(sitemaps)],
    unavailable: false,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function robotsRuleMatch(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const source = anchored ? pattern.slice(0, -1) : pattern;
  const expression = source.split(/\*+/).map(escapeRegExp).join(".*");
  return new RegExp(`^${expression}${anchored ? "$" : ""}`).test(path);
}

export function robotsAllows(policy: RobotsPolicy, path: string): boolean {
  if (policy.unavailable) {
    return false;
  }
  let selected: { allow: boolean; length: number } | null = null;
  for (const rule of policy.rules) {
    if (!robotsRuleMatch(rule.pattern, path)) {
      continue;
    }
    const length = rule.pattern.replaceAll("*", "").replace(/\$$/, "").length;
    if (
      !selected ||
      length > selected.length ||
      (length === selected.length && rule.allow)
    ) {
      selected = { allow: rule.allow, length };
    }
  }
  return selected?.allow ?? true;
}

function decodeXmlEntities(value: string): string {
  if (!/^([^&]|&(amp|apos|gt|lt|quot|#\d+|#x[0-9a-f]+);)*$/i.test(value)) {
    throw new Error("sitemap contains an unsupported entity");
  }
  const decoded = value.replace(
    /&(amp|apos|gt|lt|quot|#\d+|#x[0-9a-f]+);/gi,
    (_match, entity: string) => {
      const lower = entity.toLowerCase();
      const named: Record<string, string> = {
        amp: "&",
        apos: "'",
        gt: ">",
        lt: "<",
        quot: '"',
      };
      if (named[lower]) {
        return named[lower];
      }
      const codePoint = lower.startsWith("#x")
        ? Number.parseInt(lower.slice(2), 16)
        : Number.parseInt(lower.slice(1), 10);
      const validXmlCharacter =
        codePoint === 0x9 ||
        codePoint === 0xa ||
        codePoint === 0xd ||
        (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
        (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
        (codePoint >= 0x10000 && codePoint <= 0x10ffff);
      if (!Number.isInteger(codePoint) || !validXmlCharacter) {
        throw new Error("sitemap contains an invalid character reference");
      }
      return String.fromCodePoint(codePoint);
    }
  );
  return decoded;
}

function localName(name: string): string {
  return name.toLowerCase().split(":").at(-1) ?? "";
}

function xmlAttributeCount(value: string): number {
  const source = value.trimEnd();
  const pattern =
    /[\t\n\r ]+([A-Za-z_:][A-Za-z0-9_.:-]*)[\t\n\r ]*=[\t\n\r ]*(?:"([^"<]*)"|'([^'<]*)')/gy;
  const names = new Set<string>();
  let cursor = 0;
  let count = 0;
  while (cursor < source.length) {
    pattern.lastIndex = cursor;
    const match = pattern.exec(source);
    if (!match || match.index !== cursor) {
      throw new Error("sitemap XML is malformed");
    }
    const name = match[1];
    if (names.has(name)) {
      throw new Error("sitemap XML contains duplicate attributes");
    }
    names.add(name);
    decodeXmlEntities(match[2] ?? match[3] ?? "");
    count++;
    cursor = pattern.lastIndex;
  }
  return count;
}

export function parseSitemap(content: string): SitemapResult {
  if (new TextEncoder().encode(content).byteLength > MAX_SITEMAP_BYTES) {
    throw new Error("sitemap exceeded the decompressed byte limit");
  }
  const trimmed = content.trim();
  if (!trimmed.startsWith("<")) {
    const locations = trimmed
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith("#"));
    if (locations.length > MAX_SITEMAP_LOCATIONS) {
      throw new Error("sitemap location limit exceeded");
    }
    return { kind: "text", locations };
  }
  if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(trimmed)) {
    throw new Error("sitemap DTDs and entities are not allowed");
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/.test(trimmed)) {
    throw new Error("sitemap XML contains an invalid character");
  }
  const source = trimmed
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\?[\s\S]*?\?>/g, "");
  if (source.includes("<!")) {
    throw new Error("sitemap declarations are not allowed");
  }
  const tokenPattern = /<[^>]*>|[^<]+/g;
  const stack: string[] = [];
  const locations: string[] = [];
  let root = "";
  let locationText = "";
  let elements = 0;
  let cursor = 0;
  let rootClosed = false;
  for (const match of source.matchAll(tokenPattern)) {
    if (match.index !== cursor) {
      throw new Error("sitemap XML is malformed");
    }
    const token = match[0];
    cursor += token.length;
    if (!token.startsWith("<")) {
      if (!stack.length && token.trim()) {
        throw new Error("sitemap XML is malformed");
      }
      if (token.includes("&")) {
        decodeXmlEntities(token);
      }
      if (stack.at(-1) === "loc") {
        locationText += token;
        if (locationText.length > 4_096) {
          throw new Error("sitemap location is too long");
        }
      }
      continue;
    }
    const closing = /^<\s*\/\s*([^\s>]+)\s*>$/.exec(token);
    if (closing) {
      if (!/^[A-Za-z_:][A-Za-z0-9_.:-]*$/.test(closing[1])) {
        throw new Error("sitemap XML is malformed");
      }
      const name = localName(closing[1]);
      if (stack.pop() !== name) {
        throw new Error("sitemap XML is malformed");
      }
      if (name === "loc") {
        const location = decodeXmlEntities(locationText.trim());
        if (location) {
          locations.push(location);
          if (locations.length > MAX_SITEMAP_LOCATIONS) {
            throw new Error("sitemap location limit exceeded");
          }
        }
        locationText = "";
      }
      if (!stack.length) {
        rootClosed = true;
      }
      continue;
    }
    const opening = /^<\s*([^\s/>]+)([\s\S]*?)\/?>$/.exec(token);
    if (!opening) {
      throw new Error("sitemap XML is malformed");
    }
    if (!/^[A-Za-z_:][A-Za-z0-9_.:-]*$/.test(opening[1])) {
      throw new Error("sitemap XML is malformed");
    }
    if (!stack.length && (root || rootClosed)) {
      throw new Error("sitemap XML is malformed");
    }
    const name = localName(opening[1]);
    const attributes = xmlAttributeCount(opening[2]);
    if (attributes > 64) {
      throw new Error("sitemap attribute limit exceeded");
    }
    elements++;
    if (elements > 50_000) {
      throw new Error("sitemap element limit exceeded");
    }
    if (!root) {
      root = name;
    }
    const selfClosing = /\/\s*>$/.test(token);
    if (!selfClosing) {
      stack.push(name);
      if (stack.length > 32) {
        throw new Error("sitemap depth limit exceeded");
      }
      if (name === "loc") {
        locationText = "";
      }
    } else if (!stack.length) {
      rootClosed = true;
    }
  }
  if (cursor !== source.length || stack.length || !rootClosed) {
    throw new Error("sitemap XML is malformed");
  }
  if (root !== "sitemapindex" && root !== "urlset") {
    throw new Error("sitemap has an unsupported root element");
  }
  return {
    kind: root === "sitemapindex" ? "index" : "urlset",
    locations,
  };
}

function decodeGzipSitemap(
  content: string,
  remainingBytes: number
): { content: string; decompressedBytes: number } {
  const prefix = "data:application/gzip;base64,";
  if (!content.startsWith(prefix)) {
    return { content, decompressedBytes: 0 };
  }
  const encoded = content.slice(prefix.length);
  if (
    !encoded ||
    encoded.length > 2 * 1024 * 1024 ||
    encoded.length % 4 !== 0 ||
    !/^[a-z0-9+/]+={0,2}$/i.test(encoded)
  ) {
    throw new Error("gzip sitemap payload is malformed or oversized");
  }
  const compressed = Buffer.from(encoded, "base64");
  if (compressed[0] !== 0x1f || compressed[1] !== 0x8b) {
    throw new Error("gzip sitemap payload is malformed");
  }
  let decompressed: Buffer;
  const maxOutputLength = Math.min(MAX_SITEMAP_BYTES, remainingBytes);
  if (maxOutputLength < 1) {
    throw new Error("gzip sitemap exceeded the remaining crawl byte budget");
  }
  try {
    decompressed = gunzipSync(compressed, {
      maxOutputLength,
    });
  } catch (error) {
    if (
      maxOutputLength < MAX_SITEMAP_BYTES &&
      (error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE"
    ) {
      throw new Error("gzip sitemap exceeded the remaining crawl byte budget");
    }
    throw new Error("gzip sitemap decompression failed or exceeded the limit");
  }
  if (
    decompressed.length > 1024 * 1024 &&
    decompressed.length / compressed.length > 100
  ) {
    throw new Error("gzip sitemap decompression ratio exceeded");
  }
  let decoded: string;
  try {
    if (decompressed[0] === 0xff && decompressed[1] === 0xfe) {
      decoded = new TextDecoder("utf-16le", { fatal: true }).decode(
        decompressed
      );
    } else if (decompressed[0] === 0xfe && decompressed[1] === 0xff) {
      decoded = new TextDecoder("utf-16be", { fatal: true }).decode(
        decompressed
      );
    } else if (
      decompressed[0] === 0x3c &&
      decompressed[1] === 0x00 &&
      decompressed[2] === 0x3f &&
      decompressed[3] === 0x00
    ) {
      decoded = new TextDecoder("utf-16le", { fatal: true }).decode(
        decompressed
      );
    } else if (
      decompressed[0] === 0x00 &&
      decompressed[1] === 0x3c &&
      decompressed[2] === 0x00 &&
      decompressed[3] === 0x3f
    ) {
      decoded = new TextDecoder("utf-16be", { fatal: true }).decode(
        decompressed
      );
    } else {
      const declaration = decompressed.subarray(0, 256).toString("latin1");
      const charset = /<\?xml[^>]*\bencoding\s*=\s*["']([^"']+)["']/i.exec(
        declaration
      )?.[1];
      decoded = new TextDecoder(charset ?? "utf-8", { fatal: true }).decode(
        decompressed
      );
    }
  } catch {
    throw new Error("gzip sitemap text encoding is invalid");
  }
  return { content: decoded, decompressedBytes: decompressed.byteLength };
}

function byteLength(document: ExtractedContent): number {
  const prefix = "data:application/gzip;base64,";
  if (document.content.startsWith(prefix)) {
    const length = document.content.length - prefix.length;
    const padding = document.content.endsWith("==")
      ? 2
      : document.content.endsWith("=")
        ? 1
        : 0;
    return Math.max(0, Math.floor((length * 3) / 4) - padding);
  }
  return new TextEncoder().encode(document.content).byteLength;
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .slice(0, 1_000);
}

function abortableDelay(
  milliseconds: number,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new Error("crawl aborted"));
  }
  if (milliseconds <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("crawl aborted"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function crawlWithGecko(
  input: CrawlInput,
  cwd: string,
  sessionId: string,
  signal?: AbortSignal,
  fetchPage: typeof fetchWithGecko = fetchWithGecko,
  onProgress?: CrawlProgressCallback
): Promise<CrawlResult> {
  const options = normalizeCrawlInput(input);
  const root = canonicalizeCrawlUrl(
    options.root.toString(),
    options.ignoreQueryParameters
  );
  if (!root) {
    throw new Error("The crawl root could not be canonicalized");
  }
  options.root = new URL(root);
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const budgetController = new AbortController();
  const signals = [timeout, budgetController.signal];
  if (signal) {
    signals.push(signal);
  }
  const combined = AbortSignal.any(signals);
  const seen = new Set<string>();
  const emitted = new Set<string>();
  const documents: ExtractedContent[] = [];
  const errors: CrawlResult["errors"] = [];
  const robots = new Map<string, Promise<RobotsPolicy>>();
  const originLimits = new Map<string, ReturnType<typeof pLimit>>();
  const originDelays = new Map<string, number>();
  const originNextRequest = new Map<string, number>();
  let totalBytes = 0;
  let totalRedirects = 0;
  let visited = 0;
  let partial = false;
  let stoppedReason: string | null = null;

  const emitProgress = (
    phase: CrawlProgress["phase"],
    queued: number,
    currentDepth: number | null = null
  ) => {
    if (!onProgress) {
      return;
    }
    try {
      onProgress({
        phase,
        rootUrl: root,
        visited,
        queued: Math.min(options.limit, Math.max(0, queued)),
        documents: documents.length,
        errors: errors.length,
        totalBytes,
        currentDepth,
        partial,
        stoppedReason,
      });
    } catch {}
  };

  const stop = (reason: string) => {
    if (stoppedReason) {
      return;
    }
    stoppedReason = reason;
    partial = true;
    budgetController.abort(new Error(reason));
  };

  const recordError = (url: string, error: unknown) => {
    if (errors.length < 100) {
      errors.push({ url, error: boundedError(error) });
    }
  };

  const account = (document: ExtractedContent, extraBytes = 0): boolean => {
    const reportedNetworkBytes = document[EXTRACTED_NETWORK_BYTES];
    const networkBytes =
      typeof reportedNetworkBytes === "number" &&
      Number.isSafeInteger(reportedNetworkBytes) &&
      reportedNetworkBytes >= 0
        ? reportedNetworkBytes
        : 0;
    const bytes = Math.max(byteLength(document), networkBytes) + extraBytes;
    const redirects = Math.max(
      0,
      document.redirectCount ?? (document.url === document.finalUrl ? 0 : 1)
    );
    if (totalRedirects + redirects > MAX_CRAWL_REDIRECTS) {
      stop("maxRedirects");
      return false;
    }
    if (totalBytes + bytes > options.maxBytes) {
      stop("maxBytes");
      return false;
    }
    totalRedirects += redirects;
    totalBytes += bytes;
    return true;
  };

  const fetchRaw = async (
    url: string,
    javascript: boolean,
    byteBudget?: number,
    redirectBudget?: number
  ) => {
    const maxBytes = Math.min(
      MAX_GECKO_RENDER_BYTES,
      byteBudget ?? options.maxBytes - totalBytes
    );
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      stop("maxBytes");
      throw new Error("crawl byte budget exhausted");
    }
    const maxRedirects = Math.min(
      MAX_GECKO_RENDER_REDIRECTS,
      redirectBudget ?? MAX_CRAWL_REDIRECTS - totalRedirects
    );
    if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0) {
      stop("maxRedirects");
      throw new Error("crawl redirect budget exhausted");
    }
    const origin = new URL(url).origin;
    let originLimit = originLimits.get(origin);
    if (!originLimit) {
      originLimit = pLimit(1);
      originLimits.set(origin, originLimit);
    }
    return originLimit(async () => {
      if (combined.aborted) {
        throw combined.reason ?? new Error("crawl aborted");
      }
      await abortableDelay(
        Math.max(0, (originNextRequest.get(origin) ?? 0) - Date.now()),
        combined
      );
      const result = await fetchPage(url, "raw", cwd, sessionId, combined, {
        timeoutMs: Math.min(options.timeoutMs, 30_000),
        javascript,
        allowSubdomains: options.allowSubdomains,
        maxBytes,
        maxRedirects,
        allowedOrigins: options.allowExternalLinks
          ? undefined
          : [...new Set([options.root.origin, origin])],
      });
      originNextRequest.set(
        origin,
        Date.now() + (originDelays.get(origin) ?? DEFAULT_CRAWL_DELAY_MS)
      );
      return result;
    });
  };

  const robotsForOrigin = (origin: string): Promise<RobotsPolicy> => {
    if (options.robots === "ignore") {
      return Promise.resolve(emptyRobots());
    }
    const cached = robots.get(origin);
    if (cached) {
      return cached;
    }
    const pending = (async () => {
      const url = `${origin}/robots.txt`;
      let result: ExtractedContent;
      try {
        result = await fetchRaw(url, false);
      } catch (error) {
        if (!combined.aborted) {
          recordError(url, error);
        }
        return emptyRobots(true);
      }
      if (!account(result)) {
        return emptyRobots(true);
      }
      let finalOrigin = "";
      try {
        finalOrigin = new URL(result.finalUrl).origin;
      } catch {}
      if (finalOrigin !== origin) {
        recordError(url, "robots.txt redirect left its origin");
        return emptyRobots(true);
      }
      if (
        result.error ||
        result.status === 401 ||
        result.status === 403 ||
        result.status === 429 ||
        result.status >= 500
      ) {
        if (result.error || result.status >= 500 || result.status === 429) {
          recordError(
            url,
            result.error ?? `robots.txt returned ${result.status}`
          );
        }
        return emptyRobots(true);
      }
      if (result.status >= 400) {
        return emptyRobots();
      }
      try {
        const policy = parseRobots(result.content);
        originDelays.set(origin, policy.crawlDelayMs);
        originNextRequest.set(origin, Date.now() + policy.crawlDelayMs);
        return policy;
      } catch (error) {
        recordError(url, error);
        return emptyRobots(true);
      }
    })();
    robots.set(origin, pending);
    return pending;
  };

  const allowedByRobots = async (url: URL) => {
    if (options.robots === "ignore") {
      return true;
    }
    const policy = await robotsForOrigin(url.origin);
    return robotsAllows(policy, `${url.pathname}${url.search}`);
  };

  let queue: QueueItem[] =
    options.sitemap === "only" ? [] : [{ url: root, depth: 0 }];
  if (options.sitemap !== "skip") {
    const sitemapSeen = new Set<string>();
    let sitemapDocuments = 0;
    const collectSitemap = async (
      rawUrl: string,
      depth: number
    ): Promise<void> => {
      if (
        combined.aborted ||
        depth > MAX_SITEMAP_DEPTH ||
        sitemapDocuments >= MAX_SITEMAP_DOCUMENTS ||
        queue.length >= MAX_SITEMAP_LOCATIONS
      ) {
        return;
      }
      const url = canonicalizeCrawlUrl(rawUrl, options.ignoreQueryParameters);
      if (
        !url ||
        new URL(url).origin !== options.root.origin ||
        sitemapSeen.has(url)
      ) {
        return;
      }
      sitemapSeen.add(url);
      sitemapDocuments++;
      let result: ExtractedContent;
      try {
        result = await fetchRaw(url, false);
      } catch (error) {
        if (!combined.aborted) {
          recordError(url, error);
        }
        return;
      }
      if (!account(result)) {
        return;
      }
      if (result.error || result.status >= 400) {
        if (result.error || result.status !== 404) {
          recordError(url, result.error ?? `sitemap returned ${result.status}`);
        }
        return;
      }
      let finalUrl: URL;
      try {
        finalUrl = new URL(result.finalUrl);
      } catch {
        recordError(url, "sitemap returned an invalid final URL");
        return;
      }
      if (finalUrl.origin !== options.root.origin) {
        recordError(url, "sitemap redirect left the crawl origin");
        return;
      }
      try {
        const decoded = decodeGzipSitemap(
          result.content,
          options.maxBytes - totalBytes
        );
        if (
          decoded.decompressedBytes > 0 &&
          !account(
            {
              ...result,
              content: "",
              redirectCount: 0,
              [EXTRACTED_NETWORK_BYTES]: 0,
            },
            decoded.decompressedBytes
          )
        ) {
          return;
        }
        const sitemap = parseSitemap(decoded.content);
        for (const location of sitemap.locations) {
          const candidate = canonicalizeCrawlUrl(
            safeHttpUrl(location, result.finalUrl) ?? "",
            options.ignoreQueryParameters
          );
          if (!candidate) {
            continue;
          }
          if (sitemap.kind === "index") {
            await collectSitemap(candidate, depth + 1);
          } else if (inScope(new URL(candidate), options)) {
            if (queue.length < MAX_SITEMAP_LOCATIONS) {
              queue.push({ url: candidate, depth: 0 });
            }
          }
        }
      } catch (error) {
        if (
          error instanceof Error &&
          error.message ===
            "gzip sitemap exceeded the remaining crawl byte budget"
        ) {
          stop("maxBytes");
        } else {
          recordError(url, error);
        }
      }
    };

    const sitemapUrls = new Set([`${options.root.origin}/sitemap.xml`]);
    if (options.robots === "respect") {
      const policy = await robotsForOrigin(options.root.origin);
      if (policy.unavailable) {
        sitemapUrls.clear();
      } else {
        for (const rawUrl of policy.sitemaps) {
          const url = safeHttpUrl(rawUrl, options.root.origin);
          if (url && new URL(url).origin === options.root.origin) {
            sitemapUrls.add(url);
          }
        }
      }
    }
    for (const url of sitemapUrls) {
      await collectSitemap(url, 0);
      emitProgress("sitemap", queue.length);
      if (combined.aborted) {
        break;
      }
    }
  }

  const queued = new Set<string>();
  queue = queue.filter(item => {
    if (queued.has(item.url)) {
      return false;
    }
    queued.add(item.url);
    return true;
  });
  const globalLimit = pLimit(options.maxConcurrency);

  crawl: while (queue.length && visited < options.limit) {
    if (combined.aborted) {
      break;
    }
    const depth = queue[0].depth;
    const level: QueueItem[] = [];
    while (queue[0]?.depth === depth) {
      level.push(queue.shift()!);
    }
    const additions: QueueItem[] = [];
    let offset = 0;
    while (offset < level.length && visited < options.limit) {
      const candidates: QueueItem[] = [];
      while (
        offset < level.length &&
        candidates.length < options.maxConcurrency &&
        visited + candidates.length < options.limit
      ) {
        const item = level[offset++];
        if (seen.has(item.url)) {
          continue;
        }
        seen.add(item.url);
        const parsed = new URL(item.url);
        if (!inScope(parsed, options)) {
          continue;
        }
        candidates.push(item);
      }
      if (!candidates.length) {
        continue;
      }
      const eligible: Array<{ item: QueueItem; allowed: boolean }> = [];
      for (const item of candidates) {
        eligible.push({
          item,
          allowed: await allowedByRobots(new URL(item.url)),
        });
        if (combined.aborted) {
          break crawl;
        }
      }
      const fetches = eligible.filter(item => item.allowed);
      const remainingBytes = options.maxBytes - totalBytes;
      if (fetches.length && remainingBytes < fetches.length) {
        stop("maxBytes");
        break crawl;
      }
      const bytesPerFetch = fetches.length
        ? Math.floor(remainingBytes / fetches.length)
        : 0;
      const extraBudgetBytes = fetches.length
        ? remainingBytes % fetches.length
        : 0;
      const remainingRedirects = MAX_CRAWL_REDIRECTS - totalRedirects;
      const redirectsPerFetch = fetches.length
        ? Math.floor(remainingRedirects / fetches.length)
        : 0;
      const extraRedirects = fetches.length
        ? remainingRedirects % fetches.length
        : 0;
      visited += fetches.length;
      let outcomes: Array<{
        item: QueueItem;
        result: ExtractedContent | null;
        error: unknown;
      }>;
      try {
        outcomes = await Promise.all(
          fetches.map(({ item }, index) =>
            globalLimit(async () => {
              try {
                return {
                  item,
                  result: await fetchRaw(
                    item.url,
                    options.render !== "never",
                    Math.min(
                      MAX_GECKO_RENDER_BYTES,
                      bytesPerFetch + (index < extraBudgetBytes ? 1 : 0)
                    ),
                    Math.min(
                      MAX_GECKO_RENDER_REDIRECTS,
                      redirectsPerFetch + (index < extraRedirects ? 1 : 0)
                    )
                  ),
                  error: null,
                };
              } catch (error) {
                return { item, result: null, error };
              }
            })
          )
        );
      } catch {
        break crawl;
      }
      for (const outcome of outcomes) {
        if (combined.aborted) {
          break crawl;
        }
        if (!outcome.result) {
          recordError(outcome.item.url, outcome.error);
          continue;
        }
        const raw = outcome.result;
        if (!account(raw)) {
          break crawl;
        }
        if (raw.error) {
          recordError(outcome.item.url, raw.error);
          continue;
        }
        const final = canonicalizeCrawlUrl(
          raw.finalUrl,
          options.ignoreQueryParameters
        );
        if (!final || !inScope(new URL(final), options)) {
          recordError(
            outcome.item.url,
            "Redirect left the allowed crawl scope"
          );
          continue;
        }
        seen.add(final);
        const isHtml =
          raw.mimeType === "text/html" ||
          raw.mimeType === "application/xhtml+xml";
        const discovery = isHtml
          ? htmlDiscovery(raw.content, raw.finalUrl)
          : { canonical: null, links: [] };
        const declaredCanonical = discovery.canonical
          ? canonicalizeCrawlUrl(
              discovery.canonical,
              options.ignoreQueryParameters
            )
          : null;
        const outputKey =
          declaredCanonical && inScope(new URL(declaredCanonical), options)
            ? declaredCanonical
            : final;
        seen.add(outputKey);
        if (!emitted.has(outputKey)) {
          const document = readableDocument(raw);
          const extraOutputBytes = Math.max(
            0,
            byteLength(document) - byteLength(raw)
          );
          if (
            extraOutputBytes &&
            !account(
              {
                ...raw,
                content: "",
                redirectCount: 0,
                [EXTRACTED_NETWORK_BYTES]: 0,
              },
              extraOutputBytes
            )
          ) {
            break crawl;
          }
          emitted.add(outputKey);
          documents.push(document);
        }
        if (
          outcome.item.depth >= options.maxDepth ||
          options.sitemap === "only"
        ) {
          continue;
        }
        for (const link of discovery.links) {
          const candidate = canonicalizeCrawlUrl(
            link,
            options.ignoreQueryParameters
          );
          if (
            candidate &&
            !seen.has(candidate) &&
            inScope(new URL(candidate), options)
          ) {
            additions.push({ url: candidate, depth: outcome.item.depth + 1 });
          }
        }
      }
      emitProgress(
        "crawl",
        queue.length + Math.max(0, level.length - offset) + additions.length,
        depth
      );
    }
    for (const item of additions) {
      if (!queued.has(item.url) && !seen.has(item.url)) {
        queued.add(item.url);
        queue.push(item);
      }
    }
    if (
      visited >= options.limit &&
      (offset < level.length || queue.length > 0)
    ) {
      partial = true;
      stoppedReason = "limit";
      break;
    }
  }

  if (combined.aborted && !stoppedReason) {
    partial = true;
    stoppedReason = signal?.aborted ? "cancelled" : "timeout";
  } else if (!stoppedReason && visited >= options.limit && queue.length) {
    partial = true;
    stoppedReason = "limit";
  }
  emitProgress("complete", queue.length);
  return {
    rootUrl: root,
    documents,
    errors,
    visited,
    totalBytes,
    partial,
    stoppedReason,
  };
}
