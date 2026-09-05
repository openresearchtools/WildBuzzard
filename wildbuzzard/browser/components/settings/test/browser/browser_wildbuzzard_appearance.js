/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_task(async function appearance_has_only_working_colour_modes() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.theme.wildbuzzard.mode", "system"]],
  });
  const tab = await openPrefsTab("appearance");
  try {
    const doc = tab.linkedBrowser.contentDocument;
    const group = await settingGroupRenders(doc, "wildbuzzardThemeColors");
    await TestUtils.waitForCondition(
      () => group.querySelectorAll('[role="radio"]').length === 3
    );
    Assert.deepEqual(
      [...group.querySelectorAll('[role="radio"]')].map(e => e.dataset.value),
      ["system", "light", "dark"],
      "Only the three supported modes are offered"
    );
    const pane = group.closest("setting-pane");
    Assert.deepEqual(
      [...pane.querySelectorAll("setting-group")].map(e =>
        e.getAttribute("groupid")
      ),
      ["wildbuzzardThemeColors"],
      "No themes, palettes, layout styles or duplicate website controls"
    );
    for (const mode of ["dark", "light", "system"]) {
      group.querySelector(`[data-value="${mode}"]`).click();
      await TestUtils.waitForCondition(
        () =>
          Services.prefs.getStringPref("browser.theme.wildbuzzard.mode") ===
          mode
      );
      is(
        group.querySelector('[aria-checked="true"]').dataset.value,
        mode,
        "Mode selection is reflected in the control"
      );
    }
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});
