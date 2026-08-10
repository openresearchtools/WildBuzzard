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
const COMPARATOR_CANCEL_BOUND_MS = 3000;
let automationFixture;

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

add_setup(function setup_renderer() {
  const wasStarted = BrowserControl.started;
  BrowserControl.start();
  BrowserControl.setGeckoRenderTestAllowedHosts([
    "example.com",
    "example.org",
    "www.example.com",
    "expired.example.com",
  ]);
  BrowserControl.setGeckoRenderTestDNSAnswers({
    "rebind.example.com": ["93.184.216.34"],
  });
  registerCleanupFunction(() => {
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
  automationFixture = {
    origin: `http://127.0.0.1:${server.identity.primaryPort}`,
    server,
    state,
  };
  registerCleanupFunction(
    () =>
      new Promise(resolve => {
        automationFixture.state.releaseHold?.();
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
  assertClean("blocked initial navigations");
});

add_task(async function test_redirect_subresource_and_domain_policy() {
  let target = "http://127.0.0.1/private";
  let result = await render(
    `${FIXTURE}?mode=redirect&target=${encodeURIComponent(target)}`
  );
  ok(result.pageError.includes("ssrf-blocked"), "private redirect is blocked");

  for (const kind of ["iframe", "image", "script", "fetch"]) {
    result = await render(`${FIXTURE}?mode=private-subresource&kind=${kind}`);
    ok(
      result.pageError.includes("ssrf-blocked"),
      `private ${kind} aborts the render`
    );
  }

  for (const kind of ["iframe", "image", "script", "fetch"]) {
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
  BrowserControl.setGeckoRenderTestAllowedHosts([
    "example.org",
    "www.example.com",
    "expired.example.com",
  ]);
  BrowserControl.setGeckoRenderTestDNSAnswers({
    "example.com": ["93.184.216.34"],
  });
  let result;
  try {
    result = await render(`${FIXTURE}?mode=html`);
  } finally {
    BrowserControl.setGeckoRenderTestAllowedHosts([
      "example.com",
      "example.org",
      "www.example.com",
      "expired.example.com",
    ]);
    BrowserControl.setGeckoRenderTestDNSAnswers({
      "rebind.example.com": ["93.184.216.34"],
    });
  }
  ok(result.pageError.includes("ssrf-blocked"), "rebound channel is blocked");
  assertClean("DNS rebinding");
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
