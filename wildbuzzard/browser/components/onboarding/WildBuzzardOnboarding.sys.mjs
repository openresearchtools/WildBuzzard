/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { WildBuzzardThemeColors } from "resource:///modules/WildBuzzardThemeColors.sys.mjs";

const SPLIT_BACKGROUND =
  "var(--wildbuzzard-onboarding-split-background, linear-gradient(135deg, color-mix(in srgb, var(--button-background-color-primary) 14%, var(--background-color-canvas)), var(--background-color-canvas)))";

function splitContent(content) {
  return {
    fullscreen: true,
    position: "split",
    progress_bar: true,
    background: SPLIT_BACKGROUND,
    split_content_justify_content: "center",
    ...content,
  };
}

function wildbuzzardAction(action, value, navigate = false) {
  return {
    type: "WILDBUZZARD_ONBOARDING",
    navigate,
    data: {
      action,
      value,
    },
  };
}

function customizeSettingsAction(args) {
  return {
    type: "MULTI_ACTION",
    navigate: true,
    data: {
      orderedExecution: true,
      actions: [
        {
          type: "OPEN_ABOUT_PAGE",
          data: {
            args,
            where: "tabshifted",
          },
        },
      ],
    },
  };
}

function themeModeTile(mode, stringId) {
  return {
    id: `wildbuzzard-theme-mode-${mode}`,
    type: "wildbuzzard-theme-mode-option",
    label: {
      string_id: stringId,
    },
    icon: {},
    action: wildbuzzardAction("theme-mode", mode),
  };
}

function themeColorTile({ id, labelId, swatch }) {
  return {
    id: `wildbuzzard-color-${id}`,
    type: "wildbuzzard-color-option",
    label: {
      string_id: labelId,
    },
    icon: {
      background: swatch,
    },
    action: wildbuzzardAction("theme-color", id),
  };
}

function styleTile(style) {
  return {
    id: `wildbuzzard-style-${style}`,
    label: {
      string_id: `wildbuzzard-onboarding-style-${style}-label`,
    },
    body: {
      string_id: `wildbuzzard-onboarding-style-${style}-body`,
    },
    icon: {
      background: `center / contain no-repeat url('chrome://browser/content/wildbuzzard/style/wildbuzzard-style-${style}.svg')`,
    },
    action: wildbuzzardAction("style", style),
  };
}

function densityTile(density, stringId) {
  return {
    id: `wildbuzzard-density-${density}`,
    type: "wildbuzzard-density-option",
    label: {
      string_id: stringId,
    },
    icon: {},
    action: wildbuzzardAction("density", density),
  };
}

function layoutTile({ id, labelId, bodyId, icon }) {
  return {
    id: `wildbuzzard-layout-${id}`,
    label: {
      string_id: labelId,
    },
    body: {
      string_id: bodyId,
    },
    icon: {
      background: `center / contain no-repeat url('${icon}')`,
    },
    action: wildbuzzardAction("layout", id),
  };
}

function tabLocationTile(location, stringId) {
  return {
    id: `wildbuzzard-location-${location}`,
    type: "wildbuzzard-location-option",
    label: {
      string_id: stringId,
    },
    icon: {},
    action: wildbuzzardAction("tab-location", location),
  };
}

const WILDBUZZARD_ONBOARDING = {
  id: "WILDBUZZARD_ONBOARDING",
  template: "multistage",
  transitions: Services.prefs.getBoolPref(
    "browser.aboutwelcome.transitions",
    true
  ),
  backdrop:
    "var(--mr-welcome-background-color) var(--mr-welcome-background-gradient)",
  screens: [
    {
      id: "AW_WILDBUZZARD_WELCOME",
      content: splitContent({
        logo: {
          imageURL: "chrome://branding/content/about-logo.svg",
          height: "80px",
          width: "80px",
        },
        title: {
          string_id: "wildbuzzard-onboarding-welcome-title",
        },
        subtitle: {
          string_id: "wildbuzzard-onboarding-welcome-subtitle",
        },
        primary_button: {
          label: {
            string_id: "wildbuzzard-onboarding-start-button",
          },
          action: {
            navigate: true,
          },
        },
      }),
    },
    {
      id: "AW_WILDBUZZARD_STYLE",
      content: splitContent({
        logo: {},
        title: {
          string_id: "wildbuzzard-onboarding-style-title",
        },
        subtitle: {
          string_id: "wildbuzzard-onboarding-style-subtitle",
        },
        tiles: [
          {
            type: "single-select",
            class_name: "wildbuzzard-style",
            selected: "wildbuzzard-style-nova",
            action: {
              picker: "<event>",
            },
            data: [styleTile("nova"), styleTile("proton"), styleTile("photon")],
          },
          {
            type: "single-select",
            class_name: "wildbuzzard-density",
            selected: "wildbuzzard-density-compact",
            action: {
              picker: "<event>",
            },
            data: [
              densityTile(
                "compact",
                "wildbuzzard-onboarding-density-compact-label"
              ),
              densityTile(
                "normal",
                "wildbuzzard-onboarding-density-normal-label"
              ),
            ],
          },
        ],
        primary_button: {
          label: {
            string_id: "wildbuzzard-onboarding-continue-button",
          },
          action: {
            navigate: true,
          },
        },
        secondary_button: {
          label: {
            string_id: "wildbuzzard-onboarding-customize-appearance-button",
          },
          action: customizeSettingsAction("preferences#appearance"),
        },
      }),
    },
    {
      id: "AW_WILDBUZZARD_THEME_COLOR",
      content: splitContent({
        title: {
          string_id: "wildbuzzard-onboarding-theme-color-title",
        },
        subtitle: {
          string_id: "wildbuzzard-onboarding-theme-color-subtitle",
        },
        tiles: [
          {
            type: "single-select",
            class_name: "wildbuzzard-theme-mode",
            selected: "wildbuzzard-theme-mode-system",
            action: {
              picker: "<event>",
            },
            data: [
              themeModeTile(
                "system",
                "wildbuzzard-onboarding-theme-mode-system-label"
              ),
              themeModeTile(
                "light",
                "wildbuzzard-onboarding-theme-mode-light-label"
              ),
              themeModeTile(
                "dark",
                "wildbuzzard-onboarding-theme-mode-dark-label"
              ),
            ],
          },
          {
            type: "single-select",
            class_name: "wildbuzzard-color-grid",
            selected: "wildbuzzard-color-default",
            action: {
              picker: "<event>",
            },
            data: WildBuzzardThemeColors.colors.map(themeColorTile),
          },
        ],
        primary_button: {
          label: {
            string_id: "wildbuzzard-onboarding-save-continue-button",
          },
          action: {
            navigate: true,
          },
        },
        secondary_button: {
          label: {
            string_id: "wildbuzzard-onboarding-skip-step-button",
          },
          has_arrow_icon: true,
          action: {
            navigate: true,
          },
        },
      }),
    },
    {
      id: "AW_WILDBUZZARD_TABS",
      content: splitContent({
        logo: {},
        title: {
          string_id: "wildbuzzard-onboarding-tabs-title",
        },
        subtitle: {
          string_id: "wildbuzzard-onboarding-tabs-subtitle",
        },
        tiles: [
          {
            type: "single-select",
            selected: "wildbuzzard-layout-horizontal",
            action: {
              picker: "<event>",
            },
            data: [
              layoutTile({
                id: "horizontal",
                labelId: "wildbuzzard-onboarding-tabs-horizontal-label",
                bodyId: "wildbuzzard-onboarding-tabs-horizontal-body",
                icon: "chrome://browser/content/wildbuzzard/onboarding/browser-layout-horizontal.svg",
              }),
              layoutTile({
                id: "vertical",
                labelId: "wildbuzzard-onboarding-tabs-vertical-label",
                bodyId: "wildbuzzard-onboarding-tabs-vertical-body",
                icon: "chrome://browser/content/wildbuzzard/onboarding/browser-layout-vertical.svg",
              }),
              layoutTile({
                id: "tree",
                labelId: "wildbuzzard-onboarding-tabs-tree-label",
                bodyId: "wildbuzzard-onboarding-tabs-tree-body",
                icon: "chrome://browser/content/wildbuzzard/onboarding/browser-layout-tree.svg",
              }),
            ],
          },
          {
            type: "single-select",
            class_name: "wildbuzzard-tab-location",
            selected: "wildbuzzard-location-topabove",
            action: {
              picker: "<event>",
            },
            data: [
              tabLocationTile(
                "topabove",
                "wildbuzzard-onboarding-location-top-above-label"
              ),
              tabLocationTile(
                "topbelow",
                "wildbuzzard-onboarding-location-top-below-label"
              ),
              tabLocationTile(
                "bottomabove",
                "wildbuzzard-onboarding-location-bottom-above-label"
              ),
              tabLocationTile(
                "bottombelow",
                "wildbuzzard-onboarding-location-bottom-below-label"
              ),
            ],
          },
        ],
        primary_button: {
          label: {
            string_id: "wildbuzzard-onboarding-continue-button",
          },
          action: {
            navigate: true,
          },
        },
        secondary_button: {
          label: {
            string_id: "wildbuzzard-onboarding-customize-tabs-button",
          },
          action: customizeSettingsAction("preferences#tabsBrowsing"),
        },
      }),
    },
    {
      id: "AW_WILDBUZZARD_PRIVACY",
      content: splitContent({
        logo: {},
        title: {
          string_id: "wildbuzzard-onboarding-privacy-title",
        },
        subtitle: {
          string_id: "wildbuzzard-onboarding-privacy-subtitle",
        },
        primary_button: {
          label: {
            string_id: "wildbuzzard-onboarding-privacy-primary-button",
          },
          action: wildbuzzardAction("privacy-defaults", true, true),
        },
        secondary_button: {
          label: {
            string_id: "wildbuzzard-onboarding-customize-privacy-button",
          },
          action: customizeSettingsAction("preferences#adBlocking"),
        },
      }),
    },
    {
      id: "AW_WILDBUZZARD_DEFAULT_BROWSER",
      targeting: "needDefault",
      content: splitContent({
        logo: {},
        title: {
          string_id: "wildbuzzard-onboarding-default-title",
        },
        subtitle: {
          string_id: "wildbuzzard-onboarding-default-subtitle",
        },
        primary_button: {
          label: {
            string_id: "wildbuzzard-onboarding-default-primary-button",
          },
          action: {
            type: "SET_DEFAULT_BROWSER",
            navigate: true,
          },
        },
        secondary_button: {
          label: {
            string_id: "wildbuzzard-onboarding-skip-button",
          },
          action: {
            navigate: true,
          },
        },
      }),
    },
    {
      id: "AW_WILDBUZZARD_FINISH",
      content: splitContent({
        logo: {
          imageURL: "chrome://branding/content/about-logo.svg",
          height: "80px",
          width: "80px",
        },
        title: {
          string_id: "wildbuzzard-onboarding-finish-title",
        },
        subtitle: {
          string_id: "wildbuzzard-onboarding-finish-subtitle",
        },
        primary_button: {
          label: {
            string_id: "wildbuzzard-onboarding-finish-primary-button",
          },
          action: {
            type: "OPEN_ABOUT_PAGE",
            navigate: true,
            data: {
              args: "home",
              where: "current",
            },
          },
        },
      }),
    },
  ],
};

export const WildBuzzardOnboarding = {
  getDefaults() {
    return Cu.cloneInto(WILDBUZZARD_ONBOARDING, {});
  },
};
