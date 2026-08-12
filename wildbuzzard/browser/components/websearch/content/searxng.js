/* SPDX-License-Identifier: AGPL-3.0-or-later */

"use strict";

const { SearXNGManager } = ChromeUtils.importESModule(
  "resource:///modules/SearXNGManager.sys.mjs"
);

const elements = {};
let controller = null;
let page = 1;

function setStatus(id, args) {
  document.l10n.setAttributes(elements.status, id, args);
}

function safeWebURL(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function renderAnswers(values) {
  elements.answers.replaceChildren();
  const answers = values
    .filter(value => typeof value === "string" && value.trim())
    .slice(0, 10);
  elements.answers.hidden = !answers.length;
  for (const value of answers) {
    const paragraph = document.createElement("p");
    paragraph.textContent = value;
    elements.answers.append(paragraph);
  }
}

function renderResults(results, append) {
  if (!append) {
    elements.results.replaceChildren();
  }
  let count = 0;
  for (const result of results) {
    const url = safeWebURL(result.url);
    if (!url) {
      continue;
    }
    const item = document.createElement("li");
    item.className = "result";
    const title = document.createElement("a");
    title.className = "result-title";
    title.href = url;
    title.rel = "noreferrer noopener";
    title.textContent = result.title || url;
    const shownURL = document.createElement("div");
    shownURL.className = "result-url";
    shownURL.textContent = url;
    const content = document.createElement("p");
    content.className = "result-content";
    content.textContent = result.content || "";
    item.append(title, shownURL, content);
    elements.results.append(item);
    count++;
  }
  return count;
}

async function search({ append = false } = {}) {
  const query = elements.query.value.trim();
  if (!query) {
    return;
  }
  controller?.abort();
  controller = new AbortController();
  elements.submit.disabled = true;
  elements.cancel.hidden = false;
  elements.next.hidden = true;
  setStatus("wildbuzzard-search-running");
  try {
    const response = await SearXNGManager.search(
      { query, page, safeSearch: 1, maxResults: 50 },
      controller.signal
    );
    renderAnswers(response.answers);
    const count = renderResults(response.results, append);
    setStatus("wildbuzzard-search-complete", { count });
    elements.next.hidden = count === 0;
  } catch (error) {
    if (controller.signal.aborted) {
      setStatus("wildbuzzard-search-cancelled");
    } else {
      console.error("SearXNG search failed", error);
      setStatus("wildbuzzard-search-error");
    }
  } finally {
    elements.submit.disabled = false;
    elements.cancel.hidden = true;
    controller = null;
  }
}

function updateLocation(query) {
  const url = new URL(document.documentURI);
  url.searchParams.set("q", query);
  history.pushState(null, "", url.href);
}

document.addEventListener("DOMContentLoaded", () => {
  elements.form = document.getElementById("search-form");
  elements.query = document.getElementById("search-query");
  elements.submit = document.getElementById("search-submit");
  elements.cancel = document.getElementById("search-cancel");
  elements.status = document.getElementById("search-status");
  elements.answers = document.getElementById("answers");
  elements.results = document.getElementById("search-results");
  elements.next = document.getElementById("next-page");

  const query = new URL(document.documentURI).searchParams.get("q") ?? "";
  elements.query.value = query;
  elements.form.addEventListener("submit", event => {
    event.preventDefault();
    page = 1;
    updateLocation(elements.query.value.trim());
    search();
  });
  elements.cancel.addEventListener("click", () => controller?.abort());
  elements.next.addEventListener("click", () => {
    page++;
    search({ append: true });
  });
  document.documentElement.dataset.ready = "true";
  if (query) {
    search();
  }
});
