"use strict";

let extData = {
  manifest: {
    sidebar_action: {
      default_panel: "sidebar.html",
    },
  },
  useAddonManager: "temporary",

  files: {
    "sidebar.html": `
      <!DOCTYPE html>
      <html>
      <head><meta charset="utf-8"/>
      <script src="sidebar.js"></script>
      </head>
      <body>
      A Test Sidebar
      </body></html>
    `,

    "sidebar.js": function () {
      window.onload = () => {
        browser.test.sendMessage("sidebar");
      };
    },
  },
};

add_task(async function sidebar_windows() {
  let extension = ExtensionTestUtils.loadExtension(extData);
  await extension.startup();
  // Test sidebar is opened on install
  await extension.awaitMessage("sidebar");
  ok(
    !document.getElementById("sidebar-box").hidden,
    "sidebar box is visible in first window"
  );
  // Check that the menuitem has our image styling.
  let elements = document.getElementsByClassName("webextension-menuitem");
  // ui is in flux, at time of writing we potentially have 3 menuitems, later
  // it may be two or one, just make sure one is there.
  ok(!!elements.length, "have a menuitem");
  let style = elements[0].getAttribute("style");
  ok(style.includes("webextension-menuitem-image"), "this menu has style");

  let secondSidebar = extension.awaitMessage("sidebar");

  // SidebarController relies on window.opener being set, which is normal behavior when
  // using menu or key commands to open a new browser window.
  let win = await BrowserTestUtils.openNewBrowserWindow();

  await secondSidebar;
  ok(
    !win.document.getElementById("sidebar-box").hidden,
    "sidebar box is visible in second window"
  );
  // Check that the menuitem has our image styling.
  elements = win.document.getElementsByClassName("webextension-menuitem");
  ok(!!elements.length, "have a menuitem");
  style = elements[0].getAttribute("style");
  ok(style.includes("webextension-menuitem-image"), "this menu has style");

  await extension.unload();
  await BrowserTestUtils.closeWindow(win);
});

add_task(async function sidebar_open_on_new_window_at_end() {
  await SpecialPowers.pushPrefEnv({
    set: [["sidebar.position_start", true]],
  });

  let data = {
    ...extData,
    manifest: {
      ...extData.manifest,
      sidebar_action: {
        ...extData.manifest.sidebar_action,
        open_at_install: false,
        open_on_new_window: true,
        default_position: "end",
      },
    },
  };

  let extension = ExtensionTestUtils.loadExtension(data);
  await extension.startup();
  await extension.awaitMessage("sidebar");

  is(
    Services.prefs.getBoolPref("sidebar.position_start"),
    false,
    "sidebar uses its requested end position"
  );

  let secondSidebar = extension.awaitMessage("sidebar");
  let win = await BrowserTestUtils.openNewBrowserWindow();
  await secondSidebar;

  ok(
    !win.document.getElementById("sidebar-box").hidden,
    "sidebar opens automatically in the new window"
  );
  is(
    win.SidebarController.currentID,
    `${makeWidgetId(extension.id)}-sidebar-action`,
    "new window opens the requesting extension sidebar"
  );

  await BrowserTestUtils.closeWindow(win);
  await extension.unload();
  await SpecialPowers.popPrefEnv();
});
