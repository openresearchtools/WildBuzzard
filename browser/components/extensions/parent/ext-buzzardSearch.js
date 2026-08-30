/* SPDX-License-Identifier: AGPL-3.0-or-later */

"use strict";

ChromeUtils.defineESModuleGetters(this, {
  BuzzardSearchBridge: "resource:///modules/WildBuzzardDiscoveryBridge.sys.mjs",
  isAuthorizedDiscoveryExtension:
    "resource:///modules/WildBuzzardDiscoveryBridge.sys.mjs",
});

this.buzzardSearch = class extends ExtensionAPI {
  onShutdown() {
    BuzzardSearchBridge.shutdown(this.extension.id);
  }

  getAPI(context) {
    if (
      !isAuthorizedDiscoveryExtension(
        "web",
        context.extension,
        context.incognito
      )
    ) {
      return {};
    }
    const owner = context.extension.id;
    return {
      buzzardSearch: {
        getStatus: () => BuzzardSearchBridge.getStatus(owner),
        search: options => BuzzardSearchBridge.search(options, owner),
        cancel: operationId => BuzzardSearchBridge.cancel(operationId, owner),
      },
    };
  }
};
