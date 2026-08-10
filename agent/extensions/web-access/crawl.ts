/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { parseHTML } from "linkedom";
import pLimit from "p-limit";
import {
  fetchWithGecko,
  readableHTML,
  type ExtractedContent,
} from "./extract.ts";

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

function glob(pattern: string): RegExp {
  if (!pattern || pattern.length > 1_000) {
    throw new Error("Crawl path filters must be non-empty and at most 1000 characters");
  }
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replaceAll("**", "\u0000").replaceAll("*", "[^?]*").replaceAll("\u0000", ".*")}$`);
}

export function normalizeCrawlInput(input: CrawlInput): NormalizedCrawlInput {
  let root: URL;
  try {
    root = new URL(input.url);
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
  if (input.render === "never") {
    throw new Error("render=never requires the bounded static Gecko channel path");
  }
  return {
    root,
    include: (input.includePaths ?? []).map(glob),
    exclude: (input.excludePaths ?? []).map(glob),
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
    allowSubdomains: input.allowSubdomains ?? false,
    allowExternalLinks: input.allowExternalLinks ?? false,
    robots: input.robots ?? "respect",
    sitemap: input.sitemap ?? "include",
    ignoreQueryParameters: input.ignoreQueryParameters ?? false,
    render: input.render ?? "auto",
  };
}

function canonicalize(raw: string, ignoreQuery: boolean): string | null {
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
    url.toString().length > 4_096
  ) {
    return null;
  }
  url.hash = "";
  if (ignoreQuery) {
    url.search = "";
  } else {
    url.searchParams.sort();
  }
  return url.toString();
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
  const sameHost = url.hostname === root.hostname;
  const childHost = url.hostname.endsWith(`.${root.hostname}`);
  if (!options.allowExternalLinks) {
    if (!sameHost && !(options.allowSubdomains && childHost)) {
      return false;
    }
    if (sameHost && url.origin !== root.origin) {
      return false;
    }
  }
  if (
    sameHost &&
    url.origin === root.origin &&
    !url.pathname.startsWith(pathRoot(root))
  ) {
    return false;
  }
  const full = url.toString();
  if (options.exclude.some(pattern => pattern.test(full))) {
    return false;
  }
  return !options.include.length || options.include.some(pattern => pattern.test(full));
}

function htmlLinks(html: string, baseUrl: string): string[] {
  const { document } = parseHTML(html);
  const links: string[] = [];
  for (const anchor of document.querySelectorAll("a[href]")) {
    if (links.length === 2_000) {
      break;
    }
    const href = anchor.getAttribute("href");
    if (!href) {
      continue;
    }
    try {
      links.push(new URL(href, baseUrl).toString());
    } catch {}
  }
  return links;
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

function robotsAllows(content: string, path: string): boolean {
  let applies = false;
  let sawRule = false;
  const rules: Array<{ allow: boolean; path: string }> = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) {
      if (sawRule) {
        applies = false;
        sawRule = false;
      }
      continue;
    }
    const separator = line.indexOf(":");
    if (separator < 0) {
      continue;
    }
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (name === "user-agent") {
      if (sawRule) {
        applies = false;
        sawRule = false;
      }
      applies ||= value === "*" || value.toLowerCase() === "wildbuzzard";
    } else if (applies && (name === "allow" || name === "disallow")) {
      sawRule = true;
      if (value) {
        rules.push({ allow: name === "allow", path: value });
      }
    }
  }
  const matches = rules
    .filter(rule => path.startsWith(rule.path.replace(/\$$/, "")))
    .sort((left, right) => right.path.length - left.path.length);
  return matches[0]?.allow ?? true;
}

function sitemapLocations(content: string): string[] {
  const locations: string[] = [];
  for (const match of content.slice(0, 5 * 1024 * 1024).matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi)) {
    const value = match[1]
      .replaceAll("&amp;", "&")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .trim();
    if (value && locations.length < 10_000) {
      locations.push(value);
    }
  }
  return locations;
}

export async function crawlWithGecko(
  input: CrawlInput,
  cwd: string,
  sessionId: string,
  signal?: AbortSignal,
  fetchPage: typeof fetchWithGecko = fetchWithGecko
): Promise<CrawlResult> {
  const options = normalizeCrawlInput(input);
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const seen = new Set<string>();
  const documents: ExtractedContent[] = [];
  const errors: CrawlResult["errors"] = [];
  const robots = new Map<string, string>();
  const perOrigin = new Map<string, ReturnType<typeof pLimit>>();
  let totalBytes = 0;
  let partial = false;
  let stoppedReason: string | null = null;

  const fetchRaw = async (url: string) => {
    const origin = new URL(url).origin;
    let originLimit = perOrigin.get(origin);
    if (!originLimit) {
      originLimit = pLimit(1);
      perOrigin.set(origin, originLimit);
    }
    return originLimit(async () => {
      const result = await fetchPage(
        url,
        "raw",
        cwd,
        sessionId,
        combined,
        { timeoutMs: Math.min(options.timeoutMs, 30_000) }
      );
      await new Promise(resolve => setTimeout(resolve, 100));
      return result;
    });
  };

  const allowedByRobots = async (url: URL) => {
    if (options.robots === "ignore") {
      return true;
    }
    if (!robots.has(url.origin)) {
      const robotsResult = await fetchRaw(`${url.origin}/robots.txt`);
      robots.set(
        url.origin,
        robotsResult.error || robotsResult.status >= 400 ? "" : robotsResult.content
      );
    }
    return robotsAllows(robots.get(url.origin) ?? "", `${url.pathname}${url.search}`);
  };

  const root = canonicalize(options.root.toString(), options.ignoreQueryParameters);
  if (!root) {
    throw new Error("The crawl root could not be canonicalized");
  }
  let queue: QueueItem[] = options.sitemap === "only" ? [] : [{ url: root, depth: 0 }];
  if (options.sitemap !== "skip") {
    let sitemapDocuments = 0;
    const collectSitemap = async (url: string, depth: number): Promise<void> => {
      if (depth > 3 || sitemapDocuments >= 20 || queue.length >= 10_000) {
        return;
      }
      sitemapDocuments++;
      const sitemap = await fetchRaw(url);
      if (sitemap.error || sitemap.status >= 400) {
        return;
      }
      const indexed = /<sitemapindex\b/i.test(sitemap.content.slice(0, 4_096));
      for (const location of sitemapLocations(sitemap.content)) {
        const candidate = canonicalize(location, options.ignoreQueryParameters);
        if (!candidate) {
          continue;
        }
        if (indexed) {
          const nested = new URL(candidate);
          if (
            nested.origin === options.root.origin &&
            /\.xml(?:\.gz)?$/i.test(nested.pathname)
          ) {
            await collectSitemap(candidate, depth + 1);
          }
        } else if (inScope(new URL(candidate), options)) {
          queue.push({ url: candidate, depth: 0 });
        }
      }
    };
    await collectSitemap(`${options.root.origin}/sitemap.xml`, 0);
  }

  const globalLimit = pLimit(options.maxConcurrency);
  while (queue.length && documents.length < options.limit) {
    if (combined.aborted) {
      partial = true;
      stoppedReason = signal?.aborted ? "cancelled" : "timeout";
      break;
    }
    const depth = Math.min(...queue.map(item => item.depth));
    const level = queue.filter(item => item.depth === depth);
    queue = queue.filter(item => item.depth !== depth);
    const additions = await Promise.all(
      level.map(item =>
        globalLimit(async () => {
          if (seen.has(item.url) || seen.size >= options.limit || combined.aborted) {
            return [] as QueueItem[];
          }
          seen.add(item.url);
          const parsed = new URL(item.url);
          if (!inScope(parsed, options) || !(await allowedByRobots(parsed))) {
            return [] as QueueItem[];
          }
          const raw = await fetchRaw(item.url);
          if (raw.error) {
            errors.push({ url: item.url, error: raw.error });
            return [] as QueueItem[];
          }
          const final = canonicalize(raw.finalUrl, options.ignoreQueryParameters);
          if (!final || !inScope(new URL(final), options)) {
            errors.push({ url: item.url, error: "Redirect left the allowed crawl scope" });
            return [] as QueueItem[];
          }
          const bytes = new TextEncoder().encode(raw.content).byteLength;
          if (totalBytes + bytes > options.maxBytes) {
            partial = true;
            stoppedReason = "maxBytes";
            return [] as QueueItem[];
          }
          totalBytes += bytes;
          documents.push(readableDocument(raw));
          if (item.depth >= options.maxDepth || options.sitemap === "only") {
            return [] as QueueItem[];
          }
          return htmlLinks(raw.content, raw.finalUrl)
            .map(url => canonicalize(url, options.ignoreQueryParameters))
            .filter((url): url is string => Boolean(url))
            .filter(url => !seen.has(url) && inScope(new URL(url), options))
            .map(url => ({ url, depth: item.depth + 1 }));
        })
      )
    );
    for (const items of additions) {
      queue.push(...items);
    }
    const queued = new Set<string>();
    queue = queue.filter(item => {
      if (seen.has(item.url) || queued.has(item.url)) {
        return false;
      }
      queued.add(item.url);
      return true;
    });
  }
  if (documents.length >= options.limit && queue.length) {
    partial = true;
    stoppedReason ??= "limit";
  }
  if (combined.aborted && !stoppedReason) {
    partial = true;
    stoppedReason = signal?.aborted ? "cancelled" : "timeout";
  }
  return {
    rootUrl: root,
    documents,
    errors: errors.slice(0, 100),
    visited: seen.size,
    totalBytes,
    partial,
    stoppedReason,
  };
}
