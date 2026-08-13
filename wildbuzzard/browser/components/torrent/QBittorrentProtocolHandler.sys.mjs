/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { QBittorrentWebBridge } from "resource:///modules/QBittorrentWebBridge.sys.mjs";

function byteStream(bytes) {
  const stream = Cc["@mozilla.org/io/arraybuffer-input-stream;1"].createInstance(
    Ci.nsIArrayBufferInputStream
  );
  stream.setData(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return stream;
}

export class QBittorrentProtocolHandler {
  scheme = "moz-torrent";

  allowPort() {
    return false;
  }

  newChannel(uri, loadInfo) {
    const loadingPrincipal = loadInfo.loadingPrincipal;
    const triggeringPrincipal = loadInfo.triggeringPrincipal;
    const trusted = Boolean(
      loadingPrincipal.isSystemPrincipal ||
        triggeringPrincipal?.isSystemPrincipal ||
        loadingPrincipal.URI?.spec === "about:torrents"
    );
    if (
      uri.host !== "local" ||
      uri.userPass ||
      uri.port !== -1 ||
      !trusted
    ) {
      throw Components.Exception(
        "moz-torrent is restricted to about:torrents",
        Cr.NS_ERROR_DOM_BAD_URI
      );
    }
    const inner = Cc["@mozilla.org/network/input-stream-channel;1"]
      .createInstance(Ci.nsIInputStreamChannel)
      .QueryInterface(Ci.nsIChannel);
    inner.loadInfo = loadInfo;
    inner.setURI(uri);
    inner.owner = Services.scriptSecurityManager.getSystemPrincipal();
    const channel = Services.io.newSuspendableChannelWrapper(inner);
    channel.suspend();
    QBittorrentWebBridge.request({
      method: "GET",
      target: `${uri.filePath || "/"}${uri.query ? `?${uri.query}` : ""}`,
      headers: { Accept: "*/*" },
      body: new Uint8Array(),
    })
      .then(response => {
        if (response.status < 200 || response.status >= 300) {
          throw new Error(`qBittorrent resource failed (${response.status})`);
        }
        inner.contentStream = byteStream(response.body);
        inner.contentType =
          response.headers.find(([name]) => name === "content-type")?.[1] ||
          "application/octet-stream";
        channel.resume();
      })
      .catch(error => {
        console.error("Failed to load torrent manager resource", error);
        inner.cancel(Cr.NS_ERROR_FAILURE);
        channel.resume();
      });
    return channel;
  }

  QueryInterface = ChromeUtils.generateQI(["nsIProtocolHandler"]);
}
