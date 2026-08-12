/* SPDX-License-Identifier: AGPL-3.0-or-later */
/* Derived from pi-web-access. Copyright (c) 2025 Nico Bailon. */

import { callBrowserTool } from "../browser-tools/bridge-client.ts";
import {
  buildSearchQuery,
  matchesDomainFilters,
  sanitizeStructuredValue,
  type NormalizedSearchInput,
  type QueryResponse,
  type SearchResult,
} from "./contracts.ts";
import { redactSensitiveText } from "./safe-output.ts";

export interface NativeSearchRequest {
  query: string;
  engines?: string[];
  language?: string;
  page?: number;
  timeRange?: "day" | "week" | "month" | "year";
  safeSearch?: 1;
  maxResults?: number;
}

interface NativeSearchDiagnostics {
  catalogSha256: string;
  totalEntries: number;
  eligibleEntries: number;
  totalModules: number;
  eligibleModules: number;
  attemptedEngines: string[];
  completedEngines: string[];
}

interface RawResult {
  title?: string;
  url: string;
  content?: string;
  engines?: string[];
  score?: number | null;
  publishedDate?: string | null;
}

interface NativeSearchResponse {
  schema: 1;
  implementation: "bundled-searxng";
  query: string;
  results: RawResult[];
  answers: unknown[];
  corrections: unknown[];
  suggestions: unknown[];
  infoboxes: unknown[];
  unresponsiveEngines: unknown[];
  diagnostics: NativeSearchDiagnostics;
}

type BrowserCall = typeof callBrowserTool;

const RESPONSE_FIELDS = new Set([
  "answers",
  "corrections",
  "diagnostics",
  "implementation",
  "infoboxes",
  "query",
  "results",
  "schema",
  "suggestions",
  "unresponsiveEngines",
]);
const DIAGNOSTIC_FIELDS = new Set([
  "attemptedEngines",
  "catalogSha256",
  "completedEngines",
  "eligibleEntries",
  "eligibleModules",
  "totalEntries",
  "totalModules",
]);
const RESULT_FIELDS = new Set([
  "content",
  "engines",
  "publishedDate",
  "score",
  "title",
  "url",
]);
const MAX_CATALOG_ENTRIES = 4_096;
const MAX_STRUCTURED_ITEMS = 50;

function recordWithFields(
  value: unknown,
  fields: Set<string>,
  exact: boolean
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const names = Object.keys(value);
  return (
    (!exact || names.length === fields.size) &&
    names.every(name => fields.has(name))
  );
}

function stringArray(
  value: unknown,
  field: string,
  limit: number,
  itemLimit: number
): string[] {
  if (!Array.isArray(value) || value.length > limit) {
    throw new Error(`Native search returned invalid ${field}`);
  }
  const result: string[] = [];
  for (const item of value) {
    if (
      typeof item !== "string" ||
      !item.trim() ||
      item.length > itemLimit ||
      result.includes(item)
    ) {
      throw new Error(`Native search returned invalid ${field}`);
    }
    result.push(item);
  }
  return result;
}

function structuredArray(
  value: unknown,
  field: string,
  limit = MAX_STRUCTURED_ITEMS
): unknown[] {
  if (!Array.isArray(value) || value.length > limit) {
    throw new Error(`Native search returned invalid ${field}`);
  }
  return value.map(item => sanitizeStructuredValue(item));
}

function validateDiagnostics(value: unknown): NativeSearchDiagnostics {
  if (!recordWithFields(value, DIAGNOSTIC_FIELDS, true)) {
    throw new Error("Native search returned invalid diagnostics");
  }
  const totalEntries = value.totalEntries;
  const eligibleEntries = value.eligibleEntries;
  const totalModules = value.totalModules;
  const eligibleModules = value.eligibleModules;
  if (
    typeof value.catalogSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.catalogSha256) ||
    !Number.isInteger(totalEntries) ||
    Number(totalEntries) < 1 ||
    Number(totalEntries) > MAX_CATALOG_ENTRIES ||
    !Number.isInteger(eligibleEntries) ||
    Number(eligibleEntries) < 1 ||
    Number(eligibleEntries) > Number(totalEntries) ||
    !Number.isInteger(totalModules) ||
    Number(totalModules) < 1 ||
    Number(totalModules) > MAX_CATALOG_ENTRIES ||
    !Number.isInteger(eligibleModules) ||
    Number(eligibleModules) < 1 ||
    Number(eligibleModules) > Number(totalModules)
  ) {
    throw new Error("Native search returned invalid diagnostics");
  }
  const attemptedEngines = stringArray(
    value.attemptedEngines,
    "attempted engines",
    Number(eligibleEntries),
    128
  );
  const completedEngines = stringArray(
    value.completedEngines,
    "completed engines",
    Number(eligibleEntries),
    128
  );
  if (completedEngines.some(engine => !attemptedEngines.includes(engine))) {
    throw new Error("Native search returned invalid diagnostics");
  }
  return {
    catalogSha256: value.catalogSha256,
    totalEntries: Number(totalEntries),
    eligibleEntries: Number(eligibleEntries),
    totalModules: Number(totalModules),
    eligibleModules: Number(eligibleModules),
    attemptedEngines,
    completedEngines,
  };
}

function validateRawResult(value: unknown): RawResult {
  if (!recordWithFields(value, RESULT_FIELDS, false)) {
    throw new Error("Native search returned invalid results");
  }
  if (
    typeof value.url !== "string" ||
    value.url.length > 4_096 ||
    (value.title !== undefined &&
      (typeof value.title !== "string" || value.title.length > 500)) ||
    (value.content !== undefined &&
      (typeof value.content !== "string" || value.content.length > 4_000)) ||
    (value.score !== undefined &&
      value.score !== null &&
      (typeof value.score !== "number" || !Number.isFinite(value.score))) ||
    (value.publishedDate !== undefined &&
      value.publishedDate !== null &&
      (typeof value.publishedDate !== "string" ||
        value.publishedDate.length > 128))
  ) {
    throw new Error("Native search returned invalid results");
  }
  const engines =
    value.engines === undefined
      ? undefined
      : stringArray(value.engines, "result engines", 16, 128);
  return {
    url: value.url,
    ...(value.title !== undefined ? { title: value.title } : {}),
    ...(value.content !== undefined ? { content: value.content } : {}),
    ...(engines !== undefined ? { engines } : {}),
    ...(value.score !== undefined ? { score: value.score } : {}),
    ...(value.publishedDate !== undefined
      ? { publishedDate: value.publishedDate }
      : {}),
  };
}

function validateResponse(
  value: unknown,
  request: NativeSearchRequest
): NativeSearchResponse {
  if (!recordWithFields(value, RESPONSE_FIELDS, true)) {
    throw new Error("Native search returned an invalid response");
  }
  if (
    value.schema !== 1 ||
    value.implementation !== "bundled-searxng" ||
    value.query !== request.query ||
    !Array.isArray(value.results) ||
    value.results.length > (request.maxResults ?? 20)
  ) {
    throw new Error("Native search returned an invalid response");
  }
  const diagnostics = validateDiagnostics(value.diagnostics);
  return {
    schema: 1,
    implementation: "bundled-searxng",
    query: request.query,
    results: value.results.map(validateRawResult),
    answers: structuredArray(value.answers, "answers"),
    corrections: structuredArray(value.corrections, "corrections"),
    suggestions: structuredArray(value.suggestions, "suggestions"),
    infoboxes: structuredArray(value.infoboxes, "infoboxes"),
    unresponsiveEngines: structuredArray(
      value.unresponsiveEngines,
      "unresponsive engines",
      diagnostics.eligibleEntries
    ),
    diagnostics,
  };
}

function normalizeResult(
  raw: RawResult,
  includeContent: boolean
): SearchResult | null {
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
  for (const name of [...url.searchParams.keys()]) {
    if (
      /^(?:access_token|api[-_]?key|apikey|auth|authorization|key|passkey|password|signature|sig|token)$/i.test(
        name
      )
    ) {
      url.searchParams.delete(name);
    }
  }
  const normalizedUrl = url.toString();
  if (normalizedUrl.length > 4_096) {
    return null;
  }
  const snippet = redactSensitiveText(raw.content?.trim() ?? "", 1_000);
  return {
    title: redactSensitiveText(raw.title?.trim() || normalizedUrl, 500),
    url: normalizedUrl,
    snippet,
    engines: raw.engines ?? [],
    score: raw.score ?? null,
    date:
      typeof raw.publishedDate === "string"
        ? redactSensitiveText(raw.publishedDate, 128)
        : null,
    provenance: "searxng",
    trust: "untrusted",
    ...(includeContent && snippet ? { contentPreview: snippet } : {}),
  };
}

export function nativeSearchRequest(
  query: string,
  input: NormalizedSearchInput
): NativeSearchRequest {
  const request: NativeSearchRequest = {
    query: buildSearchQuery(query, input.domains),
    ...(input.recencyFilter ? { timeRange: input.recencyFilter } : {}),
    safeSearch: 1,
    maxResults: input.numResults,
  };
  if (
    [...request.query].length > 512 ||
    Buffer.byteLength(request.query, "utf8") > 2_048
  ) {
    throw new Error("Native search query exceeds the audited limit");
  }
  return request;
}

export async function searchSearXNG(
  query: string,
  input: NormalizedSearchInput,
  cwd: string,
  sessionId: string,
  signal?: AbortSignal,
  call: BrowserCall = callBrowserTool
): Promise<QueryResponse> {
  const request = nativeSearchRequest(query, input);
  let response;
  try {
    response = await call(
      "native_search",
      request,
      cwd,
      `web-access:${sessionId}`,
      signal
    );
  } catch (error) {
    if (signal?.aborted) {
      throw new Error("Web search was cancelled");
    }
    throw error;
  }
  const raw = validateResponse(response.details, request);
  const results = raw.results
    .map(value => normalizeResult(value, input.includeContent))
    .filter((value): value is SearchResult =>
      Boolean(value && matchesDomainFilters(value.url, input.domains))
    )
    .slice(0, input.numResults);
  return {
    query,
    implementation: raw.implementation,
    diagnostics: raw.diagnostics,
    answers: raw.answers,
    corrections: raw.corrections,
    suggestions: raw.suggestions,
    infoboxes: raw.infoboxes,
    unresponsiveEngines: raw.unresponsiveEngines,
    results,
  };
}

type SearchImplementation = typeof searchSearXNG;

export async function searchSearXBatch(
  queries: string[],
  input: NormalizedSearchInput,
  cwd: string,
  sessionId: string,
  signal?: AbortSignal,
  search: SearchImplementation = searchSearXNG
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
      queries.map(query => search(query, input, cwd, sessionId, combined))
    );
  } catch (error) {
    controller.abort(new Error("Web search batch failed"));
    throw error;
  }
}
