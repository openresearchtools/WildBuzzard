/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { SettingPaneManager } from "chrome://browser/content/preferences/config/SettingPaneManager.mjs";

SettingPaneManager.registerPanes({
  adBlocking: {
    l10nId: "wildbuzzard-blocker-pane-header",
    iconSrc: "chrome://browser/content/blocker/blockerShield.svg",
    groupIds: [
      "wildbuzzardBlocker",
      "wildbuzzardBlockerLists",
      "wildbuzzardBlockerExceptions",
    ],
    module: "chrome://browser/content/blocker/blockerSettings.mjs",
    visible: () =>
      Services.prefs.getBoolPref("wildbuzzard.blocker.ui.enabled", true),
  },
});
