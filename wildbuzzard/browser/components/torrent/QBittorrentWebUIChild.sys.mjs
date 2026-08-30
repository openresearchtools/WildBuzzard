/* SPDX-License-Identifier: AGPL-3.0-or-later */

import {
  isTorrentDocumentNonce,
  prepareTorrentHTML,
} from "resource:///modules/TorrentDocumentPolicy.sys.mjs";
import {
  isPrivateTorrentLoad,
  isTorrentAddTarget,
} from "resource:///modules/TorrentSecurityPolicy.sys.mjs";

const ACTOR_REQUEST_TOPIC = "wildbuzzard-qbittorrent-actor-request";
const ACTIVATION_TTL_MS = 10_000;
const CONTENT_BRIDGE_URL = "resource:///modules/torrent-content-bridge.js";
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_HEADERS = 64;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_PENDING_REQUESTS = 32;
const MAX_TARGET_LENGTH = 65_536;
const MAX_USER_ACTIVATIONS = 32;

/** Bridges qBittorrent WebUI requests to the parent process. */
export class QBittorrentWebUIChild extends JSWindowActorChild {
  #documentNonce = null;
  #pendingRequests = 0;
  #userActivations = new Map();

  actorCreated() {
    this.actorObserver = {
      observe: subject => {
        const request = subject.wrappedJSObject;
        if (
          !request.actor &&
          request.browsingContextId === this.browsingContext.id &&
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
    if (event.type === "WildBuzzardTorrentActivation") {
      this.#captureUserActivation(event.detail);
      return;
    }
    if (event.type !== "WildBuzzardTorrentRequest") {
      return;
    }
    let data;
    let id;
    try {
      ({ id, data } = this.#validatedRequest(event.detail));
      if (this.#pendingRequests >= MAX_PENDING_REQUESTS) {
        throw new Error("Too many pending torrent actor requests");
      }
    } catch (error) {
      this.respond(id ?? "", { error: String(error) });
      return;
    }
    this.#pendingRequests++;
    this.request(data)
      .then(response => this.#prepareResponse(data, response))
      .then(
        response => {
          this.#pendingRequests--;
          this.respond(id, { response });
        },
        error => {
          this.#pendingRequests--;
          this.respond(id, { error: String(error) });
        }
      );
  }

  #captureUserActivation(eventDetail) {
    if (!eventDetail || typeof eventDetail !== "object") {
      return;
    }
    const detail = Cu.waiveXrays(eventDetail);
    if (
      !detail ||
      detail.method !== "POST" ||
      typeof detail.target !== "string" ||
      detail.target.length > MAX_TARGET_LENGTH ||
      !isTorrentAddTarget(detail.target) ||
      isPrivateTorrentLoad(this.browsingContext) ||
      !this.browsingContext.isActive ||
      !this.browsingContext.top.isActive ||
      !this.document.hasFocus() ||
      !this.contentWindow.windowUtils.isHandlingUserInput
    ) {
      return;
    }
    const now = Date.now();
    for (const [token, entry] of this.#userActivations) {
      if (entry.expires <= now) {
        this.#userActivations.delete(token);
      }
    }
    if (this.#userActivations.size >= MAX_USER_ACTIVATIONS) {
      return;
    }
    const token = ChromeUtils.base64URLEncode(
      crypto.getRandomValues(new Uint8Array(24)),
      { pad: false }
    );
    this.#userActivations.set(token, {
      browsingContextId: this.browsingContext.id,
      expires: now + ACTIVATION_TTL_MS,
      method: detail.method,
      target: detail.target,
      topBrowsingContextId: this.browsingContext.top.id,
    });
    detail.token = token;
  }

  #takeUserActivation(token, method, target) {
    if (typeof token !== "string") {
      return false;
    }
    const entry = this.#userActivations.get(token);
    this.#userActivations.delete(token);
    return Boolean(
      entry &&
      entry.expires > Date.now() &&
      entry.method === method &&
      entry.target === target &&
      entry.browsingContextId === this.browsingContext.id &&
      entry.topBrowsingContextId === this.browsingContext.top.id
    );
  }

  #validatedRequest(detail) {
    if (!detail || typeof detail !== "object") {
      throw new TypeError("Invalid torrent actor request");
    }
    const id = String(detail.id ?? "");
    const request = detail.request;
    if (
      !/^\d{1,20}$/.test(id) ||
      !request ||
      typeof request !== "object" ||
      !["GET", "POST"].includes(request.method) ||
      typeof request.target !== "string" ||
      !request.target.startsWith("/") ||
      request.target.length > MAX_TARGET_LENGTH ||
      request.target.includes("#") ||
      request.target.includes("\\") ||
      /[^\x21-\x7e]/.test(request.target) ||
      !request.headers ||
      typeof request.headers !== "object" ||
      !ArrayBuffer.isView(request.body) ||
      Object.prototype.toString.call(request.body) !== "[object Uint8Array]" ||
      request.body.byteLength > MAX_BODY_BYTES
    ) {
      throw new TypeError("Invalid torrent actor request");
    }
    const headers = Object.entries(request.headers);
    let headerBytes = 0;
    if (headers.length > MAX_HEADERS) {
      throw new TypeError("Invalid torrent actor request headers");
    }
    for (const [name, value] of headers) {
      if (
        typeof value !== "string" ||
        name.length > 128 ||
        value.length > 8192
      ) {
        throw new TypeError("Invalid torrent actor request headers");
      }
      headerBytes += name.length + value.length;
    }
    if (headerBytes > MAX_HEADER_BYTES) {
      throw new TypeError("Invalid torrent actor request headers");
    }
    return {
      data: {
        actorBrowsingContextId: this.browsingContext.id,
        actorTopBrowsingContextId: this.browsingContext.top.id,
        actorUserActivation: this.#takeUserActivation(
          request.activationToken,
          request.method,
          request.target
        ),
        method: request.method,
        target: request.target,
        headers: Object.fromEntries(headers),
        body: new Uint8Array(request.body),
      },
      id,
    };
  }

  #nonce() {
    const scripts = Array.from(this.document.scripts).filter(
      script => script.src === CONTENT_BRIDGE_URL
    );
    if (
      scripts.length !== 1 ||
      !isTorrentDocumentNonce(scripts[0].nonce) ||
      (this.#documentNonce && this.#documentNonce !== scripts[0].nonce)
    ) {
      throw new Error("The torrent document nonce is unavailable");
    }
    this.#documentNonce = scripts[0].nonce;
    return this.#documentNonce;
  }

  #prepareResponse(request, response) {
    if (response.classification !== "torrent-html") {
      return response;
    }
    const contentTypes = response.headers.filter(
      ([name]) => name.toLowerCase() === "content-type"
    );
    const essence = contentTypes[0]?.[1].split(";", 1)[0].trim().toLowerCase();
    if (contentTypes.length !== 1 || essence !== "text/html") {
      throw new Error("The torrent HTML response is ambiguous");
    }
    const source = new TextDecoder("utf-8", { fatal: true }).decode(
      new Uint8Array(response.body)
    );
    return {
      ...response,
      body: new TextEncoder().encode(
        prepareTorrentHTML(source, request.target, this.#nonce())
      ),
      preparedDocument: true,
    };
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
