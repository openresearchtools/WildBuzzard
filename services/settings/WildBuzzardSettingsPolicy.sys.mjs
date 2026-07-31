/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// WildBuzzard keeps Remote Settings fully offline. Collections read their
// records from dumps bundled with the build and never contact Mozilla or a
// WildBuzzard-operated replacement service.

// Packaged dump-only collections that active desktop features read at runtime.
const REQUIRED_OFFLINE_DUMPS = Object.freeze([
  ["main", "ai-window-prompts"],
  ["main", "anti-tracking-url-decoration"],
  ["main", "cookie-banner-rules-list"],
  ["main", "devtools-compatibility-browsers"],
  ["main", "devtools-devices"],
  ["main", "doh-config"],
  ["main", "doh-providers"],
  ["main", "hijack-blocklists"],
  ["main", "language-dictionaries"],
  ["main", "moz-essential-domain-fallbacks"],
  ["main", "newtab-wallpapers-v2"],
  ["main", "password-recipes"],
  ["main", "password-rules"],
  ["main", "remote-permissions"],
  ["main", "search-default-override-allowlist"],
  ["main", "search-telemetry-v2"],
  ["main", "sites-classification"],
  ["main", "top-sites"],
  ["main", "translations-models-v2"],
  ["main", "translations-wasm-v2"],
  ["main", "url-parser-default-unknown-schemes-interventions"],
  ["main", "urlbar-persisted-search-terms"],
  ["main", "websites-with-shared-credential-backends"],
]);

export const WildBuzzardSettingsPolicy = {
  requiredOfflineDumps: REQUIRED_OFFLINE_DUMPS,

  canSync() {
    return false;
  },

  canDownloadAttachments() {
    return false;
  },
};
