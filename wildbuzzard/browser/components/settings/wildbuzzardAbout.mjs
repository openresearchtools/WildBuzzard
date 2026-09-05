/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { Preferences } from "chrome://global/content/preferences/Preferences.mjs";
import { SettingGroupManager } from "chrome://browser/content/preferences/config/SettingGroupManager.mjs";

Preferences.addSetting({
  id: "wildbuzzardAboutDescription",
  getControlConfig(config) {
    config.l10nArgs = {
      version: Services.appinfo.version,
      engine: Services.appinfo.platformVersion,
    };
    return config;
  },
});

const links = [
  ["wildbuzzardAboutLicenses", "wildbuzzard-about-licenses", "about:license"],
  [
    "wildbuzzardAboutSource",
    "wildbuzzard-about-source",
    "https://github.com/openresearchtools/WildBuzzard",
  ],
  ["wildbuzzardAboutBuild", "wildbuzzard-about-build", "about:buildconfig"],
  [
    "wildbuzzardAboutSupport",
    "wildbuzzard-about-support",
    "https://github.com/openresearchtools/WildBuzzard/issues",
  ],
];
for (const [id] of links) {
  Preferences.addSetting({ id });
}

Preferences.addSetting({
  id: "wildbuzzardCheckSpelling",
  pref: "layout.spellcheckDefault",
  get: value => value !== 0,
  set: value => (value ? 1 : 0),
});

SettingGroupManager.registerGroups({
  wildbuzzardAbout: {
    headingLevel: 2,
    items: [
      {
        id: "wildbuzzardAboutDescription",
        l10nId: "wildbuzzard-about-description",
        control: "moz-box-item",
      },
    ],
  },
  wildbuzzardAboutLinks: {
    headingLevel: 2,
    l10nId: "wildbuzzard-about-project-heading",
    items: links.map(([id, l10nId, href]) => ({
      id,
      l10nId,
      control: "moz-box-link",
      controlAttrs: { href },
    })),
  },
  wildbuzzardSpelling: {
    headingLevel: 2,
    l10nId: "wildbuzzard-spelling-heading",
    items: [
      {
        id: "wildbuzzardCheckSpelling",
        l10nId: "wildbuzzard-spelling-enabled",
      },
    ],
  },
});
