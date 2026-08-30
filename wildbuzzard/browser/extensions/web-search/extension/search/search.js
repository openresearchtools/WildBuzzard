"use strict";

localizeDocument();

const {
  API_SCHEMA,
  DEFAULT_SETTINGS,
  MAX_QUERY_LENGTH,
  PROVIDERS,
} = BuzzardSearchExtension;
const form = document.querySelector("#search-form");
const queryInput = document.querySelector("#query");
const providerSelect = document.querySelector("#provider");
const safeSearchSelect = document.querySelector("#safe-search");
const maxResultsSelect = document.querySelector("#max-results");
const searchButton = document.querySelector("#search-button");
const cancelButton = document.querySelector("#cancel-button");
const moreButton = document.querySelector("#more-button");
const statusElement = document.querySelector("#status");
const resultsSection = document.querySelector("#results-section");
const resultsHeading = document.querySelector("#results-heading");
const resultsList = document.querySelector("#results");

const ERROR_MESSAGES = Object.freeze({
  bridge_unavailable: "errorUnsupportedBrowser",
  busy: "errorBusy",
  cli_missing: "errorMissingCli",
  protocol_mismatch: "errorProtocolMismatch",
  timeout: "errorTimeout",
  cancelled: "errorCancelled",
  invalid_request: "errorInvalidRequest",
  invalid_output: "errorInvalidOutput",
  output_too_large: "errorOutputTooLarge",
  cli_failed: "errorCliFailed",
  searxng_not_configured: "errorSearxngNotConfigured",
  unsupported_platform: "errorUnsupportedBrowser",
});

let settings = { ...DEFAULT_SETTINGS };
let currentRequestId = null;
let currentPage = 1;
let bridgeAvailable = false;

function boundedInteger(value, minimum, maximum, fallback) {
  const number = Number.parseInt(value, 10);
  return Number.isInteger(number) && number >= minimum && number <= maximum
    ? number
    : fallback;
}

function showStatus(message, isError = false) {
  statusElement.textContent = message;
  statusElement.classList.toggle("error", isError);
  statusElement.setAttribute("role", isError ? "alert" : "status");
}

function errorMessage(error) {
  const match = /^\[buzzard-search\/([a-z_]+)\]/.exec(error?.message || "");
  const key = match ? ERROR_MESSAGES[match[1]] : null;
  return browser.i18n.getMessage(key || "errorGeneric");
}

function statusErrorMessage(code) {
  return browser.i18n.getMessage(ERROR_MESSAGES[code] || "errorGeneric");
}

function setRunning(running) {
  form.setAttribute("aria-busy", String(running));
  searchButton.disabled = running || !bridgeAvailable;
  queryInput.disabled = running;
  providerSelect.disabled = running;
  safeSearchSelect.disabled = running;
  maxResultsSelect.disabled = running;
  cancelButton.hidden = !running;
  cancelButton.disabled = false;
  moreButton.disabled = running;
}

function normalizeStoredSettings(stored) {
  const maxResults = boundedInteger(stored.maxResults, 1, 20, 10);
  return {
    provider: PROVIDERS.includes(stored.provider)
      ? stored.provider
      : DEFAULT_SETTINGS.provider,
    maxResults: [5, 10, 15, 20].includes(maxResults) ? maxResults : 10,
    safeSearch: boundedInteger(stored.safeSearch, 0, 2, 1),
    timeoutSeconds: boundedInteger(stored.timeoutSeconds, 1, 60, 30),
    language: typeof stored.language === "string" ? stored.language : "",
    searxngUrl:
      typeof stored.searxngUrl === "string" ? stored.searxngUrl : "",
    engines: typeof stored.engines === "string" ? stored.engines : "",
  };
}

function updateLocation(query, provider) {
  const url = new URL(location.href);
  url.searchParams.set("q", query);
  url.searchParams.set("provider", provider);
  history.replaceState(null, "", url);
}

function safeResultURL(value) {
  if (typeof value !== "string" || value.length > 8192) {
    return null;
  }
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch (_error) {
    return null;
  }
}

function createResult(result) {
  const target = safeResultURL(result.url);
  if (!target) {
    return null;
  }
  const item = document.createElement("li");
  item.className = "result";

  const article = document.createElement("article");
  const heading = document.createElement("h3");
  const link = document.createElement("a");
  link.href = target;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.dir = "auto";
  link.textContent = result.title || target;
  heading.append(link);

  const url = document.createElement("p");
  url.className = "result-url";
  url.textContent = target;

  article.append(heading, url);

  if (result.snippet) {
    const snippet = document.createElement("p");
    snippet.className = "result-snippet";
    snippet.dir = "auto";
    snippet.textContent = result.snippet;
    article.append(snippet);
  }

  const metadata = [];
  if (result.provider) {
    metadata.push(result.provider);
  }
  if (Array.isArray(result.engines) && result.engines.length) {
    metadata.push(result.engines.join(", "));
  }
  if (result.date) {
    metadata.push(result.date);
  }
  if (metadata.length) {
    const meta = document.createElement("p");
    meta.className = "result-meta";
    meta.dir = "auto";
    meta.textContent = metadata.join(" — ");
    article.append(meta);
  }

  item.append(article);
  return item;
}

function renderResults(response, append) {
  if (!append) {
    resultsList.replaceChildren();
  }
  const fragment = document.createDocumentFragment();
  for (const result of response.results) {
    const item = createResult(result);
    if (item) {
      fragment.append(item);
    }
  }
  resultsList.append(fragment);

  const count = resultsList.childElementCount;
  resultsHeading.textContent = browser.i18n.getMessage("resultCount", [
    String(count),
  ]);
  resultsSection.hidden = false;
  moreButton.hidden =
    currentPage >= 10 ||
    response.results.length < Number(maxResultsSelect.value);

  if (!count) {
    showStatus(browser.i18n.getMessage("noResults"));
    moreButton.hidden = true;
    return;
  }
  showStatus(browser.i18n.getMessage("resultCount", [String(count)]));
  if (!append) {
    resultsHeading.focus();
  }
}

function buildRequest(requestId, page) {
  const provider = PROVIDERS.includes(providerSelect.value)
    ? providerSelect.value
    : DEFAULT_SETTINGS.provider;
  const request = {
    schema: API_SCHEMA,
    requestId,
    query: queryInput.value.trim(),
    provider,
    maxResults: boundedInteger(maxResultsSelect.value, 1, 20, 10),
    timeoutSeconds: settings.timeoutSeconds,
    page,
    safeSearch: boundedInteger(safeSearchSelect.value, 0, 2, 1),
  };

  if (provider === "searxng" && settings.language) {
    request.language = settings.language;
  }
  if (provider === "searxng" && settings.searxngUrl) {
    request.searxngUrl = settings.searxngUrl;
  }
  if (provider === "searxng" && settings.engines) {
    request.engines = [
      ...new Set(
        settings.engines
          .split(",")
          .map(value => value.trim())
          .filter(Boolean)
      ),
    ].slice(0, 10);
  }
  return request;
}

async function runSearch(page = 1) {
  const query = queryInput.value.trim();
  if (!bridgeAvailable || !query || query.length > MAX_QUERY_LENGTH) {
    queryInput.focus();
    return;
  }
  if (providerSelect.value === "searxng" && !settings.searxngUrl) {
    showStatus(
      browser.i18n.getMessage("errorSearxngNotConfigured"),
      true
    );
    return;
  }

  const requestId = crypto.randomUUID();
  currentRequestId = requestId;
  currentPage = page;
  setRunning(true);
  showStatus(browser.i18n.getMessage("statusSearching"));
  updateLocation(query, providerSelect.value);

  try {
    const response = await browser.buzzardSearch.search(
      buildRequest(requestId, page)
    );
    if (
      response.schema !== API_SCHEMA ||
      response.requestId !== requestId ||
      !Array.isArray(response.results)
    ) {
      throw new Error("[buzzard-search/invalid_output]");
    }
    renderResults(response, page > 1);
  } catch (error) {
    showStatus(errorMessage(error), true);
  } finally {
    if (currentRequestId === requestId) {
      currentRequestId = null;
      setRunning(false);
    }
  }
}

form.addEventListener("submit", event => {
  event.preventDefault();
  currentPage = 1;
  runSearch();
});

cancelButton.addEventListener("click", async () => {
  if (!currentRequestId) {
    return;
  }
  cancelButton.disabled = true;
  showStatus(browser.i18n.getMessage("statusCancelling"));
  try {
    await browser.buzzardSearch.cancel(currentRequestId);
  } catch (error) {
    showStatus(errorMessage(error), true);
  }
});

moreButton.addEventListener("click", () => {
  runSearch(currentPage + 1);
});

async function initialize() {
  settings = normalizeStoredSettings(
    await browser.storage.local.get(DEFAULT_SETTINGS)
  );
  providerSelect.value = settings.provider;
  safeSearchSelect.value = String(settings.safeSearch);
  maxResultsSelect.value = String(settings.maxResults);

  const parameters = new URLSearchParams(location.search);
  const requestedProvider = parameters.get("provider");
  if (PROVIDERS.includes(requestedProvider)) {
    providerSelect.value = requestedProvider;
  }
  queryInput.value = (parameters.get("q") || "").slice(0, MAX_QUERY_LENGTH);

  if (!browser.buzzardSearch) {
    showStatus(browser.i18n.getMessage("errorUnsupportedBrowser"), true);
    setRunning(false);
    return;
  }

  showStatus(browser.i18n.getMessage("statusChecking"));
  try {
    const status = await browser.buzzardSearch.getStatus();
    if (status.schema !== API_SCHEMA || status.protocolVersion !== API_SCHEMA) {
      showStatus(browser.i18n.getMessage("errorProtocolMismatch"), true);
      setRunning(false);
      return;
    }
    bridgeAvailable = status.available;
    if (!bridgeAvailable) {
      showStatus(statusErrorMessage(status.errorCode), true);
      setRunning(false);
      return;
    }
    showStatus(browser.i18n.getMessage("statusIdle"));
    setRunning(false);
    if (queryInput.value.trim()) {
      await runSearch();
    }
  } catch (error) {
    showStatus(errorMessage(error), true);
    setRunning(false);
  }
}

setRunning(false);
initialize();
