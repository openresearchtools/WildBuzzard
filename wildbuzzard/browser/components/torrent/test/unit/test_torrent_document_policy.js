/* SPDX-License-Identifier: AGPL-3.0-or-later */

const {
  TorrentDocumentPolicyTestUtils,
  hardenTorrentMarkup,
  isPinnedTorrentSubdocumentTarget,
  isTorrentStaticResourceTarget,
  prepareTorrentHTML,
  torrentBootstrapDocument,
  torrentDocumentCSP,
} = ChromeUtils.importESModule(
  "resource:///modules/TorrentDocumentPolicy.sys.mjs"
);

const NONCE = "A".repeat(32);

add_task(function test_script_policy_uses_nonces_and_handler_hashes() {
  const csp = torrentDocumentCSP(NONCE);
  Assert.ok(csp.includes(`script-src-elem 'nonce-${NONCE}'`));
  Assert.ok(csp.includes("script-src-attr 'unsafe-hashes'"));
  Assert.ok(!csp.includes("script-src-elem 'unsafe-inline'"));
  Assert.ok(!csp.includes("blob:"));
  Assert.ok(!csp.includes("http:"));
  Assert.ok(!csp.includes("https:"));
  Assert.ok(!csp.includes("frame-src about:"));
  Assert.equal(TorrentDocumentPolicyTestUtils.eventHandlerHashes.length, 58);
  Assert.equal(TorrentDocumentPolicyTestUtils.externalScriptSources.length, 25);
  Assert.equal(TorrentDocumentPolicyTestUtils.inlineScriptHashes.length, 66);
  Assert.equal(TorrentDocumentPolicyTestUtils.targets.length, 47);
});

add_task(function test_bootstrap_contains_only_packaged_external_scripts() {
  const source = torrentBootstrapDocument(
    NONCE,
    "torrent-bootstrap.js",
    "Torrents"
  );
  Assert.equal((source.match(/<script\b/g) || []).length, 2);
  Assert.equal((source.match(/<script[^>]+\bsrc=/g) || []).length, 2);
  Assert.ok(!source.includes("<script>("));
});

add_task(function test_only_pinned_dialogs_are_subdocuments() {
  Assert.ok(isPinnedTorrentSubdocumentTarget("/addtorrent.html?hash=abc"));
  Assert.ok(!isPinnedTorrentSubdocumentTarget("/"));
  Assert.ok(!isPinnedTorrentSubdocumentTarget("/index.html"));
  Assert.ok(!isPinnedTorrentSubdocumentTarget("/views/transferlist.html"));
  Assert.ok(!isPinnedTorrentSubdocumentTarget("/api/v2/torrents/info"));
  Assert.ok(!isPinnedTorrentSubdocumentTarget("/attacker.html"));
});

add_task(function test_protocol_resources_are_static_qbittorrent_assets() {
  for (const target of [
    "/scripts/client.js?v=0",
    "/css/style.css",
    "/images/qbittorrent.svg",
  ]) {
    Assert.ok(isTorrentStaticResourceTarget(target), target);
  }
  for (const target of [
    "/api/v2/torrents/add",
    "/views/transferlist.html",
    "/addtorrent.html",
    "/scripts/../api/v2/torrents/add",
    "/scripts/%2e%2e/api/v2/torrents/add",
    "\\scripts\\client.js",
  ]) {
    Assert.ok(!isTorrentStaticResourceTarget(target), target);
  }
});

add_task(function test_markup_hardening_is_context_aware() {
  const source = `<!doctype html><script src="scripts/addtorrent.js"></script><style>body { color: black; }</style><iframe src="about:blank"></iframe><iframe sandbox="allow-scripts allow-same-origin allow-top-navigation"></iframe>`;
  const hardened = hardenTorrentMarkup(source, NONCE, "/addtorrent.html");
  Assert.ok(hardened.includes('<script src="scripts/addtorrent.js">'));
  Assert.ok(hardened.includes(`<style nonce="${NONCE}">`));
  Assert.ok(!hardened.includes('src="about:blank"'));
  Assert.equal(
    (
      hardened.match(
        new RegExp(
          `sandbox="${TorrentDocumentPolicyTestUtils.frameSandbox}"`,
          "g"
        )
      ) || []
    ).length,
    2
  );
  Assert.ok(!hardened.includes('sandbox="allow-same-origin"'));
  Assert.ok(!hardened.includes("allow-top-navigation"));
  Assert.throws(
    () =>
      hardenTorrentMarkup(
        '<iframe src="moz-torrent://local/addtorrent.html"></iframe>',
        NONCE,
        "/addpeers.html"
      ),
    /iframe source/
  );
  Assert.throws(
    () =>
      hardenTorrentMarkup(
        '<iframe srcdoc="<script>window.injected = true;</script>"></iframe>',
        NONCE,
        "/addpeers.html"
      ),
    /iframe source/
  );
});

add_task(function test_unknown_or_localized_inline_scripts_fail_closed() {
  Assert.throws(
    () =>
      hardenTorrentMarkup(
        "<script>window.injected = true;</script>",
        NONCE,
        "/addtorrent.html"
      ),
    /inline script, build, or locale/
  );
});

add_task(function test_active_markup_cannot_precede_the_document_policy() {
  Assert.throws(
    () =>
      prepareTorrentHTML(
        '<!doctype html><script src="scripts/addtorrent.js"></script><html><head></head></html>',
        "/addtorrent.html",
        NONCE
      ),
    /unsafe prefix/
  );
});

add_task(function test_scripts_and_handlers_are_bound_to_their_target() {
  const handler =
    '<button onclick="parent.qBittorrent.Client.closeFrameWindow(window);"></button>';
  Assert.equal(hardenTorrentMarkup(handler, NONCE, "/addpeers.html"), handler);
  Assert.throws(
    () => hardenTorrentMarkup(handler, NONCE, "/addtrackers.html"),
    /event handler/
  );

  const script = '<script src="scripts/addtorrent.js"></script>';
  Assert.equal(hardenTorrentMarkup(script, NONCE, "/addtorrent.html"), script);
  Assert.throws(
    () => hardenTorrentMarkup(script, NONCE, "/addpeers.html"),
    /script source/
  );
});
