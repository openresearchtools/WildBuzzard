/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { BrowserWindowTracker } from "resource:///modules/BrowserWindowTracker.sys.mjs";
import { TorrentManager } from "resource:///modules/TorrentManager.sys.mjs";

const CONTENT_TYPES = new Set([
  "application/x-bittorrent",
  "application/vnd.bittorrent",
]);

/** Routes BitTorrent metadata responses to the built-in client. */
export class TorrentContentHandler {
  classID = Components.ID("{a4241547-2440-441b-99a0-cd278ef88fdd}");
  QueryInterface = ChromeUtils.generateQI(["nsIContentHandler"]);

  handleContent(contentType, context, request) {
    if (
      !CONTENT_TYPES.has(contentType) ||
      !(request instanceof Ci.nsIChannel)
    ) {
      throw Components.Exception("", Cr.NS_ERROR_WONT_HANDLE_CONTENT);
    }
    const { loadInfo, URI } = request;
    const privateBrowsing = Boolean(
      loadInfo.originAttributes.privateBrowsingId
    );
    const originatingWindow =
      loadInfo.targetBrowsingContext?.top?.embedderElement?.ownerGlobal;
    const targetWindow = () =>
      originatingWindow && !originatingWindow.closed
        ? originatingWindow
        : BrowserWindowTracker.getTopWindow({ private: privateBrowsing });
    request.cancel(Cr.NS_BINDING_ABORTED);
    const window = targetWindow();
    if (!window) {
      throw Components.Exception("", Cr.NS_ERROR_NOT_AVAILABLE);
    }
    TorrentManager.createDraftFromURL(
      URI.spec,
      loadInfo.triggeringPrincipal,
      loadInfo.cookieJarSettings
    )
      .then(async draft => {
        const destination = targetWindow();
        if (destination) {
          try {
            destination.openTrustedLinkIn(
              `about:torrents#draft=${encodeURIComponent(draft.draftId)}`,
              "tab"
            );
          } catch (error) {
            await TorrentManager.cancelTorrentDraft(draft.draftId).catch(
              () => {}
            );
            throw error;
          }
        } else {
          await TorrentManager.cancelTorrentDraft(draft.draftId).catch(
            () => {}
          );
        }
      })
      .catch(() => {
        targetWindow()?.openTrustedLinkIn(
          "about:torrents#draft-error=1",
          "tab"
        );
      });
  }
}
