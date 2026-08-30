"use strict";

function localizeDocument() {
  document.documentElement.lang = browser.i18n.getUILanguage();
  document.documentElement.dir = browser.i18n.getMessage("textDirection") || "ltr";

  for (const element of document.querySelectorAll("[data-i18n]")) {
    element.textContent = browser.i18n.getMessage(element.dataset.i18n);
  }
  for (const element of document.querySelectorAll("[data-i18n-placeholder]")) {
    element.placeholder = browser.i18n.getMessage(
      element.dataset.i18nPlaceholder
    );
  }
  for (const element of document.querySelectorAll("[data-i18n-title]")) {
    element.title = browser.i18n.getMessage(element.dataset.i18nTitle);
  }
  for (const element of document.querySelectorAll("[data-i18n-aria-label]")) {
    element.setAttribute(
      "aria-label",
      browser.i18n.getMessage(element.dataset.i18nAriaLabel)
    );
  }
}

globalThis.localizeDocument = localizeDocument;
