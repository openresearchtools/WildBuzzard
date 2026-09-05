/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* global gSubDialog */

import { Preferences } from "chrome://global/content/preferences/Preferences.mjs";
import { SettingGroupManager } from "chrome://browser/content/preferences/config/SettingGroupManager.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
  addonDisplayName: "resource:///modules/WildBuzzardBlockerUtils.sys.mjs",
  isEnabledAdblockAddon: "resource:///modules/WildBuzzardBlockerUtils.sys.mjs",
});

Preferences.addAll([{ id: "wildbuzzard.blocker.enabled", type: "bool" }]);

Preferences.addSetting({
  id: "wildbuzzard-blocker-enabled",
  pref: "wildbuzzard.blocker.enabled",
});

Preferences.addSetting({
  id: "wildbuzzard-blocker-extension-notice",
  deps: ["wildbuzzard-blocker-enabled"],
  _extensionName: "",
  setup(emitChange, deps) {
    const refresh = () => {
      lazy.AddonManager.getAddonsByTypes(["extension"]).then(
        addons => {
          const detected = addons.find(addon =>
            lazy.isEnabledAdblockAddon(addon)
          );
          const detectedName = detected
            ? lazy.addonDisplayName(detected) || ""
            : "";
          if (detectedName !== this._extensionName) {
            this._extensionName = detectedName;
            emitChange();
          }
        },
        () => {}
      );
    };
    refresh();
    deps["wildbuzzard-blocker-enabled"].on("change", refresh);
    return () => deps["wildbuzzard-blocker-enabled"].off("change", refresh);
  },
  visible(deps) {
    return !deps["wildbuzzard-blocker-enabled"].value && !!this._extensionName;
  },
  getControlConfig(config) {
    return {
      ...config,
      l10nArgs: { extensionName: this._extensionName },
    };
  },
});

Preferences.addSetting({ id: "wildbuzzardBlockerListsBoxGroup" });

Preferences.addSetting({
  id: "wildbuzzard-blocker-manage-lists",
  onUserClick(e) {
    e.preventDefault();
    gSubDialog.open(
      "chrome://browser/content/preferences/dialogs/wildbuzzardBlockerFilterLists.xhtml"
    );
  },
});

Preferences.addSetting({
  id: "wildbuzzard-blocker-custom-lists",
  onUserClick(e) {
    e.preventDefault();
    gSubDialog.open(
      "chrome://browser/content/preferences/dialogs/wildbuzzardBlockerCustomFilterLists.xhtml"
    );
  },
});

Preferences.addSetting({
  id: "wildbuzzard-blocker-my-filters",
  onUserClick(e) {
    e.preventDefault();
    gSubDialog.open(
      "chrome://browser/content/preferences/dialogs/wildbuzzardBlockerCustomFilters.xhtml"
    );
  },
});

Preferences.addSetting({
  id: "wildbuzzard-blocker-exceptions",
  onUserClick(e) {
    e.preventDefault();
    gSubDialog.open(
      "chrome://browser/content/preferences/dialogs/permissions.xhtml",
      undefined,
      {
        permissionType: "wildbuzzard-blocker",
        disableETPVisible: true,
        prefilledHost: "",
        hideStatusColumn: true,
      }
    );
  },
});

SettingGroupManager.registerGroups({
  wildbuzzardBlocker: {
    l10nId: "wildbuzzard-blocker-group",
    headingLevel: 2,
    items: [
      {
        id: "wildbuzzard-blocker-enabled",
        l10nId: "wildbuzzard-blocker-enabled-toggle",
        control: "moz-toggle",
        controlAttrs: {
          searchkeywords: "adblock adblocker ublock filter",
        },
      },
      {
        id: "wildbuzzard-blocker-extension-notice",
        l10nId: "wildbuzzard-blocker-extension-notice",
        control: "moz-message-bar",
        controlAttrs: {
          role: "status",
        },
      },
    ],
  },
  wildbuzzardBlockerLists: {
    l10nId: "wildbuzzard-blocker-lists-group",
    headingLevel: 2,
    items: [
      {
        id: "wildbuzzardBlockerListsBoxGroup",
        control: "moz-box-group",
        items: [
          {
            id: "wildbuzzard-blocker-manage-lists",
            l10nId: "wildbuzzard-blocker-manage-lists-button",
            control: "moz-box-button",
            controlAttrs: {
              "search-l10n-ids":
                "wildbuzzard-blocker-filter-lists-window.title,wildbuzzard-blocker-filter-lists-description.value",
            },
          },
          {
            id: "wildbuzzard-blocker-custom-lists",
            l10nId: "wildbuzzard-blocker-custom-lists-button",
            control: "moz-box-button",
            controlAttrs: {
              "search-l10n-ids":
                "wildbuzzard-blocker-custom-filter-lists-window.title,wildbuzzard-blocker-custom-filter-lists-description",
            },
          },
          {
            id: "wildbuzzard-blocker-my-filters",
            l10nId: "wildbuzzard-blocker-my-filters-button",
            control: "moz-box-button",
            controlAttrs: {
              "search-l10n-ids":
                "wildbuzzard-blocker-custom-filters-window.title,wildbuzzard-blocker-custom-filters-description",
            },
          },
        ],
      },
    ],
  },
  wildbuzzardBlockerExceptions: {
    l10nId: "wildbuzzard-blocker-exceptions-group",
    headingLevel: 2,
    items: [
      {
        id: "wildbuzzard-blocker-exceptions",
        l10nId: "wildbuzzard-blocker-exceptions-button",
        control: "moz-box-button",
        controlAttrs: {
          "search-l10n-ids":
            "permissions-exceptions-wildbuzzard-blocker-window2.title,permissions-exceptions-manage-wildbuzzard-blocker-desc",
        },
      },
    ],
  },
});
