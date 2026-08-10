/* SPDX-License-Identifier: AGPL-3.0-or-later */

import assert from "node:assert/strict";
import test from "node:test";
import { SessionGeneration } from "../session-generation.ts";

test("session generation rejects stale async web operations", () => {
  const sessions = new SessionGeneration();
  sessions.select("session-a");
  const operation = sessions.begin("session-a");
  operation.assertCurrent();
  sessions.select("session-b");
  assert.throws(operation.assertCurrent, /changed while/);
  assert.throws(() => sessions.begin("session-a"), /changed before/);
  sessions.begin("session-b").assertCurrent();
});

test("session generation rejects malformed identities", () => {
  const sessions = new SessionGeneration();
  assert.throws(() => sessions.select(""), /identity is invalid/);
  assert.throws(() => sessions.select("bad\0session"), /identity is invalid/);
});
