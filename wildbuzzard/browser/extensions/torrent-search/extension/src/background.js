"use strict";

browser.runtime.onInstalled.addListener(async () => {
  const current = await browser.storage.local.get(["resultLimit"]);
  if (current.resultLimit === undefined) {
    await browser.storage.local.set({ resultLimit: 25 });
  }
});

browser.omnibox.setDefaultSuggestion({
  description: browser.i18n.getMessage("omniboxSuggestion"),
});

browser.omnibox.onInputEntered.addListener(query => {
  const url = new URL(browser.runtime.getURL("src/popup.html"));
  url.searchParams.set("query", query);
  browser.tabs.create({ url: url.href });
});
