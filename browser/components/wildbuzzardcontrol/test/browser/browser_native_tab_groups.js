/* SPDX-License-Identifier: AGPL-3.0-or-later */

"use strict";

const { BrowserControl } = ChromeUtils.importESModule(
  "chrome://remote/content/wildbuzzard/BrowserControl.sys.mjs"
);

add_task(async function test_native_tab_group_lifecycle() {
  const { WildBuzzardControlStartup: startup } = ChromeUtils.importESModule(
    "resource:///modules/WildBuzzardControlStartup.sys.mjs"
  );
  const { Subprocess } = ChromeUtils.importESModule(
    "resource://gre/modules/Subprocess.sys.mjs"
  );
  const wasStarted = Boolean(startup.task);
  const endpoint = await startup.init();
  Assert.ok(endpoint?.socketPath, "the native command socket is ready");
  async function read(pipe) {
    let result = "";
    for (let chunk; (chunk = await pipe.readString()); ) {
      result += chunk;
    }
    return result;
  }
  const call = async (tool, args) => {
    const process = await Subprocess.call({
      command: Services.dirsvc.get("XREExeF", Ci.nsIFile).path,
      arguments: [
        "--json",
        "--session",
        "native-tab-groups-test",
        tool,
        "--input",
        JSON.stringify(args),
      ],
      environmentAppend: true,
      environment: {
        WILDBUZZARD_CONTROL_SOCKET: endpoint.socketPath,
        WILDBUZZARD_NO_START: "1",
      },
      stderr: "pipe",
    });
    await process.stdin.close();
    const [stdout, stderr, result] = await Promise.all([
      read(process.stdout),
      read(process.stderr),
      process.wait(),
    ]);
    Assert.equal(result.exitCode, 0, `${tool}: ${stderr}`);
    return JSON.parse(stdout);
  };
  const pages = [];
  const extraWindow = await BrowserTestUtils.openNewBrowserWindow();
  try {
    for (let index = 0; index < 2; index++) {
      const result = await call("tabs", {
        action: "new",
        url: "https://example.com/browser/browser/components/wildbuzzardcontrol/test/browser/file_gecko_render.sjs",
        background: false,
        windowId: extraWindow.windowGlobalChild.innerWindowId,
      });
      pages.push(result.details.page);
    }
    const created = await call("tab_groups", {
      action: "create",
      pages,
      title: "Native test group",
      color: "blue",
    });
    Assert.deepEqual(created.details.group.pageIds, pages);
    await call("tab_groups", {
      action: "update",
      groupId: created.details.group.groupId,
      collapsed: true,
    });
    await call("tab_groups", { action: "ungroup", pages });
    for (const page of pages) {
      Assert.equal(BrowserControl.pageForId(page).tab.group, null);
    }
  } finally {
    for (const page of pages) {
      const entry = [...BrowserControl.tabs()].find(
        item => BrowserControl.pageIds.get(item.browser) === page
      );
      if (entry) {
        BrowserTestUtils.removeTab(entry.tab);
      }
      BrowserControl.pageOwners.delete(page);
    }
    await BrowserTestUtils.closeWindow(extraWindow);
    if (!wasStarted) {
      await startup.uninit();
    }
  }
});
