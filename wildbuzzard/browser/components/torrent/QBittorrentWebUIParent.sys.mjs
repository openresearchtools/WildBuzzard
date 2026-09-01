/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { QBittorrentWebBridge } from "resource:///modules/QBittorrentWebBridge.sys.mjs";
import { isTorrentStaticResourceTarget } from "resource:///modules/TorrentDocumentPolicy.sys.mjs";
import {
  isPrivateTorrentLoad,
  isTorrentAddTarget,
  isTorrentWebUIPrincipal,
} from "resource:///modules/TorrentSecurityPolicy.sys.mjs";

const TORRENT_L10N = new Localization(
  ["browser/wildbuzzard/discovery.ftl"],
  true
);

function byteStream(bytes) {
  const copy = new Uint8Array(bytes);
  const stream = Cc[
    "@mozilla.org/io/arraybuffer-input-stream;1"
  ].createInstance(Ci.nsIArrayBufferInputStream);
  stream.setData(copy.buffer, copy.byteOffset, copy.byteLength);
  return stream;
}

/**
 *
 */
export class QBittorrentWebUIParent extends JSWindowActorParent {
  async receiveMessage(message) {
    if (isPrivateTorrentLoad(this.browsingContext)) {
      return Promise.reject(
        new Error("The torrent manager is unavailable in private browsing")
      );
    }
    if (this.manager.remoteType !== "privilegedabout") {
      return Promise.reject(new Error("Process type mismatch"));
    }
    if (!isTorrentWebUIPrincipal(this.manager.documentPrincipal)) {
      return Promise.reject(new Error("Principal mismatch"));
    }
    if (message.name === "Request") {
      const userActivation = Boolean(
        message.data.actorUserActivation === true &&
        message.data.actorBrowsingContextId === this.browsingContext.id &&
        message.data.actorTopBrowsingContextId ===
          this.browsingContext.top.id &&
        this.browsingContext.isActive &&
        this.browsingContext.top.isActive
      );
      if (isTorrentAddTarget(message.data.target)) {
        const chromeWindow =
          this.browsingContext.top.embedderElement?.ownerGlobal;
        if (
          !userActivation ||
          Services.focus.activeWindow !== chromeWindow ||
          !chromeWindow?.document.hasFocus() ||
          !this.#isActiveTorrentContext(chromeWindow)
        ) {
          throw new Error("Torrent addition requires user activation");
        }
        const [title, prompt] = await TORRENT_L10N.formatValues([
          { id: "wildbuzzard-torrent-webui-confirm-title" },
          { id: "wildbuzzard-torrent-webui-confirm-message" },
        ]);
        if (
          !this.#isActiveTorrentContext(chromeWindow) ||
          !Services.prompt.confirm(chromeWindow, title, prompt) ||
          !this.#isActiveTorrentContext(chromeWindow)
        ) {
          throw new Error("Torrent addition requires confirmation");
        }
      }
      return QBittorrentWebBridge.request(message.data, { userActivation });
    }
    if (message.name === "GetInputStream") {
      return this.#getInputStream(message.data);
    }
    return null;
  }

  #isActiveTorrentContext(chromeWindow) {
    return Boolean(
      chromeWindow &&
      Services.focus.activeWindow === chromeWindow &&
      chromeWindow.document.hasFocus() &&
      !isPrivateTorrentLoad(this.browsingContext) &&
      isTorrentWebUIPrincipal(this.manager.documentPrincipal) &&
      this.browsingContext.isActive &&
      this.browsingContext.top.isActive
    );
  }

  async #getInputStream(request) {
    try {
      if (!isTorrentStaticResourceTarget(request?.target)) {
        throw new Error("Unexpected torrent resource");
      }
      const response = await QBittorrentWebBridge.request({
        method: "GET",
        target: request.target,
        headers: { Accept: "*/*" },
        body: new Uint8Array(),
      });
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`qBittorrent resource failed (${response.status})`);
      }
      return {
        success: true,
        inputStream: byteStream(response.body),
        contentType:
          response.headers.find(([name]) => name === "content-type")?.[1] ||
          "application/octet-stream",
      };
    } catch (error) {
      console.error("Failed to load torrent manager resource", error);
      return { success: false, error: String(error) };
    }
  }
}
