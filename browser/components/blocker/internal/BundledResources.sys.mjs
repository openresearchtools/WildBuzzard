/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const BUNDLED_RESOURCE_URLS = Object.freeze([
  "resource://wildbuzzard/blocker/assets/resources/ubo-scriptlets.json",
  "resource://wildbuzzard/blocker/assets/resources/resources.json",
]);

async function readBundledArray(url) {
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      return [];
    }
    const parsed = JSON.parse(await response.text());
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.warn(
      `[WildBuzzardBlocker] Failed reading bundled resource ${url}:`,
      error
    );
    return [];
  }
}

export const BundledResources = {
  async readMergedResources() {
    const merged = [];
    for (const url of BUNDLED_RESOURCE_URLS) {
      const entries = await readBundledArray(url);
      if (entries.length) {
        merged.push(...entries);
      }
    }
    return merged;
  },
};
