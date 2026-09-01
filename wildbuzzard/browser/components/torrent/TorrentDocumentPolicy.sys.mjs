/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { TORRENT_DOCUMENT_SOURCES } from "resource:///modules/TorrentDocumentSources.sys.mjs";

const NONCE_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const PACKAGED_SCRIPT_ORIGIN = "moz-torrent://local/__wildbuzzard/";
const PACKAGED_SCRIPT_RESOURCES = new Map(
  [
    "torrent-bootstrap.js",
    "torrent-content-bridge.js",
    "torrent-dialog-bootstrap.js",
    "torrent-document-guard.js",
    "torrent-script-executor.js",
  ].map(name => [name, `resource:///modules/${name}`])
);
// qB dialogs require parent access; principal, actor, CSP, and bridge checks
// remain the authority boundary.
const FRAME_SANDBOX =
  "allow-downloads allow-forms allow-modals allow-same-origin allow-scripts";
// Pinned source and the English fallback are accepted. Other translated qB
// inline scripts fail closed instead of receiving nonce authority.
const DOCUMENT_POLICIES = new Map(
  Object.entries(TORRENT_DOCUMENT_SOURCES).map(([target, policy]) => [
    target,
    {
      external: new Set(policy.external),
      handlers: new Set(policy.handlers),
      inline: new Set(policy.inline),
    },
  ])
);
DOCUMENT_POLICIES.set("/", DOCUMENT_POLICIES.get("/index.html"));
// Root views share one CSP, so it carries the union. Markup is still validated
// against its exact target policy before any script or handler reaches the DOM.
const INLINE_SCRIPT_HASHES = [
  ...new Set(
    [...DOCUMENT_POLICIES.values()].flatMap(policy => [...policy.inline])
  ),
];
const EVENT_HANDLER_HASHES = [
  ...new Set(
    [...DOCUMENT_POLICIES.values()].flatMap(policy => [...policy.handlers])
  ),
];
const EXTERNAL_SCRIPT_SOURCES = [
  ...new Set(
    [...DOCUMENT_POLICIES.values()].flatMap(policy => [...policy.external])
  ),
];

function tagEnd(source, start) {
  let quote = "";
  for (let index = start; index < source.length; index++) {
    const character = source[index];
    if (quote) {
      if (character === quote) {
        quote = "";
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index + 1;
    }
  }
  throw new TypeError("Malformed torrent WebUI markup");
}

function withAttribute(tag, name, value) {
  const end = tag.endsWith("/>") ? tag.length - 2 : tag.length - 1;
  return `${tag.slice(0, end)} ${name}="${value}"${tag.slice(end)}`;
}

function withoutAttribute(tag, name) {
  return tag.replace(
    new RegExp(`\\s+${name}(?:\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+))?`, "gi"),
    ""
  );
}

function tagAttributes(tag) {
  const attributes = [];
  const pattern =
    /\s+([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of tag.matchAll(pattern)) {
    attributes.push({
      name: match[1].toLowerCase(),
      value: match[2] ?? match[3] ?? match[4] ?? "",
    });
  }
  return attributes;
}

function normalizedTargetPath(target) {
  let path = target.split(/[?#]/, 1)[0].replaceAll("\\", "/");
  for (let index = 0; index < 4; index++) {
    try {
      const decoded = decodeURIComponent(path);
      if (decoded === path) {
        break;
      }
      path = decoded;
    } catch {
      break;
    }
  }
  const segments = [];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

function sourceHash(source) {
  const bytes = new TextEncoder().encode(source);
  const hash = Cc["@mozilla.org/security/hash;1"].createInstance(
    Ci.nsICryptoHash
  );
  hash.init(hash.SHA256);
  hash.update(bytes, bytes.length);
  return hash.finish(true);
}

function canonicalInlineScript(source) {
  const cacheIDs = new Set();
  source = source.replaceAll("${CACHEID}", "0");
  source = source.replace(
    /\?v=([0-9a-z]{1,16})(?=[&"'`<])/g,
    (match, cacheID) => {
      cacheIDs.add(cacheID);
      return "?v=0";
    }
  );
  source = source.replace(
    /(\bv:\s*")([0-9a-z]{1,16})(")/g,
    (match, prefix, cacheID, suffix) => {
      cacheIDs.add(cacheID);
      return `${prefix}0${suffix}`;
    }
  );
  if (cacheIDs.size > 1) {
    throw new TypeError("Ambiguous torrent WebUI cache identifier");
  }
  return source;
}

function assertPinnedInlineScript(source, policy) {
  const canonical = canonicalInlineScript(source);
  if (!policy.inline.has(sourceHash(canonical))) {
    throw new TypeError(
      "Unexpected torrent WebUI inline script, build, or locale"
    );
  }
  return canonical;
}

function validateEventHandlers(tag, policy) {
  for (const { name, value } of tagAttributes(tag)) {
    if (name.startsWith("on") && !policy.handlers.has(sourceHash(value))) {
      throw new TypeError("Unexpected torrent WebUI event handler");
    }
  }
}

function validatedScriptSource(tag, policy) {
  const sources = tagAttributes(tag).filter(({ name }) => name === "src");
  if (sources.length !== 1) {
    throw new TypeError("Unexpected torrent WebUI script source");
  }
  const path = sources[0].value.split(/[?#]/, 1)[0];
  const canonical = path.startsWith("/") ? path : `/${path}`;
  if (
    !/^\/scripts\/[A-Za-z0-9_./-]+$/.test(canonical) ||
    canonical.includes("//") ||
    /\/(?:\.{1,2})(?:\/|$)/.test(canonical) ||
    !policy.external.has(canonical)
  ) {
    throw new TypeError("Unexpected torrent WebUI script source");
  }
}

function nonceScript(source, nonce) {
  return source.replace("{nonce}", nonce);
}

export function createTorrentDocumentNonce() {
  return ChromeUtils.base64URLEncode(
    crypto.getRandomValues(new Uint8Array(24)),
    { pad: false }
  );
}

export function isTorrentDocumentNonce(value) {
  return typeof value === "string" && NONCE_PATTERN.test(value);
}

export function torrentPackagedScriptURL(name) {
  if (!PACKAGED_SCRIPT_RESOURCES.has(name)) {
    throw new TypeError("Unexpected packaged torrent script");
  }
  return `${PACKAGED_SCRIPT_ORIGIN}${name}`;
}

export function torrentPackagedScriptResource(target) {
  if (typeof target !== "string" || !target.startsWith("/__wildbuzzard/")) {
    return null;
  }
  const name = target.slice("/__wildbuzzard/".length);
  return PACKAGED_SCRIPT_RESOURCES.get(name) || null;
}

export function torrentDocumentCSP(nonce) {
  if (!isTorrentDocumentNonce(nonce)) {
    throw new TypeError("Invalid torrent document nonce");
  }
  return [
    "default-src 'none'",
    "base-uri moz-torrent://local",
    "connect-src moz-torrent://local",
    "font-src moz-torrent://local",
    "form-action moz-torrent://local",
    "frame-src moz-torrent://local",
    "img-src data: moz-torrent://local",
    "manifest-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "script-src 'none'",
    `script-src-elem 'nonce-${nonce}' ${INLINE_SCRIPT_HASHES.map(hash => `'sha256-${hash}'`).join(" ")} ${[...PACKAGED_SCRIPT_RESOURCES.keys()].map(torrentPackagedScriptURL).join(" ")} ${EXTERNAL_SCRIPT_SOURCES.map(path => `moz-torrent://local${path}`).join(" ")}`,
    `script-src-attr 'unsafe-hashes' ${EVENT_HANDLER_HASHES.map(hash => `'sha256-${hash}'`).join(" ")}`,
    "style-src 'none'",
    `style-src-elem 'nonce-${nonce}' moz-torrent://local`,
    "style-src-attr 'unsafe-inline'",
    "worker-src 'none'",
  ].join("; ");
}

export function torrentBootstrapDocument(nonce, script, title) {
  if (!/^torrent-[a-z-]+\.js$/.test(script) || /[<>&"]/u.test(title)) {
    throw new TypeError("Invalid torrent bootstrap document");
  }
  const csp = torrentDocumentCSP(nonce);
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><title>${title}</title><script nonce="${nonce}" src="${torrentPackagedScriptURL("torrent-content-bridge.js")}"></script><script nonce="${nonce}" src="${torrentPackagedScriptURL(script)}"></script></head><body></body></html>`;
}

export function isFixedTorrentHTMLTarget(target) {
  return canonicalTorrentHTMLTarget(target) !== null;
}

function isFullTorrentDocumentTarget(target) {
  const canonical = canonicalTorrentHTMLTarget(target);
  return canonical !== null && !canonical.startsWith("/views/");
}

function canonicalTorrentHTMLTarget(target) {
  if (typeof target !== "string" || target.includes("#")) {
    return null;
  }
  const path = target.split("?", 1)[0];
  if (
    !path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("%") ||
    normalizedTargetPath(path) !== path ||
    !DOCUMENT_POLICIES.has(path)
  ) {
    return null;
  }
  return path;
}

export function isPinnedTorrentSubdocumentTarget(target) {
  const canonical = canonicalTorrentHTMLTarget(target);
  return (
    canonical !== null &&
    canonical !== "/" &&
    canonical !== "/index.html" &&
    !canonical.startsWith("/views/")
  );
}

export function isTorrentStaticResourceTarget(target) {
  if (typeof target !== "string" || target.includes("#")) {
    return false;
  }
  const path = target.split("?", 1)[0];
  return Boolean(
    path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("%") &&
    normalizedTargetPath(path) === path &&
    /^\/(?:css|images|scripts)\/[A-Za-z0-9_.@/-]+$/.test(path) &&
    !path.includes("//") &&
    !/(?:^|\/)\.{1,2}(?:\/|$)/.test(path)
  );
}

export function hardenTorrentMarkup(source, nonce, target) {
  const canonical = canonicalTorrentHTMLTarget(target);
  if (
    typeof source !== "string" ||
    !isTorrentDocumentNonce(nonce) ||
    canonical === null
  ) {
    throw new TypeError("Invalid torrent WebUI markup");
  }
  const policy = DOCUMENT_POLICIES.get(canonical);
  let output = "";
  let cursor = 0;
  const lower = source.toLowerCase();
  while (cursor < source.length) {
    const start = source.indexOf("<", cursor);
    if (start === -1) {
      output += source.slice(cursor);
      break;
    }
    output += source.slice(cursor, start);
    if (source.startsWith("<!--", start)) {
      const end = source.indexOf("-->", start + 4);
      if (end === -1) {
        throw new TypeError("Malformed torrent WebUI comment");
      }
      output += source.slice(start, end + 3);
      cursor = end + 3;
      continue;
    }
    const opening = /^<\s*([A-Za-z][A-Za-z0-9:-]*)\b/i.exec(
      source.slice(start)
    );
    if (!opening) {
      output += "<";
      cursor = start + 1;
      continue;
    }
    const end = tagEnd(source, start + opening[0].length);
    let tag = source.slice(start, end);
    validateEventHandlers(tag, policy);
    const match = /^(?:<\s*)(script|style|iframe)\b/i.exec(tag);
    if (!match) {
      output += tag;
      cursor = end;
      continue;
    }
    const name = match[1].toLowerCase();
    if (/\bnonce\s*=/i.test(tag)) {
      throw new TypeError("Unexpected torrent WebUI nonce");
    }
    if (name === "iframe") {
      const attributes = tagAttributes(tag);
      const sources = attributes.filter(
        ({ name: attributeName }) => attributeName === "src"
      );
      if (
        sources.length > 1 ||
        (sources.length === 1 && sources[0].value !== "about:blank") ||
        attributes.some(({ name: attributeName }) => attributeName === "srcdoc")
      ) {
        throw new TypeError("Unexpected torrent WebUI iframe source");
      }
      tag = withoutAttribute(tag, "src");
      tag = withAttribute(
        withoutAttribute(tag, "sandbox"),
        "sandbox",
        FRAME_SANDBOX
      );
      output += tag;
      cursor = end;
      continue;
    }
    const closeStart = lower.indexOf(`</${name}`, end);
    if (closeStart === -1) {
      throw new TypeError(`Unclosed torrent WebUI ${name}`);
    }
    const closeEnd = tagEnd(source, closeStart + name.length + 2);
    let content = source.slice(end, closeStart);
    if (name === "script") {
      if (/\bsrc\s*=/i.test(tag)) {
        validatedScriptSource(tag, policy);
      } else {
        content = assertPinnedInlineScript(content, policy);
      }
      output += tag;
    } else {
      output += withAttribute(tag, "nonce", nonce);
    }
    output += `${content}${source.slice(closeStart, closeEnd)}`;
    cursor = closeEnd;
  }
  return output;
}

export function prepareTorrentHTML(source, target, nonce) {
  const canonical = canonicalTorrentHTMLTarget(target);
  if (canonical === null) {
    throw new TypeError("Unexpected torrent WebUI HTML target");
  }
  const fullDocument = isFullTorrentDocumentTarget(canonical);
  let transformed = hardenTorrentMarkup(source, nonce, canonical);
  if (!fullDocument) {
    return transformed;
  }
  if (/http-equiv\s*=\s*["']Content-Security-Policy["']/i.test(transformed)) {
    throw new TypeError("Unexpected torrent WebUI content security policy");
  }
  const head = /<head(?:\s[^>]*)?>/i.exec(transformed);
  if (!head) {
    throw new TypeError("Torrent WebUI document has no head");
  }
  const prefix = transformed
    .slice(0, head.index)
    .replaceAll(/<!--[\s\S]*?-->/g, "");
  if (!/^\s*<!doctype html>\s*<html(?:\s[^>]*)?>\s*$/i.test(prefix)) {
    throw new TypeError("Torrent WebUI document has an unsafe prefix");
  }
  const injectionPoint = head.index + head[0].length;
  const infrastructure = [
    `<meta http-equiv="Content-Security-Policy" content="${torrentDocumentCSP(nonce)}">`,
    '<meta name="referrer" content="no-referrer">',
    '<base href="moz-torrent://local/">',
    nonceScript(
      `<script nonce="{nonce}" src="${torrentPackagedScriptURL("torrent-document-guard.js")}"></script>`,
      nonce
    ),
    nonceScript(
      `<script nonce="{nonce}" src="${torrentPackagedScriptURL("torrent-content-bridge.js")}"></script>`,
      nonce
    ),
    DOCUMENT_POLICIES.get(canonical).external.has(
      "/scripts/wildbuzzard-bridge.js"
    )
      ? ""
      : '<script src="/scripts/wildbuzzard-bridge.js"></script>',
  ].join("");
  transformed = `${transformed.slice(0, injectionPoint)}${infrastructure}${transformed.slice(injectionPoint)}`;
  const core =
    /<script\b(?=[^>]*\bsrc\s*=\s*["'][^"']*MooTools-Core-1\.6\.0-compat-compressed\.js[^"']*["'])[^>]*>\s*<\/script\s*>/i.exec(
      transformed
    );
  if (core) {
    const end = core.index + core[0].length;
    transformed = `${transformed.slice(0, end)}${nonceScript(
      `<script defer nonce="{nonce}" src="${torrentPackagedScriptURL("torrent-script-executor.js")}"></script>`,
      nonce
    )}${transformed.slice(end)}`;
  }
  return transformed;
}

export const TorrentDocumentPolicyTestUtils = {
  eventHandlerHashes: EVENT_HANDLER_HASHES,
  externalScriptSources: EXTERNAL_SCRIPT_SOURCES,
  frameSandbox: FRAME_SANDBOX,
  inlineScriptHashes: INLINE_SCRIPT_HASHES,
  targets: [...DOCUMENT_POLICIES.keys()],
};
