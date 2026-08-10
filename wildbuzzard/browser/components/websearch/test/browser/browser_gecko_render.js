/* SPDX-License-Identifier: AGPL-3.0-or-later */

"use strict";

/* eslint-disable @microsoft/sdl/no-insecure-url */

const { BrowserControl } = ChromeUtils.importESModule(
  "chrome://remote/content/wildbuzzard/BrowserControl.sys.mjs"
);
const { HttpServer } = ChromeUtils.importESModule(
  "resource://testing-common/httpd.sys.mjs"
);

const FIXTURE_PATH =
  "/browser/wildbuzzard/browser/components/websearch/test/browser/file_gecko_render.sjs";
const FIXTURE = `https://example.com${FIXTURE_PATH}`;
const OTHER_FIXTURE = `https://example.org${FIXTURE_PATH}`;
const PINNED_HOST = "wildbuzzard-pinned.example";
const REBIND_HOST = "wildbuzzard-rebind.example";
const FALLBACK_HOST = "wildbuzzard-fallback.example";
const OVERLAP_HOST = "wildbuzzard-overlap.example";
const PRECONNECT_HOST = "wildbuzzard-preconnect.example";
const ALT_USED_HOST = "wildbuzzard-alt-used.example";
const TLS_PINNED_HOST = "wildbuzzard-tls-pinned.example";
const COMPARATOR_CANCEL_BOUND_MS = 3000;
const TEST_ALLOWED_HOSTS = Object.freeze([
  "example.com",
  "example.org",
  "www.example.com",
  "expired.example.com",
]);
let automationFixture;

function setDefaultTestDNSAnswers() {
  BrowserControl.setGeckoRenderTestDNSAnswers({
    [PINNED_HOST]: ["127.0.0.1"],
    [REBIND_HOST]: ["127.0.0.2"],
    [FALLBACK_HOST]: ["127.0.0.2", "127.0.0.1"],
    [OVERLAP_HOST]: ["127.0.0.1"],
    [TLS_PINNED_HOST]: ["127.0.0.1"],
  });
}

async function render(url, args = {}, signal = new AbortController().signal) {
  const result = await BrowserControl.dispatch(
    "gecko_render",
    { url, ...args },
    PathUtils.profileDir,
    "gecko-render-test",
    signal
  );
  return result.details;
}

function assertClean(message) {
  const diagnostics = BrowserControl.geckoRenderDiagnostics();
  is(diagnostics.active, 0, `${message}: no active permit`);
  is(diagnostics.queued, 0, `${message}: no queued job`);
  is(diagnostics.contexts.length, 0, `${message}: no browsing context`);
  is(diagnostics.userContexts.length, 0, `${message}: no storage context`);
  is(
    diagnostics.lastCleanup?.failedFlags,
    0,
    `${message}: isolated data deletion succeeded`
  );
  is(
    diagnostics.lastCleanup?.leakedContextIds.length,
    0,
    `${message}: every browsing context was discarded`
  );
}

function assertAutomationClean(result, message) {
  Assert.deepEqual(
    result._testDiagnostics,
    {
      active: 0,
      queued: 0,
      contexts: 0,
      userContexts: 0,
      cleanupFailedFlags: 0,
      leakedContexts: 0,
    },
    `${message}: comparator diagnostics contain only clean bounded state`
  );
}

function createConnectionCounter() {
  const server = Cc["@mozilla.org/network/server-socket;1"].createInstance(
    Ci.nsIServerSocket
  );
  const stopped = Promise.withResolvers();
  const state = { accepted: 0 };
  server.init(-1, true, -1);
  server.asyncListen({
    onSocketAccepted(_server, transport) {
      state.accepted++;
      transport.close(Cr.NS_BINDING_ABORTED);
    },
    onStopListening() {
      stopped.resolve();
    },
  });
  return {
    port: server.port,
    state,
    async stop() {
      server.close();
      await stopped.promise;
    },
  };
}

function createTLSServer() {
  const certDB = Cc["@mozilla.org/security/x509certdb;1"].getService(
    Ci.nsIX509CertDB
  );
  const cert = [...certDB.getCerts()].find(
    candidate => candidate.commonName === "Mochitest client"
  );
  if (!cert) {
    throw new Error("Mochitest TLS certificate is unavailable");
  }
  const server = Cc["@mozilla.org/network/tls-server-socket;1"].createInstance(
    Ci.nsITLSServerSocket
  );
  const stopped = Promise.withResolvers();
  const connections = new Set();
  const state = { host: null };
  server.init(-1, true, -1);
  server.serverCert = cert;
  server.setSessionTickets(false);
  server.asyncListen({
    onSocketAccepted(_server, transport) {
      const input = transport.openInputStream(0, 0, 0);
      const output = transport.openOutputStream(0, 0, 0);
      const connection = { input, output, request: "", stopped: false };
      connections.add(connection);
      const close = () => {
        if (connection.stopped) {
          return;
        }
        connection.stopped = true;
        connections.delete(connection);
        try {
          input.close();
        } catch {}
        try {
          output.close();
        } catch {}
      };
      const callback = {
        onInputStreamReady(stream) {
          if (connection.stopped) {
            return;
          }
          let available;
          try {
            available = stream.available();
          } catch {
            close();
            return;
          }
          connection.request += NetUtil.readInputStreamToString(
            stream,
            available
          );
          if (!connection.request.includes("\r\n\r\n")) {
            input.asyncWait(callback, 0, 0, Services.tm.currentThread);
            return;
          }
          state.host =
            (/^Host:\s*(.+)$/im.exec(connection.request)?.[1] ?? "").trim() ||
            null;
          const body = "routed tls fixture";
          const response = `HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`;
          output.write(response, response.length);
          close();
        },
      };
      const connectionInfo = transport.securityCallbacks.getInterface(
        Ci.nsITLSServerConnectionInfo
      );
      connectionInfo.setSecurityObserver({
        onHandshakeDone() {
          input.asyncWait(callback, 0, 0, Services.tm.currentThread);
        },
      });
    },
    onStopListening() {
      stopped.resolve();
    },
  });
  return {
    cert,
    port: server.port,
    state,
    async stop() {
      for (const connection of connections) {
        connection.stopped = true;
        try {
          connection.input.close();
        } catch {}
        try {
          connection.output.close();
        } catch {}
      }
      connections.clear();
      server.close();
      await stopped.promise;
    },
  };
}

add_setup(function setup_renderer() {
  const wasStarted = BrowserControl.started;
  const dnsOverride = Cc[
    "@mozilla.org/network/native-dns-override;1"
  ].getService(Ci.nsINativeDNSResolverOverride);
  BrowserControl.start();
  BrowserControl.setGeckoRenderTestAllowedHosts(TEST_ALLOWED_HOSTS);
  setDefaultTestDNSAnswers();
  dnsOverride.addIPOverride(PINNED_HOST, "127.0.0.2");
  dnsOverride.addIPOverride(REBIND_HOST, "127.0.0.1");
  dnsOverride.addIPOverride(FALLBACK_HOST, "127.0.0.3");
  dnsOverride.addIPOverride(OVERLAP_HOST, "127.0.0.2");
  dnsOverride.addIPOverride(PRECONNECT_HOST, "127.0.0.1");
  dnsOverride.addIPOverride(ALT_USED_HOST, "127.0.0.2");
  dnsOverride.addIPOverride(TLS_PINNED_HOST, "127.0.0.2");
  Services.dns.clearCache(false);
  registerCleanupFunction(() => {
    dnsOverride.clearHostOverride(PINNED_HOST);
    dnsOverride.clearHostOverride(REBIND_HOST);
    dnsOverride.clearHostOverride(FALLBACK_HOST);
    dnsOverride.clearHostOverride(OVERLAP_HOST);
    dnsOverride.clearHostOverride(PRECONNECT_HOST);
    dnsOverride.clearHostOverride(ALT_USED_HOST);
    dnsOverride.clearHostOverride(TLS_PINNED_HOST);
    Services.dns.clearCache(false);
    BrowserControl.setGeckoRenderTestAllowedHosts([]);
    BrowserControl.setGeckoRenderTestDNSAnswers({});
    if (!wasStarted) {
      BrowserControl.stop();
    }
  });
});

add_setup(function setup_automation_fixture() {
  const server = new HttpServer();
  const pendingSlowRequests = new Set();
  const state = {
    active: 0,
    fastRequests: 0,
    pinnedHost: null,
    pinnedRequests: 0,
    pinnedAltUsed: null,
    privateRequests: 0,
    overlapHeldRequests: 0,
    overlapSecondRequests: 0,
    releaseOverlap: null,
    maxActive: 0,
    releaseHold: null,
    releaseSlowRequests() {
      for (const finish of [...pendingSlowRequests]) {
        finish();
      }
    },
  };
  server.registerPathHandler("/fast", (_request, response) => {
    state.active++;
    state.fastRequests++;
    state.maxActive = Math.max(state.maxActive, state.active);
    response.setHeader("Content-Type", "text/html; charset=utf-8", false);
    response.write("<!doctype html><title>Fast</title><h1>Fast fixture</h1>");
    state.active--;
  });
  server.registerPathHandler("/private", (_request, response) => {
    state.privateRequests++;
    response.setHeader("Content-Type", "text/plain; charset=utf-8", false);
    response.write("private fixture");
  });
  server.registerPathHandler("/pinned", (request, response) => {
    state.pinnedRequests++;
    state.pinnedHost = request.getHeader("Host");
    state.pinnedAltUsed = request.hasHeader("Alt-Used")
      ? request.getHeader("Alt-Used")
      : null;
    response.setHeader("Content-Type", "text/plain; charset=utf-8", false);
    response.write("pinned fixture");
  });
  server.registerPathHandler("/overlap", (_request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8", false);
    response.write(`<!doctype html><title>overlap</title><p>overlap</p><script>
      setTimeout(() => fetch("/overlap-held").catch(() => {}), 25);
      setTimeout(() => fetch("/overlap-second").catch(() => {}), 1000);
    </script>`);
  });
  server.registerPathHandler("/overlap-held", (_request, response) => {
    state.overlapHeldRequests++;
    response.processAsync();
    state.releaseOverlap = () => {
      response.setHeader("Content-Type", "text/plain; charset=utf-8", false);
      response.write("held response");
      response.finish();
      state.releaseOverlap = null;
    };
  });
  server.registerPathHandler("/overlap-second", (_request, response) => {
    state.overlapSecondRequests++;
    response.setHeader("Content-Type", "text/plain; charset=utf-8", false);
    response.write("second response");
  });
  server.registerPathHandler("/hold", (_request, response) => {
    state.active++;
    state.maxActive = Math.max(state.maxActive, state.active);
    response.processAsync();
    state.releaseHold = () => {
      response.setHeader("Content-Type", "text/html; charset=utf-8", false);
      response.write("<!doctype html><title>Held</title><h1>Held fixture</h1>");
      response.finish();
      state.active--;
      state.releaseHold = null;
    };
  });
  server.registerPathHandler("/slow", (request, response) => {
    state.active++;
    state.maxActive = Math.max(state.maxActive, state.active);
    const delayMs = Math.min(
      10000,
      Math.max(1, Number(request.queryString.split("=", 2)[1]) || 150)
    );
    response.processAsync();
    let timeoutId;
    const finish = () => {
      if (!pendingSlowRequests.delete(finish)) {
        return;
      }
      clearTimeout(timeoutId);
      try {
        response.setHeader("Content-Type", "text/html; charset=utf-8", false);
        response.write(
          "<!doctype html><title>Slow</title><h1>Slow fixture</h1>"
        );
        response.finish();
      } catch {}
      state.active--;
    };
    pendingSlowRequests.add(finish);
    // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
    timeoutId = setTimeout(finish, delayMs);
  });
  server.start(-1);
  server.identity.add("http", PINNED_HOST, server.identity.primaryPort);
  server.identity.add("http", REBIND_HOST, server.identity.primaryPort);
  server.identity.add("http", FALLBACK_HOST, server.identity.primaryPort);
  server.identity.add("http", OVERLAP_HOST, server.identity.primaryPort);
  server.identity.add("http", ALT_USED_HOST, server.identity.primaryPort);
  automationFixture = {
    origin: `http://127.0.0.1:${server.identity.primaryPort}`,
    server,
    state,
  };
  registerCleanupFunction(
    () =>
      new Promise(resolve => {
        automationFixture.state.releaseHold?.();
        automationFixture.state.releaseOverlap?.();
        automationFixture.state.releaseSlowRequests();
        automationFixture.server.stop(resolve);
      })
  );
});

add_task(async function test_javascript_dom_status_and_final_url() {
  const result = await render(`${FIXTURE}?mode=html`, {
    waitForSelector: "#ready",
    waitMs: 10,
  });
  is(result.pageStatusCode, 200, "main-document status is returned");
  is(result.pageError, null, "successful render has no page error");
  is(
    result.contentType,
    "text/html; charset=utf-8",
    "content type is returned"
  );
  is(result.finalUrl, `${FIXTURE}?mode=html`, "final URL is returned");
  Assert.greater(result.decodedBytes, 0, "decoded response bytes are returned");
  ok(result.content.includes("Static heading"), "static DOM is serialized");
  ok(
    result.content.includes("JavaScript mutated DOM"),
    "JavaScript-mutated DOM is serialized"
  );
  assertClean("successful HTML render");
});

add_task(async function test_static_mode_does_not_execute_page_javascript() {
  const result = await render(`${FIXTURE}?mode=html`, { javascript: false });
  is(result.pageError, null, "static Gecko load succeeds");
  ok(result.content.includes("Static heading"), "static HTML is serialized");
  ok(!result.content.includes('id="ready"'), "page JavaScript did not run");
  assertClean("static render");
});

add_task(async function test_xml_encoding_gzip_and_redirect_contract() {
  let result = await render(`${FIXTURE}?mode=xml`);
  is(result.pageStatusCode, 200, "XML status is returned");
  is(result.contentType, "application/xml; charset=utf-8", "XML type is kept");
  ok(result.content.includes("<urlset>"), "original XML markup is returned");
  ok(result.content.includes("&amp;"), "XML entities remain serialized");

  result = await render(`${FIXTURE}?mode=xml-utf16`);
  is(result.contentType, "text/xml", "text XML variant is accepted");
  ok(
    result.content.includes("<value>encoded</value>"),
    "UTF-16 XML is decoded"
  );

  result = await render(`${FIXTURE}?mode=gzip-sitemap`);
  is(result.contentType, "application/gzip", "gzip type is retained");
  ok(
    result.content.startsWith("data:application/gzip;base64,"),
    "gzip bytes use the bounded binary envelope"
  );
  const gzip = atob(result.content.split(",", 2)[1]);
  is(gzip.charCodeAt(0), 0x1f, "gzip magic byte one is preserved");
  is(gzip.charCodeAt(1), 0x8b, "gzip magic byte two is preserved");

  result = await render(`${FIXTURE}?mode=redirect-chain&hops=2`);
  is(result.redirectCount, 3, "the complete redirect chain is counted");
  is(result.finalUrl, `${FIXTURE}?mode=text`, "redirect final URL is exact");
  is(result.content, "plain response body", "redirect target body is returned");
  assertClean("XML, gzip, and redirect renders");
});

add_task(async function test_status_and_original_text_bodies() {
  let result = await render(`${FIXTURE}?mode=json`);
  is(result.pageStatusCode, 200, "JSON status is returned");
  is(
    result.content,
    '{"rendered":true,"source":"original"}',
    "original JSON body is returned"
  );

  result = await render(`${FIXTURE}?mode=text`);
  is(result.content, "plain response body", "original plain body is returned");

  result = await render(`${FIXTURE}?mode=missing`);
  is(result.pageStatusCode, 404, "HTTP error status is retained");
  ok(result.content.includes("Not Found"), "HTTP error DOM is returned");

  result = await render(`${FIXTURE}?mode=empty`);
  is(result.pageStatusCode, 204, "204 status is retained");
  is(result.content, "", "204 has an empty body");
  is(result.contentType, "", "204 has no content type");

  result = await render(`${FIXTURE}?mode=same-origin-iframe`);
  is(result.redirectCount, 0, "iframe loads are not counted as redirects");
  is(
    result.finalUrl,
    `${FIXTURE}?mode=same-origin-iframe`,
    "iframe responses do not replace the top-level final URL"
  );
  ok(result.content.includes("Outer document"), "the top document is returned");
  assertClean("status and content-type renders");
});

add_task(async function test_pdf_returns_bounded_original_bytes() {
  const result = await render(`${FIXTURE}?mode=pdf`);
  is(result.pageStatusCode, 200, "PDF status is returned");
  is(result.pageError, null, "PDF render has no page error");
  is(result.contentType, "application/pdf", "PDF content type is returned");
  ok(
    result.content.startsWith("data:application/pdf;base64,"),
    "PDF content is tagged as base64"
  );
  const decoded = atob(result.content.split(",", 2)[1]);
  ok(decoded.startsWith("%PDF-1.4"), "original PDF header is preserved");
  ok(decoded.includes("Renderer PDF"), "original PDF body is preserved");
  Assert.lessOrEqual(
    result.content.length,
    2 * 1024 * 1024,
    "PDF output is bounded"
  );
  assertClean("PDF render");
});

add_task(async function test_initial_ssrf_policy() {
  for (const url of [
    "http://127.0.0.1/",
    "http://10.0.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://192.168.0.1/",
    "http://198.18.0.1/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[fc00::1]/",
    "http://metadata.google.internal/",
  ]) {
    const result = await render(url);
    is(result.pageStatusCode, 0, `${url} did not navigate`);
    ok(
      result.pageError.includes("private") ||
        result.pageError.includes("reserved")
    );
  }
  automationFixture.state.privateRequests = 0;
  const result = await render(`${automationFixture.origin}/private`);
  ok(result.pageError.includes("private"), "private fixture is blocked");
  is(
    automationFixture.state.privateRequests,
    0,
    "blocked main navigation sends no request to the private fixture"
  );
  assertClean("blocked initial navigations");
});

add_task(async function test_redirect_subresource_and_domain_policy() {
  automationFixture.state.privateRequests = 0;
  let target = `${automationFixture.origin}/private`;
  let result = await render(
    `${FIXTURE}?mode=redirect&target=${encodeURIComponent(target)}`
  );
  ok(result.pageError.includes("ssrf-blocked"), "private redirect is blocked");
  is(
    automationFixture.state.privateRequests,
    0,
    "blocked redirect sends no request to the private fixture"
  );

  for (const kind of ["iframe", "image", "script", "fetch", "xhr"]) {
    result = await render(
      `${FIXTURE}?mode=private-subresource&kind=${kind}&target=${encodeURIComponent(target)}`
    );
    ok(
      result.pageError.includes("ssrf-blocked"),
      `private ${kind} aborts the render`
    );
    is(
      automationFixture.state.privateRequests,
      0,
      `blocked ${kind} sends no request to the private fixture`
    );
  }

  for (const kind of ["iframe", "image", "script", "fetch", "xhr"]) {
    result = await render(`${FIXTURE}?mode=public-subresource&kind=${kind}`, {
      allowedOrigins: ["https://example.com"],
      waitMs: 50,
    });
    ok(
      result.pageError.includes("outside the allowed scope"),
      `out-of-scope public ${kind} aborts the render`
    );
  }

  result = await render(`${FIXTURE}?mode=html`, {
    blockDomains: ["ample.com"],
  });
  is(result.pageError, null, "substring domain does not overblock");

  result = await render(`${FIXTURE}?mode=html`, {
    blockDomains: ["example.com"],
  });
  ok(result.pageError.includes("blocked"), "exact blocked domain is enforced");
  assertClean("redirect and subresource policy");
});

add_task(async function test_dns_rebinding_is_checked_at_the_channel() {
  automationFixture.state.privateRequests = 0;
  const result = await render(
    `http://${REBIND_HOST}:${automationFixture.server.identity.primaryPort}/private`,
    { timeoutMs: 2000 }
  );
  ok(result.pageError, "the pinned channel cannot follow the rebound answer");
  is(
    automationFixture.state.privateRequests,
    0,
    "DNS rebinding sends no request to the private fixture"
  );
  assertClean("DNS rebinding");
});

add_task(async function test_approved_fixture_address_is_pinned() {
  automationFixture.state.pinnedHost = null;
  automationFixture.state.pinnedRequests = 0;
  const result = await render(
    `http://${PINNED_HOST}:${automationFixture.server.identity.primaryPort}/pinned`,
    { timeoutMs: 2000 }
  );
  is(result.pageError, null, "the approved pinned fixture renders");
  is(result.content, "pinned fixture", "the pinned response is returned");
  is(
    automationFixture.state.pinnedRequests,
    1,
    "the channel uses the approved address instead of the native DNS answer"
  );
  is(
    automationFixture.state.pinnedHost,
    `${PINNED_HOST}:${automationFixture.server.identity.primaryPort}`,
    "address pinning retains the origin Host header"
  );
  assertClean("approved fixture address pinning");
});

add_task(async function test_https_route_retains_origin_tls_identity() {
  const tlsServer = createTLSServer();
  const certOverrideService = Cc[
    "@mozilla.org/security/certoverride;1"
  ].getService(Ci.nsICertOverrideService);
  certOverrideService.rememberValidityOverride(
    TLS_PINNED_HOST,
    tlsServer.port,
    {},
    tlsServer.cert,
    true
  );
  try {
    const result = await render(
      `https://${TLS_PINNED_HOST}:${tlsServer.port}/`,
      { timeoutMs: 3000 }
    );
    is(result.pageError, null, "the routed TLS handshake uses the origin name");
    is(result.content, "routed tls fixture", "the HTTPS response is returned");
    is(
      tlsServer.state.host,
      `${TLS_PINNED_HOST}:${tlsServer.port}`,
      "the routed TLS request retains its origin Host header"
    );
  } finally {
    certOverrideService.clearValidityOverride(
      TLS_PINNED_HOST,
      tlsServer.port,
      {}
    );
    await tlsServer.stop();
  }
  assertClean("HTTPS routed origin identity");
});

add_task(async function test_approved_address_fallback_is_ordered() {
  automationFixture.state.pinnedRequests = 0;
  const result = await render(
    `http://${FALLBACK_HOST}:${automationFixture.server.identity.primaryPort}/pinned`,
    { timeoutMs: 3000 }
  );
  is(result.pageError, null, "the second approved address is retried");
  is(result.content, "pinned fixture", "fallback response is returned");
  is(
    automationFixture.state.pinnedRequests,
    1,
    "the unapproved native DNS address is never used"
  );
  assertClean("approved address fallback");
});

add_task(async function test_renderer_routes_never_use_configured_proxy() {
  const counter = createConnectionCounter();
  const proxyService = Cc[
    "@mozilla.org/network/protocol-proxy-service;1"
  ].getService(Ci.nsIProtocolProxyService);
  const filter = {
    QueryInterface: ChromeUtils.generateQI(["nsIProtocolProxyChannelFilter"]),
    applyFilter(_channel, _proxyInfo, callback) {
      callback.onProxyFilterResult(
        proxyService.newProxyInfo(
          "http",
          "127.0.0.1",
          counter.port,
          "",
          "",
          0,
          0,
          null
        )
      );
    },
  };
  proxyService.registerChannelFilter(filter, 0);
  try {
    const result = await render(
      `http://${PINNED_HOST}:${automationFixture.server.identity.primaryPort}/pinned`,
      { timeoutMs: 2000 }
    );
    is(result.pageError, null, "the approved direct route loads");
    is(counter.state.accepted, 0, "the configured proxy receives no socket");
  } finally {
    proxyService.unregisterChannelFilter(filter);
    await counter.stop();
  }
  assertClean("renderer proxy exclusion");
});

add_task(async function test_renderer_preconnects_fail_closed() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["network.early-hints.enabled", true],
      ["network.early-hints.over-http-v1-1.enabled", true],
      ["network.early-hints.preconnect.enabled", true],
      ["network.http.debug-observations", true],
    ],
  });
  const counter = createConnectionCounter();
  const target = `https://${PRECONNECT_HOST}:${counter.port}/`;
  const observations = [];
  const observer = (_subject, _topic, data) => observations.push(data);
  Services.obs.addObserver(observer, "speculative-connect-request");
  try {
    for (const mode of ["preconnect", "early-hint-preconnect"]) {
      const result = await render(
        `${FIXTURE}?mode=${mode}&target=${encodeURIComponent(target)}`,
        { waitMs: 350 }
      );
      is(result.pageError, null, `${mode} page renders normally`);
      is(
        counter.state.accepted,
        0,
        `${mode} opens no speculative socket outside channel policy`
      );
    }
  } finally {
    Services.obs.removeObserver(observer, "speculative-connect-request");
    await counter.stop();
  }
  ok(
    observations.every(value => !value.includes(PRECONNECT_HOST)),
    "renderer preconnects never reach the HTTP connection manager"
  );
  assertClean("renderer preconnect policy");
});

add_task(async function test_connection_override_clears_alt_used() {
  automationFixture.state.pinnedAltUsed = null;
  automationFixture.state.pinnedRequests = 0;
  const uri = `http://${ALT_USED_HOST}:${automationFixture.server.identity.primaryPort}/pinned`;
  const channel = NetUtil.newChannel({
    uri,
    loadUsingSystemPrincipal: true,
  }).QueryInterface(Ci.nsIHttpChannel);
  channel.loadFlags |=
    Ci.nsIRequest.LOAD_BYPASS_CACHE | Ci.nsIRequest.INHIBIT_CACHING;
  channel.setRequestHeader("Alt-Used", "stale-route.invalid:443", false);
  const observer = subject => {
    if (subject !== channel) {
      return;
    }
    const internal = channel.QueryInterface(Ci.nsIHttpChannelInternal);
    is(
      channel.getRequestHeader("Alt-Used"),
      "stale-route.invalid:443",
      "the pre-existing alternate route header reached modify-request"
    );
    internal.setConnectionTargetIPAddress("127.0.0.1");
    Assert.throws(
      () => channel.getRequestHeader("Alt-Used"),
      /NS_ERROR_NOT_AVAILABLE/,
      "the explicit route removes Alt-Used"
    );
  };
  Services.obs.addObserver(observer, "http-on-modify-request");
  try {
    await new Promise((resolve, reject) => {
      channel.asyncOpen({
        onStartRequest(request) {
          if (!Components.isSuccessCode(request.status)) {
            reject(new Error(`channel failed: ${request.status}`));
          }
        },
        onDataAvailable(_request, stream, _offset, count) {
          NetUtil.readInputStreamToString(stream, count);
        },
        onStopRequest(_request, status) {
          if (Components.isSuccessCode(status)) {
            resolve();
          } else {
            reject(new Error(`channel stopped: ${status}`));
          }
        },
      });
    });
  } finally {
    Services.obs.removeObserver(observer, "http-on-modify-request");
  }
  is(automationFixture.state.pinnedRequests, 1, "the explicit route loads");
  is(
    automationFixture.state.pinnedAltUsed,
    null,
    "the stale Alt-Used header is not sent to the pinned origin"
  );
});

add_task(async function test_overlapping_dns_records_are_channel_bound() {
  automationFixture.state.overlapHeldRequests = 0;
  automationFixture.state.overlapSecondRequests = 0;
  BrowserControl.setGeckoRenderTestDNSAnswers({
    [OVERLAP_HOST]: ["127.0.0.1"],
  });
  let result;
  try {
    const renderPromise = render(
      `http://${OVERLAP_HOST}:${automationFixture.server.identity.primaryPort}/overlap`,
      { timeoutMs: 4000, waitMs: 1600 }
    );
    await TestUtils.waitForCondition(
      () => automationFixture.state.overlapHeldRequests === 1,
      "the first same-host request reaches its approved address"
    );
    const secondRoute = TestUtils.topicObserved(
      "wildbuzzard-gecko-render-route",
      (_subject, data) => {
        const route = JSON.parse(data);
        return (
          route.host === OVERLAP_HOST &&
          route.targets.length === 1 &&
          route.targets[0] === "127.0.0.2"
        );
      }
    );
    BrowserControl.setGeckoRenderTestDNSAnswers({
      [OVERLAP_HOST]: ["127.0.0.2"],
    });
    await secondRoute;
    automationFixture.state.releaseOverlap();
    result = await renderPromise;
  } finally {
    automationFixture.state.releaseOverlap?.();
    setDefaultTestDNSAnswers();
  }
  is(
    result.pageError,
    null,
    "the first channel retains its immutable approved target"
  );
  is(
    automationFixture.state.overlapSecondRequests,
    0,
    "the later channel does not fall back to mutable native DNS"
  );
  assertClean("overlapping same-host DNS records");
});

add_task(async function test_test_dns_answers_require_ip_literals() {
  Assert.throws(
    () => BrowserControl.setGeckoRenderTestDNSAnswers({ invalid: ["host"] }),
    /IP literals/,
    "test DNS cannot install a hostname target"
  );
  setDefaultTestDNSAnswers();
});

add_task(async function test_cross_origin_header_stripping() {
  let result = await render(`${FIXTURE}?mode=header`, {
    headers: { "X-Requested-With": "renderer-secret" },
  });
  ok(result.content.includes("renderer-secret"), "same-origin header is sent");

  const target = `${OTHER_FIXTURE}?mode=header`;
  result = await render(
    `${FIXTURE}?mode=redirect&target=${encodeURIComponent(target)}`,
    { headers: { "X-Requested-With": "renderer-secret" } }
  );
  is(result.finalUrl, target, "cross-origin redirect is followed");
  ok(result.content.includes("absent"), "custom header is stripped");
  ok(!result.content.includes("renderer-secret"), "custom value did not leak");

  result = await render(
    `${FIXTURE}?mode=redirect&target=${encodeURIComponent(target)}`,
    { allowedOrigins: ["https://example.com"] }
  );
  ok(
    result.pageError.includes("outside the allowed scope"),
    "cross-origin redirect is blocked before an out-of-scope request"
  );

  const subdomainTarget = `https://www.example.com${FIXTURE_PATH}?mode=text`;
  result = await render(
    `${FIXTURE}?mode=redirect&target=${encodeURIComponent(subdomainTarget)}`,
    {
      allowedOrigins: ["https://example.com"],
      allowSubdomains: true,
    }
  );
  is(result.finalUrl, subdomainTarget, "opt-in subdomain redirect is allowed");
  is(result.pageError, null, "subdomain target renders successfully");
  assertClean("header stripping");
});

add_task(async function test_direct_socket_apis_are_unavailable() {
  const result = await render(`${FIXTURE}?mode=restricted-apis`);
  is(result.pageError, null, "restricted API fixture rendered");
  for (const name of ["RTCPeerConnection", "WebSocket", "WebTransport"]) {
    ok(result.content.includes(`${name}=undefined`), `${name} is unavailable`);
  }
  assertClean("restricted network APIs");
});

add_task(async function test_invalid_tls_timeout_abort_and_limits() {
  let result = await render("https://expired.example.com/");
  ok(result.pageError, "invalid TLS returns a normalized page error");

  result = await render(`${FIXTURE}?mode=slow&delay=1000`, {
    timeoutMs: 50,
  });
  ok(result.pageError.includes("timeout"), "navigation timeout is bounded");

  const controller = new AbortController();
  const pending = render(
    `${FIXTURE}?mode=slow&delay=1000`,
    {},
    controller.signal
  );
  controller.abort();
  await Assert.rejects(pending, /aborted/, "caller cancellation is propagated");

  result = await render(`${FIXTURE}?mode=large-dom`);
  ok(result.pageError.includes("DOM node limit"), "oversized DOM is rejected");

  result = await render(`${FIXTURE}?mode=large-body`);
  ok(result.pageError.includes("response"), "oversized body is rejected");

  result = await render(`${FIXTURE}?mode=large-output`);
  ok(
    result.pageError.includes("serialized output"),
    "oversized serialized DOM is rejected"
  );

  result = await render(`${FIXTURE}?mode=text`, { maxBytes: 8 });
  ok(result.pageError.includes("response"), "caller byte budget is enforced");
  Assert.lessOrEqual(result.decodedBytes, 8, "reported bytes stay in budget");

  result = await render(`${FIXTURE}?mode=redirect-chain&hops=1`, {
    maxRedirects: 0,
  });
  ok(result.pageError.includes("redirect"), "caller redirect cap is enforced");
  is(result.redirectCount, 0, "reported redirects stay within the caller cap");
  assertClean("TLS, timeout, abort, and DOM limits");
});

add_task(async function test_storage_cleanup_and_concurrency_permits() {
  let result = await render(`${FIXTURE}?mode=storage`, { waitMs: 100 });
  is(result.pageError, null, "storage fixture rendered");
  assertClean("storage fixture");

  const jobs = [0, 1, 2].map(() =>
    render(`${FIXTURE}?mode=slow&delay=150`, { timeoutMs: 2000 })
  );
  await TestUtils.waitForCondition(
    () => BrowserControl.geckoRenderDiagnostics().active === 2,
    "renderer reaches its concurrency bound"
  );
  const results = await Promise.all(jobs);
  ok(
    results.every(item => item.pageError === null),
    "concurrent jobs succeed"
  );
  assertClean("concurrent jobs");
});

add_task(async function test_rejects_sensitive_headers() {
  for (const name of [
    "Host",
    "Connection",
    "Cookie",
    "Authorization",
    "Proxy-Authorization",
  ]) {
    await Assert.rejects(
      render(FIXTURE, { headers: { [name]: "secret" } }),
      /not allowed/,
      `${name} is rejected before navigation`
    );
  }
  assertClean("invalid headers");
});

add_task(async function test_comparator_override_is_exclusive_and_bounded() {
  automationFixture.state.maxActive = 0;
  const options = {
    _testAllowedHosts: [automationFixture.origin],
    _testDiagnostics: true,
    timeoutMs: 2000,
  };
  const [slow, fast] = await Promise.all([
    render(`${automationFixture.origin}/slow?delay=150`, options),
    render(`${automationFixture.origin}/fast`, options),
  ]);
  is(automationFixture.state.maxActive, 1, "fixture overrides cannot overlap");
  is(slow.pageError, null, "the first fixture render succeeds");
  is(fast.pageError, null, "the queued fixture render succeeds");
  assertAutomationClean(slow, "first exclusive fixture render");
  assertAutomationClean(fast, "second exclusive fixture render");
  assertClean("exclusive fixture renders");
});

add_task(async function test_ordinary_render_waits_for_override_restoration() {
  automationFixture.state.fastRequests = 0;
  const options = {
    _testAllowedHosts: [automationFixture.origin],
    _testDiagnostics: true,
    timeoutMs: 2000,
  };
  const exclusive = render(`${automationFixture.origin}/hold`, options);
  await TestUtils.waitForCondition(
    () => typeof automationFixture.state.releaseHold === "function",
    "the exclusive fixture override starts"
  );
  let ordinarySettled = false;
  const ordinary = render(`${automationFixture.origin}/fast`).then(result => {
    ordinarySettled = true;
    return result;
  });
  await TestUtils.waitForTick();
  ok(!ordinarySettled, "the ordinary render remains queued");
  is(
    automationFixture.state.fastRequests,
    0,
    "the ordinary render cannot use the active fixture override"
  );
  automationFixture.state.releaseHold();
  const exclusiveResult = await exclusive;
  assertAutomationClean(exclusiveResult, "held exclusive fixture render");
  const ordinaryResult = await ordinary;
  ok(
    ordinaryResult.pageError.includes("private") ||
      ordinaryResult.pageError.includes("reserved"),
    "the ordinary render is rejected after fixture policy restoration"
  );
  is(
    automationFixture.state.fastRequests,
    0,
    "the blocked ordinary render never reaches the loopback fixture"
  );
  assertClean("ordinary render queued behind fixture override");
});

add_task(async function test_comparator_override_queue_cancellation() {
  const options = {
    _testAllowedHosts: [automationFixture.origin],
    _testDiagnostics: true,
    timeoutMs: 2000,
  };
  const first = render(`${automationFixture.origin}/slow?delay=250`, options);
  await TestUtils.waitForCondition(
    () => automationFixture.state.active === 1,
    "the exclusive fixture render starts"
  );
  const controller = new AbortController();
  const queued = render(
    `${automationFixture.origin}/fast`,
    options,
    controller.signal
  );
  controller.abort();
  await Assert.rejects(
    queued,
    /aborted/,
    "cancellation removes an exclusive fixture waiter"
  );
  const result = await first;
  assertAutomationClean(result, "fixture render after queued cancellation");
  const followup = await render(`${automationFixture.origin}/fast`, options);
  is(followup.pageError, null, "the override lock remains usable");
  assertAutomationClean(followup, "follow-up after queued cancellation");
  assertClean("fixture override queue cancellation");
});

add_task(async function test_comparator_override_restores_after_timeout() {
  const result = await render(`${automationFixture.origin}/slow?delay=250`, {
    _testAllowedHosts: [automationFixture.origin],
    _testDiagnostics: true,
    timeoutMs: 50,
  });
  ok(result.pageError.includes("timeout"), "fixture timeout is reported");
  assertAutomationClean(result, "timed out fixture render");
  await TestUtils.waitForCondition(
    () => automationFixture.state.active === 0,
    "the timed out fixture response finishes"
  );
  const followup = await render(`${automationFixture.origin}/fast`);
  ok(
    followup.pageError.includes("private") ||
      followup.pageError.includes("reserved"),
    "a normal follow-up render cannot inherit the fixture override"
  );
  assertClean("fixture timeout restoration");
});

add_task(async function test_comparator_override_restores_after_cancel() {
  const controller = new AbortController();
  const pending = render(
    `${automationFixture.origin}/slow?delay=5000`,
    {
      _testAllowedHosts: [automationFixture.origin],
      _testDiagnostics: true,
      timeoutMs: 6000,
    },
    controller.signal
  );
  await TestUtils.waitForCondition(
    () => automationFixture.state.active === 1,
    "the cancellable fixture request starts"
  );
  const cancelledAt = ChromeUtils.now();
  controller.abort();
  const result = await pending;
  Assert.less(
    ChromeUtils.now() - cancelledAt,
    COMPARATOR_CANCEL_BOUND_MS,
    "fixture cancellation completes before the natural response"
  );
  ok(result._testError.includes("aborted"), "fixture cancellation is reported");
  assertAutomationClean(result, "cancelled fixture render");
  automationFixture.state.releaseSlowRequests();
  await TestUtils.waitForCondition(
    () => automationFixture.state.active === 0,
    "the cancelled fixture response finishes"
  );
  const followup = await render(`${automationFixture.origin}/fast`);
  ok(
    followup.pageError.includes("private") ||
      followup.pageError.includes("reserved"),
    "cancellation does not leak the fixture override"
  );
  assertClean("fixture cancellation restoration");
});
