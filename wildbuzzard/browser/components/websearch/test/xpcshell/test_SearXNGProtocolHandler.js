/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { searXNGTargetFromURI, SearXNGProtocolHandlerTestUtils } =
  ChromeUtils.importESModule(
    "resource:///modules/SearXNGProtocolHandler.sys.mjs"
  );

add_task(function test_internal_route_allowlist() {
  for (const [spec, expected] of [
    ["moz-searxng://local/search?q=firefox", "/search?q=firefox"],
    [
      "moz-searxng://local/static/themes/simple/app.css",
      "/static/themes/simple/app.css",
    ],
    ["moz-searxng://local/clientabc.css", "/clientabc.css"],
    ["moz-searxng://local/preferences", "/preferences"],
    ["moz-searxng://local/info/en-US/about", "/info/en-US/about"],
    ["moz-searxng://local/manifest.json", "/manifest.json"],
  ]) {
    Assert.equal(searXNGTargetFromURI(Services.io.newURI(spec)), expected);
  }
  for (const spec of [
    "moz-searxng://other/search?q=x",
    "moz-searxng://local/config",
    "moz-searxng://local/metrics",
    "moz-searxng://local/static/../settings.yml",
    "moz-searxng://local/search?q=x#fragment",
  ]) {
    Assert.throws(
      () => searXNGTargetFromURI(Services.io.newURI(spec)),
      /Invalid internal SearXNG/
    );
  }
});

add_task(function test_document_content_type_allowlist() {
  Assert.deepEqual(
    SearXNGProtocolHandlerTestUtils.responseContentType({
      headers: new Map([["content-type", "text/html; charset=UTF-8"]]),
    }),
    { contentCharset: "UTF-8", contentType: "text/html" }
  );
  Assert.throws(
    () =>
      SearXNGProtocolHandlerTestUtils.responseContentType({
        headers: new Map([["content-type", "application/octet-stream"]]),
      }),
    /unsupported content type/
  );
});
