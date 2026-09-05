const { LightweightThemeManager } = ChromeUtils.importESModule(
  "resource://gre/modules/LightweightThemeManager.sys.mjs"
);
const { WildBuzzardTheme } = ChromeUtils.importESModule(
  "resource:///modules/WildBuzzardTheme.sys.mjs"
);
const {
  WILDBUZZARD_THEME_COLOR_PREF,
  WILDBUZZARD_THEME_ID,
  WILDBUZZARD_THEME_MODE_PREF,
} = ChromeUtils.importESModule(
  "resource:///modules/WildBuzzardThemeColors.sys.mjs"
);

const DEFAULT_THEME_ID = "default-theme@mozilla.org";
const MODE_PREF = "browser.theme.enableWildBuzzardCustomizations";
const THEME_PREF = "extensions.activeThemeID";
const THEME_UPDATE_TOPIC = "lightweight-theme-styling-update";

function assertLoaded(loaded, message) {
  is(WildBuzzardTheme.stylesEnabled, loaded, message);
}

function makeThemeData(id, toolbarColor) {
  return LightweightThemeManager.themeDataFrom(
    { colors: { toolbar: toolbarColor } },
    null,
    null,
    Services.io.newURI("resource://gre/"),
    id,
    "1.0",
    null
  );
}

function updateTheme(data) {
  LightweightThemeManager.fallbackThemeData = data;
  Services.obs.notifyObservers(data, THEME_UPDATE_TOPIC);
}

function waitForMainThread() {
  return new Promise(resolve => Services.tm.dispatchToMainThread(resolve));
}

async function withPaletteSelection(task) {
  const originalThemeData = LightweightThemeManager.themeData;
  await SpecialPowers.pushPrefEnv({
    set: [
      [THEME_PREF, DEFAULT_THEME_ID],
      [WILDBUZZARD_THEME_MODE_PREF, "light"],
      [WILDBUZZARD_THEME_COLOR_PREF, "pine"],
    ],
  });

  try {
    await task();
  } finally {
    await SpecialPowers.popPrefEnv();
    updateTheme(originalThemeData);
    await waitForMainThread();
  }
}

add_task(async function test_default_state() {
  assertLoaded(false, "Nova leaves Lepton off by default");
});

add_task(async function test_mode_gating() {
  await SpecialPowers.pushPrefEnv({ set: [[MODE_PREF, 2]] });
  assertLoaded(false, "Mode 2 keeps the stock look");
  await SpecialPowers.popPrefEnv();

  await SpecialPowers.pushPrefEnv({ set: [[MODE_PREF, 0]] });
  assertLoaded(true, "Mode 0 applies Lepton with every theme");

  await SpecialPowers.pushPrefEnv({
    set: [[THEME_PREF, "some-third-party-theme@example.com"]],
  });
  assertLoaded(true, "Mode 0 stays on with a third party theme");
  await SpecialPowers.popPrefEnv();
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_theme_gating() {
  await SpecialPowers.pushPrefEnv({ set: [[MODE_PREF, 1]] });

  await SpecialPowers.pushPrefEnv({
    set: [[THEME_PREF, "some-third-party-theme@example.com"]],
  });
  assertLoaded(false, "Mode 1 unloads for a third party theme");
  await SpecialPowers.popPrefEnv();

  assertLoaded(true, "Mode 1 reloads when the stock theme returns");
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_palette_reapplies_after_default_theme_update() {
  await withPaletteSelection(async () => {
    const updates = [];
    const observer = subject => {
      updates.push(subject.wrappedJSObject.theme?.id);
    };
    Services.obs.addObserver(observer, THEME_UPDATE_TOPIC);

    try {
      const reapplied = TestUtils.topicObserved(
        THEME_UPDATE_TOPIC,
        subject => subject.wrappedJSObject.theme?.id === WILDBUZZARD_THEME_ID
      );
      updateTheme(makeThemeData(DEFAULT_THEME_ID, "#ffffff"));
      await reapplied;
      await waitForMainThread();

      is(
        LightweightThemeManager.themeData.theme.id,
        WILDBUZZARD_THEME_ID,
        "The WildBuzzard palette replaces the late default theme update"
      );
      is(
        LightweightThemeManager.themeData.theme.toolbarColor,
        "#f0fcf5",
        "The persisted palette is reapplied"
      );
      is(
        updates.filter(id => id === WILDBUZZARD_THEME_ID).length,
        1,
        "The WildBuzzard theme update does not loop"
      );
      is(
        updates[updates.length - 1],
        WILDBUZZARD_THEME_ID,
        "The WildBuzzard theme is the final update"
      );
    } finally {
      Services.obs.removeObserver(observer, THEME_UPDATE_TOPIC);
    }
  });
});

add_task(async function test_pending_reapply_preserves_new_theme_update() {
  await withPaletteSelection(async () => {
    const thirdPartyThemeId = "third-party-theme@example.com";
    const updates = [];
    const observer = subject => {
      updates.push(subject.wrappedJSObject.theme?.id);
    };
    Services.obs.addObserver(observer, THEME_UPDATE_TOPIC);

    try {
      updateTheme(makeThemeData(DEFAULT_THEME_ID, "#ffffff"));
      updateTheme(makeThemeData(thirdPartyThemeId, "#000000"));
      await waitForMainThread();

      is(
        LightweightThemeManager.themeData.theme.id,
        thirdPartyThemeId,
        "A newer third-party theme update is preserved"
      );
      ok(
        !updates.includes(WILDBUZZARD_THEME_ID),
        "The pending WildBuzzard reapply is cancelled"
      );
    } finally {
      Services.obs.removeObserver(observer, THEME_UPDATE_TOPIC);
    }
  });
});

add_task(async function test_default_palette_without_saved_selection() {
  const { WildBuzzardThemeColors } = ChromeUtils.importESModule(
    "resource:///modules/WildBuzzardThemeColors.sys.mjs"
  );
  await SpecialPowers.pushPrefEnv({
    set: [[THEME_PREF, DEFAULT_THEME_ID]],
    clear: [[WILDBUZZARD_THEME_MODE_PREF], [WILDBUZZARD_THEME_COLOR_PREF]],
  });
  try {
    WildBuzzardThemeColors.apply();
    is(
      LightweightThemeManager.themeData.theme.id,
      WILDBUZZARD_THEME_ID,
      "A fresh profile gets the WildBuzzard default without onboarding"
    );
    is(WildBuzzardThemeColors.getMode(), "system", "Default follows the OS");
    ok(
      LightweightThemeManager.themeData.darkTheme,
      "System mode provides a dark variant"
    );

    for (const [mode, background] of [
      ["light", "#f5f5f5"],
      ["dark", "#303030"],
    ]) {
      WildBuzzardThemeColors.setMode(mode);
      is(
        LightweightThemeManager.themeData.theme.toolbarColor,
        background,
        `${mode} mode uses a neutral toolbar`
      );
      WildBuzzardThemeColors.setColor("pine");
      WildBuzzardThemeColors.setColor("default");
      is(
        LightweightThemeManager.themeData.theme.toolbarColor,
        background,
        "Selecting Default restores the neutral palette"
      );
      gURLBar.focus();
      is(
        getComputedStyle(gURLBar.querySelector(".urlbar-input-container"))
          .outlineColor,
        mode === "light" ? "rgb(74, 74, 74)" : "rgb(200, 200, 200)",
        "The focused address bar follows the neutral accent"
      );
    }
    WildBuzzardThemeColors.clear();
    const reapplied = TestUtils.topicObserved(
      THEME_UPDATE_TOPIC,
      subject => subject.wrappedJSObject.theme?.id === WILDBUZZARD_THEME_ID
    );
    updateTheme(makeThemeData(DEFAULT_THEME_ID, "#ffffff"));
    await reapplied;
    ok(
      !Services.prefs.prefHasUserValue(WILDBUZZARD_THEME_MODE_PREF) &&
        !Services.prefs.prefHasUserValue(WILDBUZZARD_THEME_COLOR_PREF),
      "Reset and late startup theme updates need no saved selection"
    );
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_quiet_startup_defaults() {
  const prefs = Services.prefs.getDefaultBranch("");
  for (const pref of [
    "browser.aboutwelcome.enabled",
    "browser.aboutwelcome.experimentsGate.enabled",
    "browser.startup.upgradeDialog.enabled",
    "browser.shell.checkDefaultBrowser",
    "browser.laterrun.enabled",
    "browser.preonboarding.enabled",
  ]) {
    ok(!prefs.getBoolPref(pref), `${pref} is off by default`);
  }
  for (const pref of [
    "startup.homepage_welcome_url",
    "startup.homepage_welcome_url.additional",
    "startup.homepage_override_url",
  ]) {
    is(prefs.getStringPref(pref), "", `${pref} opens no extra page`);
  }
});

add_task(async function test_dark_web_page_defaults() {
  await BrowserTestUtils.withNewTab(
    'data:text/html,<meta name="color-scheme" content="dark"><body><div style="background:Canvas;color:CanvasText">Dark page</div><div id="authored" style="background:blue">Authored color</div>',
    async browser => {
      await SpecialPowers.spawn(browser, [], async () => {
        const canvas = content.getComputedStyle(
          content.document.querySelector("div")
        );
        is(
          canvas.backgroundColor,
          "rgb(30, 30, 30)",
          "Dark Canvas is graphite"
        );
        is(
          canvas.color,
          "rgb(229, 229, 229)",
          "Dark Canvas text stays readable"
        );
        is(
          content.getComputedStyle(content.document.getElementById("authored"))
            .backgroundColor,
          "rgb(0, 0, 255)",
          "The website still controls its own authored colors"
        );
      });
    }
  );
});
