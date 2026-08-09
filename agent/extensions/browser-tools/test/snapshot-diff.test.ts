/* SPDX-License-Identifier: AGPL-3.0-or-later */

import assert from "node:assert/strict";
import test from "node:test";
import { diffSnapshotObservations, diffSnapshots } from "../snapshot-diff.ts";

test("unchanged snapshots are empty", () => {
  assert.deepEqual(diffSnapshots('- button "Save"', '- button "Save"'), {
    text: "",
    added: 0,
    removed: 0,
    changed: false,
  });
});

test("line changes retain BrowserOS-style context", () => {
  const result = diffSnapshots(
    [
      '- document "Form"',
      '  - textbox "Name" [ref=e1]',
      '  - button "Save" [ref=e2]',
    ].join("\n"),
    [
      '- document "Form"',
      '  - textbox "Name" [ref=e1]: "Ada"',
      '  - button "Save" [ref=e2]',
    ].join("\n")
  );
  assert.equal(result.changed, true);
  assert.equal(result.added, 1);
  assert.equal(result.removed, 1);
  assert.match(result.text, /textbox "Name".*"Ada"/);
});

test("duplicate lines are matched by position instead of collapsed as a set", () => {
  const result = diffSnapshots(
    [
      "- list",
      '  - listitem "same"',
      '  - listitem "same"',
      '  - listitem "tail"',
    ].join("\n"),
    ["- list", '  - listitem "same"', '  - listitem "tail"'].join("\n")
  );
  assert.equal(result.changed, true);
  assert.equal(result.added, 0);
  assert.equal(result.removed, 1);
  assert.match(result.text, /-   listitem "same"/);
});

test("oversized changed regions skip the quadratic line comparison", () => {
  const before = Array.from(
    { length: 2_001 },
    (_, index) => `- old ${index}`
  ).join("\n");
  const after = Array.from(
    { length: 2_001 },
    (_, index) => `- new ${index}`
  ).join("\n");
  const result = diffSnapshots(before, after);
  assert.equal(result.changed, true);
  assert.equal(result.lineDiffSkipped, true);
  assert.equal(result.added, 2_001);
  assert.equal(result.removed, 2_001);
  assert.match(result.text, /Line-level diff skipped/);
});

test("navigation returns the complete new snapshot", () => {
  const result = diffSnapshotObservations(
    { text: '- link "Old"', url: "https://example.com/old" },
    { text: '- heading "New"', url: "https://example.com/new" }
  );
  assert.equal(result.urlChanged, true);
  assert.equal(result.text, '- heading "New"');
});
