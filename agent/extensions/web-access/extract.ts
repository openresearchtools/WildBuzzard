/* SPDX-License-Identifier: AGPL-3.0-or-later */
/* Derived from pi-web-access. Copyright (c) 2025 Nico Bailon. */

import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import {
  appendDeclaredWebLinks,
  discoverDeclaredWebLinks,
} from "./declared-web-links.ts";
import {
  renderWithGecko,
  type GeckoRenderOptions,
} from "./gecko-client.ts";
import { extractPdfDataUrl } from "./pdf-extract.ts";
import { extractRSCContent } from "./rsc-extract.ts";

export type FetchMode = "readable" | "raw" | "answer";

export interface FetchInput {
  url?: string;
  urls?: string[];
  forceClone?: boolean;
  mode?: FetchMode;
  prompt?: string;
  answerModel?: string;
  timestamp?: string;
  frames?: number;
}

export interface ExtractedContent {
  url: string;
  finalUrl: string;
  title: string;
  content: string;
  error: string | null;
  mimeType: string;
  status: number;
  provenance: "gecko" | "github-clone" | "youtube-captions" | "pdf";
}

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});

function normalizeUrls(input: FetchInput): string[] {
  const hasUrl = input.url !== undefined;
  const hasUrls = input.urls !== undefined;
  if (hasUrl === hasUrls) {
    throw new Error("Provide exactly one of url or urls");
  }
  const values = hasUrl ? [input.url] : input.urls;
  if (!Array.isArray(values) || !values.length || values.length > 20) {
    throw new Error("urls must contain from 1 to 20 URLs");
  }
  return values.map((value, index) => {
    if (typeof value !== "string" || !value.trim() || value.length > 4_096) {
      throw new Error(`URL ${index + 1} is invalid`);
    }
    let url: URL;
    try {
      url = new URL(value.trim());
    } catch {
      throw new Error(`URL ${index + 1} is invalid`);
    }
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password
    ) {
      throw new Error(`URL ${index + 1} must be an HTTP(S) URL without userinfo`);
    }
    return url.toString();
  });
}

export function normalizeFetchInput(input: FetchInput): {
  urls: string[];
  mode: FetchMode;
  forceClone: boolean;
  prompt?: string;
  answerModel?: string;
  timestamp?: string;
  frames?: number;
} {
  const urls = normalizeUrls(input);
  const mode = input.mode ?? "readable";
  if (!["readable", "raw", "answer"].includes(mode)) {
    throw new Error("mode must be readable, raw, or answer");
  }
  if (
    input.frames !== undefined &&
    (!Number.isInteger(input.frames) || input.frames < 1 || input.frames > 12)
  ) {
    throw new Error("frames must be an integer from 1 to 12");
  }
  if (
    mode === "raw" &&
    (input.forceClone ||
      input.prompt !== undefined ||
      input.answerModel !== undefined ||
      input.timestamp !== undefined ||
      input.frames !== undefined)
  ) {
    throw new Error(
      "raw mode cannot combine with clone, prompt, answerModel, timestamp, or frames"
    );
  }
  if (mode === "answer" && !input.prompt?.trim()) {
    throw new Error("answer mode requires prompt");
  }
  if (
    mode === "readable" &&
    (input.prompt !== undefined || input.answerModel !== undefined)
  ) {
    throw new Error("prompt and answerModel require answer mode");
  }
  return {
    urls,
    mode,
    forceClone: input.forceClone ?? false,
    prompt: input.prompt?.trim(),
    answerModel: input.answerModel?.trim(),
    timestamp: input.timestamp?.trim(),
    frames: input.frames,
  };
}

function textTitle(content: string, url: string): string {
  return (
    content
      .split(/\r?\n/)
      .map(line => line.trim())
      .find(Boolean)
      ?.slice(0, 500) ?? new URL(url).hostname
  );
}

export function readableHTML(
  html: string,
  url: string
): { title: string; content: string } {
  const { document } = parseHTML(html);
  const documentTitle = document.title?.trim().slice(0, 500) ?? "";
  const links = discoverDeclaredWebLinks(
    document as unknown as Document,
    url
  );
  const rsc = extractRSCContent(html);
  if (rsc) {
    return {
      title: rsc.title || documentTitle || new URL(url).hostname,
      content: appendDeclaredWebLinks(rsc.content, links).slice(0, 2_000_000),
    };
  }
  const reader = new Readability(document as unknown as Document);
  const article = reader.parse();
  if (!article || typeof article.content !== "string") {
    const body = document.body?.textContent?.replace(/\s+/g, " ").trim() ?? "";
    if (!body) {
      throw new Error("Could not extract readable content from the rendered page");
    }
    return {
      title: documentTitle || new URL(url).hostname,
      content: appendDeclaredWebLinks(body, links).slice(0, 2_000_000),
    };
  }
  return {
    title: article.title?.trim().slice(0, 500) || documentTitle || new URL(url).hostname,
    content: appendDeclaredWebLinks(
      turndown.turndown(article.content),
      links
    ).slice(0, 2_000_000),
  };
}

export async function fetchWithGecko(
  url: string,
  mode: Exclude<FetchMode, "answer">,
  cwd: string,
  sessionId: string,
  signal?: AbortSignal,
  renderOptions: GeckoRenderOptions = {}
): Promise<ExtractedContent> {
  try {
    const rendered = await renderWithGecko(
      url,
      renderOptions,
      cwd,
      sessionId,
      signal
    );
    if (rendered.pageError) {
      return {
        url,
        finalUrl: rendered.finalUrl,
        title: "",
        content: "",
        error: rendered.pageError.slice(0, 1_000),
        mimeType: rendered.contentType,
        status: rendered.pageStatusCode,
        provenance: "gecko",
      };
    }
    const mimeType = rendered.contentType.split(";", 1)[0].trim().toLowerCase();
    if (mode === "raw") {
      return {
        url,
        finalUrl: rendered.finalUrl,
        title: textTitle(rendered.content, rendered.finalUrl),
        content: rendered.content,
        error: null,
        mimeType,
        status: rendered.pageStatusCode,
        provenance: "gecko",
      };
    }
    if (mimeType === "text/html" || mimeType === "application/xhtml+xml") {
      const extracted = readableHTML(rendered.content, rendered.finalUrl);
      return {
        url,
        finalUrl: rendered.finalUrl,
        ...extracted,
        error: null,
        mimeType,
        status: rendered.pageStatusCode,
        provenance: "gecko",
      };
    }
    if (mimeType === "application/pdf") {
      const extracted = await extractPdfDataUrl(rendered.content);
      return {
        url,
        finalUrl: rendered.finalUrl,
        title: new URL(rendered.finalUrl).pathname.split("/").pop() || "PDF document",
        content: extracted.content,
        error: extracted.content ? null : "The PDF contains no extractable text",
        mimeType,
        status: rendered.pageStatusCode,
        provenance: "pdf",
      };
    }
    if (
      mimeType.startsWith("text/") ||
      mimeType === "application/json" ||
      mimeType.endsWith("+json") ||
      mimeType === "application/xml" ||
      mimeType.endsWith("+xml")
    ) {
      return {
        url,
        finalUrl: rendered.finalUrl,
        title: textTitle(rendered.content, rendered.finalUrl),
        content: rendered.content,
        error: null,
        mimeType,
        status: rendered.pageStatusCode,
        provenance: "gecko",
      };
    }
    return {
      url,
      finalUrl: rendered.finalUrl,
      title: "",
      content: "",
      error: `Unsupported rendered content type: ${mimeType || "unknown"}`,
      mimeType,
      status: rendered.pageStatusCode,
      provenance: "gecko",
    };
  } catch (error) {
    return {
      url,
      finalUrl: url,
      title: "",
      content: "",
      error: error instanceof Error ? error.message.slice(0, 1_000) : String(error),
      mimeType: "",
      status: 0,
      provenance: "gecko",
    };
  }
}
