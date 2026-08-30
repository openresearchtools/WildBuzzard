/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { magnetDisplayName } = ChromeUtils.importESModule(
  "resource:///modules/TorrentIngress.sys.mjs"
);

add_task(function test_magnet_display_name_is_bounded_and_sanitized() {
  const hash = "1".repeat(40);
  Assert.equal(
    magnetDisplayName(`magnet:?xt=urn:btih:${hash}&dn=Linux%0AImage`),
    "Linux Image"
  );
  Assert.equal(magnetDisplayName(`magnet:?xt=urn:btih:${hash}`), "Magnet link");
  Assert.equal(
    Array.from(
      magnetDisplayName(`magnet:?xt=urn:btih:${hash}&dn=${"x".repeat(300)}`)
    ).length,
    256
  );
});

add_task(function test_invalid_magnets_are_rejected() {
  for (const source of [
    "https://example.com/file.torrent",
    "magnet:",
    "magnet:?dn=No%20hash",
    "magnet:?xt=urn:btih:not-a-hash",
    `magnet:?xt=urn:btih:${"1".repeat(40)}#fragment`,
    `magnet:?xt=urn:btih:${"1".repeat(40)}\n`,
    `magnet:?xt=urn:btih:${"1".repeat(40)}&dn=Linux%00Image`,
    `magnet:?xt=urn:btih:${"1".repeat(40)}&dn=Linux%zzImage`,
    `magnet:?xt=urn:btih:${"1".repeat(40)}&tr=https%3A%2F%2Fexample.com%2F%0Atracker`,
    `magnet:?xt=urn:btih:${"1".repeat(40)}&dn=${"x".repeat(32768)}`,
  ]) {
    Assert.throws(() => magnetDisplayName(source), /Invalid magnet link/);
  }
});
