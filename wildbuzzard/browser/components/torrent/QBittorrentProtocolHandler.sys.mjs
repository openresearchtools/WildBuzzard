/* SPDX-License-Identifier: AGPL-3.0-or-later */

const ACTOR_REQUEST_TOPIC = "wildbuzzard-qbittorrent-actor-request";

/** Loads qBittorrent WebUI resources through the private runtime. */
export class QBittorrentProtocolHandler {
  scheme = "moz-torrent";

  allowPort() {
    return false;
  }

  newChannel(uri, loadInfo) {
    const loadingPrincipal = loadInfo.loadingPrincipal;
    const triggeringPrincipal = loadInfo.triggeringPrincipal;
    const trusted = Boolean(
      loadingPrincipal?.isSystemPrincipal ||
      triggeringPrincipal?.isSystemPrincipal ||
      loadingPrincipal?.origin === "about:torrents" ||
      triggeringPrincipal?.origin === "about:torrents" ||
      loadingPrincipal?.origin === "https://torrent.wildbuzzard.invalid"
    );
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
    if (
      loadInfo.externalContentPolicyType ===
      Ci.nsIContentPolicy.TYPE_SUBDOCUMENT
    ) {
      const encodedTarget = encodeURIComponent(target);
      const source = `<!doctype html><meta charset="utf-8"><title>Add torrent</title><script>(async()=>{try{const request=async(request,...args)=>{const response=await parent.WildBuzzardTorrentRequest(request,...args);if(request.method==="POST"&&response.status>=200&&response.status<300){for(const delay of[0,250,1000,2500])parent.setTimeout(()=>parent.updateMainData?.(),delay)}return response};const response=await request({method:"GET",target:decodeURIComponent("${encodedTarget}"),headers:{Accept:"text/html"},body:new Uint8Array()});if(response.status<200||response.status>=300)throw new Error("qBittorrent WebUI failed ("+response.status+")");const html=new TextDecoder().decode(response.body);document.open();window.WildBuzzardTorrentRequest=request;document.write(html);document.close()}catch(error){console.error("Failed to initialize qBittorrent dialog",error);document.body.textContent="The torrent dialog could not be started."}})();</script>`;
      const stream = Cc["@mozilla.org/io/string-input-stream;1"].createInstance(
        Ci.nsIStringInputStream
      );
      stream.setUTF8Data(source);
      const subdocument = Cc["@mozilla.org/network/input-stream-channel;1"]
        .createInstance(Ci.nsIInputStreamChannel)
        .QueryInterface(Ci.nsIChannel);
      subdocument.loadInfo = loadInfo;
      subdocument.setURI(uri);
      subdocument.owner = loadingPrincipal || triggeringPrincipal;
      subdocument.contentStream = stream;
      subdocument.contentType = "text/html";
      return subdocument;
    }
    const inner = Cc["@mozilla.org/network/input-stream-channel;1"]
      .createInstance(Ci.nsIInputStreamChannel)
      .QueryInterface(Ci.nsIChannel);
    inner.loadInfo = loadInfo;
    inner.setURI(uri);
    inner.owner = loadingPrincipal || triggeringPrincipal;
    const channel = Services.io.newSuspendableChannelWrapper(inner);
    channel.suspend();
    Promise.resolve()
      .then(() => {
        let actor = null;
        const actorRequest = {
          actor: null,
          topBrowsingContextId: loadInfo.browsingContext?.top?.id,
        };
        Services.obs.notifyObservers(
          { wrappedJSObject: actorRequest },
          ACTOR_REQUEST_TOPIC
        );
        actor = actorRequest.actor;
        try {
          const node = loadInfo.loadingContext;
          const window =
            node?.documentGlobal ||
            node?.ownerGlobal ||
            node?.defaultView ||
            node?.ownerDocument?.documentGlobal;
          for (
            let current = window;
            current && !actor;
            current = current === current.parent ? null : current.parent
          ) {
            actor = current.windowGlobalChild?.getActor("QBittorrentWebUI");
          }
        } catch {}
        const contexts = [
          loadInfo.browsingContext,
          loadInfo.targetBrowsingContext,
          loadInfo.frameBrowsingContext,
        ];
        for (const context of actor ? [] : contexts) {
          try {
            for (let current = context; current; current = current.parent) {
              actor =
                current?.window?.windowGlobalChild?.getActor(
                  "QBittorrentWebUI"
                );
              if (actor) {
                break;
              }
            }
          } catch {}
          if (actor) {
            break;
          }
        }
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
