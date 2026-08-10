/* SPDX-License-Identifier: AGPL-3.0-or-later */
/* Derived from pi-web-access. Copyright (c) 2025 Nico Bailon. */

import { randomUUID } from "node:crypto";
import {
  MAX_PAGE_CHARS,
  RESULT_TTL_MS,
  type QueryResponse,
} from "./contracts.ts";
import type { ExtractedContent } from "./extract.ts";
import {
  clearStoredSearchDatabase,
  deleteExpiredStoredSearches,
  loadStoredSearch,
  persistStoredSearch,
} from "./database.ts";

export interface StoredSearch {
  id: string;
  type: "search" | "research" | "fetch" | "crawl";
  createdAt: number;
  expiresAt: number;
  queries?: QueryResponse[];
  documents?: ExtractedContent[];
}

interface SessionEntry {
  type: string;
  customType?: string;
  data?: unknown;
}

type PassageMode = "exact" | "case-insensitive" | "fuzzy" | "none";

const results = new Map<string, StoredSearch>();

function isStoredSearch(value: unknown): value is StoredSearch {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const item = value as Partial<StoredSearch>;
  return (
    typeof item.id === "string" &&
    ["search", "research", "fetch", "crawl"].includes(item.type ?? "") &&
    Number.isFinite(item.createdAt) &&
    Number.isFinite(item.expiresAt) &&
    ((item.type === "search" || item.type === "research")
      ? Array.isArray(item.queries)
      : Array.isArray(item.documents))
  );
}

export function createStoredSearch(
  queries: QueryResponse[],
  type: StoredSearch["type"] = "search",
  now = Date.now()
): StoredSearch {
  return {
    id: randomUUID(),
    type,
    createdAt: now,
    expiresAt: now + RESULT_TTL_MS,
    queries,
  };
}

export function createStoredDocuments(
  documents: ExtractedContent[],
  type: "fetch" | "crawl" = "fetch",
  now = Date.now()
): StoredSearch {
  return {
    id: randomUUID(),
    type,
    createdAt: now,
    expiresAt: now + RESULT_TTL_MS,
    documents,
  };
}

export function storeSearch(value: StoredSearch): void {
  purgeExpired();
  results.set(value.id, value);
  persistStoredSearch(value);
}

export function getStoredSearch(id: string, now = Date.now()): StoredSearch {
  const loaded = results.get(id) ?? loadStoredSearch(id, now) ?? undefined;
  if (loaded && !isStoredSearch(loaded)) {
    throw new Error("Stored web-search data is invalid");
  }
  const value = loaded;
  if (!value || value.expiresAt <= now) {
    results.delete(id);
    throw new Error("Search result handle is missing or expired");
  }
  results.set(id, value);
  return value;
}

export function restoreSearches(entries: SessionEntry[], now = Date.now()): void {
  results.clear();
  for (const entry of entries) {
    if (
      entry.type === "custom" &&
      entry.customType === "wildbuzzard-web-search" &&
      isStoredSearch(entry.data) &&
      entry.data.expiresAt > now
    ) {
      results.set(entry.data.id, entry.data);
      persistStoredSearch(entry.data);
    }
  }
}

export function purgeExpired(now = Date.now()): void {
  for (const [id, value] of results) {
    if (value.expiresAt <= now) {
      results.delete(id);
    }
  }
  deleteExpiredStoredSearches(now);
}

function normalized(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function trigrams(value: string): Set<string> {
  const padded = `  ${normalized(value)}  `;
  const grams = new Set<string>();
  for (let index = 0; index + 3 <= padded.length; index++) {
    grams.add(padded.slice(index, index + 3));
  }
  return grams;
}

function similarity(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) {
    return 0;
  }
  let intersection = 0;
  for (const value of left) {
    if (right.has(value)) {
      intersection++;
    }
  }
  return (2 * intersection) / (left.size + right.size);
}

function fuzzyIndex(content: string, needle: string): number {
  const target = trigrams(needle);
  const width = Math.max(needle.length * 2, 160);
  const step = Math.max(40, Math.floor(width / 3));
  let best = { index: -1, score: 0 };
  for (let index = 0; index < content.length; index += step) {
    const score = similarity(target, trigrams(content.slice(index, index + width)));
    if (score > best.score) {
      best = { index, score };
    }
  }
  return best.score >= 0.42 ? best.index : -1;
}

function passage(
  content: string,
  needle: string
): { index: number; mode: PassageMode; text: string } {
  let index = content.indexOf(needle);
  let mode: PassageMode = "exact";
  if (index < 0) {
    index = content.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase());
    mode = "case-insensitive";
  }
  if (index < 0) {
    index = fuzzyIndex(content, needle);
    mode = "fuzzy";
  }
  if (index < 0) {
    return { index: -1, mode: "none", text: "" };
  }
  const start = Math.max(0, index - 240);
  const end = Math.min(content.length, index + needle.length + 760);
  return { index, mode, text: content.slice(start, end) };
}

export function pageStoredSearch(
  value: StoredSearch,
  options: {
    query?: string;
    url?: string;
    offset?: number;
    limit?: number;
    findText?: string[];
  }
): {
  responseId: string;
  offset: number;
  limit: number;
  totalCharacters: number;
  content: string;
  passages: Array<{
    findText: string;
    index: number;
    mode: PassageMode;
    text: string;
  }>;
} {
  if (options.query && options.url) {
    throw new Error("Select at most one of query or url");
  }
  const selected = value.queries
    ? options.query
      ? value.queries.filter(item => item.query === options.query)
      : options.url
        ? value.queries
            .map(item => ({
              ...item,
              results: item.results.filter(result => result.url === options.url),
            }))
            .filter(item => item.results.length)
        : value.queries
    : options.query
      ? []
      : options.url
        ? value.documents?.filter(
            item => item.url === options.url || item.finalUrl === options.url
          ) ?? []
        : value.documents ?? [];
  if (!selected.length) {
    throw new Error("No stored content matched the requested query or URL");
  }
  const serialized = JSON.stringify(selected, null, 2);
  const offset = options.offset ?? 0;
  const limit = options.limit ?? MAX_PAGE_CHARS;
  if (!Number.isInteger(offset) || offset < 0 || offset > serialized.length) {
    throw new Error("offset is outside the stored content");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_CHARS) {
    throw new Error(`limit must be an integer from 1 to ${MAX_PAGE_CHARS}`);
  }
  const needles = options.findText ?? [];
  if (needles.length > 10) {
    throw new Error("findText accepts at most 10 values");
  }
  const passages = needles.map(value => {
    if (typeof value !== "string" || !value.trim() || value.length > 500) {
      throw new Error(
        "findText values must be non-empty strings up to 500 characters"
      );
    }
    return { findText: value, ...passage(serialized, value) };
  });
  return {
    responseId: value.id,
    offset,
    limit,
    totalCharacters: serialized.length,
    content: serialized.slice(offset, offset + limit),
    passages,
  };
}

export function clearStoredSearches(): void {
  results.clear();
  clearStoredSearchDatabase();
}
