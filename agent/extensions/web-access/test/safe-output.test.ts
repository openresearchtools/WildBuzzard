/* SPDX-License-Identifier: AGPL-3.0-or-later */

import assert from "node:assert/strict";
import test from "node:test";
import {
  hasSensitiveUrlCredentials,
  redactSensitiveText,
  sanitizeAgentOutput,
} from "../safe-output.ts";

test("agent output removes service secrets, headers, cookies, and local paths", () => {
  const value = sanitizeAgentOutput({
    token: "service-capability",
    headers: { Authorization: "Bearer nested-secret" },
    content:
      "Authorization: Bearer exposed\nCookie=session-secret\nX-API-Key: Basic hidden-key\n/home/user/private/file https://name:password@example.test/ https://example.test/?access_token=query-secret",
    path: "docs/README.md",
  });
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(
    serialized,
    /service-capability|nested-secret|exposed|session-secret|hidden-key|query-secret|password|\/home\/user\/private/
  );
  assert.match(serialized, /docs\/README\.md/);
  assert.match(serialized, /\[redacted\]|\[local-path-redacted\]/);
});

test("redaction bounds arbitrary helper errors without hiding source URLs", () => {
  const output = redactSensitiveText(
    "failed at /tmp/wildbuzzard-secret/file for https://example.test/docs " +
      "Bearer abc.def"
  );
  assert.match(output, /https:\/\/example\.test\/docs/);
  assert.doesNotMatch(output, /wildbuzzard-secret|abc\.def/);
});

test("agent output redacts common secret keys and URL credentials", () => {
  const sanitized = sanitizeAgentOutput({
    apiKey: "api-secret",
    client_secret: "client-secret",
    password: "password-secret",
    nested: "https://example.test/?signature=url-secret /root/private/file",
  });
  const serialized = JSON.stringify(sanitized);
  assert.doesNotMatch(
    serialized,
    /api-secret|client-secret|password-secret|url-secret|\/root\/private/
  );
});

test("credential URL detection distinguishes secrets from ordinary URL state", () => {
  for (const value of [
    "https://name:password@example.test/private",
    "https://example.test/download?signature=secret&q=ordinary",
    "https://example.test/#token=secret",
    "https://example.test/path?API_KEY=secret",
    "https://objects.test/file?X-Amz-Credential=value&X-Amz-Signature=value",
  ]) {
    assert.equal(hasSensitiveUrlCredentials(value), true, value);
  }
  for (const value of [
    "https://example.test/search?q=ordinary&page=2",
    "https://example.test/docs#installing",
    "https://example.test/#page=2&section=usage",
  ]) {
    assert.equal(hasSensitiveUrlCredentials(value), false, value);
  }
});
