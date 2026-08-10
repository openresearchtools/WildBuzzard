/* SPDX-License-Identifier: AGPL-3.0-or-later */

"use strict";

/* global browser */

async function startPiWeb() {
  const status = await browser.wildbuzzardAgent.initialize();
  const tabs = await browser.tabs.query({});
  await Promise.allSettled(
    tabs
      .filter(
        tab => tab.url === status.pageUrl || tab.url?.startsWith(status.url)
      )
      .map(tab => browser.tabs.reload(tab.id))
  );
}

startPiWeb().catch(error => {
  console.error("Pi Web failed to initialize", error);
});
