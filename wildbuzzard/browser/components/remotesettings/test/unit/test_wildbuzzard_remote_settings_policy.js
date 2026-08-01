/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { Utils } = ChromeUtils.importESModule(
  "resource://services-settings/Utils.sys.mjs"
);
const { WildBuzzardSettingsPolicy } = ChromeUtils.importESModule(
  "resource://services-settings/WildBuzzardSettingsPolicy.sys.mjs"
);

async function hasPackagedDump(bucket, collection) {
  if (await Utils.hasLocalDump(bucket, collection)) {
    return true;
  }

  // In xpcshell, resource://app resolves one level above firefox-appdir.
  try {
    const response = await fetch(
      `resource://app/browser/defaults/settings/${bucket}/${collection}.json`,
      { method: "HEAD" }
    );
    return response.ok;
  } catch (ex) {
    return false;
  }
}

add_task(async function test_required_offline_dumps_are_bundled() {
  const missing = [];

  for (const [
    bucket,
    collection,
  ] of WildBuzzardSettingsPolicy.requiredOfflineDumps) {
    Assert.ok(
      !WildBuzzardSettingsPolicy.canSync(bucket, collection),
      `${bucket}/${collection} stays on bundled records`
    );

    if (!(await hasPackagedDump(bucket, collection))) {
      missing.push(`${bucket}/${collection}`);
    }
  }

  Assert.deepEqual(missing, [], "required offline dumps are bundled");
});

add_task(function test_vendor_services_are_disabled_and_locked() {
  const booleanPolicy = new Map([
    ["app.update.enabled", false],
    ["datareporting.policy.dataSubmissionEnabled", false],
    ["identity.fxaccounts.enabled", false],
    ["services.sync.enabled", false],
    ["toolkit.telemetry.enabled", false],
  ]);
  const stringPolicy = new Map([
    ["app.update.url.override", ""],
    ["dom.push.serverURL", ""],
    ["extensions.update.url", ""],
    ["services.settings.server", "data:,#remote-settings-disabled/v1"],
    ["toolkit.telemetry.server", ""],
  ]);

  for (const [name, expected] of booleanPolicy) {
    Assert.ok(Services.prefs.prefIsLocked(name), `${name} is policy-locked`);
    Assert.equal(
      Services.prefs.getBoolPref(name),
      expected,
      `${name} has the offline value`
    );
  }

  for (const [name, expected] of stringPolicy) {
    Assert.ok(Services.prefs.prefIsLocked(name), `${name} is policy-locked`);
    Assert.equal(
      Services.prefs.getStringPref(name),
      expected,
      `${name} has the offline value`
    );
  }
});

add_task(function test_no_vendor_service_urls_remain_in_effective_prefs() {
  const forbiddenVendor =
    /https?:\/\/(?:[^/]*\.)?(?:browserworks\.(?:com|org)|firefox\.com|mozilla\.(?:com|net|org)|waterfox\.net)(?:[/:]|$)/i;
  const remaining = [];

  for (const name of Services.prefs.getChildList("")) {
    if (Services.prefs.getPrefType(name) !== Services.prefs.PREF_STRING) {
      continue;
    }

    let value;
    try {
      value = Services.prefs.getStringPref(name);
    } catch (ex) {
      continue;
    }

    if (forbiddenVendor.test(value)) {
      remaining.push(`${name}=${value}`);
    }
  }

  Assert.deepEqual(
    remaining,
    [],
    "effective preferences contain no Mozilla, Firefox, Waterfox, or BrowserWorks service URLs"
  );
});
