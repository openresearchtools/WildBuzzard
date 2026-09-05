"use strict";

const { SEARCH_PAGE } = BuzzardSearchExtension;

function searchPageUrl(query) {
  const url = new URL(browser.runtime.getURL(SEARCH_PAGE));
  if (query) {
    url.searchParams.set("q", query);
  }
  return url.href;
}

browser.omnibox.setDefaultSuggestion({
  description: browser.i18n.getMessage("omniboxSuggestion"),
});

browser.omnibox.onInputChanged.addListener((text, suggest) => {
  const query = text.trim();
  if (!query) {
    suggest([]);
    return;
  }
  suggest([
    {
      content: query,
      description: browser.i18n.getMessage("omniboxSuggestion"),
    },
  ]);
});

browser.omnibox.onInputEntered.addListener(async (text, disposition) => {
  const url = searchPageUrl(text.trim());
  if (disposition === "currentTab") {
    await browser.tabs.update({ url });
    return;
  }
  await browser.tabs.create({
    active: disposition !== "newBackgroundTab",
    url,
  });
});
