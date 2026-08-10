/* SPDX-License-Identifier: AGPL-3.0-or-later */
/* Derived from pi-web-access. Copyright (c) 2025 Nico Bailon. */

import {
  buildSearchQuery,
  matchesDomainFilters,
  sanitizeStructuredValue,
  type NormalizedSearchInput,
  type QueryResponse,
  type SearchResult,
} from "./contracts.ts";
import { requestSearchService } from "./connection.ts";

interface RawResult {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  engines?: unknown;
  score?: unknown;
  publishedDate?: unknown;
  published_date?: unknown;
}

interface RawResponse {
  results?: unknown;
  answers?: unknown;
  corrections?: unknown;
  suggestions?: unknown;
  unresponsive_engines?: unknown;
}

function text(value: unknown, fallback: string, max: number): string {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, max)
    : fallback;
}

function stringArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map(item => item.trim().slice(0, 128))
    .filter(Boolean)
    .slice(0, limit);
}

function structuredArray(value: unknown): unknown[] {
  const source = Array.isArray(value)
    ? value
    : value === undefined
      ? []
      : [value];
  return source.slice(0, 50).map(item => sanitizeStructuredValue(item));
}

function normalizeResult(
  value: unknown,
  includeContent: boolean
): SearchResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = value as RawResult;
  if (typeof raw.url !== "string") {
    return null;
  }
  let url: URL;
  try {
    url = new URL(raw.url);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }
  const snippet = text(raw.content, "", 4_000);
  const score =
    typeof raw.score === "number" && Number.isFinite(raw.score)
      ? raw.score
      : null;
  const dateValue = raw.publishedDate ?? raw.published_date;
  const date = typeof dateValue === "string" ? dateValue.slice(0, 128) : null;
  return {
    title: text(raw.title, url.toString(), 500),
    url: url.toString().slice(0, 4_096),
    snippet,
    engines: stringArray(raw.engines, 16),
    score,
    date,
    ...(includeContent && snippet ? { contentPreview: snippet } : {}),
  };
}

export async function searchSearXNG(
  query: string,
  input: NormalizedSearchInput,
  signal?: AbortSignal
): Promise<QueryResponse> {
  const form = new URLSearchParams({
    q: buildSearchQuery(query, input.domains),
    format: "json",
  });
  if (input.recencyFilter) {
    form.set("time_range", input.recencyFilter);
  }
  const response = await requestSearchService(
    "/search",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    },
    signal
  );
  let raw: RawResponse;
  try {
    raw = (await response.json()) as RawResponse;
  } catch {
    throw new Error("WildBuzzard search service returned invalid JSON");
  }
  const rawResults = Array.isArray(raw.results) ? raw.results : [];
  const results: SearchResult[] = [];
  for (const value of rawResults) {
    const result = normalizeResult(value, input.includeContent);
    if (!result || !matchesDomainFilters(result.url, input.domains)) {
      continue;
    }
    results.push(result);
    if (results.length === input.numResults) {
      break;
    }
  }
  return {
    query,
    answers: structuredArray(raw.answers),
    corrections: structuredArray(raw.corrections),
    suggestions: structuredArray(raw.suggestions),
    unresponsiveEngines: structuredArray(raw.unresponsive_engines),
    results,
  };
}
