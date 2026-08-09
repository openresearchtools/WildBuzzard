/* SPDX-License-Identifier: AGPL-3.0-or-later */
/*
 * Derived from BrowserOS browser-core snapshot/diff.ts.
 * Copyright (C) BrowserOS contributors.
 */

const BULLET = /^(\s*)- /;
const MAX_LCS_CELLS = 4_000_000;

export interface SnapshotObservation {
  text: string;
  url?: string;
}

export interface SnapshotDiff {
  text: string;
  added: number;
  removed: number;
  changed: boolean;
  lineDiffSkipped?: true;
  urlChanged?: true;
  beforeUrl?: string;
  afterUrl?: string;
}

interface TaggedLine {
  gutter: " " | "-" | "+";
  text: string;
}

export function diffSnapshotObservations(
  before: SnapshotObservation | undefined,
  after: SnapshotObservation,
  contextRadius = 3
): SnapshotDiff {
  if (
    before?.url &&
    after.url &&
    before.url !== "unknown" &&
    after.url !== "unknown" &&
    before.url !== after.url
  ) {
    return {
      text: after.text,
      added: 0,
      removed: 0,
      changed: true,
      urlChanged: true,
      beforeUrl: before.url,
      afterUrl: after.url,
    };
  }
  const diff = diffSnapshots(before?.text ?? "", after.text, contextRadius);
  return after.url ? { ...diff, afterUrl: after.url } : diff;
}

export function diffSnapshots(
  before: string,
  after: string,
  contextRadius = 3
): SnapshotDiff {
  if (before === after) {
    return { text: "", added: 0, removed: 0, changed: false };
  }
  const beforeLines = before === "" ? [] : before.split("\n");
  const afterLines = after === "" ? [] : after.split("\n");
  let start = 0;
  while (
    start < beforeLines.length &&
    start < afterLines.length &&
    beforeLines[start] === afterLines[start]
  ) {
    start++;
  }
  let beforeEnd = beforeLines.length;
  let afterEnd = afterLines.length;
  while (
    beforeEnd > start &&
    afterEnd > start &&
    beforeLines[beforeEnd - 1] === afterLines[afterEnd - 1]
  ) {
    beforeEnd--;
    afterEnd--;
  }
  const removedWindow = beforeEnd - start;
  const addedWindow = afterEnd - start;
  if (
    removedWindow > 0 &&
    addedWindow > 0 &&
    removedWindow + 1 > MAX_LCS_CELLS / (addedWindow + 1)
  ) {
    return {
      text: [
        `Snapshot changed substantially: ${beforeLines.length} lines before, ${afterLines.length} lines after.`,
        `Line-level diff skipped because the changed region exceeds the ${MAX_LCS_CELLS}-cell comparison limit.`,
      ].join("\n"),
      added: addedWindow,
      removed: removedWindow,
      changed: true,
      lineDiffSkipped: true,
    };
  }

  const tagged: TaggedLine[] = beforeLines
    .slice(0, start)
    .map(text => ({ gutter: " ", text }));
  appendDiff(
    tagged,
    beforeLines.slice(start, beforeEnd),
    afterLines.slice(start, afterEnd)
  );
  tagged.push(
    ...beforeLines
      .slice(beforeEnd)
      .map(text => ({ gutter: " " as const, text }))
  );
  const added = tagged.filter(line => line.gutter === "+").length;
  const removed = tagged.filter(line => line.gutter === "-").length;
  return {
    text: `${collapse(tagged, contextRadius)}\n${added} added, ${removed} removed`,
    added,
    removed,
    changed: true,
  };
}

function appendDiff(tagged: TaggedLine[], before: string[], after: string[]) {
  if (!before.length) {
    tagged.push(...after.map(text => ({ gutter: "+" as const, text })));
    return;
  }
  if (!after.length) {
    tagged.push(...before.map(text => ({ gutter: "-" as const, text })));
    return;
  }
  const table = Array.from({ length: before.length + 1 }, () =>
    new Array<number>(after.length + 1).fill(0)
  );
  for (let beforeIndex = before.length - 1; beforeIndex >= 0; beforeIndex--) {
    for (let afterIndex = after.length - 1; afterIndex >= 0; afterIndex--) {
      table[beforeIndex][afterIndex] =
        before[beforeIndex] === after[afterIndex]
          ? table[beforeIndex + 1][afterIndex + 1] + 1
          : Math.max(
              table[beforeIndex + 1][afterIndex],
              table[beforeIndex][afterIndex + 1]
            );
    }
  }
  let beforeIndex = 0;
  let afterIndex = 0;
  while (beforeIndex < before.length && afterIndex < after.length) {
    if (before[beforeIndex] === after[afterIndex]) {
      tagged.push({ gutter: " ", text: before[beforeIndex++] });
      afterIndex++;
    } else if (
      table[beforeIndex + 1][afterIndex] >= table[beforeIndex][afterIndex + 1]
    ) {
      tagged.push({ gutter: "-", text: before[beforeIndex++] });
    } else {
      tagged.push({ gutter: "+", text: after[afterIndex++] });
    }
  }
  while (beforeIndex < before.length) {
    tagged.push({ gutter: "-", text: before[beforeIndex++] });
  }
  while (afterIndex < after.length) {
    tagged.push({ gutter: "+", text: after[afterIndex++] });
  }
}

function collapse(tagged: TaggedLine[], radius: number): string {
  const keep = new Array<boolean>(tagged.length).fill(false);
  for (let index = 0; index < tagged.length; index++) {
    if (tagged[index].gutter === " ") {
      continue;
    }
    for (
      let context = Math.max(0, index - radius);
      context <= Math.min(tagged.length - 1, index + radius);
      context++
    ) {
      keep[context] = true;
    }
  }
  const output: string[] = [];
  let previous = -1;
  for (let index = 0; index < tagged.length; index++) {
    if (!keep[index]) {
      continue;
    }
    if (previous >= 0 && index - previous > 1) {
      output.push("…");
    }
    const line = tagged[index];
    output.push(`${line.gutter} ${line.text.replace(BULLET, "$1")}`);
    previous = index;
  }
  return output.join("\n");
}
