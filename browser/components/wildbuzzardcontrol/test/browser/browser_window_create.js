/* SPDX-License-Identifier: AGPL-3.0-or-later */

"use strict";

const { BrowserControl } = ChromeUtils.importESModule(
  "chrome://remote/content/wildbuzzard/BrowserControl.sys.mjs"
);

const TARGET_URL =
  "https://example.com/browser/browser/components/wildbuzzardcontrol/test/browser/file_gecko_render.sjs?mode=text";

add_task(async function test_window_create_waits_for_requested_url() {
  const wasStarted = BrowserControl.started;
  BrowserControl.start();
  const clientId = "window-create-test";
  let windowId;
  try {
    const result = await BrowserControl.dispatch(
      "windows",
      { action: "create", url: TARGET_URL },
      PathUtils.profileDir,
      clientId,
      new AbortController().signal
    );
    windowId = result.details.window.windowId;
    Assert.equal(
      result.details.window.page.url,
      TARGET_URL,
      "window creation returns only after the requested page loads"
    );
  } finally {
    if (windowId) {
      await BrowserControl.dispatch(
        "windows",
        { action: "close", windowId },
        PathUtils.profileDir,
        clientId,
        new AbortController().signal
      );
    }
    if (!wasStarted) {
      BrowserControl.stop();
    }
  }
});
