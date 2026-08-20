/* SPDX-License-Identifier: AGPL-3.0-or-later */

const ACTOR_REQUEST_TOPIC = "wildbuzzard-qbittorrent-actor-request";

/** Bridges qBittorrent WebUI requests to the parent process. */
export class QBittorrentWebUIChild extends JSWindowActorChild {
  actorCreated() {
    this.actorObserver = {
      observe: subject => {
        const request = subject.wrappedJSObject;
        if (
          !request.actor &&
          request.topBrowsingContextId === this.browsingContext.top.id
        ) {
          request.actor = this;
        }
      },
      QueryInterface: ChromeUtils.generateQI(["nsIObserver"]),
    };
    Services.obs.addObserver(this.actorObserver, ACTOR_REQUEST_TOPIC);
  }

  didDestroy() {
    if (this.actorObserver) {
      Services.obs.removeObserver(this.actorObserver, ACTOR_REQUEST_TOPIC);
      this.actorObserver = null;
    }
  }

  handleEvent(event) {
    if (event.type !== "WildBuzzardTorrentRequest") {
      return;
    }
    const { id, request } = event.detail;
    const data = {
      method: String(request.method),
      target: String(request.target),
      headers: Object.fromEntries(Object.entries(request.headers)),
      body: new Uint8Array(request.body),
    };
    this.request(data).then(
      response => this.respond(id, { response }),
      error => this.respond(id, { error: String(error) })
    );
  }

  respond(id, result) {
    const window = this.contentWindow;
    window.document.dispatchEvent(
      new window.CustomEvent("WildBuzzardTorrentResponse", {
        bubbles: true,
        detail: Cu.cloneInto({ id: String(id), ...result }, window),
      })
    );
  }

  request(request) {
    return this.sendQuery("Request", request);
  }

  getInputStream(request) {
    return this.sendQuery("GetInputStream", request);
  }
}
