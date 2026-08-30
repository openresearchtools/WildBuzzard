"use strict";

globalThis.BuzzardSearchExtension = Object.freeze({
  API_SCHEMA: 1,
  MAX_QUERY_LENGTH: 512,
  PROVIDERS: Object.freeze(["ddgs", "searxng"]),
  DEFAULT_SETTINGS: Object.freeze({
    provider: "ddgs",
    maxResults: 10,
    safeSearch: 1,
    timeoutSeconds: 30,
    language: "",
    searxngUrl: "",
    engines: "",
  }),
  SEARCH_PAGE: "search/search.html",
});
