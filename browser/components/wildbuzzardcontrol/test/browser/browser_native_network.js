/* SPDX-License-Identifier: AGPL-3.0-or-later */

"use strict";

const { BrowserControl } = ChromeUtils.importESModule(
  "chrome://remote/content/wildbuzzard/BrowserControl.sys.mjs"
);

add_task(async function test_native_network_captures_page_response() {
  const wasStarted = BrowserControl.started;
  BrowserControl.start();
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "about:blank"
  );
  const page = BrowserControl.pageIdFor(tab.linkedBrowser);
  const clientId = "native-network-test";
  BrowserControl.pageOwners.set(page, clientId);
  const url =
    "https://example.com/browser/browser/components/wildbuzzardcontrol/test/browser/file_gecko_render.sjs?mode=json";
  const call = (tool, args = {}) =>
    BrowserControl.dispatch(
      tool,
      { page, ...args },
      PathUtils.profileDir,
      clientId,
      new AbortController().signal
    );
  try {
    await call("navigate", { action: "url", url });
    let request;
    await TestUtils.waitForCondition(async () => {
      const result = await call("list_network_requests");
      request = result.details.requests.find(item => item.url === url);
      return request?.status === 200;
    }, "native network tools capture the loaded page");
    let response;
    await TestUtils.waitForCondition(async () => {
      const result = await call("get_network_request", { id: request.id });
      response = result.details.request;
      return typeof response.responseBody === "string";
    }, "the response body is collected");
    const body =
      response.responseBodyEncoding === "base64"
        ? atob(response.responseBody)
        : response.responseBody;
    Assert.deepEqual(JSON.parse(body), { rendered: true, source: "original" });
  } finally {
    BrowserControl.pageOwners.delete(page);
    BrowserTestUtils.removeTab(tab);
    if (!wasStarted) {
      BrowserControl.stop();
    }
  }
});
