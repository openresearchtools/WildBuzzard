"use strict";

localizeDocument();

const { DEFAULT_SETTINGS, PROVIDERS, SEARCH_PAGE } = BuzzardSearchExtension;
const form = document.querySelector("#search-form");
const queryInput = document.querySelector("#query");
const providerSelect = document.querySelector("#provider");
const searchButton = document.querySelector("#search-button");
const sidebarButton = document.querySelector("#sidebar-button");
const optionsButton = document.querySelector("#options-button");
const statusElement = document.querySelector("#status");

function showStatus(message, isError = false) {
  statusElement.textContent = message;
  statusElement.classList.toggle("error", isError);
}

async function initialize() {
  const settings = await browser.storage.local.get(DEFAULT_SETTINGS);
  providerSelect.value = PROVIDERS.includes(settings.provider)
    ? settings.provider
    : DEFAULT_SETTINGS.provider;

  if (!browser.buzzardSearch) {
    searchButton.disabled = true;
    showStatus(browser.i18n.getMessage("errorUnsupportedBrowser"), true);
    return;
  }

  showStatus(browser.i18n.getMessage("statusChecking"));
  try {
    const status = await browser.buzzardSearch.getStatus();
    if (status.schema !== 1 || status.protocolVersion !== 1) {
      searchButton.disabled = true;
      showStatus(browser.i18n.getMessage("errorProtocolMismatch"), true);
      return;
    }
    if (!status.available) {
      searchButton.disabled = true;
      const key =
        status.errorCode === "protocol_mismatch"
          ? "errorProtocolMismatch"
          : status.errorCode === "unsupported_platform"
            ? "errorUnsupportedBrowser"
            : "errorMissingCli";
      showStatus(browser.i18n.getMessage(key), true);
      return;
    }
    searchButton.disabled = false;
    showStatus(browser.i18n.getMessage("statusIdle"));
  } catch (_error) {
    searchButton.disabled = true;
    showStatus(browser.i18n.getMessage("errorGeneric"), true);
  }
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  const query = queryInput.value.trim();
  if (!query) {
    queryInput.focus();
    return;
  }
  const url = new URL(browser.runtime.getURL(SEARCH_PAGE));
  url.searchParams.set("q", query);
  url.searchParams.set("provider", providerSelect.value);
  await browser.tabs.create({ url: url.href });
  window.close();
});

sidebarButton.addEventListener("click", async () => {
  await browser.sidebarAction.open();
  window.close();
});

optionsButton.addEventListener("click", async () => {
  await browser.runtime.openOptionsPage();
  window.close();
});

initialize();
