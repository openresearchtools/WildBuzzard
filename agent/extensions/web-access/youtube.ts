/* SPDX-License-Identifier: AGPL-3.0-or-later */

import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { spawn } from "node:child_process";
import type { ExtractedContent } from "./extract.ts";

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_TEMP_BYTES = 20 * 1024 * 1024;
const MAX_TEMP_FILES = 50;
const TIMEOUT_MS = 45_000;
const TEMP_PREFIX = "wildbuzzard-captions-";
const MAX_TRANSCRIPT_CHARS = 1_900_000;

export interface YouTubeLocation {
  videoId: string;
  canonicalUrl: string;
}

export interface CaptionContent extends ExtractedContent {
  provenance: "youtube-captions";
  trust: "untrusted";
  available: boolean;
  channel: string;
  duration: number | null;
  language: string;
  captionKind: "manual" | "automatic" | null;
}

interface CaptionCue {
  startMs: number;
  endMs: number;
  text: string;
}

export function parseYouTubeUrl(raw: string): YouTubeLocation | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    return null;
  }
  const host = url.hostname.toLowerCase();
  let videoId: string | null = null;
  if (host === "youtu.be") {
    videoId = url.pathname.split("/").filter(Boolean)[0] ?? null;
  } else if (
    ["youtube.com", "www.youtube.com", "m.youtube.com"].includes(host)
  ) {
    if (url.pathname === "/watch") {
      videoId = url.searchParams.get("v");
    } else {
      const match = /^\/(?:shorts|live|embed|v)\/([^/]+)$/.exec(url.pathname);
      videoId = match?.[1] ?? null;
    }
  }
  if (!videoId || !VIDEO_ID.test(videoId)) {
    return null;
  }
  return {
    videoId,
    canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
  };
}

function normalizeCaptionText(value: string): string {
  return value
    .replace(/<[^>]*>/g, "")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&nbsp;", " ")
    .replace(/\s+/g, " ")
    .trim();
}

function deduplicateCues(cues: CaptionCue[]): CaptionCue[] {
  const output: CaptionCue[] = [];
  for (const cue of cues.sort((left, right) => left.startMs - right.startMs)) {
    cue.text = normalizeCaptionText(cue.text);
    if (!cue.text) {
      continue;
    }
    const previous = output.at(-1);
    if (!previous) {
      output.push(cue);
    } else if (cue.text === previous.text) {
      previous.endMs = Math.max(previous.endMs, cue.endMs);
    } else if (
      cue.startMs <= previous.endMs &&
      cue.text.startsWith(previous.text)
    ) {
      previous.text = cue.text;
      previous.endMs = Math.max(previous.endMs, cue.endMs);
    } else if (
      cue.startMs <= previous.endMs &&
      previous.text.startsWith(cue.text)
    ) {
      previous.endMs = Math.max(previous.endMs, cue.endMs);
    } else {
      output.push(cue);
    }
  }
  return output;
}

export function parseJson3Captions(raw: string): CaptionCue[] {
  const value = JSON.parse(raw) as { events?: unknown };
  if (!Array.isArray(value.events)) {
    return [];
  }
  const cues: CaptionCue[] = [];
  for (const event of value.events.slice(0, 100_000)) {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      continue;
    }
    const item = event as {
      tStartMs?: unknown;
      dDurationMs?: unknown;
      segs?: unknown;
    };
    if (!Number.isFinite(item.tStartMs) || !Array.isArray(item.segs)) {
      continue;
    }
    const text = item.segs
      .map(segment =>
        segment && typeof segment === "object" && !Array.isArray(segment)
          ? (segment as { utf8?: unknown }).utf8
          : ""
      )
      .filter((segment): segment is string => typeof segment === "string")
      .join("");
    const startMs = Number(item.tStartMs);
    const duration = Number.isFinite(item.dDurationMs)
      ? Math.max(0, Number(item.dDurationMs))
      : 0;
    cues.push({ startMs, endMs: startMs + duration, text });
  }
  return deduplicateCues(cues);
}

function timestampMs(value: string): number | null {
  const match = /^(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})$/.exec(value.trim());
  if (!match) {
    return null;
  }
  return (
    (Number(match[1] ?? 0) * 60 * 60 +
      Number(match[2]) * 60 +
      Number(match[3])) *
      1_000 +
    Number(match[4])
  );
}

export function parseVttCaptions(raw: string): CaptionCue[] {
  const cues: CaptionCue[] = [];
  for (const block of raw.replace(/^\uFEFF/, "").split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter(line => line.trim());
    const timingIndex = lines.findIndex(line => line.includes(" --> "));
    if (timingIndex < 0) {
      continue;
    }
    const [startValue, endValue] = lines[timingIndex].split(" --> ");
    const startMs = timestampMs(startValue);
    const endMs = timestampMs(endValue.split(/\s/, 1)[0]);
    if (startMs === null || endMs === null) {
      continue;
    }
    cues.push({
      startMs,
      endMs,
      text: lines.slice(timingIndex + 1).join(" "),
    });
  }
  return deduplicateCues(cues);
}

function formatTimestamp(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  return [hours, minutes, seconds]
    .map(value => String(value).padStart(2, "0"))
    .join(":");
}

export function captionLanguageOrder(requested: string[] = []): string[] {
  const locale = (process.env.LC_ALL || process.env.LANG || "")
    .split(".", 1)[0]
    .replace("_", "-");
  const exact = requested[0] || locale;
  const fallbacks = (
    process.env.WILDBUZZARD_CAPTION_FALLBACK_LANGUAGES ?? "en"
  ).split(",");
  const values = [
    exact,
    exact.split("-", 1)[0],
    ...requested.slice(1),
    ...fallbacks,
  ];
  return [
    ...new Set(
      values
        .map(value => value.trim())
        .filter(value => /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(value))
    ),
  ];
}

function executable(name: "yt-dlp" | "node", environmentName: string): string {
  const value = process.env[environmentName];
  if (!value || !value.startsWith("/") || basename(value) !== name) {
    throw new Error(`WildBuzzard's bundled ${name} runtime is unavailable`);
  }
  const stat = statSync(value);
  if (!stat.isFile() || (stat.mode & 0o111) === 0) {
    throw new Error(`WildBuzzard's bundled ${name} runtime is unavailable`);
  }
  return realpathSync(value);
}

function runYtDlp(
  binary: string,
  node: string,
  args: string[],
  directory: string,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binary, args, {
      cwd: directory,
      detached: true,
      env: {
        PATH: `${dirname(binary)}:${dirname(node)}`,
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        TMPDIR: directory,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stderr: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    let closed = false;
    let pendingError: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const terminate = () => {
      if (!child.pid) {
        return;
      }
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
      killTimer = setTimeout(() => {
        if (!closed) {
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {}
        }
      }, 1_000);
      killTimer.unref();
    };
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      clearInterval(tempMonitor);
      signal?.removeEventListener("abort", abort);
      error ? reject(error) : resolvePromise();
    };
    const abort = () => {
      pendingError ??= new Error("Caption extraction was cancelled");
      terminate();
    };
    const collect = (chunk: Buffer, keep: boolean) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        pendingError ??= new Error("Caption helper produced too much output");
        terminate();
      } else if (keep) {
        stderr.push(chunk);
      }
    };
    const timeout = setTimeout(() => {
      pendingError ??= new Error("Caption extraction timed out");
      terminate();
    }, TIMEOUT_MS);
    const tempMonitor = setInterval(() => {
      try {
        temporaryFiles(directory);
      } catch {
        pendingError ??= new Error(
          "Caption helper exceeded temporary-file limits"
        );
        terminate();
      }
    }, 100);
    tempMonitor.unref();
    child.stdout.on("data", chunk => collect(chunk, false));
    child.stderr.on("data", chunk => collect(chunk, true));
    child.on("error", () => {
      closed = true;
      finish(new Error("Caption helper could not be started"));
    });
    child.on("close", code => {
      closed = true;
      if (killTimer) {
        clearTimeout(killTimer);
      }
      if (pendingError) {
        finish(pendingError);
      } else if (code === 0) {
        finish();
      } else {
        const detail = Buffer.concat(stderr)
          .toString("utf8")
          .replace(/https?:\/\/\S+/g, "[URL]")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 500);
        finish(
          new Error(detail || `Caption helper exited with status ${code}`)
        );
      }
    });
    if (signal?.aborted) {
      abort();
    } else {
      signal?.addEventListener("abort", abort, { once: true });
    }
  });
}

function safeRemove(directory: string): void {
  const root = `${realpathSync(tmpdir())}${sep}`;
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Refusing unsafe caption cleanup");
  }
  const target = realpathSync(directory);
  if (!target.startsWith(root) || !basename(target).startsWith(TEMP_PREFIX)) {
    throw new Error("Refusing unsafe caption cleanup");
  }
  rmSync(target, { recursive: true });
}

function temporaryFiles(directory: string): string[] {
  const files: string[] = [];
  let bytes = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const stat = lstatSync(path);
    if (!entry.isFile() || stat.isSymbolicLink()) {
      throw new Error("Caption helper created an unsafe file");
    }
    files.push(path);
    bytes += stat.size;
    if (files.length > MAX_TEMP_FILES || bytes > MAX_TEMP_BYTES) {
      throw new Error("Caption helper exceeded temporary-file limits");
    }
  }
  return files;
}

function availabilityError(message: string): string {
  const value = message.toLowerCase();
  if (value.includes("private")) return "Video is private or unavailable";
  if (value.includes("sign in") || value.includes("age")) {
    return "Video is age-restricted and requires authentication";
  }
  if (value.includes("geo") || value.includes("country")) {
    return "Video is unavailable in this region";
  }
  if (value.includes("live")) return "Live captions are unavailable";
  if (value.includes("429") || value.includes("rate")) {
    return "YouTube temporarily rate-limited caption access";
  }
  if (value.includes("unavailable") || value.includes("removed")) {
    return "Video is unavailable or has been removed";
  }
  if (
    value.includes("too much") ||
    value.includes("exceed") ||
    value.includes("size") ||
    value.includes("limit")
  ) {
    return "Caption data exceeds the extraction limit";
  }
  if (value.includes("cancel")) return "Caption extraction was cancelled";
  if (value.includes("timed out")) return "Caption extraction timed out";
  if (value.includes("no captions")) {
    return "No captions are available in the requested languages";
  }
  if (value.includes("caption track is empty")) {
    return "The selected caption track is empty";
  }
  return "Caption extraction failed";
}

export function formatCaptionTranscript(cues: CaptionCue[]): string {
  let transcript = "";
  for (const cue of cues) {
    const line = `[${formatTimestamp(cue.startMs)}] ${cue.text}`;
    const separator = transcript ? "\n" : "";
    if (
      transcript.length + separator.length + line.length >
      MAX_TRANSCRIPT_CHARS
    ) {
      throw new Error("Caption transcript exceeds the extraction size limit");
    }
    transcript += separator + line;
  }
  return transcript;
}

export async function extractYouTubeCaptions(
  rawUrl: string,
  signal?: AbortSignal,
  requestedLanguages: string[] = []
): Promise<CaptionContent> {
  const location = parseYouTubeUrl(rawUrl);
  if (!location) {
    throw new Error("A supported public YouTube video URL is required");
  }
  const ytDlp = executable("yt-dlp", "WILDBUZZARD_YTDLP");
  const node = executable("node", "WILDBUZZARD_BUNDLED_NODE");
  const directory = mkdtempSync(join(realpathSync(tmpdir()), TEMP_PREFIX));
  chmodSync(directory, 0o700);
  try {
    const languages = captionLanguageOrder(requestedLanguages);
    await runYtDlp(
      ytDlp,
      node,
      [
        "--ignore-config",
        "--no-plugin-dirs",
        "--no-remote-components",
        "--no-update",
        "--no-cache-dir",
        "--no-playlist",
        "--skip-download",
        "--write-subs",
        "--write-auto-subs",
        "--sub-langs",
        languages.join(","),
        "--sub-format",
        "json3/vtt/best",
        "--write-info-json",
        "--js-runtimes",
        `node:${node}`,
        "--output",
        `${location.videoId}.%(ext)s`,
        "--",
        location.canonicalUrl,
      ],
      directory,
      signal
    );
    const files = temporaryFiles(directory);
    const infoPath = files.find(path => path.endsWith(".info.json"));
    if (!infoPath) {
      throw new Error("Caption helper did not return video metadata");
    }
    const info = JSON.parse(readFileSync(infoPath, "utf8")) as {
      id?: unknown;
      title?: unknown;
      channel?: unknown;
      uploader?: unknown;
      duration?: unknown;
      subtitles?: unknown;
      automatic_captions?: unknown;
    };
    if (info.id !== location.videoId) {
      throw new Error("Caption helper returned mismatched video metadata");
    }
    const manual =
      info.subtitles && typeof info.subtitles === "object"
        ? (info.subtitles as Record<string, unknown>)
        : {};
    const automatic =
      info.automatic_captions && typeof info.automatic_captions === "object"
        ? (info.automatic_captions as Record<string, unknown>)
        : {};
    const candidates = [
      ...languages.map(language => ({
        language,
        kind: "manual" as const,
        available: Object.hasOwn(manual, language),
      })),
      ...languages.map(language => ({
        language,
        kind: "automatic" as const,
        available: Object.hasOwn(automatic, language),
      })),
    ];
    const selected = candidates
      .filter(candidate => candidate.available)
      .map(candidate => {
        const prefix = `${location.videoId}.${candidate.language}.`;
        const matching = files.filter(
          path =>
            basename(path).startsWith(prefix) && !path.endsWith(".info.json")
        );
        const captionPath =
          matching.find(path => path.endsWith(".json3")) ??
          matching.find(path => path.endsWith(".vtt"));
        return captionPath ? { ...candidate, captionPath } : null;
      })
      .find(candidate => candidate !== null);
    if (!selected) {
      throw new Error("No captions are available in the requested languages");
    }
    const { captionPath } = selected;
    const rawCaptions = readFileSync(captionPath, "utf8");
    const cues = captionPath.endsWith(".json3")
      ? parseJson3Captions(rawCaptions)
      : parseVttCaptions(rawCaptions);
    if (!cues.length) {
      throw new Error("The selected caption track is empty");
    }
    const title =
      typeof info.title === "string" && info.title.trim()
        ? info.title.trim().slice(0, 500)
        : "YouTube video";
    const channelValue = info.channel ?? info.uploader;
    const channel =
      typeof channelValue === "string" ? channelValue.trim().slice(0, 500) : "";
    const duration =
      typeof info.duration === "number" && Number.isFinite(info.duration)
        ? Math.max(0, info.duration)
        : null;
    const transcript = formatCaptionTranscript(cues);
    return {
      url: rawUrl,
      finalUrl: location.canonicalUrl,
      title,
      content: `# ${title}\n\nChannel: ${channel || "Unavailable"}\nDuration: ${
        duration === null ? "Unavailable" : `${duration} seconds`
      }\nCaptions: ${selected.language} (${selected.kind})\n\n## Transcript\n\n${transcript}`,
      error: null,
      mimeType: "text/markdown",
      status: 200,
      provenance: "youtube-captions",
      trust: "untrusted",
      available: true,
      channel,
      duration,
      language: selected.language,
      captionKind: selected.kind,
    };
  } catch (error) {
    if (signal?.aborted) {
      throw new Error("Caption extraction was cancelled");
    }
    const message = availabilityError(
      error instanceof Error ? error.message : String(error)
    );
    return {
      url: rawUrl,
      finalUrl: location.canonicalUrl,
      title: "",
      content: "",
      error: message,
      mimeType: "text/markdown",
      status: 0,
      provenance: "youtube-captions",
      trust: "untrusted",
      available: false,
      channel: "",
      duration: null,
      language: "",
      captionKind: null,
    };
  } finally {
    safeRemove(directory);
  }
}
