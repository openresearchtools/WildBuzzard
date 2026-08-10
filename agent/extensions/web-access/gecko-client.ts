/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { callBrowserTool } from "../browser-tools/bridge-client.ts";

export interface GeckoRenderOptions {
  waitMs?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
  blockDomains?: string[];
  waitForSelector?: string;
}

export interface GeckoRenderResult {
  content: string;
  pageStatusCode: number;
  pageError: string | null;
  contentType: string;
  finalUrl: string;
}

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
    (result.pageError !== null && typeof result.pageError !== "string") ||
    typeof result.contentType !== "string" ||
    typeof result.finalUrl !== "string"
  ) {
    throw new Error("Gecko renderer returned an invalid response");
  }
  let finalUrl: URL;
  try {
    finalUrl = new URL(result.finalUrl);
  } catch {
    throw new Error("Gecko renderer returned an invalid final URL");
  }
  if (finalUrl.protocol !== "http:" && finalUrl.protocol !== "https:") {
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
