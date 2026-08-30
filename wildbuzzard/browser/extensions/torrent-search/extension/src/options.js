"use strict";

const elements = {};

document.addEventListener("DOMContentLoaded", initialize);

async function initialize() {
  TorrentSearchI18n.localizeDocument(document);
  Object.assign(elements, {
    defaultSource: document.querySelector("#default-source"),
    form: document.querySelector("#options-form"),
    resultLimit: document.querySelector("#result-limit"),
    status: document.querySelector("#save-status"),
  });
  elements.form.addEventListener("submit", save);

  try {
    const [sources, preferences] = await Promise.all([
      browser.torrentSearch.listSources(),
      browser.storage.local.get(["defaultSource", "resultLimit"]),
    ]);
    for (const source of sources.sources.slice(0, 64)) {
      const option = document.createElement("option");
      option.value = source.id;
      option.textContent = source.name;
      elements.defaultSource.append(option);
    }
    elements.defaultSource.value = preferences.defaultSource ?? "";
    elements.resultLimit.value = String(preferences.resultLimit ?? 25);
  } catch {
    elements.status.textContent = TorrentSearchI18n.message("statusUnavailable");
    for (const control of elements.form.elements) {
      control.disabled = true;
    }
  }
}

async function save(event) {
  event.preventDefault();
  await browser.storage.local.set({
    defaultSource: elements.defaultSource.value,
    resultLimit: Number(elements.resultLimit.value),
  });
  elements.status.textContent = TorrentSearchI18n.message("settingsSaved");
}
