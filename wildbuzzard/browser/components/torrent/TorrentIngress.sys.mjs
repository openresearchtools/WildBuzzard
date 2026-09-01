/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { NetUtil } from "resource://gre/modules/NetUtil.sys.mjs";
import { TorrentManager as DefaultTorrentManager } from "resource:///modules/TorrentManager.sys.mjs";
import {
  hasExplicitTorrentNavigation,
  isPrivateTorrentLoad,
  isValidBTIHMagnet,
} from "resource:///modules/TorrentSecurityPolicy.sys.mjs";

const CONTENT_TYPES = new Set([
  "application/x-bittorrent",
  "application/vnd.bittorrent",
]);
const MAX_TORRENT_SIZE = 12 * 1024 * 1024;
const TORRENT_L10N = new Localization(
  ["browser/wildbuzzard/discovery.ftl"],
  true
);
const pendingSources = new Set();

let manager = DefaultTorrentManager;
let confirmPrompt = (context, title, message) =>
  Services.prompt.confirmBC(
    context.browsingContext,
    Services.prompt.MODAL_TYPE_TAB,
    title,
    message
  );
let openManager = window => {
  const tab = window.gBrowser.addTab("about:torrents", {
    skipAnimation: true,
    inBackground: false,
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  });
  window.gBrowser.selectedTab = tab;
};
let fetchBytes = fetchTorrentBytes;

function cleanText(value, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }
  const cleaned = Array.from(
    value
      .normalize("NFC")
      .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
      .trim()
  )
    .slice(0, 256)
    .join("");
  return cleaned || fallback;
}

function activeContext(loadInfo) {
  try {
    if (
      !hasExplicitTorrentNavigation(loadInfo) ||
      isPrivateTorrentLoad(loadInfo)
    ) {
      return null;
    }
    const browsingContext =
      loadInfo.targetBrowsingContext || loadInfo.browsingContext;
    if (
      !browsingContext ||
      browsingContext !== browsingContext.top ||
      isPrivateTorrentLoad(browsingContext)
    ) {
      return null;
    }
    const browser = browsingContext?.embedderElement;
    const window = browser?.documentGlobal;
    if (
      !window ||
      window.closed ||
      window.gBrowser?.selectedBrowser !== browser ||
      !browsingContext.isActive
    ) {
      return null;
    }
    return { browser, browsingContext, window };
  } catch {
    return null;
  }
}

function contextRemainsActive(context) {
  try {
    return Boolean(
      context?.window &&
      !context.window.closed &&
      context.browser?.documentGlobal === context.window &&
      context.browsingContext?.isActive &&
      context.browsingContext.top === context.browsingContext &&
      context.window.gBrowser?.selectedBrowser === context.browser
    );
  } catch {
    return false;
  }
}

function sourceName(uri) {
  if (uri.schemeIs("file")) {
    return "Local file";
  }
  try {
    return cleanText(uri.prePath, "Torrent link");
  } catch {
    return "Torrent link";
  }
}

function torrentName(uri) {
  try {
    const filename = uri.QueryInterface(Ci.nsIURL).fileName;
    return cleanText(decodeURIComponent(filename), "Torrent metadata");
  } catch {
    return "Torrent metadata";
  }
}

export function magnetDisplayName(spec) {
  if (!isValidBTIHMagnet(spec)) {
    throw new TypeError("Invalid magnet link");
  }
  try {
    const url = new URL(spec);
    return cleanText(url.searchParams.get("dn"), "Magnet link");
  } catch {
    throw new TypeError("Invalid magnet link");
  }
}

async function confirmImport(context, { kind, name, source, size }) {
  const [title, message] = await TORRENT_L10N.formatValues([
    { id: "wildbuzzard-torrent-extension-confirm-title" },
    {
      id: "wildbuzzard-torrent-extension-confirm-message",
      args: {
        kind,
        name: `\u2068${cleanText(name, "Torrent")}\u2069`,
        size: size === null ? "unknown" : String(size),
        source: `\u2068${cleanText(source, "Torrent link")}\u2069`,
      },
    },
  ]);
  return Boolean(
    contextRemainsActive(context) &&
    confirmPrompt(context, title, message) &&
    contextRemainsActive(context)
  );
}

function mergeChunks(chunks, length) {
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function fetchTorrentBytes(uri, sourceContext) {
  if (!["http", "https", "file"].some(scheme => uri.schemeIs(scheme))) {
    return Promise.reject(new TypeError("Unsupported torrent source"));
  }
  const loadingPrincipal =
    sourceContext?.loadingPrincipal || sourceContext?.triggeringPrincipal;
  if (!loadingPrincipal) {
    return Promise.reject(new TypeError("Torrent source principal is missing"));
  }
  const channel = NetUtil.newChannel({
    uri,
    contentPolicyType: Ci.nsIContentPolicy.TYPE_SAVEAS_DOWNLOAD,
    loadingPrincipal,
    triggeringPrincipal: sourceContext.triggeringPrincipal || loadingPrincipal,
    securityFlags: Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_INHERITS_SEC_CONTEXT,
  });
  if (sourceContext.cookieJarSettings) {
    channel.loadInfo.cookieJarSettings = sourceContext.cookieJarSettings;
  }
  if (channel instanceof Ci.nsIHttpChannel && sourceContext.referrerInfo) {
    channel.referrerInfo = sourceContext.referrerInfo;
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    let failure = null;
    const stream = Cc["@mozilla.org/binaryinputstream;1"].createInstance(
      Ci.nsIBinaryInputStream
    );
    const listener = {
      QueryInterface: ChromeUtils.generateQI([
        "nsIRequestObserver",
        "nsIStreamListener",
      ]),
      onStartRequest(request) {
        const responseChannel = request.QueryInterface(Ci.nsIChannel);
        const type = responseChannel.contentType;
        if (
          !CONTENT_TYPES.has(type) ||
          responseChannel.contentLength > MAX_TORRENT_SIZE
        ) {
          failure = new TypeError("Invalid torrent metadata response");
          request.cancel(Cr.NS_ERROR_FILE_TOO_BIG);
        }
      },
      onDataAvailable(request, inputStream, _offset, count) {
        if (failure) {
          return;
        }
        if (length + count > MAX_TORRENT_SIZE) {
          failure = new TypeError("Torrent metadata is too large");
          request.cancel(Cr.NS_ERROR_FILE_TOO_BIG);
          return;
        }
        stream.setInputStream(inputStream);
        const chunk = Uint8Array.from(stream.readByteArray(count));
        chunks.push(chunk);
        length += chunk.length;
      },
      onStopRequest(request, status) {
        if (
          failure ||
          !Components.isSuccessCode(status) ||
          (request instanceof Ci.nsIHttpChannel && !request.requestSucceeded) ||
          !length
        ) {
          reject(failure || new Error("Torrent metadata download failed"));
          return;
        }
        resolve(mergeChunks(chunks, length));
      },
    };
    channel.asyncOpen(listener);
  });
}

async function addMagnet(spec, loadInfo) {
  const context = activeContext(loadInfo);
  if (!context) {
    throw new Error("Magnet links require an active user gesture");
  }
  const key = `${context.browsingContext.id}:${spec}`;
  if (pendingSources.has(key)) {
    return false;
  }
  pendingSources.add(key);
  try {
    const accepted = await confirmImport(context, {
      kind: "magnet",
      name: magnetDisplayName(spec),
      size: null,
      source: "Magnet link",
    });
    if (!accepted) {
      return false;
    }
    await manager.initialize();
    if (!contextRemainsActive(context)) {
      throw new Error("The originating tab is no longer active");
    }
    await manager.addMagnet(spec);
    openManager(context.window);
    return true;
  } finally {
    pendingSources.delete(key);
  }
}

async function addTorrentURL(uri, loadInfo, sourceContext) {
  const context = activeContext(loadInfo);
  if (!context) {
    throw new Error("Torrent links require an active user gesture");
  }
  const key = `${context.browsingContext.id}:${uri.spec}`;
  if (pendingSources.has(key)) {
    return false;
  }
  pendingSources.add(key);
  try {
    const accepted = await confirmImport(context, {
      kind: "torrent",
      name: torrentName(uri),
      size: null,
      source: sourceName(uri),
    });
    if (!accepted) {
      return false;
    }
    const bytes = await fetchBytes(uri, sourceContext);
    if (!contextRemainsActive(context)) {
      throw new Error("The originating tab is no longer active");
    }
    await manager.initialize();
    if (!contextRemainsActive(context)) {
      throw new Error("The originating tab is no longer active");
    }
    await manager.addTorrentBytes(bytes);
    openManager(context.window);
    return true;
  } finally {
    pendingSources.delete(key);
  }
}

export const TorrentIngress = Object.freeze({ addMagnet, addTorrentURL });

export const TorrentIngressTestUtils = Object.freeze({
  configure({ manager: testManager, confirm, fetch: testFetch, open } = {}) {
    manager = testManager || DefaultTorrentManager;
    confirmPrompt =
      confirm ||
      ((context, title, message) =>
        Services.prompt.confirmBC(
          context.browsingContext,
          Services.prompt.MODAL_TYPE_TAB,
          title,
          message
        ));
    fetchBytes = testFetch || fetchTorrentBytes;
    openManager =
      open ||
      (window => {
        const tab = window.gBrowser.addTab("about:torrents", {
          skipAnimation: true,
          inBackground: false,
          triggeringPrincipal:
            Services.scriptSecurityManager.getSystemPrincipal(),
        });
        window.gBrowser.selectedTab = tab;
      });
  },
  reset() {
    this.configure();
    pendingSources.clear();
  },
  pendingCount() {
    return pendingSources.size;
  },
});
