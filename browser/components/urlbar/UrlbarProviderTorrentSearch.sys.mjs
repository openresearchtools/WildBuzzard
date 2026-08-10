/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  UrlbarProvider,
  UrlbarUtils,
} from "moz-src:///browser/components/urlbar/UrlbarUtils.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  UrlbarResult: "chrome://browser/content/urlbar/UrlbarResult.mjs",
});

/** Provides the native torrent search mode result. */
export class UrlbarProviderTorrentSearch extends UrlbarProvider {
  get type() {
    return UrlbarUtils.PROVIDER_TYPE.HEURISTIC;
  }

  getPriority() {
    return 1;
  }

  async isActive(queryContext) {
    return (
      queryContext.searchMode?.source == UrlbarUtils.RESULT_SOURCE.TORRENT &&
      Boolean(queryContext.trimmedSearchString)
    );
  }

  startQuery(queryContext, addCallback) {
    const query = queryContext.trimmedSearchString;
    const url = `about:torrents?search=${encodeURIComponent(query)}`;
    addCallback(
      this,
      new lazy.UrlbarResult({
        type: UrlbarUtils.RESULT_TYPE.URL,
        source: UrlbarUtils.RESULT_SOURCE.TORRENT,
        heuristic: true,
        payload: {
          title: query,
          titleL10n: {
            id: "urlbar-result-action-search-torrents",
          },
          url,
          displayUrl: url,
          icon: "chrome://browser/skin/torrent.svg",
        },
      })
    );
  }
}
