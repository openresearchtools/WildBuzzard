/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Preferences } from "chrome://global/content/preferences/Preferences.mjs";
import { SettingGroupManager } from "chrome://browser/content/preferences/config/SettingGroupManager.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WildBuzzardThemeColors: "resource:///modules/WildBuzzardThemeColors.sys.mjs",
});

const WILDBUZZARD_THEME_MODE_PREF = "browser.theme.wildbuzzard.mode";

const THEME_MODES = [
  {
    value: "system",
    l10nId: "wildbuzzard-appearance-theme-mode-option-system",
    imageSrc: "chrome://browser/skin/device-desktop.svg",
  },
  {
    value: "light",
    l10nId: "wildbuzzard-appearance-theme-mode-option-light",
    imageSrc: "chrome://browser/skin/weather/sunny.svg",
  },
  {
    value: "dark",
    l10nId: "wildbuzzard-appearance-theme-mode-option-dark",
    imageSrc: "chrome://browser/skin/weather/night-hazy-moonlight.svg",
  },
];

/** Theme mode segmented control for about:preferences. */
class WildBuzzardModeSegmented extends HTMLElement {
  static get observedAttributes() {
    return ["disabled", "data-l10n-id"];
  }

  #l10nRequest = 0;
  #options = [];
  #value = "";

  connectedCallback() {
    this.#render();
  }

  attributeChangedCallback(attrName) {
    if (attrName == "disabled") {
      this.#syncSelection();
      return;
    }
    this.#render();
  }

  get options() {
    return this.#options;
  }

  set options(options) {
    this.#options = options ?? [];
    this.#render();
  }

  get value() {
    return this.#value;
  }

  set value(value) {
    this.#value = value;
    this.#syncSelection();
  }

  get disabled() {
    return this.hasAttribute("disabled");
  }

  set disabled(disabled) {
    this.toggleAttribute("disabled", Boolean(disabled));
  }

  focus() {
    this.#selectedButton?.focus();
  }

  #render() {
    if (!this.isConnected || !this.#options.length) {
      return;
    }

    const labelId = `${this.id || "wildbuzzard-mode-segmented"}-label`;
    const label = this.ownerDocument.createElement("span");
    label.className = "wildbuzzard-mode-segmented-label";
    label.id = labelId;
    if (this.dataset.l10nId) {
      label.dataset.labelL10nId = this.dataset.l10nId;
    }

    const group = this.ownerDocument.createElement("div");
    group.className = "wildbuzzard-mode-segmented-options";
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-labelledby", labelId);
    group.addEventListener("click", this);
    group.addEventListener("keydown", this);

    for (let option of this.#options) {
      const button = this.ownerDocument.createElement("button");
      button.type = "button";
      button.className = "wildbuzzard-mode-segmented-option";
      button.dataset.value = option.value;
      button.value = option.value;
      button.setAttribute("role", "radio");

      const icon = this.ownerDocument.createElement("img");
      icon.className = "wildbuzzard-mode-segmented-icon";
      icon.src = option.imageSrc;
      icon.alt = "";

      const text = this.ownerDocument.createElement("span");
      text.className = "wildbuzzard-mode-segmented-text";
      text.dataset.labelL10nId = option.l10nId;

      button.append(icon, text);
      group.append(button);
    }

    this.replaceChildren(label, group);
    this.#syncSelection();
    this.#localizeLabels();
  }

  async #localizeLabels() {
    const l10n = this.ownerDocument.l10n;
    if (!l10n) {
      return;
    }

    const request = ++this.#l10nRequest;
    const elements = Array.from(this.querySelectorAll("[data-label-l10n-id]"));
    const messages = await l10n.formatMessages(
      elements.map(element => ({ id: element.dataset.labelL10nId }))
    );
    if (request != this.#l10nRequest || !this.isConnected) {
      return;
    }

    for (let i = 0; i < elements.length; i++) {
      elements[i].textContent = this.#messageLabel(messages[i]);
    }
  }

  #messageLabel(message) {
    return (
      message?.attributes?.find(attribute => attribute.name == "label")
        ?.value ??
      message?.value ??
      ""
    );
  }

  #syncSelection() {
    const buttons = this.#buttons;
    const selectedButton = this.#selectedButton ?? buttons[0];

    for (let button of buttons) {
      const checked = button.dataset.value == this.#value;
      button.disabled = this.disabled;
      button.setAttribute("aria-checked", checked);
      button.tabIndex = button == selectedButton && !button.disabled ? 0 : -1;
    }
  }

  get #buttons() {
    return Array.from(
      this.querySelectorAll(".wildbuzzard-mode-segmented-option")
    );
  }

  get #selectedButton() {
    return this.#buttons.find(button => button.dataset.value == this.#value);
  }

  handleEvent(event) {
    if (event.type == "click") {
      this.#handleClick(event);
    } else if (event.type == "keydown") {
      this.#handleKeyDown(event);
    }
  }

  #handleClick(event) {
    if (!Element.isInstance(event.target)) {
      return;
    }

    const button = event.target.closest(".wildbuzzard-mode-segmented-option");
    if (!button || button.disabled) {
      return;
    }
    this.#selectValue(button.dataset.value);
  }

  #handleKeyDown(event) {
    if (this.disabled) {
      return;
    }

    const buttons = this.#buttons.filter(button => !button.disabled);
    if (!buttons.length) {
      return;
    }

    const currentButton = Element.isInstance(event.target)
      ? event.target.closest(".wildbuzzard-mode-segmented-option")
      : null;
    let currentIndex = buttons.indexOf(currentButton);
    if (currentIndex < 0) {
      currentIndex = Math.max(buttons.indexOf(this.#selectedButton), 0);
    }

    let nextIndex;
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowUp":
        nextIndex = (currentIndex + buttons.length - 1) % buttons.length;
        break;
      case "ArrowRight":
      case "ArrowDown":
        nextIndex = (currentIndex + 1) % buttons.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = buttons.length - 1;
        break;
      case " ":
      case "Enter":
        nextIndex = currentIndex;
        break;
      default:
        return;
    }

    event.preventDefault();
    buttons[nextIndex].focus();
    this.#selectValue(buttons[nextIndex].dataset.value);
  }

  #selectValue(value) {
    if (value == this.#value) {
      return;
    }
    this.value = value;
    this.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

if (!customElements.get("wildbuzzard-mode-segmented")) {
  customElements.define("wildbuzzard-mode-segmented", WildBuzzardModeSegmented);
}

function observeBranches(branches, emitChange) {
  for (let branch of branches) {
    Services.prefs.addObserver(branch, emitChange);
  }
  return () => {
    for (let branch of branches) {
      Services.prefs.removeObserver(branch, emitChange);
    }
  };
}

Preferences.addSetting({
  id: "wildbuzzard-theme-mode",
  get: () => lazy.WildBuzzardThemeColors.getMode(),
  async set(val) {
    const { AddonManager: Manager } = ChromeUtils.importESModule(
      "resource://gre/modules/AddonManager.sys.mjs"
    );
    await (await Manager.getAddonByID("default-theme@mozilla.org")).enable();
    lazy.WildBuzzardThemeColors.setColor("default");
    return lazy.WildBuzzardThemeColors.setMode(val);
  },
  setup: emitChange =>
    observeBranches([WILDBUZZARD_THEME_MODE_PREF], emitChange),
});

SettingGroupManager.registerGroups({
  wildbuzzardThemeColors: {
    l10nId: "wildbuzzard-appearance-mode-group",
    headingLevel: 2,
    items: [
      {
        id: "wildbuzzard-theme-mode",
        l10nId: "wildbuzzard-appearance-theme-mode-picker",
        control: "wildbuzzard-mode-segmented",
        controlAttrs: {
          class: "wildbuzzard-mode-segmented",
          ".options": THEME_MODES,
          searchkeywords: "appearance mode system light dark",
        },
      },
    ],
  },
});

// The appearance styling uses shadow ::part() selectors for visual pickers,
// which only match from an author sheet in the preferences document. This
// module runs in the preferences global, so attach the sheet here.
(function injectAppearanceSheet() {
  const doc = globalThis.document;
  const href =
    "chrome://browser/content/wildbuzzard/settings/wildbuzzardAppearance.css";
  if (!doc || doc.querySelector(`link[href="${href}"]`)) {
    return;
  }
  const link = doc.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  (doc.head || doc.documentElement).appendChild(link);
})();
