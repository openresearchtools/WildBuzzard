"use strict";

localizeDocument();

const { DEFAULT_SETTINGS, PROVIDERS } = BuzzardSearchExtension;
const form = document.querySelector("#options-form");
const provider = document.querySelector("#provider");
const searxngUrl = document.querySelector("#searxng-url");
const maxResults = document.querySelector("#max-results");
const safeSearch = document.querySelector("#safe-search");
const timeout = document.querySelector("#timeout");
const language = document.querySelector("#language");
const engines = document.querySelector("#engines");
const resetButton = document.querySelector("#reset-button");
const saveStatus = document.querySelector("#save-status");
const cliStatus = document.querySelector("#cli-status");

function validSearxngUrl(value) {
  if (!value) {
    return true;
  }
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      return false;
    }
    if (url.protocol === "https:") {
      return true;
    }
    return (
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    );
  } catch (_error) {
    return false;
  }
}

function validEngines(value) {
  if (!value) {
    return true;
  }
  const names = value.split(",").map(name => name.trim());
  return (
    names.length <= 10 &&
    new Set(names).size === names.length &&
    names.every(name => /^[A-Za-z0-9 ._-]{1,64}$/.test(name))
  );
}

function boundedInteger(value, minimum, maximum, fallback) {
  const number = Number.parseInt(value, 10);
  return Number.isInteger(number) && number >= minimum && number <= maximum
    ? number
    : fallback;
}

function writeForm(settings) {
  provider.value = PROVIDERS.includes(settings.provider)
    ? settings.provider
    : DEFAULT_SETTINGS.provider;
  searxngUrl.value = settings.searxngUrl || "";
  const storedMaxResults = boundedInteger(
    settings.maxResults,
    1,
    20,
    DEFAULT_SETTINGS.maxResults
  );
  maxResults.value = String(
    [5, 10, 15, 20].includes(storedMaxResults)
      ? storedMaxResults
      : DEFAULT_SETTINGS.maxResults
  );
  safeSearch.value = String(
    boundedInteger(settings.safeSearch, 0, 2, DEFAULT_SETTINGS.safeSearch)
  );
  timeout.value = String(
    boundedInteger(
      settings.timeoutSeconds,
      1,
      60,
      DEFAULT_SETTINGS.timeoutSeconds
    )
  );
  language.value = settings.language || "";
  engines.value = settings.engines || "";
  updateEndpointRequirement();
}

function updateEndpointRequirement() {
  const required = provider.value === "searxng";
  searxngUrl.required = required;
  searxngUrl.setAttribute("aria-required", String(required));
}

async function updateCliStatus() {
  if (!browser.buzzardSearch) {
    cliStatus.textContent = browser.i18n.getMessage("errorUnsupportedBrowser");
    cliStatus.classList.add("error");
    return;
  }
  cliStatus.textContent = browser.i18n.getMessage("statusChecking");
  try {
    const status = await browser.buzzardSearch.getStatus();
    if (status.schema !== 1 || status.protocolVersion !== 1) {
      cliStatus.textContent = browser.i18n.getMessage("errorProtocolMismatch");
      cliStatus.classList.add("error");
      return;
    }
    if (!status.available) {
      const key =
        status.errorCode === "protocol_mismatch"
          ? "errorProtocolMismatch"
          : status.errorCode === "unsupported_platform"
            ? "errorUnsupportedBrowser"
            : "cliUnavailable";
      cliStatus.textContent = browser.i18n.getMessage(key);
      cliStatus.classList.add("error");
      return;
    }
    cliStatus.textContent = browser.i18n.getMessage("cliAvailable", [
      status.packageVersion || "unknown",
    ]);
    cliStatus.classList.remove("error");
  } catch (_error) {
    cliStatus.textContent = browser.i18n.getMessage("errorGeneric");
    cliStatus.classList.add("error");
  }
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  const endpoint = searxngUrl.value.trim();
  if (!validSearxngUrl(endpoint)) {
    searxngUrl.setCustomValidity(browser.i18n.getMessage("invalidEndpoint"));
    searxngUrl.reportValidity();
    return;
  }
  searxngUrl.setCustomValidity("");
  const engineNames = engines.value.trim();
  if (!validEngines(engineNames)) {
    engines.setCustomValidity(browser.i18n.getMessage("invalidEngines"));
    engines.reportValidity();
    return;
  }
  engines.setCustomValidity("");
  const values = {
    provider: provider.value,
    searxngUrl: endpoint,
    maxResults: boundedInteger(maxResults.value, 1, 20, 10),
    safeSearch: boundedInteger(safeSearch.value, 0, 2, 1),
    timeoutSeconds: boundedInteger(timeout.value, 1, 60, 30),
    language: language.value.trim(),
    engines: engineNames,
  };
  await browser.storage.local.set(values);
  saveStatus.textContent = browser.i18n.getMessage("settingsSaved");
});

searxngUrl.addEventListener("input", () => {
  searxngUrl.setCustomValidity("");
});

provider.addEventListener("change", updateEndpointRequirement);

engines.addEventListener("input", () => {
  engines.setCustomValidity("");
});

resetButton.addEventListener("click", async () => {
  await browser.storage.local.set(DEFAULT_SETTINGS);
  writeForm(DEFAULT_SETTINGS);
  saveStatus.textContent = browser.i18n.getMessage("settingsReset");
});

async function initialize() {
  writeForm(await browser.storage.local.get(DEFAULT_SETTINGS));
  await updateCliStatus();
}

initialize();
