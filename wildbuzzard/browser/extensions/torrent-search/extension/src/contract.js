"use strict";

(function defineContract(root) {
  const SCHEMA_VERSION = 1;
  const QUERY_MAX_LENGTH = 256;
  const RESULT_LIMIT_DEFAULT = 25;
  const RESULT_LIMIT_MAX = 50;
  const SOURCE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

  function normalizeQuery(value) {
    const query = String(value ?? "").trim();
    if (!query || Array.from(query).length > QUERY_MAX_LENGTH || /\p{Cc}/u.test(query)) {
      throw new RangeError("invalid-query");
    }
    return query;
  }

  function normalizeLimit(value) {
    const limit = Number(value ?? RESULT_LIMIT_DEFAULT);
    if (!Number.isInteger(limit) || limit < 1 || limit > RESULT_LIMIT_MAX) {
      throw new RangeError("invalid-limit");
    }
    return limit;
  }

  function normalizeSource(value) {
    if (value === undefined || value === null || value === "") {
      return undefined;
    }
    const source = String(value);
    if (!SOURCE_PATTERN.test(source)) {
      throw new RangeError("invalid-source");
    }
    return source;
  }

  function createOperationId() {
    return crypto.randomUUID();
  }

  function normalizeImportResponse(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("torrentSearch.CLI_PROTOCOL_ERROR");
    }
    const allowed = new Set(["schemaVersion", "accepted", "downloadId"]);
    if (
      !Object.hasOwn(value, "schemaVersion") ||
      !Object.hasOwn(value, "accepted") ||
      Object.keys(value).some(key => !allowed.has(key)) ||
      value.schemaVersion !== SCHEMA_VERSION ||
      typeof value.accepted !== "boolean"
    ) {
      throw new TypeError("torrentSearch.CLI_PROTOCOL_ERROR");
    }
    const hasDownloadId = Object.hasOwn(value, "downloadId");
    if (
      hasDownloadId &&
      (value.accepted !== true ||
        typeof value.downloadId !== "string" ||
        Array.from(value.downloadId).length > 256 ||
        /\p{Cc}/u.test(value.downloadId))
    ) {
      throw new TypeError("torrentSearch.CLI_PROTOCOL_ERROR");
    }
    return {
      accepted: value.accepted,
      ...(hasDownloadId ? { downloadId: value.downloadId } : {}),
    };
  }

  function formatBytes(value) {
    if (!Number.isSafeInteger(value) || value < 0) {
      return "";
    }
    const units = ["B", "KiB", "MiB", "GiB", "TiB"];
    let size = value;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
      size /= 1024;
      unit += 1;
    }
    const precision = unit === 0 || size >= 10 ? 0 : 1;
    return `${size.toFixed(precision)} ${units[unit]}`;
  }

  function errorCode(error) {
    const match = String(error?.message ?? error).match(/torrentSearch\.([A-Z_]+)/u);
    return match?.[1] ?? "UNKNOWN";
  }

  root.TorrentSearchContract = Object.freeze({
    SCHEMA_VERSION,
    QUERY_MAX_LENGTH,
    RESULT_LIMIT_DEFAULT,
    RESULT_LIMIT_MAX,
    createOperationId,
    errorCode,
    formatBytes,
    normalizeImportResponse,
    normalizeLimit,
    normalizeQuery,
    normalizeSource,
  });
})(globalThis);
