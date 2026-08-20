#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import argparse
import datetime as dt
import html
import http.client
import ipaddress
import json
import os
import pathlib
import re
import secrets
import socket
import stat
import subprocess
import sys
import urllib.parse
import urllib.error
import urllib.request
from html.parser import HTMLParser
from typing import Any


VERSION = "0.1.0"
PROTOCOL_VERSION = 1
RUNTIME_VERSION = "2026.8.6+b023a28ba"
UPSTREAM_COMMIT = "b023a28bab8839dba9eac96e9a51cc91bbd0a267"
MAX_RESPONSE = 4 * 1024 * 1024
MAX_PAGE_CHARS = 16_000
MAX_FETCH_BYTES = 8 * 1024 * 1024
FULL_MARKDOWN_MARKER = "BUZZARD_FULL_MARKDOWN_PATH="


class UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, socket_path: str, timeout: float = 30) -> None:
        super().__init__("localhost", timeout=timeout)
        self.socket_path = socket_path

    def connect(self) -> None:
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.socket_path)


def xdg_path(variable: str, fallback: pathlib.Path) -> pathlib.Path:
    value = os.environ.get(variable)
    return pathlib.Path(value) if value else fallback


def paths() -> dict[str, pathlib.Path]:
    home = pathlib.Path.home()
    data = xdg_path("XDG_DATA_HOME", home / ".local" / "share") / "buzzard" / "search"
    cache = xdg_path("XDG_CACHE_HOME", home / ".cache") / "buzzard" / "search"
    runtime_base = os.environ.get("XDG_RUNTIME_DIR")
    runtime = (
        pathlib.Path(runtime_base) / "buzzard" / "search"
        if runtime_base
        else pathlib.Path("/tmp") / f"buzzard-{os.getuid()}" / "search"
    )
    return {
        "data": data,
        "cache": cache,
        "runtime": runtime,
        "installed": data / "runtime" / RUNTIME_VERSION,
        "connection": runtime / "connection.json",
        "socket": runtime / "s",
        "documents": runtime / "documents",
    }


def private_directory(path: pathlib.Path) -> pathlib.Path:
    if path.is_symlink():
        raise RuntimeError(f"refusing symlink directory: {path}")
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.chmod(0o700)
    status = path.stat()
    if status.st_uid != os.getuid() or stat.S_IMODE(status.st_mode) != 0o700:
        raise RuntimeError(f"unsafe private directory: {path}")
    return path.resolve()


def document_directory() -> pathlib.Path:
    owned = paths()
    runtime_base = os.environ.get("XDG_RUNTIME_DIR")
    if runtime_base:
        base = pathlib.Path(runtime_base)
        if not base.is_absolute() or base.is_symlink():
            raise RuntimeError("XDG_RUNTIME_DIR is unsafe")
        base_status = base.stat()
        if not stat.S_ISDIR(base_status.st_mode) or base_status.st_uid != os.getuid():
            raise RuntimeError("XDG_RUNTIME_DIR is unsafe")
    else:
        private_directory(owned["runtime"].parent)
    private_directory(owned["runtime"])
    return private_directory(owned["documents"])


def safe_document_title(title: str) -> str:
    value = html.unescape(title)
    value = re.sub(r"\s+", " ", value).strip()
    value = value.encode("ascii", "ignore").decode("ascii")
    value = re.sub(r"[^A-Za-z0-9]+", "-", value).strip("-.")
    return value or "page"


def write_markdown_document(title: str, markdown: str) -> pathlib.Path:
    directory = document_directory()
    suffix = f"--{secrets.token_hex(8)}.md"
    name_max = os.pathconf(directory, "PC_NAME_MAX")
    path_max = os.pathconf(directory, "PC_PATH_MAX")
    prefix_budget = min(
        120,
        name_max - len(suffix.encode()),
        path_max - len(os.fsencode(directory)) - len(suffix.encode()) - 1,
    )
    if prefix_budget < 1:
        raise RuntimeError("buzzard-search document path has no safe filename space")
    prefix = safe_document_title(title)[:prefix_budget].rstrip("-.") or "page"
    filename = f"{prefix}{suffix}"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    directory_descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    descriptor = -1
    try:
        descriptor = os.open(filename, flags, 0o600, dir_fd=directory_descriptor)
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as output:
            descriptor = -1
            output.write(markdown)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        os.close(directory_descriptor)
    result = directory / filename
    if not result.is_absolute() or len(os.fsencode(result)) >= path_max:
        raise RuntimeError("buzzard-search document path exceeded PATH_MAX")
    return result


def truncate_page_text(text: str) -> str:
    if not text:
        return "(page returned no readable text)"
    if len(text) > MAX_PAGE_CHARS:
        return text[:MAX_PAGE_CHARS] + f"\n\n... (truncated, {len(text)} chars total)"
    return text


def text_with_document_path(content: str, path: str) -> str:
    return f"{content}\n\n{FULL_MARKDOWN_MARKER}{path}"


class ReadableHTMLParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.title_parts: list[str] = []
        self.ignored = 0
        self.in_title = False
        self.links: list[str | None] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        if tag in {"script", "style", "noscript", "svg", "nav", "footer", "form"}:
            self.ignored += 1
        if self.ignored:
            return
        if tag == "title":
            self.in_title = True
        elif tag in {"h1", "h2", "h3", "h4", "h5", "h6"}:
            self.parts.append(f"\n\n{'#' * int(tag[1])} ")
        elif tag in {"p", "div", "section", "article", "main", "blockquote", "pre"}:
            self.parts.append("\n\n")
        elif tag == "br":
            self.parts.append("\n")
        elif tag == "li":
            self.parts.append("\n- ")
        elif tag == "a":
            href = attributes.get("href")
            safe_href = (
                href
                if href and not href.lower().startswith(("javascript:", "data:"))
                else None
            )
            self.links.append(safe_href)
            self.parts.append("[")
        elif tag in {"strong", "b"}:
            self.parts.append("**")
        elif tag in {"em", "i"}:
            self.parts.append("*")
        elif tag == "code":
            self.parts.append("`")

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "noscript", "svg", "nav", "footer", "form"}:
            if self.ignored:
                self.ignored -= 1
            return
        if self.ignored:
            return
        if tag == "title":
            self.in_title = False
        elif tag == "a":
            href = self.links.pop() if self.links else None
            self.parts.append(f"]({href})" if href else "]")
        elif tag in {"strong", "b"}:
            self.parts.append("**")
        elif tag in {"em", "i"}:
            self.parts.append("*")
        elif tag == "code":
            self.parts.append("`")
        elif tag in {"p", "div", "section", "article", "main", "blockquote", "pre", "li"}:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if self.ignored:
            return
        if self.in_title:
            self.title_parts.append(data)
            return
        collapsed = re.sub(r"\s+", " ", data)
        if collapsed.strip():
            if self.parts and not self.parts[-1].endswith((" ", "\n", "[", "*", "`")):
                self.parts.append(" ")
            self.parts.append(collapsed.strip())

    def markdown(self) -> str:
        value = "".join(self.parts)
        value = re.sub(r"[ \t]+\n", "\n", value)
        value = re.sub(r"\n{3,}", "\n\n", value)
        return value.strip()

    def title(self) -> str:
        return re.sub(r"\s+", " ", "".join(self.title_parts)).strip()


def normalize_public_url(source: str) -> tuple[str, str]:
    candidate = source.strip()
    if not candidate:
        raise ValueError("URL must not be empty")
    if "://" not in candidate:
        candidate = f"https://{candidate}"
    parsed = urllib.parse.urlsplit(candidate)
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
        raise ValueError("only HTTP and HTTPS URLs are supported")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("URLs containing credentials are not supported")
    try:
        port = parsed.port
    except ValueError as error:
        raise ValueError("URL port is invalid") from error
    hostname = parsed.hostname.encode("idna").decode("ascii").lower()
    host = f"[{hostname}]" if ":" in hostname else hostname
    netloc = f"{host}:{port}" if port is not None else host
    normalized = urllib.parse.urlunsplit(
        (parsed.scheme.lower(), netloc, parsed.path or "/", parsed.query, "")
    )
    return normalized, hostname


def validate_public_url(source: str) -> str:
    normalized, hostname = normalize_public_url(source)
    parsed = urllib.parse.urlsplit(normalized)
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    try:
        addresses = socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
    except (OSError, UnicodeError) as error:
        raise RuntimeError(f"failed to resolve URL host: {error}") from error
    if not addresses:
        raise RuntimeError("failed to resolve URL host")
    for address in addresses:
        value = ipaddress.ip_address(address[4][0])
        if not value.is_global:
            raise ValueError("refusing to fetch a non-public URL")
    return normalized


class PublicRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        return super().redirect_request(
            request,
            file_pointer,
            code,
            message,
            headers,
            validate_public_url(new_url),
        )


def title_without_url_secrets(title: str, source_url: str) -> str:
    value = title
    parsed = urllib.parse.urlsplit(source_url)
    for _, secret in urllib.parse.parse_qsl(parsed.query, keep_blank_values=False):
        if secret:
            value = value.replace(secret, "redacted")
    return re.sub(r"\s+", " ", value).strip()


def title_from_markdown(markdown: str, hostname: str) -> str:
    match = re.search(r"(?m)^#{1,6}\s+(.+?)\s*$", markdown[:32_000])
    return match.group(1).strip(" #") if match else hostname


def fetch_readable_page(source: str, timeout: int = 60) -> tuple[str, str]:
    normalized = validate_public_url(source)
    request_value = urllib.request.Request(
        normalized,
        headers={
            "Accept": "text/html,text/markdown,text/plain,application/json;q=0.8,*/*;q=0.1",
            "User-Agent": "WildBuzzard/0.1 (+https://github.com/openresearchtools/wildbuzzard)",
        },
    )
    opener = urllib.request.build_opener(PublicRedirectHandler())
    try:
        with opener.open(request_value, timeout=min(max(timeout, 1), 60)) as response:
            body = response.read(MAX_FETCH_BYTES + 1)
            if len(body) > MAX_FETCH_BYTES:
                raise RuntimeError("page download exceeded 8 MiB")
            content_type = response.headers.get_content_type().lower()
            charset = response.headers.get_content_charset() or "utf-8"
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"page fetch failed with HTTP status {error.code}") from error
    except urllib.error.URLError as error:
        raise RuntimeError("page fetch failed") from error
    if not (
        content_type.startswith("text/")
        or content_type in {"application/json", "application/ld+json", "application/xhtml+xml"}
    ):
        raise RuntimeError(f"unsupported page content type: {content_type}")
    try:
        decoded = body.decode(charset, errors="replace")
    except LookupError:
        decoded = body.decode("utf-8", errors="replace")
    if content_type in {"text/html", "application/xhtml+xml"} or re.match(
        r"\s*<(?:!doctype\s+html|html|head|body)\b", decoded[:512], re.I
    ):
        parser = ReadableHTMLParser()
        parser.feed(decoded)
        markdown = parser.markdown()
        title = parser.title()
    else:
        markdown = decoded.strip()
        title = ""
    _, hostname = normalize_public_url(normalized)
    title = title_without_url_secrets(title or title_from_markdown(markdown, hostname), normalized)
    return markdown or "(page returned no readable text)", title


def fetch(arguments: Any) -> dict[str, Any]:
    if not isinstance(arguments, dict) or set(arguments) - {"url", "timeout"}:
        raise ValueError("web_search URL arguments are invalid")
    source = arguments.get("url")
    timeout = arguments.get("timeout", 60)
    if not isinstance(source, str) or not source.strip() or len(source) > 8192:
        raise ValueError("web_search url must contain 1 to 8192 characters")
    if not isinstance(timeout, int) or isinstance(timeout, bool) or not 1 <= timeout <= 60:
        raise ValueError("web_search timeout must be between 1 and 60 seconds")
    from buzzard_youtube_transcript import (
        InvalidYouTubeInput,
        canonicalize_youtube_input,
        fetch_youtube_transcript,
    )

    try:
        canonicalize_youtube_input(source)
    except InvalidYouTubeInput:
        pass
    else:
        transcript = fetch_youtube_transcript(
            source,
            output_directory=document_directory(),
        )
        return {
            "schema": 1,
            "implementation": "buzzard-search",
            "kind": "youtube_transcript",
            "content": transcript["content"],
            "fullMarkdownPath": transcript["path"],
            "contentLength": transcript["content_length"],
            "truncated": transcript["truncated"],
            "videoId": transcript["video_id"],
            "canonicalUrl": transcript["url"],
            "language": transcript["language"],
            "segmentCount": transcript["segment_count"],
        }
    markdown, title = fetch_readable_page(source, timeout)
    path = write_markdown_document(title, markdown)
    content = truncate_page_text(markdown)
    return {
        "schema": 1,
        "implementation": "buzzard-search",
        "kind": "page",
        "content": content,
        "fullMarkdownPath": str(path),
        "contentLength": len(markdown),
        "truncated": len(markdown) > MAX_PAGE_CHARS,
    }


def runtime_executable() -> pathlib.Path:
    return pathlib.Path(
        os.environ.get(
            "BUZZARD_SEARCH_RUNTIME",
            "/usr/lib/buzzard-search/buzzard-searxng.AppImage",
        )
    )


def lifecycle(action: str) -> subprocess.CompletedProcess[str]:
    owned = paths()
    for key in ("data", "cache", "runtime"):
        private_directory(owned[key])
    runtime = runtime_executable()
    if not runtime.is_file() or runtime.is_symlink():
        raise RuntimeError(f"buzzard-search runtime is unavailable: {runtime}")
    arguments = [
        str(runtime),
        action,
        "--install-dir",
        str(owned["installed"]),
        "--state-dir",
        str(owned["runtime"]),
        "--connection-file",
        str(owned["connection"]),
    ]
    if action == "start":
        arguments.extend(
            ["--cache-dir", str(owned["cache"]), "--socket", str(owned["socket"])]
        )
    environment = {
        "APPIMAGE_EXTRACT_AND_RUN": "1",
        "HOME": str(owned["data"]),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "PATH": "/usr/bin:/bin",
        "TMPDIR": str(owned["cache"]),
        "TZ": "UTC",
    }
    return subprocess.run(
        arguments,
        check=False,
        capture_output=True,
        text=True,
        env=environment,
        timeout=60,
    )


def connection_record() -> dict[str, Any]:
    path = paths()["connection"]
    status = os.stat(path, follow_symlinks=False)
    if not stat.S_ISREG(status.st_mode) or stat.S_IMODE(status.st_mode) != 0o600:
        raise RuntimeError("buzzard-search connection record is unsafe")
    value = json.loads(path.read_text(encoding="utf-8"))
    socket_path = value.get("socketPath")
    if (
        value.get("schema") != 1
        or value.get("runtimeVersion") != RUNTIME_VERSION
        or value.get("upstreamCommit") != UPSTREAM_COMMIT
        or not isinstance(socket_path, str)
        or pathlib.Path(socket_path) != paths()["socket"]
    ):
        raise RuntimeError("buzzard-search connection record is incompatible")
    socket_status = os.stat(socket_path, follow_symlinks=False)
    if not stat.S_ISSOCK(socket_status.st_mode):
        raise RuntimeError("buzzard-search socket is unavailable")
    return value


def ensure() -> dict[str, Any]:
    result = lifecycle("start")
    if result.returncode != 0 or result.stderr.strip():
        raise RuntimeError(result.stderr.strip() or "buzzard-search failed to start")
    published = json.loads(result.stdout)
    record = connection_record()
    if published != record:
        raise RuntimeError("buzzard-search lifecycle record mismatch")
    status, _, body = request(record, "GET", "/healthz", maximum=16)
    if status != 200 or body != b"OK":
        raise RuntimeError("buzzard-search health check failed")
    return record


def request(
    record: dict[str, Any],
    method: str,
    target: str,
    body: bytes | None = None,
    content_type: str | None = None,
    maximum: int = MAX_RESPONSE,
) -> tuple[int, dict[str, str], bytes]:
    connection = UnixHTTPConnection(str(record["socketPath"]))
    headers = {"Accept": "application/json", "Connection": "close"}
    if content_type:
        headers["Content-Type"] = content_type
    connection.request(method, target, body=body, headers=headers)
    response = connection.getresponse()
    payload = response.read(maximum + 1)
    connection.close()
    if len(payload) > maximum:
        raise RuntimeError("buzzard-search response exceeded its limit")
    return response.status, {key.lower(): value for key, value in response.headers.items()}, payload


def validate_search(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("web_search arguments must be an object")
    allowed = {
        "query",
        "engines",
        "language",
        "page",
        "timeRange",
        "safeSearch",
        "maxResults",
        "sortOrder",
    }
    if set(value) - allowed:
        raise ValueError("web_search contains unknown arguments")
    query = value.get("query")
    if not isinstance(query, str) or not query or len(query) > 512:
        raise ValueError("web_search query must contain 1 to 512 characters")
    engines = value.get("engines")
    if engines is not None and (
        not isinstance(engines, list)
        or len(engines) > 332
        or len(set(engines)) != len(engines)
        or any(not isinstance(item, str) or not item or len(item) > 128 for item in engines)
    ):
        raise ValueError("web_search engines are invalid")
    if value.get("timeRange") not in (None, "day", "week", "month", "year"):
        raise ValueError("web_search timeRange is invalid")
    if value.get("sortOrder", "relevance") not in ("relevance", "newest", "oldest"):
        raise ValueError("web_search sortOrder is invalid")
    maximum = value.get("maxResults", 5)
    if not isinstance(maximum, int) or isinstance(maximum, bool) or not 1 <= maximum <= 20:
        raise ValueError("web_search maxResults must be between 1 and 20")
    page = value.get("page", 1)
    if not isinstance(page, int) or isinstance(page, bool) or not 1 <= page <= 10:
        raise ValueError("web_search page must be between 1 and 10")
    language = value.get("language")
    if language is not None and (
        not isinstance(language, str)
        or not language
        or len(language) > 35
        or not all(character.isalnum() or character == "-" for character in language)
    ):
        raise ValueError("web_search language is invalid")
    if value.get("safeSearch", 1) != 1:
        raise ValueError("web_search safeSearch must be 1")
    return value


def bounded_string(value: Any, maximum: int) -> str | None:
    return value if isinstance(value, str) and len(value) <= maximum else None


def bounded_string_list(value: Any, maximum_items: int = 20) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item for item in value[:maximum_items] if bounded_string(item, 300) is not None]


def normalized_result(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    url = bounded_string(value.get("url"), 4096)
    if not url:
        return None
    result: dict[str, Any] = {"url": url}
    for source, destination, maximum in (
        ("title", "title", 300),
        ("content", "content", 1000),
        ("publishedDate", "publishedDate", 128),
    ):
        item = bounded_string(value.get(source), maximum)
        if item is not None:
            result[destination] = item
    engines = value.get("engines")
    if isinstance(engines, list):
        result["engines"] = list(
            dict.fromkeys(item for item in engines[:16] if isinstance(item, str))
        )
    score = value.get("score")
    if score is None or isinstance(score, (int, float)):
        result["score"] = score
    return result


def date_value(value: dict[str, Any]) -> dt.datetime | None:
    source = value.get("publishedDate")
    if not isinstance(source, str):
        return None
    try:
        parsed = dt.datetime.fromisoformat(source.replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=dt.timezone.utc)
    except ValueError:
        return None


def search(arguments: Any) -> dict[str, Any]:
    value = validate_search(arguments)
    record = ensure()
    form = {
        "q": value["query"],
        "format": "json",
        "safesearch": "1",
        "pageno": str(value.get("page", 1)),
    }
    if value.get("engines"):
        form["engines"] = ",".join(value["engines"])
    if value.get("language"):
        form["language"] = value["language"]
    if value.get("timeRange"):
        form["time_range"] = value["timeRange"]
    encoded = urllib.parse.urlencode(form).encode()
    status, headers, body = request(
        record,
        "POST",
        "/search",
        encoded,
        "application/x-www-form-urlencoded",
    )
    if status != 200 or not headers.get("content-type", "").lower().startswith("application/json"):
        raise RuntimeError(f"buzzard-search query failed with status {status}")
    raw = json.loads(body)
    if (
        not isinstance(raw, dict)
        or raw.get("query") != value["query"]
        or not isinstance(raw.get("results"), list)
    ):
        raise RuntimeError("buzzard-search returned an invalid response")
    results = [item for item in (normalized_result(item) for item in raw["results"]) if item]
    order = value.get("sortOrder", "relevance")
    if order != "relevance":
        indexed = list(enumerate(results))
        dated = [(index, item, date_value(item)) for index, item in indexed]
        dated.sort(
            key=lambda entry: (
                entry[2] is None,
                -entry[2].timestamp()
                if entry[2] and order == "newest"
                else entry[2].timestamp()
                if entry[2]
                else 0,
                entry[0],
            )
        )
        results = [entry[1] for entry in dated]
    maximum = value.get("maxResults", 5)
    return {
        "schema": 1,
        "implementation": "buzzard-search",
        "kind": "search",
        "query": value["query"],
        "results": results[:maximum],
        "corrections": bounded_string_list(raw.get("corrections")),
        "suggestions": bounded_string_list(raw.get("suggestions")),
        "diagnostics": {
            "catalogSha256": record.get("catalogSha256"),
            "runtimeVersion": record.get("runtimeVersion"),
            "timeRange": value.get("timeRange"),
            "sortOrder": order,
        },
    }


def status() -> dict[str, Any]:
    result = lifecycle("status")
    if result.returncode == 3:
        return {"running": False}
    if result.returncode == 4:
        return {"running": True, "healthy": False}
    if result.returncode != 0 or result.stderr.strip():
        raise RuntimeError(result.stderr.strip() or "buzzard-search status failed")
    record = json.loads(result.stdout)
    return {"running": True, "healthy": True, "pid": record.get("pid")}


def stop() -> dict[str, Any]:
    result = lifecycle("stop")
    if result.returncode != 0 or result.stderr.strip():
        raise RuntimeError(result.stderr.strip() or "buzzard-search stop failed")
    return {"running": False}


def invoke(tool: str, arguments: Any) -> Any:
    if tool == "web_search":
        if isinstance(arguments, dict) and arguments.get("url"):
            return fetch(arguments)
        return search(arguments)
    raise ValueError(f"unknown buzzard-search tool: {tool}")


def parse_json_argument(source: str | None) -> Any:
    if source is None:
        return {}
    if source == "-":
        source = sys.stdin.read()
    return json.loads(source)


def search_text(value: dict[str, Any]) -> str:
    parts = []
    for result in value["results"]:
        parts.append(
            f"Title: {result.get('title', '')}\n"
            f"URL: {result['url']}\n"
            f"Snippet: {result.get('content', '')}"
        )
    if not parts:
        return "No results found."
    return "\n\n---\n\n".join(parts) + (
        "\n\n---\n\nIMPORTANT: These are only short snippets. "
        "Read a selected result with `buzzard-search search --url <URL>`."
    )


def emit_web_result(value: dict[str, Any], as_json: bool) -> None:
    if as_json:
        print(json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True))
    elif value.get("kind") == "page":
        print(text_with_document_path(value["content"], value["fullMarkdownPath"]))
    else:
        print(search_text(value))


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="buzzard-search",
        description="Search for short snippets or fetch one selected URL as Markdown.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    for name in ("version", "start", "status", "stop"):
        subparsers.add_parser(name)
    search_parser = subparsers.add_parser(
        "search",
        help="pass a query, or pass --url to read a selected result",
    )
    search_parser.add_argument("value")
    search_parser.add_argument("--url", action="store_true")
    search_parser.add_argument("--json", action="store_true")
    search_parser.add_argument("--max-results", type=int, default=5)
    search_parser.add_argument("--timeout", type=int, default=60)
    args = parser.parse_args()
    if args.command == "version":
        value = {
            "package": "buzzard-search",
            "version": VERSION,
            "protocolVersion": PROTOCOL_VERSION,
            "runtimeVersion": RUNTIME_VERSION,
            "upstreamCommit": UPSTREAM_COMMIT,
        }
    elif args.command == "start":
        value = ensure()
    elif args.command == "status":
        value = status()
    elif args.command == "stop":
        value = stop()
    elif args.command == "search":
        if args.value.lstrip().startswith("{") and not args.url:
            arguments = parse_json_argument(args.value)
        elif args.url:
            arguments = {"url": args.value, "timeout": args.timeout}
        else:
            arguments = {"query": args.value, "maxResults": args.max_results}
        value = invoke("web_search", arguments)
        emit_web_result(value, args.json)
        return 0
    else:
        raise RuntimeError("unknown buzzard-search command")
    print(json.dumps(value, separators=(",", ":"), sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
        print(
            json.dumps({"ok": False, "error": str(error)}, separators=(",", ":")),
            file=sys.stderr,
        )
        raise SystemExit(1)
