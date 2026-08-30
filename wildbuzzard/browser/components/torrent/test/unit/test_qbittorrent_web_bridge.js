/* SPDX-License-Identifier: AGPL-3.0-or-later */

const {
  isEmbeddedSearchTarget,
  isFixedTorrentHTMLTarget,
  isUnconfirmedMetadataTarget,
  QBittorrentWebBridge,
} = ChromeUtils.importESModule(
  "resource:///modules/QBittorrentWebBridge.sys.mjs"
);
const { prepareTorrentHTML } = ChromeUtils.importESModule(
  "resource:///modules/TorrentDocumentPolicy.sys.mjs"
);
const { QBittorrentRuntime } = ChromeUtils.importESModule(
  "resource:///modules/QBittorrentRuntime.sys.mjs"
);

const originalRequest = QBittorrentRuntime.request;
const DOCUMENT_NONCE = "B".repeat(32);

add_setup(function setup() {
  registerCleanupFunction(() => {
    QBittorrentRuntime.request = originalRequest;
  });
});

add_task(function test_embedded_search_routes_are_blocked() {
  for (const target of [
    "/api/v2/search",
    "/api/v2/search/start",
    "/API/V2/SEARCH/plugins?enabled=true",
    "/api/v2/%73earch/results",
    "/api/v2/%2573earch/results",
    "\\api\\v2\\search\\start",
  ]) {
    Assert.ok(isEmbeddedSearchTarget(target), target);
  }
});

add_task(function test_torrent_routes_remain_available() {
  for (const target of [
    "/api/v2/torrents/add",
    "/api/v2/torrents/info?filter=all",
    "/api/v2/transfer/info",
    "/api/v2/searchable",
    "/",
  ]) {
    Assert.ok(!isEmbeddedSearchTarget(target), target);
  }
});

add_task(function test_unconfirmed_metadata_routes_are_blocked() {
  for (const target of [
    "/api/v2/torrents/fetchMetadata",
    "/API/V2/TORRENTS/FETCHMETADATA?source=magnet%3A",
    "/api/v2/torrents/%66etchMetadata",
    "/api/v2/torrents/%2566etchMetadata",
    "/api/v2/torrents/%252566etchMetadata",
    "/api/v2/torrents/ignored/../fetchMetadata",
    "/api/v2/torrents/ignored/%2e%2e/fetchMetadata",
    "//api//v2//torrents//fetchMetadata",
    "\\api\\v2\\torrents\\fetchMetadata",
  ]) {
    Assert.ok(isUnconfirmedMetadataTarget(target), target);
  }
});

add_task(function test_confirmed_torrent_routes_remain_available() {
  for (const target of [
    "/api/v2/torrents/add",
    "/api/v2/torrents/parseMetadata",
    "/api/v2/torrents/saveMetadata",
    "/api/v2/torrents/fetchMetadataExtra",
  ]) {
    Assert.ok(!isUnconfirmedMetadataTarget(target), target);
  }
});

add_task(function test_only_fixed_local_html_targets_are_hardened() {
  for (const target of [
    "/",
    "/index.html?locale=en",
    "/addtorrent.html?source=magnet%3A",
    "/views/preferences.html",
  ]) {
    Assert.ok(isFixedTorrentHTMLTarget(target), target);
  }
  for (const target of [
    "/api/v2/torrents/info",
    "/provider/result.html/extra",
    "/views/nested/result.html",
    "/views/search.html",
    "/attacker.html",
    "/views/%74ransferlist.html",
    "/index.php",
  ]) {
    Assert.ok(!isFixedTorrentHTMLTarget(target), target);
  }
});

add_task(function test_full_documents_receive_restrictive_policy() {
  const source = `<!doctype html><html><head><script src="scripts/lib/MooTools-Core-1.6.0-compat-compressed.js"></script></head><body><iframe></iframe></body></html>`;
  const transformed = prepareTorrentHTML(
    source,
    "/addtorrent.html",
    DOCUMENT_NONCE
  );
  Assert.ok(transformed.includes("Content-Security-Policy"));
  Assert.ok(transformed.includes(`script nonce="${DOCUMENT_NONCE}"`));
  Assert.ok(transformed.includes("torrent-document-guard.js"));
  Assert.ok(transformed.includes("torrent-content-bridge.js"));
  Assert.ok(transformed.includes("torrent-script-executor.js"));
  Assert.ok(transformed.includes("wildbuzzard-bridge.js"));
  Assert.ok(transformed.includes('sandbox="allow-downloads'));
  Assert.ok(!transformed.includes("script-src-elem 'unsafe-inline'"));
  Assert.ok(!transformed.includes("blob:"));
});

add_task(function test_view_fragments_are_nonced_without_document_injection() {
  const source = `<style>.view { display: block; }</style><div class="view"></div>`;
  const transformed = prepareTorrentHTML(
    source,
    "/views/transferlist.html",
    DOCUMENT_NONCE
  );
  Assert.ok(transformed.includes(`<style nonce="${DOCUMENT_NONCE}">`));
  Assert.ok(!transformed.includes("Content-Security-Policy"));
  Assert.ok(!transformed.includes("wildbuzzard-bridge.js"));
});

add_task(function test_unpinned_qbittorrent_scripts_fail_closed() {
  Assert.throws(
    () =>
      prepareTorrentHTML(
        "<html><head><script>window.injected = true;</script></head></html>",
        "/addtorrent.html",
        DOCUMENT_NONCE
      ),
    /inline script, build, or locale/
  );
});

add_task(async function test_html_classification_is_case_insensitive() {
  QBittorrentRuntime.request = async () => ({
    body: new TextEncoder().encode("<html><head></head></html>"),
    headers: new Map([["content-type", ["Text/HTML; charset=UTF-8"]]]),
    status: 200,
  });
  const response = await QBittorrentWebBridge.request({
    method: "GET",
    target: "/addtorrent.html",
    headers: { Accept: "text/html" },
    body: new Uint8Array(),
  });
  Assert.equal(response.classification, "torrent-html");
});

add_task(async function test_duplicate_html_content_types_fail_closed() {
  QBittorrentRuntime.request = async () => ({
    body: new TextEncoder().encode("<html><head></head></html>"),
    headers: new Map([["content-type", ["text/html", "text/plain"]]]),
    status: 200,
  });
  await Assert.rejects(
    QBittorrentWebBridge.request({
      method: "GET",
      target: "/addtorrent.html",
      headers: { Accept: "text/html" },
      body: new Uint8Array(),
    }),
    /Ambiguous torrent WebUI content type/
  );
});

add_task(function test_provider_html_is_never_nonced() {
  Assert.throws(
    () =>
      prepareTorrentHTML(
        "<html><script>window.provider = true;</script></html>",
        "/api/v2/provider/result.html",
        DOCUMENT_NONCE
      ),
    /Unexpected torrent WebUI HTML target/
  );
});

add_task(async function test_metadata_prefetch_never_reaches_qbittorrent() {
  let called = false;
  QBittorrentRuntime.request = async () => {
    called = true;
    throw new Error("Unexpected native request");
  };
  const response = await QBittorrentWebBridge.request({
    method: "POST",
    target: "/api/v2/torrents/fetchMetadata",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new TextEncoder().encode("source=magnet%3A%3Fxt%3Durn%3Abtih%3A1"),
  });
  Assert.equal(response.status, 403);
  Assert.ok(!called, "The native qBittorrent runtime was not contacted");
});

add_task(async function test_torrent_add_requires_internal_activation() {
  let called = false;
  QBittorrentRuntime.request = async () => {
    called = true;
    return {
      body: new Uint8Array(),
      headers: new Map([["content-type", ["text/plain"]]]),
      status: 200,
    };
  };
  const request = {
    method: "POST",
    target: "/api/v2/torrents/add",
    headers: { "Content-Type": "multipart/form-data; boundary=test" },
    body: new Uint8Array(),
  };
  await Assert.rejects(
    QBittorrentWebBridge.request(request),
    /Invalid torrent WebUI request/
  );
  Assert.ok(!called, "An unconfirmed add did not reach qBittorrent");

  const response = await QBittorrentWebBridge.request(request, {
    userActivation: true,
  });
  Assert.equal(response.status, 200);
  Assert.ok(called, "The actor-confirmed request reached qBittorrent");
});

add_task(async function test_torrent_add_aliases_fail_closed() {
  let called = false;
  QBittorrentRuntime.request = async () => {
    called = true;
    throw new Error("Unexpected native request");
  };
  for (const target of [
    "/api/v2/torrents/add?source=dialog",
    "/api/v2/torrents/add/",
    "/API/v2/torrents/add",
    "/api/v2/torrents/%61dd",
    "/api/v2/torrents/add%3fsource=dialog",
    "/api/v2/torrents/ignored%5c..%5cadd",
    "\\api\\v2\\torrents\\add",
  ]) {
    await Assert.rejects(
      QBittorrentWebBridge.request(
        {
          method: "POST",
          target,
          headers: {},
          body: new Uint8Array(),
        },
        { userActivation: true }
      ),
      /Invalid torrent WebUI request/,
      target
    );
  }
  Assert.ok(!called, "No add alias reached qBittorrent");
});
