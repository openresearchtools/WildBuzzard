/* SPDX-License-Identifier: AGPL-3.0-or-later */

import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captionLanguageOrder,
  extractYouTubeCaptions,
  parseJson3Captions,
  parseVttCaptions,
  parseYouTubeUrl,
} from "../youtube.ts";

test("YouTube URLs accept public video forms and reject unsafe variants", () => {
  for (const url of [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ?t=3",
    "https://m.youtube.com/shorts/dQw4w9WgXcQ",
    "https://youtube.com/live/dQw4w9WgXcQ",
  ]) {
    assert.equal(parseYouTubeUrl(url)?.videoId, "dQw4w9WgXcQ");
  }
  for (const url of [
    "http://youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtube.example/watch?v=dQw4w9WgXcQ",
    "https://user:secret@youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtube.com/playlist?list=dQw4w9WgXcQ",
    "https://youtube.com/watch?v=../../passwd",
  ]) {
    assert.equal(parseYouTubeUrl(url), null);
  }
});

test("JSON3 captions preserve timestamps and collapse rolling overlap", () => {
  const cues = parseJson3Captions(
    JSON.stringify({
      events: [
        { tStartMs: 0, dDurationMs: 1_500, segs: [{ utf8: "Hello" }] },
        { tStartMs: 900, dDurationMs: 1_500, segs: [{ utf8: "Hello world" }] },
        { tStartMs: 3_000, dDurationMs: 500, segs: [{ utf8: "&lt;done&gt;" }] },
        { tStartMs: "bad", segs: [{ utf8: "ignored" }] },
      ],
    })
  );
  assert.deepEqual(cues, [
    { startMs: 0, endMs: 2_400, text: "Hello world" },
    { startMs: 3_000, endMs: 3_500, text: "<done>" },
  ]);
});

test("VTT captions parse stable hour timestamps and deduplicate cues", () => {
  const cues = parseVttCaptions(`WEBVTT

00:00:01.250 --> 00:00:02.500 align:start
First line

1
01:02:03.004 --> 01:02:05.006
Second <b>line</b>

01:02:04.000 --> 01:02:06.000
Second line
`);
  assert.deepEqual(cues, [
    { startMs: 1_250, endMs: 2_500, text: "First line" },
    { startMs: 3_723_004, endMs: 3_726_000, text: "Second line" },
  ]);
});

test("caption language order prefers exact locale, base, then fallbacks", () => {
  const previous = process.env.WILDBUZZARD_CAPTION_FALLBACK_LANGUAGES;
  process.env.WILDBUZZARD_CAPTION_FALLBACK_LANGUAGES = "fr,en,invalid!";
  try {
    assert.deepEqual(captionLanguageOrder(["pt-BR", "de"]), [
      "pt-BR",
      "pt",
      "de",
      "fr",
      "en",
    ]);
  } finally {
    if (previous === undefined) {
      delete process.env.WILDBUZZARD_CAPTION_FALLBACK_LANGUAGES;
    } else {
      process.env.WILDBUZZARD_CAPTION_FALLBACK_LANGUAGES = previous;
    }
  }
});

test("caption helper receives a sanitized environment and no cookie options", async () => {
  const directory = mkdtempSync(join(tmpdir(), "wildbuzzard-youtube-test-"));
  const helper = join(directory, "yt-dlp");
  writeFileSync(
    helper,
    `#!/bin/sh
set -eu
if [ "\${HOME+x}" = x ]; then
  exit 91
fi
case " $* " in
  *" --cookies "*|*" --cookies-from-browser "*) exit 92 ;;
esac
printf '%s' '{"id":"dQw4w9WgXcQ","title":"Fixture","channel":"Channel","duration":4,"subtitles":{"en":{}}}' > "$TMPDIR/dQw4w9WgXcQ.info.json"
printf '%s' '{"events":[{"tStartMs":1000,"dDurationMs":500,"segs":[{"utf8":"Fixture caption"}]}]}' > "$TMPDIR/dQw4w9WgXcQ.en.json3"
`,
    { mode: 0o700 }
  );
  chmodSync(helper, 0o700);
  const previousHelper = process.env.WILDBUZZARD_YTDLP;
  const previousNode = process.env.WILDBUZZARD_BUNDLED_NODE;
  process.env.WILDBUZZARD_YTDLP = helper;
  process.env.WILDBUZZARD_BUNDLED_NODE = process.execPath;
  try {
    const result = await extractYouTubeCaptions(
      "https://youtu.be/dQw4w9WgXcQ",
      undefined,
      ["en"]
    );
    assert.equal(result.error, null);
    assert.equal(result.captionKind, "manual");
    assert.match(result.content, /\[00:00:01\] Fixture caption/);
  } finally {
    if (previousHelper === undefined) delete process.env.WILDBUZZARD_YTDLP;
    else process.env.WILDBUZZARD_YTDLP = previousHelper;
    if (previousNode === undefined) delete process.env.WILDBUZZARD_BUNDLED_NODE;
    else process.env.WILDBUZZARD_BUNDLED_NODE = previousNode;
    rmSync(directory, { recursive: true });
  }
});
