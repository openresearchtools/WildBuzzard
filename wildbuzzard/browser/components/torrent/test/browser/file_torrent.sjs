/* SPDX-License-Identifier: AGPL-3.0-or-later */

function handleRequest(request, response) {
  const parameters = new URLSearchParams(request.queryString);
  response.setStatusLine(request.httpVersion, 200, "OK");
  if (parameters.has("landing")) {
    const nonce = parameters.get("landing");
    response.setHeader("Content-Type", "text/html; charset=utf-8", false);
    response.setHeader(
      "Set-Cookie",
      `torrentFixture=${nonce}; Path=/; Secure; HttpOnly; SameSite=Strict`,
      false
    );
    response.setHeader("Cache-Control", "no-store", false);
    response.write(
      `<a id="target" href="file_torrent.sjs?preserve=${nonce}">Download</a>`
    );
    return;
  }

  let contentType = "application/x-bittorrent";
  if (parameters.has("wrong-type")) {
    const key = `wrong-type-${parameters.get("nonce")}`;
    const count = Number(getState(key) || "0") + 1;
    setState(key, String(count));
    if (count > 1) {
      contentType = "text/html; charset=utf-8";
    }
  }
  if (parameters.has("preserve")) {
    const nonce = parameters.get("preserve");
    const key = `preserve-${nonce}`;
    const count = Number(getState(key) || "0") + 1;
    setState(key, String(count));
    if (count > 1) {
      const cookie = request.hasHeader("Cookie")
        ? request.getHeader("Cookie")
        : "";
      const referrer = request.hasHeader("Referer")
        ? request.getHeader("Referer")
        : "";
      if (
        !cookie.includes(`torrentFixture=${nonce}`) ||
        !referrer.includes(`file_torrent.sjs?landing=${nonce}`)
      ) {
        contentType = "text/plain; charset=utf-8";
      }
    }
  }
  response.setHeader("Content-Type", contentType, false);
  response.setHeader("Cache-Control", "no-store", false);
  if (parameters.has("attachment")) {
    response.setHeader(
      "Content-Disposition",
      'attachment; filename="fixture.torrent"',
      false
    );
  }
  if (parameters.has("oversize")) {
    const key = `oversize-${parameters.get("nonce")}`;
    const count = Number(getState(key) || "0") + 1;
    setState(key, String(count));
    if (count > 1) {
      response.setHeader("Content-Length", String(12 * 1024 * 1024 + 1));
      return;
    }
  }
  response.write(
    "d4:infod6:lengthi1e4:name12:fixture.txt12:piece lengthi16384e6:pieces20:aaaaaaaaaaaaaaaaaaaaee"
  );
}
