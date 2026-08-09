/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { UrlbarTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/UrlbarTestUtils.sys.mjs"
);
const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);

const AGENT_URL = "http://127.0.0.1:8765/";

add_setup(function () {
  UrlbarTestUtils.init(this);
});

async function enterAgentAlias(value) {
  await UrlbarTestUtils.promiseAutocompleteResultPopup({ window, value });
  EventUtils.synthesizeKey("KEY_Enter");
}

add_task(async function test_agent_alias_uses_switch_or_open_route() {
  const sandbox = sinon.createSandbox();
  try {
    const switchOrOpen = sandbox.stub(window, "switchToTabHavingURI");
    switchOrOpen.onFirstCall().returns(false);
    switchOrOpen.onSecondCall().returns(true);

    await enterAgentAlias("AgEnT");
    await enterAgentAlias("AGENT");

    is(
      switchOrOpen.callCount,
      2,
      "Every case variation uses the switch-or-open route"
    );
    for (const call of switchOrOpen.getCalls()) {
      is(call.args[0].spec, AGENT_URL, "The alias opens the Agent URL");
      is(call.args[1], true, "The alias recreates a missing Agent tab");
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
