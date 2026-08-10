/* SPDX-License-Identifier: AGPL-3.0-or-later */

export const MAX_BATCH_QUERIES = 4;
export const MAX_RESULTS = 20;
export const DEFAULT_RESULTS = 5;
export const RESULT_TTL_MS = 60 * 60 * 1000;
export const MAX_PAGE_CHARS = 30_000;

export type RecencyFilter = "day" | "week" | "month" | "year";

export interface WebSearchInput {
  query?: string;
  queries?: string[];
  numResults?: number;
  includeContent?: boolean;
  recencyFilter?: RecencyFilter;
  domainFilter?: string[];
  provider?: "auto" | "searxng";
  workflow?: "none";
}

export interface DomainFilters {
  included: string[];
  excluded: string[];
}

export interface NormalizedSearchInput {
  queries: string[];
  numResults: number;
  includeContent: boolean;
  recencyFilter?: RecencyFilter;
  domains: DomainFilters;
  provider: "searxng";
  workflow: "none";
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  engines: string[];
  score: number | null;
  date: string | null;
  contentPreview?: string;
}

export interface QueryResponse {
  query: string;
  answers: unknown[];
  corrections: unknown[];
  suggestions: unknown[];
  unresponsiveEngines: unknown[];
  results: SearchResult[];
}

function boundedText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} cannot be empty`);
  }
  if (normalized.length > max) {
    throw new Error(`${label} is too long`);
  }
  return normalized;
}

function normalizeDomain(value: string): string | null {
  let input = value.trim().toLowerCase();
  if (input.startsWith("-")) {
    input = input.slice(1).trim();
  }
  if (!input || input.length > 253) {
    return null;
  }
  try {
    const parsed = new URL(input.includes("://") ? input : `https://${input}`);
    if (parsed.username || parsed.password) {
      return null;
    }
    input = parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
  input = input.replace(/^\.+|\.+$/g, "");
  if (
    !input.includes(".") ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(input)
  ) {
    return null;
  }
  return input;
}

export function normalizeDomainFilters(values: string[] = []): DomainFilters {
  if (!Array.isArray(values) || values.length > 32) {
    throw new Error("domainFilter accepts at most 32 domains");
  }
  const filters: DomainFilters = { included: [], excluded: [] };
  for (const value of values) {
    if (typeof value !== "string") {
      throw new Error("domainFilter entries must be strings");
    }
    const domain = normalizeDomain(value);
    if (!domain) {
      throw new Error(`Invalid domain filter: ${value}`);
    }
    const destination = value.trim().startsWith("-")
      ? filters.excluded
      : filters.included;
    if (!destination.includes(domain)) {
      destination.push(domain);
    }
  }
  return filters;
}

export function normalizeSearchInput(
  input: WebSearchInput
): NormalizedSearchInput {
  const hasQuery = input.query !== undefined;
  const hasQueries = input.queries !== undefined;
  if (hasQuery === hasQueries) {
    throw new Error("Provide exactly one of query or queries");
  }
  const queries = hasQuery
    ? [boundedText(input.query, "query", 2_000)]
    : (() => {
        if (!Array.isArray(input.queries) || !input.queries.length) {
          throw new Error("queries must contain at least one query");
        }
        if (input.queries.length > MAX_BATCH_QUERIES) {
          throw new Error(`queries accepts at most ${MAX_BATCH_QUERIES} items`);
        }
        return input.queries.map((value, index) =>
          boundedText(value, `queries[${index}]`, 2_000)
        );
      })();
  const numResults = input.numResults ?? DEFAULT_RESULTS;
  if (
    !Number.isInteger(numResults) ||
    numResults < 1 ||
    numResults > MAX_RESULTS
  ) {
    throw new Error(`numResults must be an integer from 1 to ${MAX_RESULTS}`);
  }
  if (
    input.includeContent !== undefined &&
    typeof input.includeContent !== "boolean"
  ) {
    throw new Error("includeContent must be a boolean");
  }
  if (
    input.recencyFilter !== undefined &&
    !["day", "week", "month", "year"].includes(input.recencyFilter)
  ) {
    throw new Error("recencyFilter must be day, week, month, or year");
  }
  if (
    input.provider !== undefined &&
    !["auto", "searxng"].includes(input.provider)
  ) {
    throw new Error("provider must be auto or searxng");
  }
  if (input.workflow !== undefined && input.workflow !== "none") {
    throw new Error("workflow must be none");
  }
  return {
    queries,
    numResults,
    includeContent: input.includeContent ?? false,
    recencyFilter: input.recencyFilter,
    domains: normalizeDomainFilters(input.domainFilter),
    provider: "searxng",
    workflow: "none",
  };
}

export function buildSearchQuery(
  query: string,
  filters: DomainFilters
): string {
  const parts = [query];
  if (filters.included.length === 1) {
    parts.push(`site:${filters.included[0]}`);
  } else if (filters.included.length > 1) {
    parts.push(
      `(${filters.included.map(domain => `site:${domain}`).join(" OR ")})`
    );
  }
  parts.push(...filters.excluded.map(domain => `-site:${domain}`));
  return parts.join(" ");
}

export function matchesDomainFilters(
  rawUrl: string,
  filters: DomainFilters
): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password
  ) {
    return false;
  }
  const hostname = url.hostname.toLowerCase();
  const matches = (domain: string) =>
    hostname === domain || hostname.endsWith(`.${domain}`);
  if (filters.included.length && !filters.included.some(matches)) {
    return false;
  }
  return !filters.excluded.some(matches);
}

export function sanitizeStructuredValue(value: unknown, depth = 0): unknown {
  if (depth > 5 || value === null) {
    return value === null ? null : "[truncated]";
  }
  if (typeof value === "string") {
    return value.slice(0, 4_000);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 50)
      .map(item => sanitizeStructuredValue(item, depth + 1));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 50)
        .map(([key, item]) => [
          key.slice(0, 128),
          sanitizeStructuredValue(item, depth + 1),
        ])
    );
  }
  return null;
}
