# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import html
import json
import math
import os
import pathlib
import re
import secrets
import stat
import unicodedata
from collections.abc import Callable, Iterable, Sequence
from typing import Any
from urllib.parse import parse_qs, urlsplit


INLINE_CONTENT_LIMIT = 16_000
MAX_INPUT_LENGTH = 4_096
MAX_TITLE_LENGTH = 300
MAX_TITLE_RESPONSE_BYTES = 65_536
MAX_SEGMENTS = 100_000
MAX_TRANSCRIPT_CHARACTERS = 16_000_000
VIDEO_ID_PATTERN = re.compile(r"[A-Za-z0-9_-]{11}")
LANGUAGE_PATTERN = re.compile(r"[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*")
YOUTUBE_HOSTS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtube-nocookie.com",
    "www.youtube-nocookie.com",
}


class YouTubeTranscriptError(RuntimeError):
    pass


class InvalidYouTubeInput(YouTubeTranscriptError, ValueError):
    pass


def canonicalize_youtube_input(source: str) -> tuple[str, str]:
    if not isinstance(source, str):
        raise InvalidYouTubeInput("YouTube input must be a string")
    value = source.strip()
    if not value or len(value) > MAX_INPUT_LENGTH:
        raise InvalidYouTubeInput("YouTube input is empty or too long")
    if VIDEO_ID_PATTERN.fullmatch(value):
        return value, _canonical_url(value)

    try:
        parsed = urlsplit(value)
        hostname = parsed.hostname
        port = parsed.port
    except ValueError as error:
        raise InvalidYouTubeInput("Malformed YouTube URL") from error
    if parsed.scheme.casefold() not in {"http", "https"} or not parsed.netloc:
        raise InvalidYouTubeInput("Expected a YouTube video ID or HTTP(S) URL")
    if parsed.username is not None or parsed.password is not None:
        raise InvalidYouTubeInput(
            "YouTube URLs containing credentials are not accepted"
        )
    if port is not None:
        raise InvalidYouTubeInput(
            "YouTube URLs containing explicit ports are not accepted"
        )
    host = (hostname or "").casefold()

    video_id: str | None = None
    if host == "youtu.be":
        match = re.fullmatch(r"/([A-Za-z0-9_-]{11})/?", parsed.path)
        video_id = match.group(1) if match else None
    elif host in YOUTUBE_HOSTS:
        if parsed.path in {"/watch", "/watch/"}:
            try:
                query = parse_qs(
                    parsed.query,
                    keep_blank_values=True,
                    max_num_fields=32,
                )
            except ValueError as error:
                raise InvalidYouTubeInput("Malformed YouTube query") from error
            candidates = query.get("v", [])
            if len(candidates) == 1 and VIDEO_ID_PATTERN.fullmatch(candidates[0]):
                video_id = candidates[0]
        else:
            match = re.fullmatch(
                r"/(?:shorts|embed|live)/([A-Za-z0-9_-]{11})/?",
                parsed.path,
            )
            video_id = match.group(1) if match else None
    else:
        raise InvalidYouTubeInput("Only YouTube hosts are accepted")

    if video_id is None:
        raise InvalidYouTubeInput("URL does not identify a single YouTube video")
    return video_id, _canonical_url(video_id)


def fetch_youtube_transcript(
    source: str,
    *,
    output_directory: pathlib.Path,
    languages: Sequence[str] | None = None,
    api: Any | None = None,
    title_fetcher: Callable[[str], str | None] | None = None,
) -> dict[str, object]:
    video_id, canonical_url = canonicalize_youtube_input(source)
    requested_languages = _validate_languages(languages)
    client = api if api is not None else _new_transcript_api()
    try:
        fetched = client.fetch(
            video_id,
            languages=requested_languages,
            preserve_formatting=False,
        )
    except Exception as error:
        detail = _one_line(str(error), 500) or type(error).__name__
        raise YouTubeTranscriptError(
            f"Could not retrieve the transcript for {video_id}: {detail}"
        ) from error

    transcript_video_id = getattr(fetched, "video_id", video_id)
    if transcript_video_id != video_id:
        raise YouTubeTranscriptError(
            "Transcript response video ID did not match the request"
        )
    language = _one_line(getattr(fetched, "language", ""), 100)
    language_code = _one_line(getattr(fetched, "language_code", ""), 35)
    if not language or not language_code:
        raise YouTubeTranscriptError("Transcript response omitted language metadata")
    is_generated = bool(getattr(fetched, "is_generated", False))
    segments = _collect_segments(fetched)

    fetch_title = title_fetcher or _fetch_oembed_title
    try:
        title = _one_line(fetch_title(canonical_url), MAX_TITLE_LENGTH)
    except Exception:
        title = ""
    if not title:
        title = f"YouTube video {video_id}"

    markdown = _render_markdown(
        title=title,
        canonical_url=canonical_url,
        video_id=video_id,
        language=language,
        language_code=language_code,
        is_generated=is_generated,
        segments=segments,
    )
    directory = _validated_output_directory(output_directory)
    filename = _safe_filename(title, video_id)
    output_path = _atomic_private_write(directory, filename, markdown)
    content = _truncate_content(markdown)
    return {
        "type": "youtube_transcript",
        "video_id": video_id,
        "url": canonical_url,
        "title": title,
        "language": {
            "name": language,
            "code": language_code,
            "generated": is_generated,
        },
        "segment_count": len(segments),
        "content": content,
        "content_length": len(markdown),
        "truncated": len(markdown) > INLINE_CONTENT_LIMIT,
        "path": str(output_path),
    }


def _canonical_url(video_id: str) -> str:
    return f"https://www.youtube.com/watch?v={video_id}"


def _validate_languages(languages: Sequence[str] | None) -> tuple[str, ...]:
    if languages is None:
        return ("en",)
    if isinstance(languages, (str, bytes)) or not isinstance(languages, Sequence):
        raise InvalidYouTubeInput("languages must be a list of language codes")
    if not 1 <= len(languages) <= 10:
        raise InvalidYouTubeInput("languages must contain between one and ten codes")
    validated: list[str] = []
    for language in languages:
        if not isinstance(language, str) or not LANGUAGE_PATTERN.fullmatch(language):
            raise InvalidYouTubeInput(f"Invalid transcript language code: {language!r}")
        if language not in validated:
            validated.append(language)
    return tuple(validated)


def _new_http_session() -> Any:
    from requests import Session

    class BoundedSession(Session):
        def request(self, method: str, url: str, **kwargs: Any) -> Any:
            kwargs.setdefault("timeout", (5, 30))
            return super().request(method, url, **kwargs)

    session = BoundedSession()
    session.trust_env = False
    session.proxies.clear()
    return session


def _new_transcript_api() -> Any:
    from youtube_transcript_api import YouTubeTranscriptApi

    return YouTubeTranscriptApi(http_client=_new_http_session())


def _fetch_oembed_title(canonical_url: str) -> str | None:
    session = _new_http_session()
    try:
        response = session.get(
            "https://www.youtube.com/oembed",
            params={"url": canonical_url, "format": "json"},
            allow_redirects=False,
            stream=True,
            timeout=(5, 10),
        )
        if response.status_code != 200:
            return None
        content_type = response.headers.get("Content-Type", "").casefold()
        if "application/json" not in content_type:
            return None
        content_length = response.headers.get("Content-Length")
        if content_length is not None:
            try:
                if int(content_length) > MAX_TITLE_RESPONSE_BYTES:
                    return None
            except ValueError:
                return None
        body = bytearray()
        for chunk in response.iter_content(8_192):
            body.extend(chunk)
            if len(body) > MAX_TITLE_RESPONSE_BYTES:
                return None
        payload = json.loads(body.decode("utf-8"))
        title = payload.get("title") if isinstance(payload, dict) else None
        return title if isinstance(title, str) else None
    finally:
        session.close()


def _collect_segments(fetched: Iterable[Any]) -> list[dict[str, object]]:
    segments: list[dict[str, object]] = []
    text_characters = 0
    for snippet in fetched:
        if len(segments) >= MAX_SEGMENTS:
            raise YouTubeTranscriptError("Transcript exceeded the safe segment limit")
        text = getattr(snippet, "text", None)
        if not isinstance(text, str):
            raise YouTubeTranscriptError("Transcript segment omitted text")
        text = _clean_segment_text(text)
        text_characters += len(text)
        if text_characters > MAX_TRANSCRIPT_CHARACTERS:
            raise YouTubeTranscriptError("Transcript exceeded the safe text limit")
        start = _nonnegative_number(getattr(snippet, "start", None), "start")
        duration = _nonnegative_number(
            getattr(snippet, "duration", None), "duration"
        )
        segments.append({"start": start, "duration": duration, "text": text})
    return segments


def _nonnegative_number(value: object, name: str) -> float:
    if isinstance(value, bool):
        raise YouTubeTranscriptError(f"Transcript segment {name} was invalid")
    try:
        number = float(value)
    except (TypeError, ValueError) as error:
        raise YouTubeTranscriptError(
            f"Transcript segment {name} was invalid"
        ) from error
    if not math.isfinite(number) or number < 0:
        raise YouTubeTranscriptError(f"Transcript segment {name} was invalid")
    return number


def _clean_segment_text(value: str) -> str:
    normalized = value.replace("\r\n", "\n").replace("\r", "\n")
    return "".join(
        character
        for character in normalized
        if character in {"\n", "\t"} or ord(character) >= 32
    )


def _render_markdown(
    *,
    title: str,
    canonical_url: str,
    video_id: str,
    language: str,
    language_code: str,
    is_generated: bool,
    segments: Sequence[dict[str, object]],
) -> str:
    caption_type = "automatically generated" if is_generated else "human-created"
    lines = [
        f"# {_markdown_text(title)}",
        "",
        f"- Video: [{_markdown_text(video_id)}]({canonical_url})",
        f"- Language: {_markdown_text(language)} (`{_markdown_text(language_code)}`)",
        f"- Captions: {caption_type}",
        f"- Segments: {len(segments)}",
        "",
        "## Transcript",
        "",
    ]
    for segment in segments:
        timestamp = _format_timestamp(float(segment["start"]))
        text = _markdown_text(str(segment["text"])).replace("\n", "\n    ")
        lines.extend((f"- **{timestamp}**  {text}", ""))
    return "\n".join(lines).rstrip() + "\n"


def _format_timestamp(seconds: float) -> str:
    milliseconds = int(round(seconds * 1_000))
    total_seconds, milliseconds = divmod(milliseconds, 1_000)
    minutes, seconds = divmod(total_seconds, 60)
    hours, minutes = divmod(minutes, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}.{milliseconds:03d}"


def _markdown_text(value: str) -> str:
    escaped = html.escape(value, quote=False).replace("\\", "\\\\")
    for character in ("`", "*", "_", "[", "]", "#", "|", ">"):
        escaped = escaped.replace(character, f"\\{character}")
    return escaped


def _one_line(value: object, limit: int) -> str:
    if not isinstance(value, str):
        return ""
    normalized = unicodedata.normalize("NFKC", value)
    printable = "".join(
        character
        for character in normalized
        if not unicodedata.category(character).startswith("C")
    )
    return " ".join(printable.split())[:limit].strip()


def _safe_filename(title: str, video_id: str) -> str:
    normalized = unicodedata.normalize("NFKC", title).casefold()
    slug_characters: list[str] = []
    separated = False
    for character in normalized:
        if character.isalnum():
            slug_characters.append(character)
            separated = False
        elif slug_characters and not separated:
            slug_characters.append("-")
            separated = True
    slug = "".join(slug_characters).strip("-") or "youtube-transcript"
    while len(slug.encode("utf-8")) > 80:
        slug = slug[:-1].rstrip("-")
    return f"{slug}-{video_id}.md"


def _validated_output_directory(output_directory: pathlib.Path) -> pathlib.Path:
    directory = pathlib.Path(output_directory).expanduser()
    if not directory.is_absolute():
        raise YouTubeTranscriptError("Transcript output directory must be absolute")
    try:
        metadata = directory.lstat()
    except FileNotFoundError as error:
        raise YouTubeTranscriptError(
            "Transcript output directory does not exist"
        ) from error
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        raise YouTubeTranscriptError("Transcript output path is not a real directory")
    if metadata.st_uid != os.getuid():
        raise YouTubeTranscriptError("Transcript output directory has the wrong owner")
    if stat.S_IMODE(metadata.st_mode) != 0o700:
        directory.chmod(0o700)
    return directory.resolve(strict=True)


def _atomic_private_write(
    directory: pathlib.Path, filename: str, content: str
) -> pathlib.Path:
    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC
    directory_flags |= getattr(os, "O_NOFOLLOW", 0)
    directory_fd = os.open(directory, directory_flags)
    temporary_name = f".youtube-transcript-{secrets.token_hex(12)}.tmp"
    file_flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC
    file_flags |= getattr(os, "O_NOFOLLOW", 0)
    created = False
    try:
        file_fd = os.open(temporary_name, file_flags, 0o600, dir_fd=directory_fd)
        created = True
        with os.fdopen(file_fd, "w", encoding="utf-8", newline="\n") as output:
            os.fchmod(output.fileno(), 0o600)
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.replace(
            temporary_name,
            filename,
            src_dir_fd=directory_fd,
            dst_dir_fd=directory_fd,
        )
        created = False
        os.fsync(directory_fd)
    finally:
        if created:
            try:
                os.unlink(temporary_name, dir_fd=directory_fd)
            except FileNotFoundError:
                pass
        os.close(directory_fd)
    return directory / filename


def _truncate_content(content: str) -> str:
    if len(content) <= INLINE_CONTENT_LIMIT:
        return content
    return (
        content[:INLINE_CONTENT_LIMIT]
        + f"\n\n... (truncated, {len(content)} chars total)"
    )
