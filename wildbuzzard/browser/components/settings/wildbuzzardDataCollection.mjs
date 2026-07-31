/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Preferences } from "chrome://global/content/preferences/Preferences.mjs";
import { SettingGroupManager } from "chrome://browser/content/preferences/config/SettingGroupManager.mjs";

const LOCAL_POLICY_URL = "about:license";

Preferences.addSetting({ id: "wildbuzzard-data-collection" });
Preferences.addSetting({ id: "wildbuzzard-data-collection-notice" });

SettingGroupManager.registerGroups({
  wildbuzzardDataCollection: {
    items: [
      {
        id: "wildbuzzard-data-collection",
        l10nId: "wildbuzzard-data-collection-group",
        control: "moz-fieldset",
        iconSrc: "chrome://global/skin/icons/trending.svg",
        controlAttrs: {
          headinglevel: 2,
          badge: "wildbuzzard-exclusive",
          "data-l10n-attrs": "searchkeywords",
        },
        items: [
          {
            id: "wildbuzzard-data-collection-notice",
            control: "a",
            l10nId: "wildbuzzard-data-collection-link",
            slot: "support-link",
            controlAttrs: {
              id: "wildbuzzardDataCollectionPrivacyNotice",
              href: LOCAL_POLICY_URL,
            },
          },
        ],
      },
    ],
  },
});
