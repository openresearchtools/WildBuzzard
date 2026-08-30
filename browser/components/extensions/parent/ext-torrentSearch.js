/* SPDX-License-Identifier: AGPL-3.0-or-later */

"use strict";

ChromeUtils.defineESModuleGetters(this, {
  isAuthorizedDiscoveryExtension:
    "resource:///modules/WildBuzzardDiscoveryBridge.sys.mjs",
  TorrentSearchBridge: "resource:///modules/WildBuzzardDiscoveryBridge.sys.mjs",
});

this.torrentSearch = class extends ExtensionAPI {
  onShutdown() {
    TorrentSearchBridge.shutdown(this.extension.id);
  }

  getAPI(context) {
    if (
      !isAuthorizedDiscoveryExtension(
        "torrent",
        context.extension,
        context.incognito
      )
    ) {
      return {};
    }
    const owner = context.extension.id;
    return {
      torrentSearch: {
        getStatus: () => TorrentSearchBridge.getStatus(owner),
        listSources: () => TorrentSearchBridge.listSources(owner),
        search: options => TorrentSearchBridge.search(options, owner),
        cancel: options => TorrentSearchBridge.cancel(options, owner),
        prepareImport: options =>
          TorrentSearchBridge.prepareImport(options, owner),
        discardPrepared: options =>
          TorrentSearchBridge.discardPrepared(options, owner),
        importPrepared: options =>
          TorrentSearchBridge.importPrepared(options, owner, {
            isHandlingUserInput:
              context.callContextData?.isHandlingUserInput === true,
            isPrivate: context.incognito,
            window: context.currentWindow,
          }),
      },
    };
  }
};
