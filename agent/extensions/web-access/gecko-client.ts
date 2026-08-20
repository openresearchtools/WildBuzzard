/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { callBrowserTool } from "./wildbuzzard-cli.ts";

export interface GeckoRenderOptions {
  waitMs?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
  blockDomains?: string[];
  allowedOrigins?: string[];
  allowSubdomains?: boolean;
  waitForSelector?: string;
  javascript?: boolean;
  maxBytes?: number;
  maxRedirects?: number;
}

export interface GeckoRenderResult {
  content: string;
  pageStatusCode: number;
  pageError: string | null;
  contentType: string;
  finalUrl: string;
  redirectCount: number;
  decodedBytes: number;
}

export const MAX_GECKO_RENDER_BYTES = 32 * 1024 * 1024;
export const MAX_GECKO_RENDER_REDIRECTS = 10;

function validateResult(value: unknown): GeckoRenderResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Gecko renderer returned an invalid response");
  }
  const result = value as Partial<GeckoRenderResult>;
  if (
    typeof result.content !== "string" ||
    result.content.length > 8 * 1024 * 1024 ||
    !Number.isInteger(result.pageStatusCode) ||
    Number(result.pageStatusCode) < 0 ||
    Number(result.pageStatusCode) > 999 ||
    (result.pageError !== null &&
      (typeof result.pageError !== "string" ||
        result.pageError.length > 1_000)) ||
    typeof result.contentType !== "string" ||
    result.contentType.length > 512 ||
    typeof result.finalUrl !== "string" ||
    result.finalUrl.length > 8_192 ||
    !Number.isInteger(result.redirectCount) ||
    Number(result.redirectCount) < 0 ||
    Number(result.redirectCount) > MAX_GECKO_RENDER_REDIRECTS ||
    !Number.isInteger(result.decodedBytes) ||
    Number(result.decodedBytes) < 0 ||
    Number(result.decodedBytes) > MAX_GECKO_RENDER_BYTES
  ) {
    throw new Error("Gecko renderer returned an invalid response");
  }
  let finalUrl: URL;
  try {
    finalUrl = new URL(result.finalUrl);
  } catch {
    throw new Error("Gecko renderer returned an invalid final URL");
  }
  if (
    (finalUrl.protocol !== "http:" && finalUrl.protocol !== "https:") ||
    finalUrl.username ||
    finalUrl.password
  ) {
    throw new Error("Gecko renderer returned an unsafe final URL");
  }
  return result as GeckoRenderResult;
}

export async function renderWithGecko(
  url: string,
  options: GeckoRenderOptions,
  cwd: string,
  sessionId: string,
  signal?: AbortSignal
): Promise<GeckoRenderResult> {
  const response = await callBrowserTool(
    "gecko_render",
    { url, ...options },
    cwd,
    `web-access:${sessionId}`,
    signal
  );
  return validateResult(response.details);
}
