/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { StoredSearch } from "./storage.ts";

const MAX_DATABASE_BYTES = 256 * 1024 * 1024;
const MAX_RESPONSES = 500;

let database: DatabaseSync | undefined;
let openedPath: string | undefined;

function configuredPath(): string {
  if (process.env.WILDBUZZARD_WEB_SEARCH_DATABASE) {
    return process.env.WILDBUZZARD_WEB_SEARCH_DATABASE;
  }
  const profile =
    process.env.PI_CODING_AGENT_DIR ||
    join(homedir(), ".local", "share", "wildbuzzard", "agent", "profile");
  return join(profile, "web-search.sqlite");
}

function validateExistingDatabase(path: string): void {
  if (!existsSync(path)) {
    return;
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("WildBuzzard web-search database path is unsafe");
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error("WildBuzzard web-search database is not private");
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error("WildBuzzard web-search database has another owner");
  }
}

function schema(db: DatabaseSync): void {
  const version = Number(
    (db.prepare("PRAGMA user_version").get() as { user_version?: number })
      .user_version ?? 0
  );
  if (version !== 0 && version !== 1) {
    throw new Error(`Unsupported WildBuzzard web-search database version ${version}`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS responses (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      last_accessed INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      storage_policy TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS responses_expiry ON responses(expires_at);
    CREATE INDEX IF NOT EXISTS responses_lru ON responses(last_accessed);
    CREATE TABLE IF NOT EXISTS queries (
      response_id TEXT NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      query TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY(response_id, ordinal)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS documents (
      response_id TEXT NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      source_url TEXT NOT NULL,
      final_url TEXT NOT NULL,
      title TEXT NOT NULL,
      preview TEXT NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      status INTEGER NOT NULL,
      error TEXT,
      provenance TEXT NOT NULL,
      PRIMARY KEY(response_id, ordinal)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS documents_source ON documents(source_url);
    CREATE INDEX IF NOT EXISTS documents_hash ON documents(content_hash);
    CREATE TABLE IF NOT EXISTS passages (
      response_id TEXT NOT NULL,
      document_ordinal INTEGER NOT NULL,
      ordinal INTEGER NOT NULL,
      start_offset INTEGER NOT NULL,
      end_offset INTEGER NOT NULL,
      text TEXT NOT NULL,
      PRIMARY KEY(response_id, document_ordinal, ordinal),
      FOREIGN KEY(response_id, document_ordinal)
        REFERENCES documents(response_id, ordinal) ON DELETE CASCADE
    ) STRICT;
    CREATE TABLE IF NOT EXISTS crawl_membership (
      response_id TEXT NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      url TEXT NOT NULL,
      PRIMARY KEY(response_id, ordinal)
    ) STRICT;
    PRAGMA user_version = 1;
  `);
}

function db(): DatabaseSync {
  const path = configuredPath();
  if (database && openedPath === path) {
    return database;
  }
  database?.close();
  validateExistingDatabase(path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  database = new DatabaseSync(path);
  openedPath = path;
  chmodSync(path, 0o600);
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = NORMAL;
    PRAGMA temp_store = MEMORY;
    PRAGMA busy_timeout = 3000;
  `);
  schema(database);
  return database;
}

function passageRows(content: string): Array<{
  ordinal: number;
  start: number;
  end: number;
  text: string;
}> {
  const rows = [];
  const pattern = /\S(?:[\s\S]*?\S)?(?=\n{2,}|$)/g;
  for (const match of content.matchAll(pattern)) {
    if (rows.length === 1_000 || match.index === undefined) {
      break;
    }
    const text = match[0].slice(0, 4_000);
    rows.push({
      ordinal: rows.length,
      start: match.index,
      end: match.index + text.length,
      text,
    });
  }
  return rows;
}

function trimDatabase(connection: DatabaseSync, now: number): void {
  connection.prepare("DELETE FROM responses WHERE expires_at <= ?").run(now);
  const count = Number(
    (connection.prepare("SELECT COUNT(*) AS count FROM responses").get() as {
      count: number | bigint;
    }).count
  );
  if (count > MAX_RESPONSES) {
    connection
      .prepare(
        "DELETE FROM responses WHERE id IN (SELECT id FROM responses ORDER BY last_accessed ASC LIMIT ?)"
      )
      .run(count - MAX_RESPONSES);
  }
  let logicalBytes = Number(
    (
      connection
        .prepare(
          "SELECT COALESCE(SUM(length(payload_json)), 0) AS bytes FROM responses"
        )
        .get() as { bytes: number | bigint }
    ).bytes
  );
  while (logicalBytes > MAX_DATABASE_BYTES) {
    connection
      .prepare(
        "DELETE FROM responses WHERE id = (SELECT id FROM responses ORDER BY last_accessed ASC LIMIT 1)"
      )
      .run();
    logicalBytes = Number(
      (
        connection
          .prepare(
            "SELECT COALESCE(SUM(length(payload_json)), 0) AS bytes FROM responses"
          )
          .get() as { bytes: number | bigint }
      ).bytes
    );
  }
}

export function persistStoredSearch(value: StoredSearch): void {
  const connection = db();
  const payload = JSON.stringify(value);
  connection.exec("BEGIN IMMEDIATE");
  try {
    connection
      .prepare(
        `INSERT OR REPLACE INTO responses
          (id, type, created_at, expires_at, last_accessed, payload_json, storage_policy)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        value.id,
        value.type,
        value.createdAt,
        value.expiresAt,
        value.createdAt,
        payload,
        "ttl-1h"
      );
    const insertQuery = connection.prepare(
      "INSERT INTO queries(response_id, ordinal, query, payload_json) VALUES (?, ?, ?, ?)"
    );
    value.queries?.forEach((query, ordinal) =>
      insertQuery.run(value.id, ordinal, query.query, JSON.stringify(query))
    );
    const insertDocument = connection.prepare(
      `INSERT INTO documents
        (response_id, ordinal, source_url, final_url, title, preview, content,
         content_hash, mime_type, status, error, provenance)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertPassage = connection.prepare(
      `INSERT INTO passages
        (response_id, document_ordinal, ordinal, start_offset, end_offset, text)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const insertMembership = connection.prepare(
      "INSERT INTO crawl_membership(response_id, ordinal, url) VALUES (?, ?, ?)"
    );
    value.documents?.forEach((document, ordinal) => {
      insertDocument.run(
        value.id,
        ordinal,
        document.url,
        document.finalUrl,
        document.title,
        document.content.slice(0, 4_000),
        document.content,
        createHash("sha256").update(document.content).digest("hex"),
        document.mimeType,
        document.status,
        document.error,
        document.provenance
      );
      for (const passage of passageRows(document.content)) {
        insertPassage.run(
          value.id,
          ordinal,
          passage.ordinal,
          passage.start,
          passage.end,
          passage.text
        );
      }
      if (value.type === "crawl") {
        insertMembership.run(value.id, ordinal, document.finalUrl);
      }
    });
    trimDatabase(connection, Date.now());
    connection.exec("COMMIT");
  } catch (error) {
    connection.exec("ROLLBACK");
    throw error;
  }
}

export function loadStoredSearch(
  id: string,
  now = Date.now()
): StoredSearch | null {
  const connection = db();
  trimDatabase(connection, now);
  const row = connection
    .prepare(
      "SELECT payload_json AS payload, expires_at AS expiresAt FROM responses WHERE id = ?"
    )
    .get(id) as { payload: string; expiresAt: number } | undefined;
  if (!row || Number(row.expiresAt) <= now) {
    return null;
  }
  connection
    .prepare("UPDATE responses SET last_accessed = ? WHERE id = ?")
    .run(now, id);
  return JSON.parse(row.payload) as StoredSearch;
}

export function deleteExpiredStoredSearches(now = Date.now()): void {
  trimDatabase(db(), now);
}

export function clearStoredSearchDatabase(): void {
  db().prepare("DELETE FROM responses").run();
}

export function closeStoredSearchDatabase(): void {
  database?.close();
  database = undefined;
  openedPath = undefined;
}
