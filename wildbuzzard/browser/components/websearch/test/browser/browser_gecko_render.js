/* SPDX-License-Identifier: AGPL-3.0-or-later */

"use strict";

/* eslint-disable @microsoft/sdl/no-insecure-url */

const { BrowserControl } = ChromeUtils.importESModule(
  "chrome://remote/content/wildbuzzard/BrowserControl.sys.mjs"
);

const FIXTURE_PATH =
  "/browser/wildbuzzard/browser/components/websearch/test/browser/file_gecko_render.sjs";
const FIXTURE = `https://example.com${FIXTURE_PATH}`;
const OTHER_FIXTURE = `https://example.org${FIXTURE_PATH}`;

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
  ok(result.content.includes("Static heading"), "static DOM is serialized");
  ok(
    result.content.includes("JavaScript mutated DOM"),
    "JavaScript-mutated DOM is serialized"
  );
  assertClean("successful HTML render");
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
