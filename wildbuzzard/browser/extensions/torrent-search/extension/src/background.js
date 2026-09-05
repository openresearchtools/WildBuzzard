"use strict";

browser.omnibox.setDefaultSuggestion({
  description: browser.i18n.getMessage("omniboxSuggestion"),
});

browser.omnibox.onInputEntered.addListener(query => {
  const url = new URL(browser.runtime.getURL("src/popup.html"));
  url.searchParams.set("query", query);
  browser.tabs.create({ url: url.href });
});
