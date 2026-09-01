/* SPDX-License-Identifier: AGPL-3.0-or-later */

import {
  createTorrentDocumentNonce,
  isPinnedTorrentSubdocumentTarget,
  isTorrentStaticResourceTarget,
  torrentPackagedScriptResource,
  torrentBootstrapDocument,
} from "resource:///modules/TorrentDocumentPolicy.sys.mjs";
import {
  isPrivateTorrentLoad,
  isTorrentWebUIPrincipal,
} from "resource:///modules/TorrentSecurityPolicy.sys.mjs";

const ACTOR_REQUEST_TOPIC = "wildbuzzard-qbittorrent-actor-request";
const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  NetUtil: "resource://gre/modules/NetUtil.sys.mjs",
});

/** Loads qBittorrent WebUI resources through the private runtime. */
export class QBittorrentProtocolHandler {
  scheme = "moz-torrent";

  allowPort() {
    return false;
  }

  newChannel(uri, loadInfo) {
    if (isPrivateTorrentLoad(loadInfo)) {
      throw Components.Exception(
        "moz-torrent is unavailable in private browsing",
        Cr.NS_ERROR_DOM_BAD_URI
      );
    }
    const loadingPrincipal = loadInfo.loadingPrincipal;
    const trusted = isTorrentWebUIPrincipal(loadingPrincipal);
    if (
      loadInfo.externalContentPolicyType ===
        Ci.nsIContentPolicy.TYPE_DOCUMENT ||
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
    const target = `${uri.filePath || "/"}${uri.query ? `?${uri.query}` : ""}`;
    const packagedScript = torrentPackagedScriptResource(target);
    if (packagedScript) {
      const stream = lazy.NetUtil.newChannel({
        uri: packagedScript,
        loadUsingSystemPrincipal: true,
      }).open();
      const script = Cc["@mozilla.org/network/input-stream-channel;1"]
        .createInstance(Ci.nsIInputStreamChannel)
        .QueryInterface(Ci.nsIChannel);
      script.loadInfo = loadInfo;
      script.setURI(uri);
      script.owner = loadingPrincipal;
      script.contentStream = stream;
      script.contentType = "text/javascript";
      script.contentCharset = "UTF-8";
      return script;
    }
    if (
      loadInfo.externalContentPolicyType ===
      Ci.nsIContentPolicy.TYPE_SUBDOCUMENT
    ) {
      if (!isPinnedTorrentSubdocumentTarget(target)) {
        throw Components.Exception(
          "Unexpected torrent subdocument",
          Cr.NS_ERROR_DOM_BAD_URI
        );
      }
      const nonce = createTorrentDocumentNonce();
      const source = torrentBootstrapDocument(
        nonce,
        "torrent-dialog-bootstrap.js",
        "Add torrent"
      );
      const stream = Cc["@mozilla.org/io/string-input-stream;1"].createInstance(
        Ci.nsIStringInputStream
      );
      stream.setUTF8Data(source);
      const subdocument = Cc["@mozilla.org/network/input-stream-channel;1"]
        .createInstance(Ci.nsIInputStreamChannel)
        .QueryInterface(Ci.nsIChannel);
      subdocument.loadInfo = loadInfo;
      subdocument.setURI(uri);
      subdocument.owner = loadingPrincipal;
      subdocument.contentStream = stream;
      subdocument.contentType = "text/html";
      subdocument.contentCharset = "UTF-8";
      return subdocument;
    }
    if (!isTorrentStaticResourceTarget(target)) {
      throw Components.Exception(
        "Unexpected torrent resource",
        Cr.NS_ERROR_DOM_BAD_URI
      );
    }
    const inner = Cc["@mozilla.org/network/input-stream-channel;1"]
      .createInstance(Ci.nsIInputStreamChannel)
      .QueryInterface(Ci.nsIChannel);
    inner.loadInfo = loadInfo;
    inner.setURI(uri);
    inner.owner = loadingPrincipal;
    const channel = Services.io.newSuspendableChannelWrapper(inner);
    channel.suspend();
    Promise.resolve()
      .then(() => {
        const actorRequest = {
          actor: null,
          browsingContextId: loadInfo.browsingContext?.id,
          topBrowsingContextId: loadInfo.browsingContext?.top?.id,
        };
        Services.obs.notifyObservers(
          { wrappedJSObject: actorRequest },
          ACTOR_REQUEST_TOPIC
        );
        const actor = actorRequest.actor;
        if (!actor) {
          throw new Error("The qBittorrent WebUI actor is unavailable");
        }
        return actor.getInputStream({
          method: "GET",
          target,
          headers: { Accept: "*/*" },
          body: new Uint8Array(),
        });
      })
      .then(result => {
        if (!result.success) {
          throw new Error(result.error || "qBittorrent resource failed");
        }
        inner.contentStream = result.inputStream;
        inner.contentType = result.contentType;
        try {
          channel.resume();
        } catch {}
      })
      .catch(error => {
        console.error("Failed to load torrent manager resource", error);
        inner.cancel(Cr.NS_ERROR_FAILURE);
        try {
          channel.resume();
        } catch {}
      });
    return channel;
  }

  QueryInterface = ChromeUtils.generateQI(["nsIProtocolHandler"]);
}
