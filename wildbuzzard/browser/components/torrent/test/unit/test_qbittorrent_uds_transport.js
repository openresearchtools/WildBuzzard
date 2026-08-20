/* SPDX-License-Identifier: AGPL-3.0-or-later */

"use strict";

const { parseQBittorrentHTTPResponse, QBittorrentUDSTransportTestUtils } =
  ChromeUtils.importESModule(
    "resource:///modules/QBittorrentUDSTransport.sys.mjs"
  );

add_task(function test_content_length_and_chunked_framing() {
  const fixed =
    "HTTP/1.1 200 OK\r\nConnection: keep-alive\r\nContent-Length: 2\r\n\r\nOK";
  Assert.equal(
    QBittorrentUDSTransportTestUtils.completeResponseLength(
      fixed.slice(0, -1),
      1024
    ),
    null
  );
  Assert.equal(
    QBittorrentUDSTransportTestUtils.completeResponseLength(fixed, 1024),
    fixed.length
  );
  Assert.equal(
    new TextDecoder().decode(parseQBittorrentHTTPResponse(fixed).body),
    "OK"
  );

  const chunked =
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nOK\r\n0\r\n\r\n";
  Assert.equal(
    QBittorrentUDSTransportTestUtils.completeResponseLength(
      chunked.slice(0, -1),
      1024
    ),
    null
  );
  Assert.equal(
    QBittorrentUDSTransportTestUtils.completeResponseLength(chunked, 1024),
    chunked.length
  );
  Assert.equal(
    new TextDecoder().decode(parseQBittorrentHTTPResponse(chunked).body),
    "OK"
  );
});

add_task(function test_rejects_ambiguous_or_oversized_framing() {
  for (const source of [
    "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nContent-Length: 0\r\n\r\n",
    "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nTransfer-Encoding: chunked\r\n\r\n",
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\nX: y\r\n\r\n",
  ]) {
    Assert.throws(
      () =>
        QBittorrentUDSTransportTestUtils.completeResponseLength(source, 1024),
      /qBittorrent returned/
    );
  }
  Assert.throws(
    () =>
      QBittorrentUDSTransportTestUtils.completeResponseLength(
        "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nBAD",
        2
      ),
    /exceeded/
  );
});
