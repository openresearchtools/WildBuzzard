/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);

const AGENT_URL = "http://127.0.0.1:8765/";

add_task(function test_agent_button_uses_switch_or_open_route() {
  const button = document.getElementById("wildbuzzard-agent-toolbar-button");
  ok(button, "Agent button is present");

  const sandbox = sinon.createSandbox();
  try {
    const switchOrOpen = sandbox.stub(window, "switchToTabHavingURI");
    switchOrOpen.onFirstCall().returns(false);
    switchOrOpen.onSecondCall().returns(true);

    EventUtils.synthesizeMouseAtCenter(button, {}, window);
    EventUtils.synthesizeMouseAtCenter(button, {}, window);

    is(switchOrOpen.callCount, 2, "Each click uses the switch-or-open route");
    for (const call of switchOrOpen.getCalls()) {
      is(call.args[0].spec, AGENT_URL, "The Agent URL is opened");
      is(call.args[1], true, "A missing Agent tab is opened");
      ok(call.args[2].ignoreQueryString, "Pi Web session URLs are reused");
      ok(
        call.args[2].triggeringPrincipal.isSystemPrincipal,
        "The route is privileged"
      );
    }
  } finally {
    sandbox.restore();
  }
});

add_task(function test_privacy_controls_are_placed_next_to_urlbar() {
  const placements = CustomizableUI.getWidgetIdsInArea(
    CustomizableUI.AREA_NAVBAR
  );
  const blockerIndex = placements.indexOf("wildbuzzard-blocker-toolbar-button");
  is(
    blockerIndex,
    placements.indexOf("urlbar-container") - 1,
    "Ad blocking is immediately before the address bar"
  );
  is(
    placements.indexOf("wildbuzzard-tor-toolbar-button"),
    blockerIndex - 1,
    "Tor is beside ad blocking"
  );
});
