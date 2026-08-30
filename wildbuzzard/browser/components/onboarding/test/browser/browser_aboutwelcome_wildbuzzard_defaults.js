/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { AboutWelcomeDefaults } = ChromeUtils.importESModule(
  "resource:///modules/aboutwelcome/AboutWelcomeDefaults.sys.mjs"
);
const { SpecialMessageActions } = ChromeUtils.importESModule(
  "resource://messaging-system/lib/SpecialMessageActions.sys.mjs"
);
const { LightweightThemeManager } = ChromeUtils.importESModule(
  "resource://gre/modules/LightweightThemeManager.sys.mjs"
);
const {
  WildBuzzardThemeColors,
  WILDBUZZARD_THEME_COLOR_PREF,
  WILDBUZZARD_THEME_ID,
  WILDBUZZARD_THEME_MODE_PREF,
} = ChromeUtils.importESModule(
  "resource:///modules/WildBuzzardThemeColors.sys.mjs"
);

const NOVA_PREF = "browser.nova.enabled";
const STYLE_PREF = "browser.theme.enableWildBuzzardCustomizations";
const TREE_TABS_PREF = "browser.tabs.verticalTabs.tree.enabled";
const VERTICAL_TABS_PREF = "sidebar.verticalTabs";
const TABBAR_POSITION_PREF = "browser.tabs.toolbarposition";
const UIDENSITY_PREF = "browser.uidensity";
const PRIVACY_PREF = "wildbuzzard.blocker.enabled";
const SUPERNOVA_PREF = "userChrome.tab.supernova_like_contextline";

const STYLE_PRESET_PREFS = [
  "userChrome.tab.connect_to_window",
  "userChrome.tab.color_like_toolbar",
  "userChrome.tab.lepton_like_padding",
  "userChrome.tab.photon_like_padding",
  "userChrome.tab.dynamic_separator",
  "userChrome.tab.static_separator",
  "userChrome.tab.static_separator.selected_accent",
  "userChrome.tab.bar_separator",
  "userChrome.tab.newtab_button_like_tab",
  "userChrome.tab.newtab_button_smaller",
  "userChrome.tab.newtab_button_proton",
  "userChrome.icon.panel_full",
  "userChrome.icon.panel_photon",
  "userChrome.tab.box_shadow",
  "userChrome.tab.bottom_rounded_corner",
  "userChrome.tab.photon_like_contextline",
  "userChrome.rounding.square_tab",
];

const ACTION_PREFS = [
  NOVA_PREF,
  STYLE_PREF,
  TREE_TABS_PREF,
  VERTICAL_TABS_PREF,
  TABBAR_POSITION_PREF,
  UIDENSITY_PREF,
  PRIVACY_PREF,
  SUPERNOVA_PREF,
  WILDBUZZARD_THEME_MODE_PREF,
  WILDBUZZARD_THEME_COLOR_PREF,
  ...STYLE_PRESET_PREFS,
];

const WILDBUZZARD_SCREEN_IDS = [
  "AW_WILDBUZZARD_WELCOME",
  "AW_WILDBUZZARD_STYLE",
  "AW_WILDBUZZARD_THEME_COLOR",
  "AW_WILDBUZZARD_TABS",
  "AW_WILDBUZZARD_PRIVACY",
  "AW_WILDBUZZARD_DEFAULT_BROWSER",
  "AW_WILDBUZZARD_FINISH",
];

const WILDBUZZARD_COLOR_IDS = [
  "default",
  "smoke",
  "ash",
  "sun",
  "spark",
  "flame",
  "flare",
  "lavender",
  "dusk",
  "lagoon",
  "tide",
  "pine",
];

function getWildBuzzardDefaults() {
  const defaults = AboutWelcomeDefaults.getDefaults();
  Assert.equal(
    defaults.id,
    "WILDBUZZARD_ONBOARDING",
    "Uses WildBuzzard defaults"
  );
  return defaults;
}

function getScreen(defaults, id) {
  const screen = defaults.screens.find(candidate => candidate.id === id);
  Assert.ok(screen, `Found ${id}`);
  return screen;
}

function assertSettingsAction(action, args) {
  Assert.equal(action.type, "MULTI_ACTION", "Uses a multi action");
  Assert.equal(action.navigate, true, "Continues the onboarding flow");
  Assert.equal(action.data.orderedExecution, true, "Runs actions in order");
  Assert.equal(action.data.actions.length, 1, "Opens one Settings tab");

  const [openSettings] = action.data.actions;
  Assert.equal(openSettings.type, "OPEN_ABOUT_PAGE", "Opens an about page");
  Assert.equal(
    openSettings.data.args,
    args,
    "Opens the expected Settings pane"
  );
  Assert.equal(
    openSettings.data.where,
    "tabshifted",
    "Opens Settings in a background tab"
  );
}

function assertWildBuzzardAction(action, expectedAction, expectedValue) {
  Assert.equal(
    action.type,
    "WILDBUZZARD_ONBOARDING",
    "Uses the WildBuzzard action"
  );
  Assert.equal(action.data.action, expectedAction, "Uses the expected action");
  if (arguments.length === 3) {
    Assert.equal(action.data.value, expectedValue, "Passes the expected value");
  }
}

function clearUserPrefs(prefNames) {
  for (const prefName of prefNames) {
    if (Services.prefs.prefHasUserValue(prefName)) {
      Services.prefs.clearUserPref(prefName);
    }
  }
}

async function openMRAboutWelcome() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.aboutwelcome.enabled", true]],
  });
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "about:welcome",
    true
  );
  await SpecialPowers.spawn(gBrowser.selectedBrowser, [], async function () {
    content.document.notifyUserGestureActivation();
  });

  return {
    browser: tab.linkedBrowser,
    cleanup: async () => {
      BrowserTestUtils.removeTab(tab);
      await SpecialPowers.popPrefEnv();
    },
  };
}

async function test_screen_content(
  browser,
  experiment,
  expectedSelectors = [],
  unexpectedSelectors = []
) {
  await SpecialPowers.spawn(
    browser,
    [{ expectedSelectors, experiment, unexpectedSelectors }],
    async ({
      expectedSelectors: expected,
      experiment: experimentName,
      unexpectedSelectors: unexpected,
    }) => {
      for (const selector of expected) {
        await ContentTaskUtils.waitForCondition(
          () => content.document.querySelector(selector),
          `Should render ${selector} in ${experimentName}`
        );
      }
      for (const selector of unexpected) {
        ok(
          !content.document.querySelector(selector),
          `Should not render ${selector} in ${experimentName}`
        );
      }

      Assert.equal(
        content.document.location.href,
        "about:welcome",
        "Navigated to a welcome screen"
      );
    }
  );
}

async function runWildBuzzardAction(action, value) {
  await SpecialMessageActions.handleAction(
    {
      type: "WILDBUZZARD_ONBOARDING",
      data: { action, value },
    },
    gBrowser.selectedBrowser
  );
}

registerCleanupFunction(() => {
  clearUserPrefs(ACTION_PREFS);
  WildBuzzardThemeColors.clear();
});

add_task(async function test_wildbuzzard_defaults_shape() {
  const defaults = getWildBuzzardDefaults();

  Assert.equal(defaults.template, "multistage", "Uses multistage onboarding");
  Assert.deepEqual(
    defaults.screens.map(screen => screen.id),
    WILDBUZZARD_SCREEN_IDS,
    "Uses the WildBuzzard screen order"
  );

  for (const screen of defaults.screens) {
    Assert.equal(
      screen.content.position,
      "split",
      `${screen.id} uses the split layout`
    );
    Assert.equal(screen.content.fullscreen, true, `${screen.id} is fullscreen`);
    Assert.equal(
      screen.content.progress_bar,
      true,
      `${screen.id} shows progress`
    );
    Assert.ok(screen.content.background, `${screen.id} has a split background`);
  }

  const styleScreen = getScreen(defaults, "AW_WILDBUZZARD_STYLE");
  const [styleTiles, densityTiles] = styleScreen.content.tiles;
  Assert.equal(styleTiles.type, "single-select", "Style screen has a picker");
  Assert.equal(
    styleTiles.selected,
    "wildbuzzard-style-nova",
    "Preselects the Nova style"
  );
  Assert.deepEqual(
    styleTiles.data.map(tile => tile.id),
    [
      "wildbuzzard-style-nova",
      "wildbuzzard-style-proton",
      "wildbuzzard-style-photon",
    ],
    "Offers Nova, Proton, and Photon styles"
  );
  for (const tile of styleTiles.data) {
    assertWildBuzzardAction(
      tile.action,
      "style",
      tile.id.replace("wildbuzzard-style-", "")
    );
  }
  Assert.equal(
    densityTiles.class_name,
    "wildbuzzard-density",
    "Density picker has its styling hook"
  );
  Assert.equal(
    densityTiles.selected,
    "wildbuzzard-density-compact",
    "Preselects the compact density"
  );
  Assert.deepEqual(
    densityTiles.data.map(tile => tile.id),
    ["wildbuzzard-density-compact", "wildbuzzard-density-normal"],
    "Offers the compact and normal densities supported by the picker"
  );
  for (const tile of densityTiles.data) {
    assertWildBuzzardAction(
      tile.action,
      "density",
      tile.id.replace("wildbuzzard-density-", "")
    );
  }
  Assert.equal(
    styleScreen.content.primary_button.action.navigate,
    true,
    "Style primary button continues"
  );
  assertSettingsAction(
    styleScreen.content.secondary_button.action,
    "preferences#appearance"
  );

  const colorScreen = getScreen(defaults, "AW_WILDBUZZARD_THEME_COLOR");
  const [themeModeTiles, colorTiles] = colorScreen.content.tiles;
  Assert.ok(!colorScreen.content.logo, "Theme color screen has no inline logo");
  Assert.equal(
    colorScreen.content.title.string_id,
    "wildbuzzard-onboarding-theme-color-title",
    "Theme color screen uses the WildBuzzard color title"
  );
  Assert.equal(
    themeModeTiles.class_name,
    "wildbuzzard-theme-mode",
    "Theme mode picker has compact styling hook"
  );
  Assert.deepEqual(
    themeModeTiles.data.map(tile => tile.id),
    [
      "wildbuzzard-theme-mode-system",
      "wildbuzzard-theme-mode-light",
      "wildbuzzard-theme-mode-dark",
    ],
    "Offers system, light, and dark mode"
  );
  Assert.deepEqual(
    themeModeTiles.data.map(tile => tile.label.string_id),
    [
      "wildbuzzard-onboarding-theme-mode-system-label",
      "wildbuzzard-onboarding-theme-mode-light-label",
      "wildbuzzard-onboarding-theme-mode-dark-label",
    ],
    "Uses compact WildBuzzard theme mode labels"
  );
  for (const tile of themeModeTiles.data) {
    assertWildBuzzardAction(
      tile.action,
      "theme-mode",
      tile.id.replace("wildbuzzard-theme-mode-", "")
    );
  }
  Assert.equal(
    colorTiles.class_name,
    "wildbuzzard-color-grid",
    "Theme color picker has swatch grid styling hook"
  );
  Assert.equal(
    colorTiles.selected,
    "wildbuzzard-color-default",
    "Default is selected by default"
  );
  Assert.deepEqual(
    colorTiles.data.map(tile => tile.id.replace("wildbuzzard-color-", "")),
    WILDBUZZARD_COLOR_IDS,
    "Offers the expected WildBuzzard colors"
  );
  for (const tile of colorTiles.data) {
    const color = tile.id.replace("wildbuzzard-color-", "");
    assertWildBuzzardAction(tile.action, "theme-color", color);
  }
  Assert.equal(
    colorScreen.content.primary_button.action.navigate,
    true,
    "Theme color primary button continues"
  );
  Assert.equal(
    colorScreen.content.secondary_button.label.string_id,
    "wildbuzzard-onboarding-skip-step-button",
    "Theme color skip button uses the requested label"
  );
  Assert.equal(
    colorScreen.content.secondary_button.has_arrow_icon,
    true,
    "Theme color skip button shows the arrow affordance"
  );
  Assert.equal(
    colorScreen.content.secondary_button.action.navigate,
    true,
    "Theme color skip button continues"
  );

  const tabsScreen = getScreen(defaults, "AW_WILDBUZZARD_TABS");
  const [layoutTiles, locationTiles] = tabsScreen.content.tiles;
  Assert.equal(
    layoutTiles.type,
    "single-select",
    "Layout picker is a single select"
  );
  Assert.equal(
    layoutTiles.selected,
    "wildbuzzard-layout-horizontal",
    "Keeps horizontal tabs selected by default"
  );
  Assert.equal(
    layoutTiles.action.picker,
    "<event>",
    "Layout tiles run their own action"
  );
  Assert.deepEqual(
    layoutTiles.data.map(tile => tile.id),
    [
      "wildbuzzard-layout-horizontal",
      "wildbuzzard-layout-vertical",
      "wildbuzzard-layout-tree",
    ],
    "Offers horizontal, vertical, and tree layouts"
  );
  for (const tile of layoutTiles.data) {
    assertWildBuzzardAction(
      tile.action,
      "layout",
      tile.id.replace("wildbuzzard-layout-", "")
    );
  }
  Assert.equal(
    locationTiles.class_name,
    "wildbuzzard-tab-location",
    "Tab location picker has its styling hook"
  );
  Assert.equal(
    locationTiles.selected,
    "wildbuzzard-location-topabove",
    "Defaults to the top above position"
  );
  Assert.deepEqual(
    locationTiles.data.map(tile => tile.id),
    [
      "wildbuzzard-location-topabove",
      "wildbuzzard-location-topbelow",
      "wildbuzzard-location-bottomabove",
      "wildbuzzard-location-bottombelow",
    ],
    "Offers the four supported tab strip positions"
  );
  for (const tile of locationTiles.data) {
    assertWildBuzzardAction(
      tile.action,
      "tab-location",
      tile.id.replace("wildbuzzard-location-", "")
    );
  }
  assertSettingsAction(
    tabsScreen.content.secondary_button.action,
    "preferences#tabsBrowsing"
  );

  const privacyScreen = getScreen(defaults, "AW_WILDBUZZARD_PRIVACY");
  assertWildBuzzardAction(
    privacyScreen.content.primary_button.action,
    "privacy-defaults",
    true
  );
  Assert.equal(
    privacyScreen.content.primary_button.action.navigate,
    true,
    "Privacy primary button continues"
  );
  assertSettingsAction(
    privacyScreen.content.secondary_button.action,
    "preferences#adBlocking"
  );

  const defaultScreen = getScreen(defaults, "AW_WILDBUZZARD_DEFAULT_BROWSER");
  Assert.equal(
    defaultScreen.targeting,
    "needDefault",
    "Default screen is targeted"
  );
  Assert.equal(
    defaultScreen.content.primary_button.action.type,
    "SET_DEFAULT_BROWSER",
    "Default screen can set the default browser"
  );

  const finishAction = getScreen(defaults, "AW_WILDBUZZARD_FINISH").content
    .primary_button.action;
  Assert.equal(finishAction.type, "OPEN_ABOUT_PAGE", "Finish opens a page");
  Assert.equal(finishAction.data.args, "home", "Finish opens about:home");
  Assert.equal(finishAction.data.where, "current", "Finish reuses the tab");
  Assert.equal(finishAction.navigate, true, "Finish completes onboarding");
});

add_task(
  async function test_wildbuzzard_onboarding_actions_write_expected_prefs() {
    clearUserPrefs(ACTION_PREFS);
    WildBuzzardThemeColors.clear();

    try {
      Services.prefs.setBoolPref(NOVA_PREF, false);
      Services.prefs.setIntPref(STYLE_PREF, 1);

      await runWildBuzzardAction("style", "nova");
      Assert.equal(
        Services.prefs.getBoolPref(NOVA_PREF),
        true,
        "Nova turns on"
      );
      Assert.equal(
        Services.prefs.getIntPref(STYLE_PREF),
        2,
        "Nova turns Lepton chrome styling off"
      );
      Assert.equal(
        Services.prefs.getBoolPref("userChrome.tab.lepton_like_padding"),
        false,
        "Nova keeps the stock tab style"
      );
      Assert.ok(
        !Services.prefs.prefHasUserValue(SUPERNOVA_PREF),
        "Nova does not write the Supernova Lepton pref"
      );

      await runWildBuzzardAction("style", "photon");
      Assert.equal(
        Services.prefs.getBoolPref(NOVA_PREF),
        false,
        "Photon turns Nova off"
      );
      Assert.equal(
        Services.prefs.getIntPref(STYLE_PREF),
        1,
        "Photon enables WildBuzzard styling for stock themes"
      );
      Assert.equal(
        Services.prefs.getBoolPref("userChrome.tab.photon_like_contextline"),
        true,
        "Photon writes the Photon style block"
      );
      Assert.ok(
        !Services.prefs.prefHasUserValue(SUPERNOVA_PREF),
        "Photon does not write the Supernova Lepton pref"
      );

      await runWildBuzzardAction("style", "proton");
      Assert.equal(
        Services.prefs.getBoolPref(NOVA_PREF),
        false,
        "Proton keeps Nova off"
      );
      Assert.equal(
        Services.prefs.getIntPref(STYLE_PREF),
        2,
        "Proton turns Lepton chrome styling off"
      );
      Assert.equal(
        Services.prefs.getBoolPref("userChrome.tab.lepton_like_padding"),
        false,
        "Proton keeps the stock tab style"
      );

      await runWildBuzzardAction("theme-mode", "dark");
      Assert.equal(
        Services.prefs.getStringPref(WILDBUZZARD_THEME_MODE_PREF),
        "dark",
        "Theme mode writes the WildBuzzard mode pref"
      );
      Assert.equal(
        LightweightThemeManager.themeData.theme.id,
        WILDBUZZARD_THEME_ID,
        "Theme mode applies WildBuzzard dynamic theme data"
      );
      Assert.equal(
        LightweightThemeManager.themeData.theme.color_scheme,
        "dark",
        "Dark mode applies dark theme data"
      );
      Assert.ok(
        !LightweightThemeManager.themeData.darkTheme,
        "Forced dark mode does not wait for the system variant"
      );

      await runWildBuzzardAction("theme-color", "pine");
      Assert.equal(
        Services.prefs.getStringPref(WILDBUZZARD_THEME_COLOR_PREF),
        "pine",
        "Theme color writes the WildBuzzard color pref"
      );
      Assert.equal(
        LightweightThemeManager.themeData.theme.toolbarColor,
        "#0a2015",
        "Color choice combines with the current dark mode"
      );

      await runWildBuzzardAction("theme-color", "default");
      Assert.ok(
        !Services.prefs.prefHasUserValue(WILDBUZZARD_THEME_COLOR_PREF),
        "Default theme color clears the WildBuzzard color pref"
      );
      Assert.equal(
        LightweightThemeManager.themeData.theme.toolbarColor,
        "#081a2d",
        "Default color keeps the current dark mode with default colors"
      );

      await runWildBuzzardAction("theme-mode", "system");
      Assert.equal(
        Services.prefs.getStringPref(WILDBUZZARD_THEME_MODE_PREF),
        "system",
        "System mode writes the WildBuzzard mode pref"
      );
      Assert.ok(
        LightweightThemeManager.themeData.darkTheme,
        "System mode keeps light and dark variants available"
      );
      Assert.notEqual(
        LightweightThemeManager.themeData.theme.toolbarColor,
        LightweightThemeManager.themeData.darkTheme.toolbarColor,
        "Light and dark variants visibly differ"
      );

      await runWildBuzzardAction("density", "touch");
      Assert.equal(
        Services.prefs.getIntPref(UIDENSITY_PREF),
        2,
        "Density action writes the UI density pref"
      );

      await runWildBuzzardAction("layout", "tree");
      Assert.equal(
        Services.prefs.getBoolPref(VERTICAL_TABS_PREF),
        true,
        "Tree layout enables vertical tabs"
      );
      Assert.equal(
        Services.prefs.getBoolPref(TREE_TABS_PREF),
        true,
        "Tree layout enables the tree"
      );

      await runWildBuzzardAction("layout", "vertical");
      Assert.equal(
        Services.prefs.getBoolPref(VERTICAL_TABS_PREF),
        true,
        "Vertical layout keeps vertical tabs on"
      );
      Assert.equal(
        Services.prefs.getBoolPref(TREE_TABS_PREF),
        false,
        "Vertical layout turns the tree off"
      );

      await runWildBuzzardAction("layout", "horizontal");
      Assert.equal(
        Services.prefs.getBoolPref(TREE_TABS_PREF),
        false,
        "Horizontal layout keeps the tree off"
      );
      Assert.equal(
        Services.prefs.getBoolPref(VERTICAL_TABS_PREF),
        false,
        "Horizontal layout disables vertical tabs"
      );

      await runWildBuzzardAction("tab-location", "bottomabove");
      Assert.equal(
        Services.prefs.getStringPref(TABBAR_POSITION_PREF),
        "bottomabove",
        "Tab location action writes the tab strip position"
      );

      Services.prefs.setBoolPref(PRIVACY_PREF, false);
      await runWildBuzzardAction("privacy-defaults", true);
      Assert.equal(
        Services.prefs.getBoolPref(PRIVACY_PREF),
        true,
        "Privacy action keeps the blocker enabled"
      );
    } finally {
      clearUserPrefs(ACTION_PREFS);
      WildBuzzardThemeColors.clear();
    }
  }
);

add_task(async function test_wildbuzzard_defaults_render_first_screen() {
  const { browser, cleanup } = await openMRAboutWelcome();

  try {
    await test_screen_content(
      browser,
      "WildBuzzard onboarding first screen",
      [
        "main.AW_WILDBUZZARD_WELCOME[pos='split']",
        "div.onboardingContainer",
        "div.section-secondary",
        "div.steps",
        "button.primary",
      ],
      ["main.AW_WILDBUZZARD_STYLE"]
    );
  } finally {
    await cleanup();
  }
});
