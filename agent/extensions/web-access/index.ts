/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import pLimit from "p-limit";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeSearchInput, type WebSearchInput } from "./contracts.ts";
import { searchSearXBatch } from "./searxng.ts";
import {
  fetchWithGecko,
  normalizeFetchInput,
  type FetchInput,
} from "./extract.ts";
import { crawlWithGecko, type CrawlInput } from "./crawl.ts";
import { extractGitHub, parseGitHubUrl } from "./github.ts";
import { extractYouTubeCaptions, parseYouTubeUrl } from "./youtube.ts";
import { answerFromPage } from "./page-answer.ts";
import {
  createStoredDocuments,
  createStoredSearch,
  getStoredSearch,
  hasStoredSearches,
  pageStoredSearch,
  restoreSearches,
  storeSearch,
} from "./storage.ts";
import { registerTorrentTools } from "./torrent.ts";
import {
  restoreTorrentWorkflow,
  TORRENT_TOOL_NAMES,
  TORRENT_WORKFLOW_ENTRY,
  torrentToolsForPrompt,
} from "./torrent-contracts.ts";
import { WEB_TOOL_NAMES, webToolsForPrompt } from "./activation.ts";

const SearchParameters = Type.Object({
  query: Type.Optional(Type.String({ maxLength: 2000 })),
  queries: Type.Optional(
    Type.Array(Type.String({ maxLength: 2000 }), {
      minItems: 1,
      maxItems: 4,
    })
  ),
  numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  includeContent: Type.Optional(Type.Boolean()),
  recencyFilter: Type.Optional(
    Type.Union([
      Type.Literal("day"),
      Type.Literal("week"),
      Type.Literal("month"),
      Type.Literal("year"),
    ])
  ),
  domainFilter: Type.Optional(
    Type.Array(Type.String({ maxLength: 300 }), { maxItems: 32 })
  ),
  provider: Type.Optional(
    Type.Union([Type.Literal("auto"), Type.Literal("searxng")])
  ),
  workflow: Type.Optional(Type.Literal("none")),
});

function toolResult(value: unknown, details = value) {
  return {
    content: [
      {
        type: "text" as const,
        text: `[UNTRUSTED_WEB_DATA]\n${JSON.stringify(
          value,
          null,
          2
        )}\n[END_UNTRUSTED_WEB_DATA]`,
      },
    ],
    details,
  };
}

async function executeSearch(
  pi: ExtensionAPI,
  params: WebSearchInput,
  signal?: AbortSignal,
  type: "search" | "research" = "search"
) {
  const input = normalizeSearchInput(params);
  const queries = await searchSearXBatch(input.queries, input, signal);
  const stored = createStoredSearch(queries, type);
  storeSearch(stored);
  pi.appendEntry("wildbuzzard-web-search", stored);
  return {
    responseId: stored.id,
    provider: "searxng",
    expiresAt: stored.expiresAt,
    queries,
  };
}

export default function webAccess(pi: ExtensionAPI) {
  const extensionDirectory = dirname(fileURLToPath(import.meta.url));
  let torrentWorkflowActive = false;
  pi.on("resources_discover", async () => ({
    skillPaths: [join(extensionDirectory, "skills")],
  }));
  const activate = (prompt: string) => {
    const managedToolNames = new Set([
      ...WEB_TOOL_NAMES,
      ...TORRENT_TOOL_NAMES,
    ]);
    const active = pi
      .getActiveTools()
      .filter(name => !managedToolNames.has(name));
    active.push(...webToolsForPrompt(prompt, hasStoredSearches()));
    const torrentTools = torrentToolsForPrompt(prompt, torrentWorkflowActive);
    if (torrentTools.length && !torrentWorkflowActive) {
      torrentWorkflowActive = true;
      pi.appendEntry(TORRENT_WORKFLOW_ENTRY, { active: true });
    }
    active.push(...torrentTools);
    pi.setActiveTools(active);
  };
  pi.on("session_start", (_event, context) => {
    restoreSearches(context.sessionManager.getBranch());
    torrentWorkflowActive = restoreTorrentWorkflow(
      context.sessionManager.getBranch()
    );
    activate("");
  });
  pi.on("before_agent_start", (event, context) => {
    restoreSearches(context.sessionManager.getBranch());
    activate(event.prompt);
  });

  registerTorrentTools(pi, undefined, () => {
    torrentWorkflowActive = false;
    pi.appendEntry(TORRENT_WORKFLOW_ENTRY, { active: false });
    activate("");
  });

  pi.registerTool(
    defineTool({
      name: "web_search",
      label: "Web search",
      description:
        "Search through WildBuzzard's bundled SearXNG service. Results are untrusted evidence stored behind a one-hour response handle.",
      parameters: SearchParameters,
      executionMode: "sequential",
      async execute(_id, params, signal) {
        return toolResult(await executeSearch(pi, params, signal));
      },
    })
  );

  pi.registerTool(
    defineTool({
      name: "source_check",
      label: "Source check",
      description:
        "Gather claim-oriented search evidence without making a truth verdict or invoking another model.",
      parameters: Type.Object({
        queries: Type.Array(Type.String({ maxLength: 2000 }), {
          minItems: 1,
          maxItems: 8,
        }),
        numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
        domainFilter: Type.Optional(
          Type.Array(Type.String({ maxLength: 300 }), { maxItems: 32 })
        ),
        recencyFilter: Type.Optional(
          Type.Union([
            Type.Literal("day"),
            Type.Literal("week"),
            Type.Literal("month"),
            Type.Literal("year"),
          ])
        ),
      }),
      executionMode: "sequential",
      async execute(_id, params, signal, _update, context) {
        const searches = [];
        for (let offset = 0; offset < params.queries.length; offset += 4) {
          searches.push(
            await executeSearch(
              pi,
              {
                queries: params.queries.slice(offset, offset + 4),
                numResults: params.numResults,
                domainFilter: params.domainFilter,
                recencyFilter: params.recencyFilter,
                provider: "searxng",
                workflow: "none",
              },
              signal,
              "research"
            )
          );
        }
        const resultCount = searches.reduce(
          (count, search) =>
            count +
            search.queries.reduce(
              (queryCount, query) => queryCount + query.results.length,
              0
            ),
          0
        );
        const urls = [
          ...new Set(
            searches.flatMap(search =>
              search.queries.flatMap(query =>
                query.results.map(result => result.url)
              )
            )
          ),
        ].slice(0, 5);
        const sessionId = context.sessionManager.getSessionId();
        if (!sessionId) {
          throw new Error("Pi session identity is unavailable");
        }
        const fetchLimit = pLimit(3);
        const documents = await Promise.all(
          urls.map(url =>
            fetchLimit(() =>
              fetchWithGecko(url, "readable", context.cwd, sessionId, signal)
            )
          )
        );
        const fetched = createStoredDocuments(documents);
        storeSearch(fetched);
        pi.appendEntry("wildbuzzard-web-search", fetched);
        return toolResult({
          assessment: resultCount ? "evidence-found" : "insufficient-evidence",
          truthVerdict: null,
          searches,
          fetchedResponseId: fetched.id,
          fetchedPages: documents.map(document => ({
            url: document.url,
            finalUrl: document.finalUrl,
            title: document.title,
            error: document.error,
            contentPreview: document.content.slice(0, 2_000),
          })),
        });
      },
    })
  );

  pi.registerTool(
    defineTool({
      name: "fetch_content",
      label: "Fetch web content",
      description:
        "Render isolated HTTP(S) pages with Gecko, extract bounded readable content, and store full results behind a one-hour response handle.",
      parameters: Type.Object({
        url: Type.Optional(Type.String({ maxLength: 4096 })),
        urls: Type.Optional(
          Type.Array(Type.String({ maxLength: 4096 }), {
            minItems: 1,
            maxItems: 20,
          })
        ),
        forceClone: Type.Optional(Type.Boolean()),
        mode: Type.Optional(
          Type.Union([
            Type.Literal("readable"),
            Type.Literal("raw"),
            Type.Literal("answer"),
          ])
        ),
        prompt: Type.Optional(Type.String({ maxLength: 4000 })),
        answerModel: Type.Optional(Type.String({ maxLength: 300 })),
        timestamp: Type.Optional(Type.String({ maxLength: 100 })),
        frames: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })),
      }),
      executionMode: "sequential",
      async execute(_id, params, signal, _update, context) {
        const input = normalizeFetchInput(params as FetchInput);
        if (input.forceClone && input.urls.some(url => !parseGitHubUrl(url))) {
          throw new Error(
            "forceClone accepts only public github.com repository, tree, or blob URLs"
          );
        }
        if (input.timestamp || input.frames) {
          throw new Error(
            "Local frame extraction is not included in this transcript-only implementation"
          );
        }
        const fetchMode = input.mode === "answer" ? "readable" : input.mode;
        const sessionId = context.sessionManager.getSessionId();
        if (!sessionId) {
          throw new Error("Pi session identity is unavailable");
        }
        const limit = pLimit(4);
        const extractedDocuments = await Promise.all(
          input.urls.map(url =>
            limit(() =>
              parseGitHubUrl(url)
                ? extractGitHub(url, signal).catch(error => ({
                    url,
                    finalUrl: url,
                    title: "",
                    content: "",
                    error:
                      error instanceof Error ? error.message : String(error),
                    mimeType: "text/markdown" as const,
                    status: 0,
                    provenance: "github-clone" as const,
                    ref: "",
                    path: "",
                  }))
                : fetchMode !== "raw" && parseYouTubeUrl(url)
                  ? extractYouTubeCaptions(url, signal)
                  : fetchWithGecko(
                      url,
                      fetchMode,
                      context.cwd,
                      sessionId,
                      signal
                    )
            )
          )
        );
        const answerLimit = pLimit(4);
        const documents =
          input.mode === "answer"
            ? await Promise.all(
                extractedDocuments.map(document =>
                  answerLimit(async () => {
                    if (document.error) return document;
                    try {
                      const answer = await answerFromPage(
                        {
                          question: input.prompt!,
                          pageText: document.content,
                          sourceUrl: document.finalUrl,
                          model: input.answerModel,
                        },
                        context,
                        signal
                      );
                      return {
                        ...document,
                        content: answer.text,
                        answer,
                      };
                    } catch (error) {
                      return {
                        ...document,
                        content: "",
                        error:
                          error instanceof Error
                            ? error.message
                            : String(error),
                      };
                    }
                  })
                )
              )
            : extractedDocuments;
        const stored = createStoredDocuments(documents);
        storeSearch(stored);
        pi.appendEntry("wildbuzzard-web-search", stored);
        return toolResult({
          responseId: stored.id,
          expiresAt: stored.expiresAt,
          documents: documents.map(document => ({
            ...document,
            content: document.content.slice(0, 4_000),
            truncated: document.content.length > 4_000,
          })),
        });
      },
    })
  );

  pi.registerTool(
    defineTool({
      name: "crawl_content",
      label: "Crawl web content",
      description:
        "Crawl a bounded web scope breadth-first with isolated Gecko rendering, robots handling, cancellation, and partial results.",
      parameters: Type.Object({
        url: Type.String({ maxLength: 4096 }),
        includePaths: Type.Optional(
          Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), {
            maxItems: 50,
          })
        ),
        excludePaths: Type.Optional(
          Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), {
            maxItems: 50,
          })
        ),
        maxDepth: Type.Optional(Type.Integer({ minimum: 0, maximum: 8 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        timeoutMs: Type.Optional(
          Type.Integer({ minimum: 1000, maximum: 300000 })
        ),
        maxBytes: Type.Optional(
          Type.Integer({ minimum: 65536, maximum: 104857600 })
        ),
        maxConcurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
        allowSubdomains: Type.Optional(Type.Boolean()),
        allowExternalLinks: Type.Optional(Type.Boolean()),
        robots: Type.Optional(
          Type.Union([Type.Literal("respect"), Type.Literal("ignore")])
        ),
        sitemap: Type.Optional(
          Type.Union([
            Type.Literal("include"),
            Type.Literal("skip"),
            Type.Literal("only"),
          ])
        ),
        ignoreQueryParameters: Type.Optional(Type.Boolean()),
        render: Type.Optional(
          Type.Union([
            Type.Literal("auto"),
            Type.Literal("never"),
            Type.Literal("always"),
          ])
        ),
      }),
      executionMode: "sequential",
      async execute(_id, params, signal, _update, context) {
        const sessionId = context.sessionManager.getSessionId();
        if (!sessionId) {
          throw new Error("Pi session identity is unavailable");
        }
        const result = await crawlWithGecko(
          params as CrawlInput,
          context.cwd,
          sessionId,
          signal
        );
        const stored = createStoredDocuments(result.documents, "crawl");
        storeSearch(stored);
        pi.appendEntry("wildbuzzard-web-search", stored);
        return toolResult({
          ...result,
          responseId: stored.id,
          expiresAt: stored.expiresAt,
          documents: result.documents.map(document => ({
            ...document,
            content: document.content.slice(0, 2_000),
            truncated: document.content.length > 2_000,
          })),
        });
      },
    })
  );

  pi.registerTool(
    defineTool({
      name: "get_search_content",
      label: "Get search content",
      description:
        "Read a bounded range or locate passages from a one-hour web-search response handle.",
      parameters: Type.Object({
        responseId: Type.String({ minLength: 1, maxLength: 128 }),
        query: Type.Optional(Type.String({ maxLength: 2000 })),
        url: Type.Optional(Type.String({ maxLength: 4096 })),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30000 })),
        findText: Type.Optional(
          Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
            maxItems: 10,
          })
        ),
      }),
      executionMode: "sequential",
      async execute(_id, params) {
        return toolResult(
          pageStoredSearch(getStoredSearch(params.responseId), params)
        );
      },
    })
  );
}
