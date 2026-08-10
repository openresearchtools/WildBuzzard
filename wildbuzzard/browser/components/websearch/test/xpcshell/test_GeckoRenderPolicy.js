/* SPDX-License-Identifier: AGPL-3.0-or-later */

"use strict";

const { GeckoRenderPolicy } = ChromeUtils.importESModule(
  "chrome://remote/content/wildbuzzard/BrowserControl.sys.mjs"
);

add_task(function test_private_and_reserved_address_policy() {
  for (const address of [
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.0.1",
    "198.18.0.1",
    "192.0.2.1",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "64:ff9b::7f00:1",
    "100::1",
    "2001:db8::1",
    "2002:7f00:1::",
    "fc00::1",
    "fe80::1",
    "ff02::1",
  ]) {
    Assert.equal(
      GeckoRenderPolicy.isForbiddenIPAddress(address),
      true,
      `${address} is forbidden`
    );
  }
  for (const address of [
    "1.1.1.1",
    "8.8.8.8",
    "2001:4860:4860::8888",
    "2606:4700:4700::1111",
  ]) {
    Assert.equal(
      GeckoRenderPolicy.isForbiddenIPAddress(address),
      false,
      `${address} is public`
    );
  }
  Assert.equal(
    GeckoRenderPolicy.isForbiddenIPAddress("example.com"),
    null,
    "hostnames require DNS validation"
  );
});

add_task(function test_hostname_and_block_domain_policy() {
  for (const host of [
    "localhost",
    "api.localhost",
    "metadata.google.internal",
    "metadata.goog",
    "instance-data.ec2.internal",
  ]) {
    Assert.ok(GeckoRenderPolicy.isMetadataHostname(host), `${host} is blocked`);
  }
  Assert.ok(
    GeckoRenderPolicy.hostMatchesBlockDomain("example.com", "example.com")
  );
  Assert.ok(
    GeckoRenderPolicy.hostMatchesBlockDomain("www.example.com", "example.com")
  );
  Assert.ok(
    !GeckoRenderPolicy.hostMatchesBlockDomain(
      "example.com.attacker.test",
      "example.com"
    )
  );
  Assert.equal(
    GeckoRenderPolicy.normalizeBlockDomain("*.EXAMPLE.com"),
    "example.com"
  );
  Assert.equal(
    GeckoRenderPolicy.normalizeBlockDomain("example.com."),
    "example.com"
  );
});

add_task(function test_url_and_header_validation() {
  for (const url of [
    "file:///etc/passwd",
    "data:text/plain,test",
    "ftp://example.com/",
    "https://user:secret@example.com/",
  ]) {
    Assert.throws(
      () => GeckoRenderPolicy.validateGeckoRenderArgs({ url }),
      /gecko_render/,
      `${url} is rejected`
    );
  }
  const options = GeckoRenderPolicy.validateGeckoRenderArgs({
    url: "https://example.com/",
    headers: {
      Accept: "text/html",
      "X-Requested-With": "WildBuzzard",
    },
    blockDomains: ["*.blocked.example"],
    waitMs: 100,
    timeoutMs: 1000,
    waitForSelector: "main",
    javascript: false,
    allowSubdomains: true,
    maxBytes: 1024,
    maxRedirects: 2,
    allowedOrigins: ["https://example.com"],
  });
  Assert.equal(options.headers.get("accept"), "text/html");
  Assert.ok(options.blockDomains.has("blocked.example"));
  Assert.equal(options.javascript, false);
  Assert.equal(options.allowSubdomains, true);
  Assert.equal(options.maxBytes, 1024);
  Assert.equal(options.maxRedirects, 2);
  Assert.ok(options.allowedOrigins.has("https://example.com"));
  for (const name of [
    "Host",
    "Connection",
    "Cookie",
    "Authorization",
    "Proxy-Authorization",
    "Referer",
  ]) {
    Assert.throws(
      () =>
        GeckoRenderPolicy.validateRenderHeaders({
          [name]: "secret",
        }),
      /not allowed/,
      `${name} is rejected`
    );
  }
  Assert.throws(
    () =>
      GeckoRenderPolicy.validateRenderHeaders({
        Accept: "text/html\r\nX-Injected: yes",
      }),
    /invalid value/,
    "header injection is rejected"
  );
  for (const args of [
    { timeoutMs: "1000" },
    { waitMs: "100" },
    { timeoutMs: true },
  ]) {
    Assert.throws(
      () =>
        GeckoRenderPolicy.validateGeckoRenderArgs({
          url: "https://example.com/",
          ...args,
        }),
      /must be an integer/,
      "numeric render options require JSON numbers"
    );
  }
  Assert.throws(
    () =>
      GeckoRenderPolicy.validateGeckoRenderArgs({
        url: "https://example.com/",
        javascript: "false",
      }),
    /must be a boolean/,
    "JavaScript mode requires a JSON boolean"
  );
  for (const maxBytes of [0, 32 * 1024 * 1024 + 1, "1024"]) {
    Assert.throws(
      () =>
        GeckoRenderPolicy.validateGeckoRenderArgs({
          url: "https://example.com/",
          maxBytes,
        }),
      /must be an integer/,
      "response byte budgets are bounded integers"
    );
  }
  for (const maxRedirects of [-1, 11, "2"]) {
    Assert.throws(
      () =>
        GeckoRenderPolicy.validateGeckoRenderArgs({
          url: "https://example.com/",
          maxRedirects,
        }),
      /must be an integer/,
      "redirect budgets are bounded integers"
    );
  }
  Assert.throws(
    () =>
      GeckoRenderPolicy.validateGeckoRenderArgs({
        url: "https://example.com/",
        allowSubdomains: "true",
      }),
    /must be a boolean/,
    "subdomain scope requires a JSON boolean"
  );
  Assert.throws(
    () =>
      GeckoRenderPolicy.validateGeckoRenderArgs({
        url: "https://example.com/",
        allowedOrigins: ["https://example.com/path"],
      }),
    /must be origins/,
    "allowed origins cannot include a path"
  );
  Assert.throws(
    () =>
      GeckoRenderPolicy.validateGeckoRenderArgs({
        url: "https://example.com/",
        allowedOrigins: null,
      }),
    /allowedOrigins/,
    "a null origin scope cannot disable enforcement"
  );
});

add_task(function test_comparator_options_are_narrow_and_automation_only() {
  const valid = {
    url: "http://127.0.0.1:32123/page",
    _testAllowedHosts: [
      "http://127.0.0.1:32123",
      "http://[::1]:32124",
      "http://localhost:32125",
    ],
    _testDiagnostics: true,
  };
  Assert.deepEqual(
    [...GeckoRenderPolicy.validateGeckoRenderTestArgs(valid, true)],
    valid._testAllowedHosts,
    "only canonical loopback fixture origins are accepted"
  );
  Assert.throws(
    () => GeckoRenderPolicy.validateGeckoRenderTestArgs(valid, false),
    /automation-only/,
    "shipping calls cannot enable the comparator override"
  );
  for (const value of [
    "http://127.0.0.1",
    "http://127.0.0.1:0",
    "http://127.0.0.1:32123/",
    "https://127.0.0.1:32123",
    "http://127.0.0.2:32123",
    "http://0.0.0.0:32123",
    "http://[::ffff:127.0.0.1]:32123",
    "http://localhost.:32123",
    "http://user@localhost:32123",
    "http://fixture.test:32123",
  ]) {
    Assert.throws(
      () =>
        GeckoRenderPolicy.validateGeckoRenderTestArgs(
          {
            url: "http://127.0.0.1:32123/page",
            _testAllowedHosts: [value],
            _testDiagnostics: true,
          },
          true
        ),
      /gecko_render/,
      `${value} cannot widen the fixture policy`
    );
  }
  for (const options of [
    { _testAllowedHosts: [], _testDiagnostics: true },
    { _testAllowedHosts: [123], _testDiagnostics: true },
    {
      _testAllowedHosts: Array(5).fill("http://127.0.0.1:32123"),
      _testDiagnostics: true,
    },
    {
      _testAllowedHosts: ["http://127.0.0.1:32123"],
      _testDiagnostics: false,
    },
    {
      _testAllowedHosts: ["http://127.0.0.1:32123"],
    },
    { _testDiagnostics: true },
  ]) {
    Assert.throws(
      () =>
        GeckoRenderPolicy.validateGeckoRenderTestArgs(
          { url: "http://127.0.0.1:32123/page", ...options },
          true
        ),
      /gecko_render/,
      "partial and malformed test options are rejected"
    );
  }
  Assert.throws(
    () =>
      GeckoRenderPolicy.validateGeckoRenderTestArgs(
        {
          url: "http://localhost:32124/page",
          _testAllowedHosts: ["http://127.0.0.1:32123"],
          _testDiagnostics: true,
        },
        true
      ),
    /outside the fixture origins/,
    "the navigation must use one of the exact fixture origins"
  );
});
