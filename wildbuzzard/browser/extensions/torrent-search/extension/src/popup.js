"use strict";

const contract = TorrentSearchContract;
const i18n = TorrentSearchI18n;

const elements = {};
let activeOperationId;
let preparedToken;
let selectedReviewButton;

document.addEventListener("DOMContentLoaded", initialize);

async function initialize() {
  i18n.localizeDocument(document);
  Object.assign(elements, {
    availability: document.querySelector("#availability"),
    cancelSearch: document.querySelector("#cancel-search"),
    confirmation: document.querySelector("#confirmation"),
    confirmationKind: document.querySelector("#confirmation-kind"),
    confirmationName: document.querySelector("#confirmation-name"),
    confirmationSize: document.querySelector("#confirmation-size"),
    confirmationSizeRow: document.querySelector("#confirmation-size-row"),
    confirmationSource: document.querySelector("#confirmation-source"),
    confirmImport: document.querySelector("#confirm-import"),
    form: document.querySelector("#search-form"),
    message: document.querySelector("#message"),
    query: document.querySelector("#query"),
    results: document.querySelector("#results"),
    resultsSection: document.querySelector("#results-section"),
    searchButton: document.querySelector("#search-button"),
    source: document.querySelector("#source"),
    template: document.querySelector("#result-template"),
  });

  elements.form.addEventListener("submit", onSearch);
  elements.cancelSearch.addEventListener("click", onCancelSearch);
  elements.confirmImport.addEventListener("click", onConfirmImport);
  elements.confirmation.addEventListener("close", onConfirmationClosed);
  window.addEventListener("pagehide", cleanUp);

  setAvailable(false);
  elements.availability.textContent = i18n.message("statusChecking");

  try {
    const [status, sources, preferences] = await Promise.all([
      browser.torrentSearch.getStatus(),
      browser.torrentSearch.listSources(),
      browser.storage.local.get(["defaultSource", "resultLimit"]),
    ]);
    if (status.schemaVersion !== contract.SCHEMA_VERSION || !status.available) {
      throw new Error("torrentSearch.CLI_NOT_INSTALLED");
    }
    populateSources(sources.sources, preferences.defaultSource);
    elements.form.dataset.limit = String(preferences.resultLimit ?? contract.RESULT_LIMIT_DEFAULT);
    elements.availability.textContent = i18n.message("statusReady");
    setAvailable(true);

    const initialQuery = new URL(location.href).searchParams.get("query");
    if (initialQuery) {
      elements.query.value = initialQuery;
      elements.form.requestSubmit();
    } else {
      elements.query.focus();
    }
  } catch (error) {
    elements.availability.textContent = i18n.message("statusUnavailable");
    showError(error);
  }
}

function populateSources(sources, defaultSource) {
  for (const source of sources.slice(0, 64)) {
    const option = document.createElement("option");
    option.value = source.id;
    option.textContent = source.name;
    option.selected = source.id === defaultSource;
    elements.source.append(option);
  }
}

function setAvailable(available) {
  for (const control of elements.form?.elements ?? []) {
    control.disabled = !available;
  }
}

async function onSearch(event) {
  event.preventDefault();
  await cancelActiveSearch();

  let query;
  let source;
  let limit;
  try {
    query = contract.normalizeQuery(elements.query.value);
    source = contract.normalizeSource(elements.source.value);
    limit = contract.normalizeLimit(elements.form.dataset.limit);
  } catch {
    elements.message.textContent = i18n.message("invalidSearch");
    elements.query.focus();
    return;
  }

  const operationId = contract.createOperationId();
  activeOperationId = operationId;
  setSearching(true);
  clearResults();
  elements.message.textContent = i18n.message("searchingStatus");

  try {
    const response = await browser.torrentSearch.search({
      schemaVersion: contract.SCHEMA_VERSION,
      operationId,
      query,
      source,
      limit,
    });
    if (activeOperationId !== operationId) {
      return;
    }
    renderResults(response.results);
    elements.message.textContent = response.results.length
      ? i18n.message("resultCount", String(response.results.length))
      : i18n.message("noResults");
    if (response.truncated) {
      elements.message.textContent += ` ${i18n.message("resultsTruncated")}`;
    }
  } catch (error) {
    if (activeOperationId === operationId && contract.errorCode(error) !== "OPERATION_CANCELLED") {
      showError(error);
    }
  } finally {
    if (activeOperationId === operationId) {
      activeOperationId = undefined;
      setSearching(false);
    }
  }
}

function setSearching(searching) {
  elements.form.setAttribute("aria-busy", String(searching));
  elements.searchButton.hidden = searching;
  elements.cancelSearch.hidden = !searching;
}

async function onCancelSearch() {
  await cancelActiveSearch();
  setSearching(false);
  elements.message.textContent = i18n.message("searchCancelled");
}

function clearResults() {
  elements.results.replaceChildren();
  elements.resultsSection.hidden = true;
}

function renderResults(results) {
  const fragment = document.createDocumentFragment();
  for (const result of results.slice(0, contract.RESULT_LIMIT_MAX)) {
    const item = elements.template.content.cloneNode(true);
    item.querySelector(".result-title").textContent = result.title;
    item.querySelector(".result-source").textContent = result.sourceName;
    setOptionalMetadata(item, ".result-size-row", ".result-size", contract.formatBytes(result.sizeBytes));
    setOptionalMetadata(item, ".result-seeders-row", ".result-seeders", Number.isSafeInteger(result.seeders) ? String(result.seeders) : "");
    const button = item.querySelector(".review-button");
    button.addEventListener("click", () => reviewResult(result.resultToken, button));
    fragment.append(item);
  }
  elements.results.append(fragment);
  elements.resultsSection.hidden = false;
}

function setOptionalMetadata(root, rowSelector, valueSelector, value) {
  const row = root.querySelector(rowSelector);
  if (!value) {
    row.remove();
    return;
  }
  root.querySelector(valueSelector).textContent = value;
}

async function reviewResult(resultToken, button) {
  if (preparedToken) {
    await discardPrepared();
  }
  selectedReviewButton = button;
  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = i18n.message("preparingButton");
  elements.message.textContent = i18n.message("preparingStatus");

  try {
    const prepared = await browser.torrentSearch.prepareImport({
      schemaVersion: contract.SCHEMA_VERSION,
      resultToken,
    });
    preparedToken = prepared.confirmationToken;
    elements.confirmationName.textContent = prepared.name;
    elements.confirmationSource.textContent = prepared.sourceName;
    elements.confirmationKind.textContent = i18n.message(prepared.kind === "magnet" ? "magnetContent" : "torrentFileContent");
    const size = contract.formatBytes(prepared.sizeBytes);
    elements.confirmationSize.textContent = size;
    elements.confirmationSizeRow.hidden = !size;
    elements.message.textContent = "";
    elements.confirmation.showModal();
  } catch (error) {
    showError(error);
    selectedReviewButton = undefined;
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

async function onConfirmImport() {
  const confirmationToken = preparedToken;
  if (!confirmationToken) {
    return;
  }
  elements.confirmImport.disabled = true;

  try {
    const response = contract.normalizeImportResponse(
      await browser.torrentSearch.importPrepared({
        schemaVersion: contract.SCHEMA_VERSION,
        confirmationToken,
      })
    );
    preparedToken = undefined;
    if (!response.accepted) {
      elements.confirmation.close("cancelled");
      elements.message.textContent = i18n.message("importCancelled");
      return;
    }
    elements.confirmation.close("imported");
    elements.message.textContent = i18n.message("importSucceeded");
    if (selectedReviewButton) {
      selectedReviewButton.disabled = true;
      selectedReviewButton.textContent = i18n.message("addedButton");
    }
  } catch (error) {
    await discardPrepared();
    showError(error);
    elements.confirmation.close("error");
  } finally {
    elements.confirmImport.disabled = false;
  }
}

async function onConfirmationClosed() {
  if (preparedToken) {
    await discardPrepared();
  }
  selectedReviewButton = undefined;
}

async function discardPrepared() {
  const confirmationToken = preparedToken;
  preparedToken = undefined;
  if (!confirmationToken) {
    return;
  }
  try {
    await browser.torrentSearch.discardPrepared({
      schemaVersion: contract.SCHEMA_VERSION,
      confirmationToken,
    });
  } catch {
  }
}

async function cancelActiveSearch() {
  const operationId = activeOperationId;
  activeOperationId = undefined;
  if (!operationId) {
    return;
  }
  try {
    await browser.torrentSearch.cancel({
      schemaVersion: contract.SCHEMA_VERSION,
      operationId,
    });
  } catch {
  }
}

function cleanUp() {
  void cancelActiveSearch();
  void discardPrepared();
}

function showError(error) {
  const code = contract.errorCode(error);
  const key = `error_${code}`;
  const localized = i18n.message(key);
  elements.message.textContent = localized === key ? i18n.message("error_UNKNOWN") : localized;
}
