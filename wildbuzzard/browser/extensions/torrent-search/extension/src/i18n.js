"use strict";

(function defineI18n(root) {
  function message(key, substitutions) {
    return browser.i18n.getMessage(key, substitutions) || key;
  }

  function localizeDocument(document) {
    document.documentElement.lang = browser.i18n.getUILanguage();
    for (const element of document.querySelectorAll("[data-i18n]")) {
      element.textContent = message(element.dataset.i18n);
    }
    for (const element of document.querySelectorAll("[data-i18n-placeholder]")) {
      element.placeholder = message(element.dataset.i18nPlaceholder);
    }
    for (const element of document.querySelectorAll("[data-i18n-aria-label]")) {
      element.setAttribute("aria-label", message(element.dataset.i18nAriaLabel));
    }
  }

  root.TorrentSearchI18n = Object.freeze({ localizeDocument, message });
})(globalThis);
