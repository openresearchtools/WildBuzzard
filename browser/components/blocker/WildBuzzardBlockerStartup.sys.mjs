/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  WildBuzzardBlockerExtensionDetector:
    "resource:///modules/WildBuzzardBlockerExtensionDetector.sys.mjs",
  WildBuzzardBlockerPanel:
    "resource:///modules/WildBuzzardBlockerPanel.sys.mjs",
  WildBuzzardBlockerService:
    "resource:///modules/WildBuzzardBlockerService.sys.mjs",
});

export const WildBuzzardBlockerStartup = {
  _initialized: false,

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;

    ChromeUtils.registerWindowActor("WildBuzzardBlocker", {
      parent: {
        esModuleURI: "resource:///modules/WildBuzzardBlockerParent.sys.mjs",
      },
      child: {
        esModuleURI: "resource:///modules/WildBuzzardBlockerChild.sys.mjs",
        events: {
          DOMWindowCreated: {},
          DOMDocElementInserted: {},
        },
      },
      allFrames: true,
      messageManagerGroups: ["browsers"],
      remoteTypes: ["web"],
    });

    ChromeUtils.registerWindowActor("WildBuzzardBlockedPage", {
      parent: {
        esModuleURI: "resource:///modules/WildBuzzardBlockedPageParent.sys.mjs",
      },
      child: {
        esModuleURI: "resource:///modules/WildBuzzardBlockedPageChild.sys.mjs",
        events: {
          click: {},
        },
      },
      matches: ["about:contentblocked?*"],
      allFrames: true,
    });

    lazy.WildBuzzardBlockerPanel.init();
    lazy.WildBuzzardBlockerExtensionDetector.init();
    lazy.WildBuzzardBlockerService.init().catch(error =>
      console.error("WildBuzzard blocker startup failed", error)
    );
  },
};
