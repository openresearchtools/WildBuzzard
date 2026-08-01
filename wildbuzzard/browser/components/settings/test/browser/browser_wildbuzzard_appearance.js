/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const MODE_PREF = "browser.theme.enableWildBuzzardCustomizations";

registerCleanupFunction(() => {
  Services.prefs.clearUserPref(MODE_PREF);
  Services.prefs.clearUserPref("userChrome.autohide.tabbar");
});

add_task(async function test_appearance_group_renders() {
  let tab = await openPrefsTab("appearance");
  let doc = tab.linkedBrowser.contentDocument;

  let group = await settingGroupRenders(doc, "wildbuzzardBrowserStyle");
  ok(group, "The WildBuzzard styling group renders on the appearance pane");

  let picker = doc
    .getElementById("setting-control-wildbuzzard-browser-style")
    ?.querySelector("moz-visual-picker");
  ok(picker, "The browser style visual picker renders");
  is(picker.value, "nova", "Nova is the default browser style");
  Assert.deepEqual(
    [...picker.querySelectorAll("moz-visual-picker-item")].map(
      item => item.value
    ),
    ["nova", "proton", "photon"],
    "Nova, Proton, and Photon are all available"
  );

  let details = await settingGroupRenders(doc, "wildbuzzardAppearanceDetails");
  ok(details, "The detailed appearance controls render");

  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_photon_picker_writes_style_block() {
  let tab = await openPrefsTab("appearance");
  let doc = tab.linkedBrowser.contentDocument;

  await settingGroupRenders(doc, "wildbuzzardBrowserStyle");
  let picker = doc
    .getElementById("setting-control-wildbuzzard-browser-style")
    ?.querySelector("moz-visual-picker");
  ok(picker, "The browser style visual picker renders");

  let prefChanged = TestUtils.waitForPrefChange(
    "userChrome.tab.photon_like_contextline"
  );
  picker.value = "photon";
  picker.dispatchEvent(new Event("change", { bubbles: true }));
  await prefChanged;

  is(
    Services.prefs.getIntPref(MODE_PREF),
    1,
    "Choosing Photon enables WildBuzzard styling for stock themes"
  );
  is(
    Services.prefs.getBoolPref("userChrome.tab.photon_like_contextline"),
    true,
    "Choosing Photon writes its style block"
  );
  is(
    Services.prefs.getBoolPref("userChrome.tab.lepton_like_padding"),
    true,
    "Photon enables the Lepton padding style"
  );

  for (let pref of [
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
  ]) {
    Services.prefs.clearUserPref(pref);
  }

  BrowserTestUtils.removeTab(tab);
});
