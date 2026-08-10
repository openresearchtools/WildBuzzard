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

const MAX_SEARCH_RESPONSE_BYTES = 4 * 1024 * 1024;

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

function structuredArray(value: unknown, field: string): unknown[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`WildBuzzard search service returned invalid ${field}`);
  }
  return value.slice(0, 50).map(item => sanitizeStructuredValue(item));
}

function normalizeResult(
  value: unknown,
  includeContent: boolean
): SearchResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = value as RawResult;
  if (typeof raw.url !== "string" || raw.url.length > 4_096) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(raw.url);
  } catch {
    return null;
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password
  ) {
    return null;
  }
  const normalizedUrl = url.toString();
  if (normalizedUrl.length > 4_096) {
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
    title: text(raw.title, normalizedUrl, 500),
    url: normalizedUrl,
    snippet,
    engines: stringArray(raw.engines, 16),
    score,
    date,
    ...(includeContent && snippet ? { contentPreview: snippet } : {}),
  };
}

async function readResponse(
  response: Response,
  signal?: AbortSignal
): Promise<RawResponse> {
  if (
    !/^application\/json(?:;|$)/i.test(
      response.headers.get("content-type") ?? ""
    )
  ) {
    await response.body?.cancel().catch(() => {});
    throw new Error("WildBuzzard search service returned a non-JSON response");
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_SEARCH_RESPONSE_BYTES
  ) {
    await response.body?.cancel().catch(() => {});
    throw new Error(
      "WildBuzzard search service response exceeded the byte limit"
    );
  }
  if (!response.body) {
    throw new Error("WildBuzzard search service returned an empty response");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let source = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      bytes += value.byteLength;
      if (bytes > MAX_SEARCH_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error(
          "WildBuzzard search service response exceeded the byte limit"
        );
      }
      source += decoder.decode(value, { stream: true });
    }
    source += decoder.decode();
  } catch (error) {
    if (error instanceof Error && error.message.includes("byte limit")) {
      throw error;
    }
    if (signal?.aborted) {
      throw new Error("WildBuzzard search service request was cancelled");
    }
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(
        "WildBuzzard search service request was cancelled or timed out"
      );
    }
    throw new Error("WildBuzzard search service returned invalid JSON");
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("WildBuzzard search service returned invalid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("WildBuzzard search service returned invalid JSON");
  }
  const raw = value as RawResponse;
  if (!Array.isArray(raw.results)) {
    throw new Error("WildBuzzard search service returned invalid results");
  }
  return raw;
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
  const raw = await readResponse(response, signal);
  const rawResults = raw.results as unknown[];
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
    answers: structuredArray(raw.answers, "answers"),
    corrections: structuredArray(raw.corrections, "corrections"),
    suggestions: structuredArray(raw.suggestions, "suggestions"),
    unresponsiveEngines: structuredArray(
      raw.unresponsive_engines,
      "unresponsive_engines"
    ),
    results,
  };
}

export async function searchSearXBatch(
  queries: string[],
  input: NormalizedSearchInput,
  signal?: AbortSignal,
  search: typeof searchSearXNG = searchSearXNG
): Promise<QueryResponse[]> {
  if (signal?.aborted) {
    throw new Error("Web search was cancelled");
  }
  const controller = new AbortController();
  const combined = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  try {
    return await Promise.all(
      queries.map(query => search(query, input, combined))
    );
  } catch (error) {
    controller.abort(new Error("Web search batch failed"));
    throw error;
  }
}
