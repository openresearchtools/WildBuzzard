/* SPDX-License-Identifier: AGPL-3.0-or-later */

const { AboutTorrents } = ChromeUtils.importESModule(
  "resource:///modules/AboutTorrents.sys.mjs"
);
const { QBittorrentProtocolHandler } = ChromeUtils.importESModule(
  "resource:///modules/QBittorrentProtocolHandler.sys.mjs"
);
const {
  hasExplicitTorrentNavigation,
  isPrivateTorrentLoad,
  isTorrentAddTarget,
  isValidBTIHMagnet,
} = ChromeUtils.importESModule(
  "resource:///modules/TorrentSecurityPolicy.sys.mjs"
);

add_task(function test_torrent_add_target_is_literal_only() {
  Assert.ok(isTorrentAddTarget("/api/v2/torrents/add"));
  for (const target of [
    "/api/v2/torrents/add?source=dialog",
    "/api/v2/torrents/add/",
    "/API/v2/torrents/add",
    "/api/v2/torrents/%61dd",
    "/api/v2/torrents/add%3fsource=dialog",
    "/api/v2/torrents/ignored%5c..%5cadd",
    "\\api\\v2\\torrents\\add",
  ]) {
    Assert.ok(!isTorrentAddTarget(target), target);
  }
});

add_task(function test_private_torrent_loads_are_rejected() {
  const privateLoadInfo = { originAttributes: { privateBrowsingId: 1 } };
  Assert.ok(isPrivateTorrentLoad(privateLoadInfo));
  Assert.ok(isPrivateTorrentLoad({ usePrivateBrowsing: true }));
  Assert.throws(
    () => new AboutTorrents().newChannel(null, privateLoadInfo),
    /unavailable in private browsing/
  );
  Assert.throws(
    () => new QBittorrentProtocolHandler().newChannel(null, privateLoadInfo),
    /unavailable in private browsing/
  );
});

add_task(function test_btih_magnets_are_strictly_validated() {
  const hex = "1".repeat(40);
  const base32 = "A".repeat(32);
  Assert.ok(isValidBTIHMagnet(`magnet:?xt=urn:btih:${hex}`));
  Assert.ok(
    isValidBTIHMagnet(
      `magnet:?dn=Linux%20fixture&xt=urn:btih:${base32}&tr=https%3A%2F%2Fexample.com`
    )
  );
  for (const source of [
    `magnet:?xt=urn:btih:${hex}#fragment`,
    `magnet:?xt=urn:btih:${hex}&tr=https%3A%2F%2Fexample.com%2F%0Atracker`,
    `magnet:?xt=urn:btih:${hex}&dn=fixture%00name`,
    `magnet:?xt=urn:btih:${hex}&dn=fixture%zzname`,
    `magnet:?xt=urn:btih:${"1".repeat(39)}`,
    `magnet:?xt=urn:btih:${"0".repeat(32768)}`,
  ]) {
    Assert.ok(!isValidBTIHMagnet(source), source);
  }
});

add_task(function test_navigation_requires_trusted_explicit_involvement() {
  for (const involvement of [1, 2]) {
    Assert.ok(
      hasExplicitTorrentNavigation({
        hasValidUserGestureActivation: true,
        userNavigationInvolvement: involvement,
      })
    );
  }
  Assert.ok(
    !hasExplicitTorrentNavigation({
      hasValidUserGestureActivation: true,
      userNavigationInvolvement: 0,
    }),
    "an external or scripted load cannot rely on the gesture flag alone"
  );
  Assert.ok(
    !hasExplicitTorrentNavigation({
      hasValidUserGestureActivation: false,
      userNavigationInvolvement: 1,
    })
  );
});

add_task(function test_native_torrent_routing_components_are_registered() {
  Assert.ok(
    "@mozilla.org/network/protocol;1?name=magnet" in Cc,
    "magnet links use the native user-confirmed ingress"
  );
  Assert.ok(
    "@mozilla.org/uriloader/content-handler;1?type=application/x-bittorrent" in
      Cc,
    "torrent responses use the native user-confirmed ingress"
  );
  Assert.ok(
    "@mozilla.org/uriloader/content-handler;1?type=application/vnd.bittorrent" in
      Cc,
    "alternate torrent MIME responses use the native user-confirmed ingress"
  );
});
