/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { QBittorrentWebBridge } from "resource:///modules/QBittorrentWebBridge.sys.mjs";

function byteStream(bytes) {
  const copy = new Uint8Array(bytes);
  const stream = Cc[
    "@mozilla.org/io/arraybuffer-input-stream;1"
  ].createInstance(Ci.nsIArrayBufferInputStream);
  stream.setData(copy.buffer, copy.byteOffset, copy.byteLength);
  return stream;
}

export class QBittorrentWebUIParent extends JSWindowActorParent {
  receiveMessage(message) {
    if (
      !this.manager.isInProcess &&
      this.manager.remoteType !== "privilegedabout"
    ) {
      return Promise.reject(new Error("Process type mismatch"));
    }
    if (message.name === "Request") {
      return QBittorrentWebBridge.request(message.data);
    }
    if (message.name === "GetInputStream") {
      return this.#getInputStream(message.data);
    }
    return null;
  }

  async #getInputStream(request) {
    try {
      const response = await QBittorrentWebBridge.request(request);
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
