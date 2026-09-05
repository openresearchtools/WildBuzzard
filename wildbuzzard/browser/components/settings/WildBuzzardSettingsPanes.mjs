/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { SettingPaneManager } from "chrome://browser/content/preferences/config/SettingPaneManager.mjs";

if (Services.prefs.getBoolPref("browser.settings-redesign.enabled", false)) {
  // The appearance and tabs panes already have Mozilla modules in their
  // slots, so the WildBuzzard group modules load here instead.
  const appearancePane = SettingPaneManager.get("appearance");
  appearancePane.groupIds = ["wildbuzzardThemeColors"];
  ChromeUtils.importESModule(
    "chrome://browser/content/wildbuzzard/settings/wildbuzzardAppearance.mjs",
    { global: "current" }
  );

  const aboutPane = SettingPaneManager.get("about");
  aboutPane.groupIds = ["wildbuzzardAbout", "updates", "wildbuzzardAboutLinks"];
  ChromeUtils.importESModule(
    "chrome://browser/content/wildbuzzard/settings/wildbuzzardAbout.mjs",
    { global: "current" }
  );

  const tabsPane = SettingPaneManager.get("tabsBrowsing");
  tabsPane.groupIds = [
    "wildbuzzardTabs",
    "wildbuzzardSpelling",
    ...tabsPane.groupIds,
  ];
  ChromeUtils.importESModule(
    "chrome://browser/content/wildbuzzard/settings/wildbuzzardTabs.mjs",
    { global: "current" }
  );

  // The Home pane's groups are registered by AboutPreferences.observe(); the
  // custom new tab URL control attaches to them at runtime, so this module only
  // needs to load before the home pane registers.
  ChromeUtils.importESModule(
    "chrome://browser/content/wildbuzzard/settings/wildbuzzardHome.mjs",
    { global: "current" }
  );

  // The search pane keeps its Mozilla module; wildbuzzardSearch amends its
  // firefoxSuggest group at runtime, so it only needs to load before that pane.
  ChromeUtils.importESModule(
    "chrome://browser/content/wildbuzzard/settings/wildbuzzardSearch.mjs",
    { global: "current" }
  );

  // The privacy pane keeps its Mozilla module; wildbuzzardPrivacy adjusts its Safe
  // Browsing status warning at runtime, so it only needs to load before that pane.
  ChromeUtils.importESModule(
    "chrome://browser/content/wildbuzzard/settings/wildbuzzardPrivacy.mjs",
    { global: "current" }
  );

  // The WildBuzzard notice renders where Mozilla's data collection group sits;
  // that group stays empty in builds without data reporting.
  const permissionsPane = SettingPaneManager.get("permissionsData");
  permissionsPane.groupIds = [
    "wildbuzzardDataCollection",
    ...permissionsPane.groupIds,
  ];
  ChromeUtils.importESModule(
    "chrome://browser/content/wildbuzzard/settings/wildbuzzardDataCollection.mjs",
    { global: "current" }
  );
}
