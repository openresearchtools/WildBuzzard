/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_task(async function test_data_collection_group_renders() {
  let tab = await openPrefsTab("permissionsData");
  let doc = tab.linkedBrowser.contentDocument;

  let group = await settingGroupRenders(doc, "wildbuzzardDataCollection");
  ok(group, "The WildBuzzard data collection group renders");

  let link = doc.getElementById("wildbuzzardDataCollectionPrivacyNotice");
  ok(link, "The privacy notice link renders");
  is(
    link.getAttribute("href"),
    "about:license",
    "The link points at the WildBuzzard privacy policy"
  );

  BrowserTestUtils.removeTab(tab);
});
