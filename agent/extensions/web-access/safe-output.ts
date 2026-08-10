/* SPDX-License-Identifier: AGPL-3.0-or-later */

const SENSITIVE_KEY =
  /^(?:access[-_]?token|api[-_]?key|authorization|client[-_]?secret|cookie|cookies|headers?|pass(?:word|key)|proxy-authorization|refresh[-_]?token|secret|service[-_]?token|token)$/i;
const SENSITIVE_URL_PARAMETER =
  /^(?:access[-_]?token|api[-_]?key|apikey|auth|authorization|client[-_]?secret|credential|key|key[-_]?pair[-_]?id|passkey|password|refresh[-_]?token|secret|signature|sig|token|x[-_](?:amz|goog)[-_](?:credential|security[-_]?token|signature))$/i;
const LOCAL_PATH =
  /(^|[\s"'=(:])(?:\/(?:app|etc|home|mnt|opt|private|root|run|tmp|usr|var\/tmp)\/[^\s"'<>)]*|\/Users\/[^\s"'<>)]*|[A-Za-z]:\\[^\s"'<>)]*)/g;

export function isSensitiveKey(value: string): boolean {
  return SENSITIVE_KEY.test(value);
}

export function hasSensitiveUrlCredentials(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return /(?:\/\/[^/\s:@]+:[^@\s/]+@|[?&#](?:access[-_]?token|api[-_]?key|apikey|auth|authorization|client[-_]?secret|credential|key|key[-_]?pair[-_]?id|passkey|password|refresh[-_]?token|secret|signature|sig|token|x[-_](?:amz|goog)[-_](?:credential|security[-_]?token|signature))=)/i.test(
      value
    );
  }
  if (url.username || url.password) {
    return true;
  }
  if (
    [...url.searchParams.keys()].some(key => SENSITIVE_URL_PARAMETER.test(key))
  ) {
    return true;
  }
  const fragment = url.hash.slice(1);
  return (
    (fragment.includes("=") || fragment.includes("&")) &&
    [...new URLSearchParams(fragment).keys()].some(key =>
      SENSITIVE_URL_PARAMETER.test(key)
    )
  );
}

export function sanitizePersistedUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return redactSensitiveText(value, 4_096);
  }
  url.username = "";
  url.password = "";
  for (const key of [...url.searchParams.keys()]) {
    if (SENSITIVE_URL_PARAMETER.test(key)) {
      url.searchParams.delete(key);
    }
  }
  const fragment = url.hash.slice(1);
  if (fragment.includes("=") || fragment.includes("&")) {
    const parameters = new URLSearchParams(fragment);
    for (const key of [...parameters.keys()]) {
      if (SENSITIVE_URL_PARAMETER.test(key)) {
        parameters.delete(key);
      }
    }
    url.hash = parameters.toString();
  }
  return url.toString();
}

export function redactSensitiveText(value: string, maximum = 30_000): string {
  return value
    .replace(/\b(https?:\/\/)[^/\s:@]+:[^@\s/]+@/gi, "$1[redacted]@")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(
      /\b(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key)\s*[:=]\s*[^,;\r\n]+/gi,
      match => `${match.split(/[:=]/, 1)[0]}: [redacted]`
    )
    .replace(
      /([?&#](?:access[-_]?token|api[-_]?key|auth(?:orization)?|client[-_]?secret|key|pass(?:word|key)|refresh[-_]?token|secret|signature|sig|token)=)[^&#\s]+/gi,
      "$1[redacted]"
    )
    .replace(LOCAL_PATH, "$1[local-path-redacted]")
    .slice(0, maximum);
}

export function sanitizeAgentOutput(value: unknown, depth = 0): unknown {
  if (depth > 12) {
    return "[truncated]";
  }
  if (typeof value === "string") {
    return redactSensitiveText(value);
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 1_000)
      .map(item => sanitizeAgentOutput(item, depth + 1));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 1_000)
        .map(([key, item]) => [
          key.slice(0, 128),
          isSensitiveKey(key)
            ? "[redacted]"
            : sanitizeAgentOutput(item, depth + 1),
        ])
    );
  }
  return null;
}
