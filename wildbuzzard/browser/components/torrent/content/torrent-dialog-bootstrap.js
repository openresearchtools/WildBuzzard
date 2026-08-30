/* SPDX-License-Identifier: AGPL-3.0-or-later */

"use strict";

(async () => {
  const response = await window.WildBuzzardTorrentRequest({
    method: "GET",
    target: `${location.pathname}${location.search}`,
    headers: { Accept: "text/html" },
    body: new Uint8Array(),
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`qBittorrent WebUI failed (${response.status})`);
  }
  const contentTypes = response.headers.filter(
    ([name]) => name.toLowerCase() === "content-type"
  );
  const contentType = contentTypes[0]?.[1]
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (
    response.classification !== "torrent-html" ||
    response.preparedDocument !== true ||
    contentTypes.length !== 1 ||
    contentType !== "text/html"
  ) {
    throw new Error("qBittorrent returned an unprepared document");
  }
  const source = new TextDecoder().decode(response.body);
  if (!source.includes('http-equiv="Content-Security-Policy"')) {
    throw new Error("qBittorrent returned a document without policy");
  }
  document.open();
  // eslint-disable-next-line no-unsanitized/method
  document.write(source);
  document.close();
})().catch(error => {
  console.error("Failed to initialize qBittorrent dialog", error);
  document.body.textContent = "The torrent dialog could not be started.";
});
