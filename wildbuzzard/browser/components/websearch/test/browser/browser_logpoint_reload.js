/* SPDX-License-Identifier: AGPL-3.0-or-later */

"use strict";

const { BrowserControl } = ChromeUtils.importESModule(
  "chrome://remote/content/wildbuzzard/BrowserControl.sys.mjs"
);

const LOGPOINT_PAGE =
  "https://example.com/browser/wildbuzzard/browser/components/websearch/test/browser/file_gecko_render.sjs?mode=logpoint-page";
const LOGPOINT_SCRIPT =
  "https://example.com/browser/wildbuzzard/browser/components/websearch/test/browser/file_gecko_render.sjs?mode=logpoint-script";

add_task(async function test_logpoint_survives_reload() {
  const wasStarted = BrowserControl.started;
  BrowserControl.start();
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    LOGPOINT_PAGE
  );
  const page = BrowserControl.pageIdFor(tab.linkedBrowser);
  const clientId = "logpoint-reload-test";
  BrowserControl.pageOwners.set(page, clientId);
  let logpoint;
  try {
    const set = await BrowserControl.dispatch(
      "set_logpoint",
      {
        expression: '"reload-hit"',
        line: 1,
        page,
        url: LOGPOINT_SCRIPT,
      },
      PathUtils.profileDir,
      clientId,
      new AbortController().signal
    );
    Assert.greater(set.details.installed, 0, "logpoint installed");
    logpoint = set.details.logpoint;

    await BrowserTestUtils.reloadTab(tab);
    await TestUtils.waitForCondition(async () => {
      const result = await BrowserControl.dispatch(
        "get_logpoint_results",
        { logpoint, page },
        PathUtils.profileDir,
        clientId,
        new AbortController().signal
      );
      return result.details.results.some(item => item.value === "reload-hit");
    }, "logpoint fired after reload");
  } finally {
    if (logpoint) {
      await BrowserControl.dispatch(
        "remove_logpoint",
        { logpoint, page },
        PathUtils.profileDir,
        clientId,
        new AbortController().signal
      );
    }
    BrowserControl.pageOwners.delete(page);
    BrowserTestUtils.removeTab(tab);
    if (!wasStarted) {
      BrowserControl.stop();
    }
  }
});
