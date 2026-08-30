/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const AGENT_BUTTON = "wildbuzzard-agent-toolbar-button";

add_task(function test_removed_agent_button_is_migrated_out_of_saved_state() {
  const oldState = CustomizableUI.getTestOnlyInternalProp("gSavedState");
  const seenWidgets = CustomizableUI.getTestOnlyInternalProp("gSeenWidgets");
  const wasSeen = seenWidgets.has(AGENT_BUTTON);
  registerCleanupFunction(() => {
    CustomizableUI.setTestOnlyInternalProp("gSavedState", oldState);
    if (!wasSeen) {
      seenWidgets.delete(AGENT_BUTTON);
    }
  });
  CustomizableUI.setTestOnlyInternalProp("gSavedState", {
    currentVersion: 29,
    placements: {
      "nav-bar": ["back-button", AGENT_BUTTON, "urlbar-container"],
      "widget-overflow-fixed-list": [AGENT_BUTTON, "downloads-button"],
    },
  });

  const internal = CustomizableUI.getTestOnlyInternalProp(
    "CustomizableUIInternal"
  );
  internal.markObsoleteBuiltinButtonsSeen();
  internal.updateForNewVersion();

  Assert.deepEqual(
    CustomizableUI.getTestOnlyInternalProp("gSavedState").placements,
    {
      "nav-bar": ["back-button", "urlbar-container"],
      "widget-overflow-fixed-list": ["downloads-button"],
    },
    "version 30 removes every stale Agent button placement"
  );
  Assert.ok(
    seenWidgets.has(AGENT_BUTTON),
    "the removed built-in is not treated as a surviving XUL widget"
  );
});
