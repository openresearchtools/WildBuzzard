#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later

import argparse
import base64
import contextlib
import datetime
import difflib
import hashlib
import http.client
import http.cookies
import http.server
import json
import os
import pathlib
import re
import secrets
import shutil
import signal
import socket
import stat
import subprocess
import threading
import time
import traceback
import urllib.parse

from canonicalize import MAX_XML_BYTES, TorznabError, parse_torznab, parse_xml
from catalog_audit import audit_catalog
from expected_mini import validate_all as validate_mini_semantics
from pristine_runtime import verify_runtime as verify_pristine_runtime

COMMIT = "0cd8622b735922a909a128d8d6943bb8565a640f"
VERSION = "0.24.2360"
SOURCE_SHA256 = "3816fea39546b5fa440d3e33b856e73500ee6129e91b14d839fc0f04c7f9bd3e"
SOURCE_MANIFEST_SHA256 = (
    "7ce151e9e59943d4411bc2347cbfb6a7a5fb29c636ca2692b521f1f2dc086187"
)
PRISTINE_EXECUTABLE_SHA256 = (
    "b8bb98aa78d9942563e303c12f511c040c7a16a8a08a8c9f02c982c61b9850c1"
)
MAX_RESPONSE_BYTES = 16 * 1024 * 1024
ADULT_CATEGORIES = [6000, 6010, 6020, 6030, 6040, 6045, 6050, 6060, 6070, 6080, 6090]
RAW_URL_SECRET = "raw-url-oracle-secret"
TRACKER_USERNAME = "tracker-user-oracle-secret"
TRACKER_PASSKEY = "tracker-passkey-oracle-secret"
MINI_SOURCES = {"showrss": "main", "linuxtracker": "alternate"}
SPECIAL_MINI_SCENARIOS = {
    "acquisition-url-reuse",
    "contradictory-peer-client-guard",
    "error-code-200-source-contract",
    "external-entity-network",
    "stale-generation",
}


def canonical_json(value):
    return json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"


def write_json(path, value):
    path.write_text(canonical_json(value), encoding="utf-8")


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def parse_source_manifest(manifest_path, expected_sha256=SOURCE_MANIFEST_SHA256):
    try:
        info = manifest_path.lstat()
    except FileNotFoundError as error:
        raise RuntimeError("the pinned source manifest is missing") from error
    if not stat.S_ISREG(info.st_mode):
        raise RuntimeError("the pinned source manifest must be a regular file")
    manifest_sha256 = sha256_file(manifest_path)
    if manifest_sha256 != expected_sha256:
        raise RuntimeError("the pinned source manifest digest does not match")
    try:
        lines = manifest_path.read_text(encoding="utf-8").splitlines()
    except UnicodeDecodeError as error:
        raise RuntimeError("the pinned source manifest is not UTF-8") from error
    entries = []
    paths = set()
    for line_number, line in enumerate(lines, 1):
        match = re.fullmatch(r"([0-9a-f]{64})  (.+)", line)
        if not match:
            raise RuntimeError(f"invalid source manifest entry at line {line_number}")
        digest, raw_path = match.groups()
        path = pathlib.PurePosixPath(raw_path)
        if (
            path.is_absolute()
            or str(path) != raw_path
            or "\\" in raw_path
            or "\0" in raw_path
            or any(part in {"", ".", ".."} for part in path.parts)
        ):
            raise RuntimeError(
                f"unsafe source manifest path at line {line_number}: {raw_path!r}"
            )
        if raw_path in paths:
            raise RuntimeError(f"duplicate source manifest path: {raw_path}")
        paths.add(raw_path)
        entries.append((raw_path, digest))
    if not entries:
        raise RuntimeError("the pinned source manifest is empty")
    return entries, manifest_sha256


def sha256_source_entry(root_descriptor, raw_path):
    parts = pathlib.PurePosixPath(raw_path).parts
    descriptor = os.dup(root_descriptor)
    try:
        for part in parts[:-1]:
            child = os.open(
                part,
                os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW,
                dir_fd=descriptor,
            )
            os.close(descriptor)
            descriptor = child
        file_descriptor = os.open(
            parts[-1],
            os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK,
            dir_fd=descriptor,
        )
        try:
            if not stat.S_ISREG(os.fstat(file_descriptor).st_mode):
                raise RuntimeError(
                    f"source manifest entry is not a regular file: {raw_path}"
                )
            digest = hashlib.sha256()
            while chunk := os.read(file_descriptor, 1024 * 1024):
                digest.update(chunk)
            return digest.hexdigest()
        finally:
            os.close(file_descriptor)
    except OSError as error:
        raise RuntimeError(
            f"source manifest entry is missing or unsafe: {raw_path}"
        ) from error
    finally:
        os.close(descriptor)


def validate_pristine_source(
    source_root,
    manifest_path,
    expected_manifest_sha256=SOURCE_MANIFEST_SHA256,
):
    entries, manifest_sha256 = parse_source_manifest(
        manifest_path, expected_manifest_sha256
    )
    try:
        root_descriptor = os.open(
            source_root,
            os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW,
        )
    except OSError as error:
        raise RuntimeError("the pristine source root is missing or unsafe") from error
    try:
        for raw_path, expected_sha256 in entries:
            if sha256_source_entry(root_descriptor, raw_path) != expected_sha256:
                raise RuntimeError(
                    f"source manifest content digest mismatch: {raw_path}"
                )
    finally:
        os.close(root_descriptor)
    return {
        "schemaVersion": 1,
        "sourceCommit": COMMIT,
        "manifestSha256": manifest_sha256,
        "entryCount": len(entries),
    }


def choose_port(address):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind((address, 0))
        return listener.getsockname()[1]


def mode(path):
    return stat.S_IMODE(path.stat().st_mode)


def local_name(tag):
    return tag.rsplit("}", 1)[-1]


def rootless_namespace_identity():
    uid_map = pathlib.Path("/proc/self/uid_map").read_text(encoding="ascii").strip()
    entries = [line.split() for line in uid_map.splitlines()]
    if not entries or any(len(entry) != 3 for entry in entries):
        raise RuntimeError("invalid user namespace identity")
    if any(
        int(inside) == 0 and int(outside) == 0 for inside, outside, _length in entries
    ):
        raise RuntimeError("the pristine oracle requires a rootless user namespace")
    return {
        "uidMap": uid_map,
        "gidMap": pathlib
        .Path("/proc/self/gid_map")
        .read_text(encoding="ascii")
        .strip(),
        "userNamespace": os.readlink("/proc/self/ns/user"),
        "networkNamespace": os.readlink("/proc/self/ns/net"),
    }


def process_identity(process):
    stat_value = pathlib.Path(f"/proc/{process.pid}/stat").read_text(encoding="ascii")
    stat_fields = stat_value[stat_value.rfind(")") + 2 :].split()
    executable = pathlib.Path(os.readlink(f"/proc/{process.pid}/exe"))
    children_path = pathlib.Path(f"/proc/{process.pid}/task/{process.pid}/children")
    return {
        "pid": process.pid,
        "linuxProcessStartTime": stat_fields[19],
        "executable": str(executable),
        "executableSha256": sha256_file(executable),
        "children": children_path.read_text(encoding="ascii").split(),
    }


def process_group_members(process):
    members = []
    for entry in pathlib.Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            value = (entry / "stat").read_text(encoding="ascii")
            fields = value[value.rfind(")") + 2 :].split()
            if int(fields[2]) == process.pid:
                members.append(int(entry.name))
        except (FileNotFoundError, IndexError, ValueError):
            pass
    return sorted(members)


def run_command(command, log_path=None, check=True):
    completed = subprocess.run(
        command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False
    )
    if log_path:
        log_path.write_bytes(completed.stdout)
    if check and completed.returncode != 0:
        raise RuntimeError(
            f"command failed ({completed.returncode}): {' '.join(command)}"
        )
    return completed


def start_process(command, cwd, environment, log_path):
    log = log_path.open("wb")
    process = subprocess.Popen(
        command,
        cwd=cwd,
        env=environment,
        stdout=log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    return process, log


def stop_process(process):
    if not process:
        return None
    members = process_group_members(process)
    if process.poll() is None or members:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGTERM)
    if process.poll() is None:
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)
    deadline = time.monotonic() + 5
    while process_group_members(process) and time.monotonic() < deadline:
        time.sleep(0.05)
    remaining = process_group_members(process)
    if remaining:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGKILL)
        deadline = time.monotonic() + 5
        while process_group_members(process) and time.monotonic() < deadline:
            time.sleep(0.05)
    return process.returncode


def request(port, method, path, body=None, headers=None, timeout=20):
    headers = dict(headers or {})
    if body is not None and not isinstance(body, bytes):
        body = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode(
            "utf-8"
        )
        headers.setdefault("Content-Type", "application/json")
    if body is not None:
        headers.setdefault("Content-Length", str(len(body)))
    started = time.monotonic()
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    try:
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        payload = response.read(MAX_RESPONSE_BYTES + 1)
        if len(payload) > MAX_RESPONSE_BYTES:
            raise RuntimeError("response exceeded oracle limit")
        return {
            "outcome": "response",
            "status": response.status,
            "headers": list(response.getheaders()),
            "body": payload,
            "elapsedMs": round((time.monotonic() - started) * 1000, 3),
        }
    except (TimeoutError, socket.timeout):
        return {
            "outcome": "timeout",
            "status": None,
            "headers": [],
            "body": b"",
            "elapsedMs": round((time.monotonic() - started) * 1000, 3),
        }
    finally:
        connection.close()


def wait_for_health(port, timeout=20):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        try:
            response = request(port, "GET", "/health", timeout=1)
            if response["status"] == 200:
                return response
            last = f"HTTP {response['status']}"
        except (ConnectionError, OSError) as error:
            last = error
        time.sleep(0.1)
    raise RuntimeError(f"pristine Jackett did not become healthy: {last}")


def wait_for_mini_health(port, capability, timeout=20):
    deadline = time.monotonic() + timeout
    headers = {"Authorization": f"Bearer {capability}"}
    last = None
    while time.monotonic() < deadline:
        try:
            response = request(port, "GET", "/v1/health", headers=headers, timeout=1)
            if response["status"] == 200:
                return response
            last = f"HTTP {response['status']}"
        except (ConnectionError, OSError) as error:
            last = error
        time.sleep(0.1)
    raise RuntimeError(f"Jackett Mini did not become healthy: {last}")


def redact_bytes(payload, redactions):
    result = payload
    for secret, replacement in redactions:
        result = result.replace(secret.encode("utf-8"), replacement.encode("utf-8"))
    result = re.sub(
        rb"((?:\?|&|&amp;)(?:apikey|passkey|path|capability)=)[^&<\"\s]+",
        rb"\1<redacted>",
        result,
        flags=re.IGNORECASE,
    )
    return result


def redact_text(value, redactions):
    return redact_bytes(value.encode("utf-8", errors="replace"), redactions).decode(
        "utf-8", errors="replace"
    )


def redacted_headers(headers, redactions):
    safe = []
    for key, original_value in (
        headers.items() if isinstance(headers, dict) else headers
    ):
        if key.lower() in {"authorization", "cookie", "set-cookie"}:
            safe_value = "<redacted>"
        else:
            safe_value = redact_text(original_value, redactions)
        safe.append([key, safe_value])
    return safe


def save_transcript(
    directory, name, method, path, headers, request_body, response, redactions
):
    safe_request_body = redact_bytes(request_body or b"", redactions)
    safe_response_body = redact_bytes(response["body"], redactions)
    document = {
        "request": {
            "method": method,
            "path": redact_text(path, redactions),
            "headers": redacted_headers(headers, redactions),
            "bodyBase64": base64.b64encode(safe_request_body).decode("ascii"),
        },
        "response": {
            "outcome": response["outcome"],
            "status": response["status"],
            "headers": redacted_headers(response["headers"], redactions),
            "bodyBase64": base64.b64encode(safe_response_body).decode("ascii"),
            "elapsedMs": response["elapsedMs"],
        },
    }
    with contextlib.suppress(UnicodeDecodeError):
        document["request"]["bodyText"] = safe_request_body.decode("utf-8")
    with contextlib.suppress(UnicodeDecodeError):
        document["response"]["bodyText"] = safe_response_body.decode("utf-8")
    write_json(directory / f"{name}.json", document)


def fixture_item(
    origin,
    source,
    title,
    category="safe",
    category2=None,
    infohash=None,
    seeders="4",
    leechers="2",
    download=True,
):
    infohash = (
        infohash or hashlib.sha1(f"{source}:{title}".encode()).hexdigest().upper()
    )
    details_id = hashlib.sha1(title.encode()).hexdigest()[:16]
    parts = [
        "<item>",
        f"<title>{title}</title>",
        f"<details>{origin}/details/{source}/{details_id}</details>",
        "<published>2026-08-10T12:00:00Z</published>",
        "<size>123456</size>",
    ]
    if category is not None:
        parts.append(f"<trackerCategory>{category}</trackerCategory>")
    if category2 is not None:
        parts.append(f"<trackerCategory2>{category2}</trackerCategory2>")
    if seeders is not None:
        parts.append(f"<seeders>{seeders}</seeders>")
    if leechers is not None:
        parts.append(f"<leechers>{leechers}</leechers>")
    parts.append(f"<infoHash>{infohash}</infoHash>")
    if download:
        parts.append(
            f'<enclosure url="{origin}/acquire/{source}/{details_id}?token={RAW_URL_SECRET}"/>'
        )
    parts.append("</item>")
    return "".join(parts)


def fixture_xml(origin, source, query, generation=0):
    prefix = '<?xml version="1.0" encoding="UTF-8"?><rss><channel>'
    suffix = "</channel></rss>"
    if query == "malformed":
        return b"<rss><channel><item><title>unterminated"
    if query == "deep":
        return (prefix + "<node>" * 80 + "deep" + "</node>" * 80 + suffix).encode()
    if query == "entity":
        body = (
            f'<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY xxe SYSTEM "{origin}/entity-leak">]>'
            f"<rss><channel>{fixture_item(origin, source, '&xxe;')}</channel></rss>"
        )
        return body.encode()
    if query == "oversized":
        return (
            prefix + "<padding>" + "X" * (MAX_XML_BYTES + 1024) + "</padding>" + suffix
        ).encode()
    if query == "adult-categories":
        items = []
        for category in ADULT_CATEGORIES:
            items.append(
                fixture_item(origin, source, f"Adult {category}", f"adult{category}")
            )
        return (prefix + "".join(items) + suffix).encode()
    if query == "mixed-categories":
        return (
            prefix
            + fixture_item(origin, source, "Mixed safe and adult", "safe", "adult6010")
            + suffix
        ).encode()
    if query == "missing-category":
        return (
            prefix + fixture_item(origin, source, "Missing category", None) + suffix
        ).encode()
    if query == "adult-provider-generic":
        return (
            prefix
            + fixture_item(origin, source, "Adult provider generic", "generic")
            + suffix
        ).encode()
    if query == "peer-counts":
        absent = fixture_item(
            origin, source, "Peers absent", seeders=None, leechers=None
        )
        contradictory = fixture_item(
            origin, source, "Negative leechers normalized", seeders="10", leechers="-7"
        )
        return (prefix + absent + contradictory + suffix).encode()
    if query == "duplicates":
        item = fixture_item(
            origin,
            source,
            f"Duplicate from {source}",
            infohash="0123456789ABCDEF0123456789ABCDEF01234567",
        )
        return (prefix + item + suffix).encode()
    if query == "partial" and source.endswith("alternate"):
        return b"<rss><channel><item>broken"
    if query == "malicious":
        title = "&lt;script&gt;alert(1)&lt;/script&gt; &#x202E; untrusted\nvalue"
        return (
            prefix
            + fixture_item(origin, source, title, "safe", "not-a-category")
            + suffix
        ).encode()
    if query == "cache":
        return (
            prefix
            + fixture_item(origin, source, f"Cache generation {generation}")
            + suffix
        ).encode()
    title = {
        "slow-generation": "Slow generation",
        "fast-generation": "Fast generation",
        "redirect-target": "Redirect target",
        "custom-category": "Custom category",
    }.get(query, f"Fixture {source}")
    return (prefix + fixture_item(origin, source, title) + suffix).encode()


def fixture_torrent(origin):
    announce = f"{origin}/announce".encode("ascii")

    def value(data):
        return str(len(data)).encode("ascii") + b":" + data

    info = b"d6:lengthi123e4:name12:fixture.file12:piece lengthi16384e6:pieces20:01234567890123456789e"
    return b"d8:announce" + value(announce) + b"4:info" + info + b"e"


class FixtureHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        parsed = urllib.parse.urlsplit(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        self.server.requests.append({
            "method": "GET",
            "path": self.path,
            "headerNames": sorted(self.headers.keys()),
        })
        if parsed.path == "/oracle":
            source = query.get("source", ["main"])[0]
            search = query.get("q", [""])[0]
            key = f"{source}:{search}"
            self.server.generations[key] = self.server.generations.get(key, 0) + 1
            generation = self.server.generations[key]
            if search == "redirect-once":
                target = "/oracle?" + urllib.parse.urlencode({
                    "source": source,
                    "q": "redirect-target",
                })
                self._respond(302, b"", {"Location": target})
                return
            if search == "redirect-loop":
                self._respond(302, b"", {"Location": self.path})
                return
            if search == "tls-failure":
                target = f"https://{self.server.server_address[0]}:{self.server.server_address[1]}/oracle?source={source}&q=tls-target"
                self._respond(302, b"", {"Location": target})
                return
            if search == "rate-limit":
                self._respond(
                    429,
                    b'{"error":"rate limited"}',
                    {"Content-Type": "application/json", "Retry-After": "7"},
                )
                return
            if search == "hang":
                time.sleep(5)
            if search == "slow-generation":
                time.sleep(0.6)
            payload = fixture_xml(self.server.origin, source, search, generation)
            self._respond(
                200, payload, {"Content-Type": "application/xml; charset=utf-8"}
            )
            return
        if parsed.path == "/api.php":
            if query.get("query") == ["rate-limit"]:
                self._respond(
                    429,
                    b'{"error":"rate limited"}',
                    {"Content-Type": "application/json", "Retry-After": "7"},
                )
                return
            document = [
                {
                    "id": 1,
                    "name": "FileList fixture",
                    "download_link": f"{self.server.origin}/acquire/filelist?token={RAW_URL_SECRET}",
                    "size": 123456,
                    "leechers": 2,
                    "seeders": 4,
                    "times_completed": 3,
                    "files": 1,
                    "imdb": "tt1234567",
                    "internal": False,
                    "freeleech": True,
                    "doubleup": False,
                    "upload_date": "2026-08-10 12:00:00",
                    "category": "Movies HD",
                    "small_description": "fixture",
                }
            ]
            self._respond(
                200,
                json.dumps(document, separators=(",", ":")).encode(),
                {"Content-Type": "application/json"},
            )
            return
        if parsed.path.startswith("/acquire/"):
            self._respond(
                200,
                fixture_torrent(self.server.origin),
                {"Content-Type": "application/x-bittorrent"},
            )
            return
        if parsed.path == "/entity-leak":
            self.server.entity_leak_requests += 1
            self._respond(200, b"ENTITY-RESOLVED", {"Content-Type": "text/plain"})
            return
        self._respond(200, b"fixture\n", {"Content-Type": "text/plain"})

    def _respond(self, status, payload, headers):
        response_headers = dict(headers)
        response_headers["Content-Length"] = str(len(payload))
        response_headers["Cache-Control"] = "no-store"
        self.server.responses.append({
            "requestPath": self.path,
            "status": status,
            "headers": sorted(response_headers.items()),
            "bodyBytes": len(payload),
            "bodySha256": hashlib.sha256(payload).hexdigest(),
        })
        self.send_response(status)
        for key, value in response_headers.items():
            self.send_header(key, value)
        self.end_headers()
        with contextlib.suppress(BrokenPipeError, ConnectionResetError):
            self.wfile.write(payload)

    def log_message(self, *_args):
        pass


def render_definition(template, destination, indexer_id, name, origin, source):
    value = template.read_text(encoding="utf-8")
    value = value.replace("__INDEXER_ID__", indexer_id)
    value = value.replace("__INDEXER_NAME__", name)
    value = value.replace("__FIXTURE_ORIGIN__", origin)
    value = value.replace("__FIXTURE_SOURCE__", source)
    destination.write_text(value, encoding="utf-8")


def response_cookie(response, name):
    cookies = http.cookies.SimpleCookie()
    for key, value in response["headers"]:
        if key.lower() == "set-cookie":
            cookies.load(value)
    if name not in cookies:
        raise AssertionError(f"upstream login did not set {name}")
    return cookies[name].value


def configure_indexer(
    port, indexer_id, dashboard_headers, transcripts, redactions, mutate=None
):
    path = f"/api/v2.0/indexers/{indexer_id}/Config"
    fetched = request(port, "GET", path, headers=dashboard_headers)
    save_transcript(
        transcripts,
        f"setup-{indexer_id}-get",
        "GET",
        path,
        dashboard_headers,
        None,
        fetched,
        redactions,
    )
    if fetched["status"] != 200:
        raise AssertionError(f"configuration for {indexer_id} could not be read")
    document = json.loads(fetched["body"])
    if mutate:
        mutate(document)
    body = json.dumps(document, separators=(",", ":")).encode()
    headers = {**dashboard_headers, "Content-Type": "application/json"}
    configured = request(port, "POST", path, body, headers, timeout=20)
    save_transcript(
        transcripts,
        f"setup-{indexer_id}-post",
        "POST",
        path,
        headers,
        body,
        configured,
        redactions,
    )
    if configured["status"] != 204:
        raise AssertionError(
            f"configuration for {indexer_id} failed: {configured['status']}"
        )


def content_type(response):
    for key, value in response["headers"]:
        if key.lower() == "content-type":
            return value.split(";", 1)[0].lower()
    return None


def header_value(response, name):
    return next(
        (value for key, value in response["headers"] if key.lower() == name.lower()),
        None,
    )


def canonical_response(response):
    if response["outcome"] != "response":
        return {"outcome": response["outcome"]}
    result = {
        "outcome": "response",
        "status": response["status"],
        "contentType": content_type(response),
    }
    retry_after = header_value(response, "Retry-After")
    if retry_after is not None:
        result["retryAfter"] = retry_after
    body = response["body"]
    try:
        root = parse_xml(body)
    except TorznabError:
        result["root"] = "non-xml"
        return result
    root_name = local_name(root.tag)
    result["root"] = root_name
    if root_name == "error":
        result["errorCode"] = int(root.attrib["code"])
        return result
    if root_name == "caps":
        categories = []
        for element in root.iter():
            if (
                local_name(element.tag) in {"category", "subcat"}
                and element.attrib.get("id", "").isdigit()
            ):
                categories.append(int(element.attrib["id"]))
        result["categoryIds"] = sorted(set(categories))
        return result
    if root_name != "rss":
        return result
    items = []
    for item in (
        element for element in root.iter() if local_name(element.tag) == "item"
    ):
        attributes = {}
        for child in item:
            if local_name(child.tag) == "attr":
                attributes.setdefault(child.attrib.get("name", "").lower(), []).append(
                    child.attrib.get("value", "")
                )
        categories = []
        for value in attributes.get("category", []):
            categories.extend(
                int(token) for token in value.split(",") if token.strip().isdigit()
            )
        title = next(
            ((child.text or "") for child in item if local_name(child.tag) == "title"),
            "",
        )
        indexer = next(
            (
                child.attrib.get("id")
                for child in item
                if local_name(child.tag) == "jackettindexer"
            ),
            None,
        )
        seeders = int(attributes["seeders"][0]) if attributes.get("seeders") else None
        peers = int(attributes["peers"][0]) if attributes.get("peers") else None
        infohash = (attributes.get("infohash") or [None])[0]
        items.append({
            "title": title,
            "indexerId": indexer,
            "categoryIds": sorted(set(categories)),
            "seeders": seeders,
            "peers": peers,
            "normalizedLeechers": max(0, peers - seeders)
            if peers is not None and seeders is not None
            else None,
            "infoHash": infohash.upper() if infohash else None,
        })
    result["items"] = sorted(
        items, key=lambda item: ((item["indexerId"] or ""), item["title"])
    )
    return result


def canonical_mini_response(response):
    if response["outcome"] != "response":
        return {"outcome": response["outcome"]}
    result = {
        "outcome": "response",
        "status": response["status"],
        "contentType": content_type(response),
    }
    retry_after = header_value(response, "Retry-After")
    if retry_after is not None:
        result["retryAfter"] = retry_after
    try:
        document = json.loads(response["body"])
    except (UnicodeDecodeError, json.JSONDecodeError):
        result["root"] = "non-json"
        return result
    if isinstance(document, dict) and "error" in document:
        result["error"] = document["error"]
        return result
    if isinstance(document, dict) and document.get("immutable") is True:
        result["sources"] = sorted(
            [
                {
                    "id": MINI_SOURCES.get(source.get("id"), source.get("id")),
                    "state": source.get("state"),
                }
                for source in document.get("sources", [])
            ],
            key=lambda source: source["id"],
        )
        return result
    if isinstance(document, dict) and "searchId" in document:
        result["partial"] = document.get("partial")
        result["providers"] = [
            {
                "id": MINI_SOURCES.get(provider.get("id"), provider.get("id")),
                "state": provider.get("state"),
            }
            for provider in document.get("providers", [])
        ]
        result["providers"].sort(key=lambda provider: provider["id"])
        result["items"] = sorted(
            [
                {
                    "title": item.get("name"),
                    "indexerId": MINI_SOURCES.get(
                        item.get("providerId"), item.get("providerId")
                    ),
                    "categoryIds": item.get("categoryIds"),
                    "seeders": item.get("seeders"),
                    "normalizedLeechers": item.get("leechers"),
                    "acquisition": item.get("acquisition"),
                }
                for item in document.get("results", [])
            ],
            key=lambda item: ((item["indexerId"] or ""), item["title"] or ""),
        )
        return result
    if isinstance(document, dict) and document.get("kind") in {"magnet", "torrent"}:
        result["resolution"] = {
            "kind": document.get("kind"),
            "torrentBytes": document.get("torrentBytes"),
        }
        return result
    if isinstance(document, dict) and document.get("status") == "ok":
        result["health"] = {
            "status": "ok",
            "protocolVersion": document.get("protocolVersion"),
            "runtimeVersion": document.get("runtimeVersion"),
        }
        return result
    result["root"] = type(document).__name__
    return result


def mini_search_body(query, source_ids=None, **extra):
    value = {"query": query, "limit": 100, **extra}
    if source_ids is not None:
        value["sourceIds"] = source_ids
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def mini_case(name, capability):
    authorized = {"Authorization": f"Bearer {capability}"}
    json_headers = {**authorized, "Content-Type": "application/json"}
    if name in {"valid-apikey", "unavailable-indexers-mode"}:
        return "GET", "/v1/sources", None, authorized, 20
    if name == "valid-passkey-alias":
        return "GET", "/v1/sources?passkey=forbidden", None, authorized, 20
    if name == "missing-apikey":
        return "GET", "/v1/sources", None, {}, 20
    if name == "invalid-apikey":
        return "GET", "/v1/sources", None, {"Authorization": "Bearer invalid"}, 20
    if name == "unsupported-mode":
        body = json.dumps(
            {"query": "fixture", "sourceIds": ["showrss"], "operation": "not-a-mode"},
            separators=(",", ":"),
        ).encode()
        return "POST", "/v1/search", body, json_headers, 20
    if name == "unsupported-indexer":
        body = mini_search_body("fixture", ["not-an-indexer"])
        return "POST", "/v1/search", body, json_headers, 20
    if name == "omitted-indexer-route":
        body = mini_search_body("fixture")
        return "POST", "/v1/search", body, json_headers, 35
    if name == "unavailable-tmdb-function":
        body = mini_search_body("fixture", ["showrss"], tmdbid="123")
        return "POST", "/v1/search", body, json_headers, 20
    if name == "invalid-imdb-parameter":
        body = mini_search_body("fixture", ["showrss"], imdbid="invalid")
        return "POST", "/v1/search", body, json_headers, 20
    if name == "adult-provider-generic-8000":
        body = mini_search_body("adult-provider-generic", ["oracle-adult"])
        return "POST", "/v1/search", body, json_headers, 20
    queries = {
        "tracker-tls-failure": "tls-failure",
        "redirect-once": "redirect-once",
        "redirect-loop": "redirect-loop",
        "http-429-retry-after": "rate-limit",
        "peer-counts": "peer-counts",
        "adult-category-matrix": "adult-categories",
        "mixed-safe-adult-category": "mixed-categories",
        "missing-category": "missing-category",
        "malicious-fields": "malicious",
        "custom-category": "custom-category",
        "duplicate-infohash-alternates": "duplicates",
        "partial-success": "partial",
        "cache-first": "cache",
        "cache-hit": "cache",
        "cache-expired": "cache",
        "cache-bypass-first": "cache",
        "cache-bypass-second": "cache",
        "hanging-provider-timeout": "hang",
    }
    match = re.fullmatch(r"tracker-(malformed|deep|entity|oversized)-xml", name)
    query = match.group(1) if match else queries[name]
    source_ids = (
        ["showrss", "linuxtracker"]
        if name
        in {
            "duplicate-infohash-alternates",
            "partial-success",
        }
        else ["showrss"]
    )
    body = mini_search_body(query, source_ids)
    timeout = 0.5 if name == "hanging-provider-timeout" else 35
    return "POST", "/v1/search", body, json_headers, timeout


def normalized_semantic_diff(pristine, mini):
    return "".join(
        difflib.unified_diff(
            canonical_json(pristine).splitlines(keepends=True),
            canonical_json(mini).splitlines(keepends=True),
            fromfile="pristine-normalized",
            tofile="jackett-mini-normalized",
        )
    )


def validate_mini_runtime(
    runtime,
    manifest_path,
    *,
    test_fixture=False,
    production_runtime_sha256=None,
):
    executable = runtime / "jackett-mini"
    if not executable.is_file():
        raise RuntimeError("the pinned Jackett Mini executable is required")
    if manifest_path != runtime / "jackett-mini-runtime.json":
        raise RuntimeError("the Jackett Mini manifest must belong to the runtime")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if (
        manifest.get("component") != "jackett-mini"
        or manifest.get("protocolVersion") != 1
        or manifest.get("upstreamVersion") != "v0.24.2360"
        or manifest.get("upstreamCommit") != COMMIT
        or manifest.get("sourceSha256") != SOURCE_SHA256
        or manifest.get("platform") != "linux"
        or manifest.get("architecture") != "x86_64"
        or manifest.get("libc") != "glibc"
        or manifest.get("testFixture") is not test_fixture
        or not re.fullmatch(r"[a-f0-9]{64}", manifest.get("catalogFileSha256", ""))
        or not re.fullmatch(r"[a-f0-9]{64}", manifest.get("providerPolicySha256", ""))
        or (not test_fixture and manifest.get("enabledProviderCount") != 60)
    ):
        raise RuntimeError(
            "the Jackett Mini runtime manifest is not the pinned runtime"
        )
    entry = next(
        (
            item
            for item in manifest.get("files", [])
            if item.get("path") == "jackett-mini"
        ),
        None,
    )
    if (
        not entry
        or not entry.get("executable")
        or sha256_file(executable) != entry.get("sha256")
    ):
        raise RuntimeError("the Jackett Mini executable does not match its manifest")
    files = manifest.get("files")
    if not isinstance(files, list) or not files:
        raise RuntimeError("the Jackett Mini manifest inventory is empty")
    canonical_files = json.dumps(files, sort_keys=True, separators=(",", ":")).encode()
    if hashlib.sha256(canonical_files).hexdigest() != manifest.get("runtimeSha256"):
        raise RuntimeError("the Jackett Mini runtime inventory digest is invalid")
    expected_paths = set()
    seen_inodes = set()
    for item in files:
        relative = item.get("path")
        if (
            not isinstance(relative, str)
            or not relative
            or pathlib.PurePosixPath(relative).is_absolute()
            or any(part in {"", ".", ".."} for part in relative.split("/"))
            or relative in expected_paths
        ):
            raise RuntimeError("the Jackett Mini runtime inventory path is invalid")
        expected_paths.add(relative)
        path = runtime.joinpath(*relative.split("/"))
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise RuntimeError("the Jackett Mini runtime contains a non-regular file")
        inode = (info.st_dev, info.st_ino)
        if inode in seen_inodes:
            raise RuntimeError("the Jackett Mini runtime contains a hard link")
        seen_inodes.add(inode)
        if (
            info.st_size != item.get("size")
            or bool(info.st_mode & 0o111) != item.get("executable")
            or sha256_file(path) != item.get("sha256")
        ):
            raise RuntimeError(f"Jackett Mini runtime file mismatch: {relative}")
    actual_paths = set()
    for path in runtime.rglob("*"):
        info = path.lstat()
        if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
            raise RuntimeError(
                "the Jackett Mini runtime contains a link or special file"
            )
        if stat.S_ISREG(info.st_mode) and path != manifest_path:
            actual_paths.add(path.relative_to(runtime).as_posix())
    if actual_paths != expected_paths:
        raise RuntimeError("the Jackett Mini runtime contains unmanifested files")
    catalog_entry = next(
        (item for item in files if item.get("path") == "catalog.json"), None
    )
    if (
        not catalog_entry
        or catalog_entry.get("sha256") != manifest["catalogFileSha256"]
    ):
        raise RuntimeError("the Jackett Mini catalog binding is invalid")
    if test_fixture:
        if (
            not re.fullmatch(
                r"[a-f0-9]{64}", manifest.get("productionRuntimeSha256", "")
            )
            or manifest.get("productionRuntimeSha256") != production_runtime_sha256
            or manifest.get("enabledProviderCount") != 2
        ):
            raise RuntimeError(
                "the Jackett Mini fixture is not bound to the production runtime"
            )
    elif "productionRuntimeSha256" in manifest:
        raise RuntimeError("the production runtime is marked as a test fixture")
    return executable, manifest


def guard_result(payload):
    try:
        parse_xml(payload)
    except TorznabError as error:
        return {"accepted": False, "error": str(error)}
    return {"accepted": True}


def source_contract(source_root):
    controller = source_root / "src/Jackett.Server/Controllers/ResultsController.cs"
    text = controller.read_text(encoding="utf-8")
    route = '[Route("api/v2.0/indexers/{indexerId}/results")]'
    branch = 'HttpStatusCode.NotFound, 200, "Indexer is not specified"'
    if route not in text or branch not in text:
        raise AssertionError("pinned error-code-200 source contract changed")
    return {
        "controllerSha256": sha256_file(controller),
        "routeRequiresIndexerId": True,
        "unreachableFilterBranch": {"httpSemantic": "not-found", "torznabCode": 200},
    }


def mini_result_store_contract(runtime):
    source = runtime / "source/jackett/src/Jackett.Mini/ResultStore.cs"
    text = source.read_text(encoding="utf-8")
    if (
        "DateTimeOffset.UtcNow.AddMinutes(10)" not in text
        or "private void Prune()" not in text
    ):
        raise AssertionError("pinned Mini opaque-result expiry contract changed")
    return {
        "sourceSha256": sha256_file(source),
        "expiryMinutes": 10,
        "unknownAndExpiredStatus": 404,
    }


def validate_matrix(observed):
    responses = [value for value in observed.values() if isinstance(value, dict)]
    error_codes = {value.get("errorCode") for value in responses}
    statuses = {value.get("status") for value in responses}
    if not {100, 201, 203, 900}.issubset(error_codes):
        raise AssertionError(f"missing Torznab error codes: {error_codes}")
    if not {400, 429}.issubset(statuses):
        raise AssertionError(f"missing adversarial HTTP statuses: {statuses}")
    if (
        observed["error-code-200-source-contract"]["unreachableFilterBranch"][
            "torznabCode"
        ]
        != 200
    ):
        raise AssertionError("the pinned source-level code-200 contract is absent")
    adult = {
        category
        for item in observed["adult-category-matrix"]["items"]
        for category in item["categoryIds"]
        if category < 100000
    }
    if adult != set(ADULT_CATEGORIES):
        raise AssertionError(f"adult category matrix mismatch: {sorted(adult)}")
    for name in (
        "tracker-malformed-xml",
        "tracker-deep-xml",
        "tracker-entity-xml",
        "tracker-oversized-xml",
    ):
        if observed[name]["clientGuard"]["accepted"]:
            raise AssertionError(f"unsafe XML passed the client guard: {name}")
    if observed["external-entity-network"]["requests"] != 0:
        raise AssertionError("external XML entity caused a network request")
    if observed["hanging-provider-timeout"]["outcome"] != "timeout":
        raise AssertionError("hanging provider was not bounded")
    if (
        observed["tracker-tls-failure"].get("errorCode") != 900
        or observed["redirect-loop"].get("errorCode") != 900
    ):
        raise AssertionError("transport errors did not retain code 900")
    peer_items = {item["title"]: item for item in observed["peer-counts"]["items"]}
    if peer_items["Peers absent"]["peers"] is not None:
        raise AssertionError("absent peer values were not preserved")
    if observed["contradictory-peer-client-guard"]["normalizedLeechers"] != 0:
        raise AssertionError("contradictory peer counts did not clamp to zero")
    if (
        observed["cache-hit"]["fixtureRequests"] != 1
        or observed["cache-expired"]["fixtureRequests"] != 2
    ):
        raise AssertionError("cache hit/expiry semantics changed")
    if observed["cache-bypass-second"]["fixtureRequests"] != 2:
        raise AssertionError("cache=false did not fetch twice")
    if observed["stale-generation"]["completionOrder"] != ["fast", "slow"]:
        raise AssertionError("stale generation did not finish after the newer request")
    if observed["acquisition-url-reuse"] != {
        "firstStatus": 200,
        "secondStatus": 200,
        "sameBytes": True,
    }:
        raise AssertionError("pristine acquisition URL reuse semantics changed")


def validate_mini_matrix(observed, security_evidence, removed_statuses):
    expected_statuses = {
        "valid-apikey": 200,
        "valid-passkey-alias": 400,
        "missing-apikey": 401,
        "invalid-apikey": 401,
        "unsupported-indexer": 400,
        "unsupported-mode": 400,
        "unavailable-indexers-mode": 200,
        "unavailable-tmdb-function": 400,
        "invalid-imdb-parameter": 400,
        "adult-provider-generic-8000": 400,
    }
    for name, status in expected_statuses.items():
        if observed[name].get("status") != status:
            raise AssertionError(f"unexpected Mini status for {name}: {observed[name]}")
    if observed["valid-apikey"].get("sources") != [
        {"id": "alternate", "state": "ready"},
        {"id": "main", "state": "ready"},
    ]:
        raise AssertionError("the deterministic Mini source overlay is not isolated")
    for name in ("adult-category-matrix", "mixed-safe-adult-category"):
        if observed[name].get("items"):
            raise AssertionError(f"adult content escaped Mini filtering: {name}")
    if len(observed["duplicate-infohash-alternates"].get("items", [])) != 1:
        raise AssertionError("Mini did not collapse the duplicate BTIH")
    if observed["stale-generation"].get("completionOrder") != ["fast", "slow"]:
        raise AssertionError("Mini stale work did not finish after the newer request")
    if not observed["partial-success"].get("partial"):
        raise AssertionError("Mini did not expose partial provider failure")
    if observed["hanging-provider-timeout"].get("outcome") != "timeout":
        raise AssertionError(
            "the Mini caller deadline did not bound the hanging provider"
        )
    if observed["cache-hit"].get("fixtureRequests") != 1:
        raise AssertionError("Mini did not reuse its internal cache")
    if observed["cache-expired"].get("fixtureRequests") != 1:
        raise AssertionError(
            "Mini unexpectedly exposed the pristine one-second cache expiry"
        )
    if observed["cache-bypass-second"].get("fixtureRequests") != 0:
        raise AssertionError(
            "Mini unexpectedly exposed the pristine cache bypass switch"
        )
    if not observed["acquisition-url-reuse"].get("oneShot"):
        raise AssertionError("Mini opaque result IDs are not one-shot")
    if observed["contradictory-peer-client-guard"].get("normalizedLeechers") != 0:
        raise AssertionError("Mini did not clamp contradictory peer counts")
    malicious_items = observed["malicious-fields"].get("items", [])
    if (
        len(malicious_items) != 1
        or malicious_items[0].get("acquisition") not in {"magnet", "torrent"}
        or "\n" in malicious_items[0].get("title", "")
    ):
        raise AssertionError("Mini did not bound malicious result fields")
    if observed["external-entity-network"].get("requests") != 0:
        raise AssertionError("Mini caused an external entity-resolution request")
    if observed["error-code-200-source-contract"].get("status") != 404:
        raise AssertionError("Mini unexpectedly exposed the raw Torznab controller")
    if security_evidence["expired-opaque-result"].get("status") != 404:
        raise AssertionError("Mini expired result IDs are not bounded")
    if security_evidence["cross-profile-result-isolation"].get("status") != 404:
        raise AssertionError("a Mini result crossed profile scope")
    if not all(
        security_evidence["same-profile-http-reconnection"].get(key)
        for key in ("sameInstanceId", "sameDataRootId")
    ):
        raise AssertionError("the same Mini profile did not preserve service identity")
    if set(removed_statuses.values()) != {404}:
        raise AssertionError("a removed Mini route remained reachable")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pristine-runtime", required=True, type=pathlib.Path)
    parser.add_argument("--pristine-build-record", required=True, type=pathlib.Path)
    parser.add_argument("--pristine-source", required=True, type=pathlib.Path)
    parser.add_argument("--mini-runtime", required=True, type=pathlib.Path)
    parser.add_argument("--mini-manifest", required=True, type=pathlib.Path)
    parser.add_argument("--mini-fixture-runtime", required=True, type=pathlib.Path)
    parser.add_argument("--mini-fixture-manifest", required=True, type=pathlib.Path)
    parser.add_argument("--artifact-root", required=True, type=pathlib.Path)
    parser.add_argument("--fixture-address", default="11.0.0.2")
    parser.add_argument("--fixture-port", default=18080, type=int)
    parser.add_argument("--oci-evidence", required=True, type=pathlib.Path)
    args = parser.parse_args()
    os.umask(0o077)
    if not any(
        pathlib.Path(path).exists() for path in ("/run/.containerenv", "/.dockerenv")
    ):
        raise RuntimeError("the adversarial comparison must run inside OCI")
    if (args.fixture_address, args.fixture_port) != ("11.0.0.2", 18080):
        raise RuntimeError("the deterministic OCI fixture endpoint changed")
    if any(shutil.which(command) is None for command in ("ip", "ss")):
        raise RuntimeError("the oracle image must provide ip and ss")

    script_dir = pathlib.Path(__file__).resolve().parent
    expected_path = script_dir / "fixtures/pristine-adversarial-expected.json"
    pristine_runtime_pin = script_dir / "fixtures/pristine-runtime-pin.json"
    template = script_dir / "fixtures/adversarial-indexer.yml.in"
    source_manifest_path = (
        script_dir.parents[2]
        / "third_party/gpl2/jackett/upstream/SOURCE-MANIFEST.sha256"
    )
    pristine_runtime = args.pristine_runtime.resolve(strict=True)
    pristine_build_record_path = args.pristine_build_record.resolve(strict=True)
    pristine_source = args.pristine_source.resolve(strict=True)
    mini_runtime = args.mini_runtime.resolve(strict=True)
    mini_manifest_path = args.mini_manifest.resolve(strict=True)
    mini_fixture_runtime = args.mini_fixture_runtime.resolve(strict=True)
    mini_fixture_manifest_path = args.mini_fixture_manifest.resolve(strict=True)
    oci_evidence_path = args.oci_evidence.resolve(strict=True)
    pristine_executable = pristine_runtime / "jackett"
    if (
        not pristine_executable.is_file()
        or sha256_file(pristine_executable) != PRISTINE_EXECUTABLE_SHA256
    ):
        raise RuntimeError("the pinned pristine Jackett executable is required")
    pristine_build_record = verify_pristine_runtime(
        pristine_runtime, pristine_build_record_path, pristine_runtime_pin
    )
    source_manifest_evidence = validate_pristine_source(
        pristine_source, source_manifest_path
    )
    mini_executable, mini_manifest = validate_mini_runtime(
        mini_runtime, mini_manifest_path
    )
    mini_fixture_executable, mini_fixture_manifest = validate_mini_runtime(
        mini_fixture_runtime,
        mini_fixture_manifest_path,
        test_fixture=True,
        production_runtime_sha256=mini_manifest["runtimeSha256"],
    )
    shipping_catalog_audit = audit_catalog(
        mini_runtime / "catalog.json", pristine_source, mini_runtime
    )
    oci_evidence = json.loads(oci_evidence_path.read_text(encoding="utf-8"))
    if (
        oci_evidence.get("rootless") is not True
        or oci_evidence.get("networkInternal") is not True
        or oci_evidence.get("platform") != "linux/amd64"
        or not re.fullmatch(r"sha256:[a-f0-9]{64}", oci_evidence.get("imageDigest", ""))
        or not re.fullmatch(r"sha256:[a-f0-9]{64}", oci_evidence.get("imageId", ""))
        or not all(oci_evidence.get("readOnlyMounts", {}).values())
    ):
        raise RuntimeError("the rootless OCI isolation evidence is incomplete")

    run_id = (
        datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        + "-"
        + secrets.token_hex(4)
    )
    artifacts = args.artifact_root.resolve() / f"adversarial-comparison-{run_id}"
    transcripts = artifacts / "transcripts"
    logs = artifacts / "logs"
    overlays = artifacts / "overlays"
    pristine_data = artifacts / "pristine-data"
    mini_data = artifacts / "mini-profile-a-data"
    mini_profile_b_data = artifacts / "mini-profile-b-data"
    shipping_mini_data = artifacts / "mini-shipping-data"
    for directory in (
        transcripts,
        logs,
        overlays,
        pristine_data,
        mini_data,
        mini_profile_b_data,
        shipping_mini_data,
    ):
        directory.mkdir(parents=True, mode=0o700)
        directory.chmod(0o700)

    write_json(logs / "rootless-namespace.json", rootless_namespace_identity())
    write_json(artifacts / "pristine-source-manifest.json", source_manifest_evidence)
    write_json(artifacts / "shipping-catalog-audit.json", shipping_catalog_audit)
    run_command(["ip", "-json", "address", "show"], logs / "network-namespace.json")
    fixture_server = http.server.ThreadingHTTPServer(
        (args.fixture_address, args.fixture_port), FixtureHandler
    )
    fixture_server.daemon_threads = True
    fixture_server.requests = []
    fixture_server.responses = []
    fixture_server.generations = {}
    fixture_server.entity_leak_requests = 0
    fixture_port = fixture_server.server_address[1]
    fixture_server.origin = f"http://{args.fixture_address}:{fixture_port}"
    fixture_thread = threading.Thread(target=fixture_server.serve_forever, daemon=True)
    fixture_thread.start()

    definitions = overlays / "xdg/cardigann/definitions"
    definitions.mkdir(parents=True, mode=0o700)
    render_definition(
        template,
        definitions / "oracle-main.yml",
        "oracle-main",
        "Oracle Main",
        fixture_server.origin,
        "main",
    )
    render_definition(
        template,
        definitions / "oracle-alternate.yml",
        "oracle-alternate",
        "Oracle Alternate",
        fixture_server.origin,
        "alternate",
    )
    render_definition(
        template,
        definitions / "oracle-adult.yml",
        "oracle-adult",
        "Oracle Adult Only",
        fixture_server.origin,
        "adult-provider",
    )
    mini_overlay_evidence = overlays / "mini-fixture"
    mini_overlay_evidence.mkdir(mode=0o700)
    shutil.copy2(
        mini_fixture_runtime / "catalog.json", mini_overlay_evidence / "catalog.json"
    )
    for indexer_id in MINI_SOURCES:
        shutil.copy2(
            mini_fixture_runtime / "Definitions" / f"{indexer_id}.yml",
            mini_overlay_evidence / f"{indexer_id}.yml",
        )

    pristine_port = choose_port("127.0.0.1")
    mini_port = choose_port("127.0.0.1")
    while mini_port == pristine_port:
        mini_port = choose_port("127.0.0.1")
    mini_profile_b_port = choose_port("127.0.0.1")
    while mini_profile_b_port in {pristine_port, mini_port}:
        mini_profile_b_port = choose_port("127.0.0.1")
    shipping_mini_port = choose_port("127.0.0.1")
    while shipping_mini_port in {pristine_port, mini_port, mini_profile_b_port}:
        shipping_mini_port = choose_port("127.0.0.1")
    bootstrap = None
    bootstrap_log = None
    process = None
    process_log = None
    mini_process = None
    mini_process_log = None
    mini_profile_b_process = None
    mini_profile_b_process_log = None
    shipping_mini_process = None
    shipping_mini_process_log = None
    process_log_path = logs / "pristine-jackett.log"
    bootstrap_log_path = logs / "pristine-jackett-bootstrap.log"
    mini_process_log_path = logs / "jackett-mini-profile-a.log"
    mini_profile_b_process_log_path = logs / "jackett-mini-profile-b.log"
    shipping_mini_process_log_path = logs / "jackett-mini-shipping.log"
    capability = secrets.token_urlsafe(32)
    profile_b_capability = secrets.token_urlsafe(32)
    shipping_capability = secrets.token_urlsafe(32)
    capability_path = mini_data / "capability"
    profile_b_capability_path = mini_profile_b_data / "capability"
    shipping_capability_path = shipping_mini_data / "capability"
    capability_path.write_text(capability + "\n", encoding="ascii")
    profile_b_capability_path.write_text(profile_b_capability + "\n", encoding="ascii")
    shipping_capability_path.write_text(shipping_capability + "\n", encoding="ascii")
    capability_path.chmod(0o600)
    profile_b_capability_path.chmod(0o600)
    shipping_capability_path.chmod(0o600)
    redactions = [
        (RAW_URL_SECRET, "<redacted-raw-url>"),
        (TRACKER_USERNAME, "<redacted-tracker-user>"),
        (TRACKER_PASSKEY, "<redacted-tracker-passkey>"),
        (capability, "<redacted-profile-a-capability>"),
        (profile_b_capability, "<redacted-profile-b-capability>"),
        (shipping_capability, "<redacted-shipping-capability>"),
        (str(pristine_runtime), "<pristine-runtime>"),
        (str(pristine_source), "<pristine-source>"),
        (str(mini_runtime), "<jackett-mini-runtime>"),
        (str(mini_fixture_runtime), "<jackett-mini-fixture-runtime>"),
        (str(pristine_data), "<pristine-data>"),
        (str(mini_data), "<mini-profile-a-data>"),
        (str(mini_profile_b_data), "<mini-profile-b-data>"),
        (str(shipping_mini_data), "<mini-shipping-data>"),
        (str(script_dir), "<comparison-source>"),
        (str(artifacts), "<comparison-artifacts>"),
    ]
    cleanup = {
        "ports": {},
        "processes": {},
        "fixtureStopped": False,
        "dataRootsRemoved": {},
    }
    success = False
    observed = {}
    pristine_raw = {}
    mini_observed = {}
    mini_raw = {}
    semantic_diffs = {}
    security_evidence = {}
    mappings = []

    environment = {
        "HOME": str(pristine_data),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "TZ": "UTC",
        "XDG_CONFIG_HOME": str(overlays / "xdg"),
    }
    command = [
        str(pristine_executable),
        "--ListenPrivate",
        "--Port",
        str(pristine_port),
        "--PIDFile",
        str(pristine_data / "jackett.pid"),
        "--NoUpdates",
        "--NoRestart",
        "--DataFolder",
        str(pristine_data),
    ]
    mini_environment = {
        "HOME": str(mini_data),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "TZ": "UTC",
    }
    mini_command = [
        str(mini_fixture_executable),
        "--ListenPrivate",
        "--Port",
        str(mini_port),
        "--PIDFile",
        str(mini_data / "jackett.pid"),
        "--NoUpdates",
        "--NoRestart",
        "--DataFolder",
        str(mini_data),
        "--CapabilityFile",
        str(capability_path),
    ]
    mini_profile_b_environment = {
        "HOME": str(mini_profile_b_data),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "TZ": "UTC",
    }
    mini_profile_b_command = [
        str(mini_fixture_executable),
        "--ListenPrivate",
        "--Port",
        str(mini_profile_b_port),
        "--PIDFile",
        str(mini_profile_b_data / "jackett.pid"),
        "--NoUpdates",
        "--NoRestart",
        "--DataFolder",
        str(mini_profile_b_data),
        "--CapabilityFile",
        str(profile_b_capability_path),
    ]
    shipping_mini_environment = {
        "HOME": str(shipping_mini_data),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "TZ": "UTC",
    }
    shipping_mini_command = [
        str(mini_executable),
        "--ListenPrivate",
        "--Port",
        str(shipping_mini_port),
        "--PIDFile",
        str(shipping_mini_data / "jackett.pid"),
        "--NoUpdates",
        "--NoRestart",
        "--DataFolder",
        str(shipping_mini_data),
        "--CapabilityFile",
        str(shipping_capability_path),
    ]

    try:
        bootstrap, bootstrap_log = start_process(
            command, pristine_runtime, environment, bootstrap_log_path
        )
        wait_for_health(pristine_port)
        cleanup["processes"]["bootstrapIdentity"] = process_identity(bootstrap)
        cleanup["processes"]["bootstrapExitCode"] = stop_process(bootstrap)
        bootstrap_log.close()

        server_config_path = pristine_data / "ServerConfig.json"
        server_config = json.loads(server_config_path.read_text(encoding="utf-8"))
        server_config["CacheEnabled"] = True
        server_config["CacheTtl"] = 1
        server_config_path.write_text(
            json.dumps(server_config, separators=(",", ":")), encoding="utf-8"
        )
        server_config_path.chmod(0o600)
        api_key = server_config["APIKey"]
        redactions.append((api_key, "<redacted-api-key>"))

        process, process_log = start_process(
            command, pristine_runtime, environment, process_log_path
        )
        health = wait_for_health(pristine_port)
        pristine_identity = process_identity(process)
        if pristine_identity["executableSha256"] != PRISTINE_EXECUTABLE_SHA256:
            raise AssertionError("the running pristine executable identity changed")
        write_json(logs / "pristine-process-identity.json", pristine_identity)
        save_transcript(
            transcripts,
            "setup-pristine-health",
            "GET",
            "/health",
            {},
            None,
            health,
            redactions,
        )

        mini_process, mini_process_log = start_process(
            mini_command,
            mini_fixture_runtime,
            mini_environment,
            mini_process_log_path,
        )
        mini_profile_b_process, mini_profile_b_process_log = start_process(
            mini_profile_b_command,
            mini_fixture_runtime,
            mini_profile_b_environment,
            mini_profile_b_process_log_path,
        )
        shipping_mini_process, shipping_mini_process_log = start_process(
            shipping_mini_command,
            mini_runtime,
            shipping_mini_environment,
            shipping_mini_process_log_path,
        )
        mini_health = wait_for_mini_health(mini_port, capability)
        mini_profile_b_health = wait_for_mini_health(
            mini_profile_b_port, profile_b_capability
        )
        shipping_mini_health = wait_for_mini_health(
            shipping_mini_port, shipping_capability
        )
        mini_health_document = json.loads(mini_health["body"])
        mini_profile_b_health_document = json.loads(mini_profile_b_health["body"])
        shipping_health_document = json.loads(shipping_mini_health["body"])
        if (
            shipping_health_document.get("catalogSha256")
            != mini_manifest["catalogFileSha256"]
            or shipping_health_document.get("catalogPolicySha256")
            != mini_manifest["providerPolicySha256"]
        ):
            raise AssertionError(
                "the shipping Mini process did not load its bound catalog"
            )
        if (
            mini_health_document["dataRootId"]
            == mini_profile_b_health_document["dataRootId"]
        ):
            raise AssertionError("distinct Mini profiles reused one data root identity")
        for value, replacement in (
            (mini_health_document["instanceId"], "<redacted-profile-a-instance-id>"),
            (mini_health_document["dataRootId"], "<redacted-profile-a-data-root-id>"),
            (
                mini_profile_b_health_document["instanceId"],
                "<redacted-profile-b-instance-id>",
            ),
            (
                mini_profile_b_health_document["dataRootId"],
                "<redacted-profile-b-data-root-id>",
            ),
        ):
            redactions.append((value, replacement))
        mini_identity = process_identity(mini_process)
        mini_profile_b_identity = process_identity(mini_profile_b_process)
        shipping_mini_identity = process_identity(shipping_mini_process)
        executable_hash = sha256_file(mini_fixture_executable)
        if any(
            identity["executableSha256"] != executable_hash
            for identity in (mini_identity, mini_profile_b_identity)
        ):
            raise AssertionError("a running Mini executable identity changed")
        if shipping_mini_identity["executableSha256"] != sha256_file(mini_executable):
            raise AssertionError(
                "the running shipping Mini executable identity changed"
            )
        write_json(
            logs / "jackett-mini-profile-a-process-identity.json",
            mini_identity,
        )
        write_json(
            logs / "jackett-mini-profile-b-process-identity.json",
            mini_profile_b_identity,
        )
        write_json(
            logs / "jackett-mini-shipping-process-identity.json",
            shipping_mini_identity,
        )
        profile_a_headers = {"Authorization": f"Bearer {capability}"}
        profile_b_headers = {"Authorization": f"Bearer {profile_b_capability}"}
        shipping_headers = {"Authorization": f"Bearer {shipping_capability}"}
        save_transcript(
            transcripts,
            "setup-mini-profile-a-health",
            "GET",
            "/v1/health",
            profile_a_headers,
            None,
            mini_health,
            redactions,
        )
        shipping_sources_response = request(
            shipping_mini_port, "GET", "/v1/sources", headers=shipping_headers
        )
        if shipping_sources_response["status"] != 200:
            raise AssertionError("the shipping Mini source set is unavailable")
        shipping_sources_document = json.loads(shipping_sources_response["body"])
        actual_shipping_ids = sorted(
            source["id"] for source in shipping_sources_document.get("sources", [])
        )
        expected_shipping_ids = sorted(shipping_catalog_audit["enabledIndexerIds"])
        if actual_shipping_ids != expected_shipping_ids:
            raise AssertionError(
                "the shipping Mini active set differs from its catalog"
            )
        save_transcript(
            transcripts,
            "setup-mini-shipping-sources",
            "GET",
            "/v1/sources",
            shipping_headers,
            None,
            shipping_sources_response,
            redactions,
        )
        excluded_statuses = {}
        for reason, indexer_ids in shipping_catalog_audit["excludedIndexerIds"].items():
            excluded_statuses[reason] = {}
            for indexer_id in indexer_ids:
                excluded_response = request(
                    shipping_mini_port,
                    "POST",
                    "/v1/search",
                    body={"query": "policy-boundary", "sourceIds": [indexer_id]},
                    headers=shipping_headers,
                )
                excluded_statuses[reason][indexer_id] = excluded_response["status"]
                if excluded_response["status"] != 400:
                    raise AssertionError(
                        f"excluded source became callable: {reason}/{indexer_id}"
                    )
        repeated_shipping_sources = request(
            shipping_mini_port, "GET", "/v1/sources", headers=shipping_headers
        )
        if json.loads(repeated_shipping_sources["body"]) != shipping_sources_document:
            raise AssertionError(
                "search capability use altered the immutable active set"
            )
        write_json(
            artifacts / "shipping-runtime-policy-evidence.json",
            {
                "activeIndexerIds": actual_shipping_ids,
                "activeSetImmutable": True,
                "catalogFileSha256": mini_manifest["catalogFileSha256"],
                "catalogPolicySha256": mini_manifest["providerPolicySha256"],
                "excludedStatuses": excluded_statuses,
            },
        )
        save_transcript(
            transcripts,
            "setup-mini-profile-b-health",
            "GET",
            "/v1/health",
            profile_b_headers,
            None,
            mini_profile_b_health,
            redactions,
        )

        login_start = request(pristine_port, "GET", "/UI/Login")
        test_cookie = response_cookie(login_start, "TestCookie")
        test_headers = {"Cookie": f"TestCookie={test_cookie}"}
        login_test = request(
            pristine_port, "GET", "/UI/TestCookie", headers=test_headers
        )
        login_finish = request(
            pristine_port, "GET", "/UI/Login?cookiesChecked=1", headers=test_headers
        )
        dashboard_cookie = response_cookie(login_finish, "Jackett")
        if len(dashboard_cookie) >= 16:
            redactions.append((dashboard_cookie, "<redacted-dashboard-cookie>"))
        dashboard_headers = {"Cookie": f"Jackett={dashboard_cookie}"}
        save_transcript(
            transcripts,
            "setup-login-start",
            "GET",
            "/UI/Login",
            {},
            None,
            login_start,
            redactions,
        )
        save_transcript(
            transcripts,
            "setup-login-test",
            "GET",
            "/UI/TestCookie",
            test_headers,
            None,
            login_test,
            redactions,
        )
        save_transcript(
            transcripts,
            "setup-login-finish",
            "GET",
            "/UI/Login?cookiesChecked=1",
            test_headers,
            None,
            login_finish,
            redactions,
        )

        configure_indexer(
            pristine_port, "oracle-main", dashboard_headers, transcripts, redactions
        )
        configure_indexer(
            pristine_port,
            "oracle-alternate",
            dashboard_headers,
            transcripts,
            redactions,
        )

        def filelist_config(document):
            values = {
                "sitelink": fixture_server.origin + "/",
                "username": TRACKER_USERNAME,
                "passkey": TRACKER_PASSKEY,
            }
            for item in document:
                if item.get("id") in values:
                    item["value"] = values[item["id"]]

        configure_indexer(
            pristine_port,
            "filelist",
            dashboard_headers,
            transcripts,
            redactions,
            filelist_config,
        )

        scenario_index = 0

        def run_scenario(name, path, ported, normalization, timeout=20, guard=None):
            nonlocal scenario_index
            scenario_index += 1
            response = request(pristine_port, "GET", path, timeout=timeout)
            save_transcript(
                transcripts,
                f"{scenario_index:02d}-pristine-{name}",
                "GET",
                path,
                {},
                None,
                response,
                redactions,
            )
            method, mini_path, mini_body, mini_headers, mini_timeout = mini_case(
                name, capability
            )
            mini_response = request(
                mini_port,
                method,
                mini_path,
                mini_body,
                mini_headers,
                timeout=mini_timeout,
            )
            save_transcript(
                transcripts,
                f"{scenario_index:02d}-mini-{name}",
                method,
                mini_path,
                mini_headers,
                mini_body,
                mini_response,
                redactions,
            )
            canonical = canonical_response(response)
            if guard is not None:
                canonical["clientGuard"] = guard_result(guard)
            observed[name] = canonical
            pristine_raw[name] = response
            mini_raw[name] = mini_response
            mini_observed[name] = canonical_mini_response(mini_response)
            semantic_diffs[name] = {
                "pristine": canonical,
                "mini": mini_observed[name],
                "diff": normalized_semantic_diff(canonical, mini_observed[name]),
                "normalization": normalization,
            }
            mappings.append({
                "scenario": name,
                "original": "GET " + redact_text(path, redactions),
                "ported": ported,
                "executedMini": f"{method} {mini_path}",
                "statuses": {
                    "pristine": response["status"],
                    "mini": mini_response["status"],
                },
                "normalization": normalization,
                "executedSideBySide": True,
            })
            return response

        def record_mini_evidence(
            name,
            method,
            path,
            body,
            headers,
            pristine_semantics,
            normalization,
            response=None,
            port=mini_port,
        ):
            nonlocal scenario_index
            scenario_index += 1
            response = response or request(
                port, method, path, body, headers, timeout=35
            )
            save_transcript(
                transcripts,
                f"{scenario_index:02d}-mini-{name}",
                method,
                path,
                headers,
                body,
                response,
                redactions,
            )
            canonical = canonical_mini_response(response)
            security_evidence[name] = canonical
            semantic_diffs[name] = {
                "pristine": pristine_semantics,
                "mini": canonical,
                "diff": normalized_semantic_diff(pristine_semantics, canonical),
                "normalization": normalization,
            }
            mappings.append({
                "scenario": name,
                "original": pristine_semantics,
                "ported": f"{method} {path}",
                "executedMini": f"{method} {path}",
                "statuses": {"mini": response["status"]},
                "normalization": normalization,
                "executedSideBySide": True,
            })
            return response

        def torznab(indexer, **params):
            values = {"apikey": api_key, **params}
            return (
                f"/api/v2.0/indexers/{indexer}/results/torznab/api?"
                + urllib.parse.urlencode(values)
            )

        run_scenario(
            "valid-apikey",
            torznab("oracle-main", t="caps"),
            "GET /v1/sources + bearer capability",
            "caps become immutable source status",
        )
        run_scenario(
            "valid-passkey-alias",
            "/api/v2.0/indexers/oracle-main/results/torznab/api?"
            + urllib.parse.urlencode({"passkey": api_key, "t": "caps"}),
            "GET /v1/sources?passkey=forbidden",
            "alias succeeds only on the pristine oracle",
        )
        run_scenario(
            "missing-apikey",
            "/api/v2.0/indexers/oracle-main/results/torznab/api?t=caps",
            "GET /v1/sources without bearer capability",
            "Torznab 100 maps to product authentication denial",
        )
        run_scenario(
            "invalid-apikey",
            "/api/v2.0/indexers/oracle-main/results/torznab/api?apikey=invalid&t=caps",
            "GET /v1/sources with invalid bearer capability",
            "Torznab 100 maps to product authentication denial",
        )
        run_scenario(
            "omitted-indexer-route",
            "/api/v2.0/indexers//results/torznab/api?"
            + urllib.parse.urlencode({"apikey": api_key, "t": "caps"}),
            "POST /v1/search with no source IDs",
            "the public route does not expose the source code-200 filter branch",
        )
        run_scenario(
            "unsupported-indexer",
            torznab("not-an-indexer", t="caps"),
            "POST /v1/search with an unknown source ID",
            "Torznab 201 maps to bounded validation failure",
        )
        run_scenario(
            "unsupported-mode",
            torznab("oracle-main", t="not-a-mode"),
            "POST /v1/search with unsupported operation",
            "Torznab 201 maps to bounded validation failure",
        )
        run_scenario(
            "unavailable-indexers-mode",
            torznab("oracle-main", t="indexers"),
            "GET /v1/sources",
            "the validation filter returns Torznab 201 before the controller's unavailable-function branch",
        )
        run_scenario(
            "unavailable-tmdb-function",
            torznab("oracle-main", t="movie", q="fixture", tmdbid="123"),
            "POST /v1/search with an unsupported typed media parameter",
            "Torznab 203 maps to bounded provider capability validation",
        )
        run_scenario(
            "invalid-imdb-parameter",
            torznab("oracle-main", t="movie", imdbid="invalid"),
            "POST /v1/search with invalid typed media parameter",
            "Torznab 201/203 maps to bounded validation failure",
        )

        for fault in ("malformed", "deep", "entity", "oversized"):
            payload = fixture_xml(fixture_server.origin, "main", fault)
            run_scenario(
                f"tracker-{fault}-xml",
                torznab("oracle-main", t="search", q=fault, cache="false"),
                "POST /v1/search using the retained provider engine",
                "upstream shape is recorded; the independent client guard rejects unsafe XML",
                guard=payload,
            )
        run_scenario(
            "tracker-tls-failure",
            torznab("oracle-main", t="search", q="tls-failure", cache="false"),
            "POST /v1/search",
            "transport failure maps to a bounded provider error",
        )
        run_scenario(
            "redirect-once",
            torznab("oracle-main", t="search", q="redirect-once", cache="false"),
            "POST /v1/search",
            "the retained provider follows the bounded redirect",
        )
        run_scenario(
            "redirect-loop",
            torznab("oracle-main", t="search", q="redirect-loop", cache="false"),
            "POST /v1/search",
            "redirect exhaustion maps to a bounded provider error",
        )
        run_scenario(
            "http-429-retry-after",
            torznab("filelist", t="search", q="rate-limit", cache="false"),
            "POST /v1/search",
            "HTTP 429/code 900 and Retry-After map to rate-limited provider state",
        )
        run_scenario(
            "peer-counts",
            torznab("oracle-main", t="search", q="peer-counts", cache="false"),
            "POST /v1/search",
            "peers is total; derive max(0, peers - seeders) and preserve absent values",
        )
        run_scenario(
            "adult-category-matrix",
            torznab("oracle-main", t="search", q="adult-categories", cache="false"),
            "POST /v1/search",
            "all 6000-series results are dropped by product policy",
        )
        run_scenario(
            "mixed-safe-adult-category",
            torznab("oracle-main", t="search", q="mixed-categories", cache="false"),
            "POST /v1/search",
            "one adult category drops the complete result",
        )
        run_scenario(
            "missing-category",
            torznab("oracle-main", t="search", q="missing-category", cache="false"),
            "POST /v1/search",
            "missing categories remain explicit and policy-bounded",
        )
        malicious = run_scenario(
            "malicious-fields",
            torznab("oracle-main", t="search", q="malicious", cache="false"),
            "POST /v1/search",
            "sanitize text and replace acquisition URLs with opaque IDs",
        )

        caps = observed["valid-apikey"]
        custom_id = (
            int.from_bytes(hashlib.sha1(b"safe").digest()[:2], "little") + 100000
        )
        if custom_id not in caps.get("categoryIds", []):
            raise AssertionError("fixture did not expose a custom per-indexer category")
        run_scenario(
            "custom-category",
            torznab(
                "oracle-main",
                t="search",
                q="custom-category",
                cat=str(custom_id),
                cache="false",
            ),
            "POST /v1/search with caps-driven source category",
            "custom categories remain per-indexer and never pass through /all",
        )
        run_scenario(
            "duplicate-infohash-alternates",
            torznab("all", t="search", q="duplicates", cache="false"),
            "POST /v1/search",
            "deduplicate BTIH while retaining alternate provider provenance",
        )
        run_scenario(
            "partial-success",
            torznab("all", t="search", q="partial", cache="false"),
            "POST /v1/search",
            "successful providers and bounded failure states form a partial response",
        )
        configure_indexer(
            pristine_port, "oracle-adult", dashboard_headers, transcripts, redactions
        )
        run_scenario(
            "adult-provider-generic-8000",
            torznab(
                "oracle-adult", t="search", q="adult-provider-generic", cache="false"
            ),
            "POST /v1/search",
            "provider classification drops adult-only sources even when the result says 8000",
        )

        before_cache = fixture_server.generations.get("main:cache", 0)
        mini_before_cache = fixture_server.generations.get("mini-main:cache", 0)
        run_scenario(
            "cache-first",
            torznab("oracle-main", t="search", q="cache", cache="true"),
            "POST /v1/search",
            "first retained-engine cache population",
        )
        run_scenario(
            "cache-hit",
            torznab("oracle-main", t="search", q="cache", cache="true"),
            "POST /v1/search",
            "same query reuses the intentional cache",
        )
        observed["cache-hit"]["fixtureRequests"] = (
            fixture_server.generations.get("main:cache", 0) - before_cache
        )
        mini_observed["cache-hit"]["fixtureRequests"] = (
            fixture_server.generations.get("mini-main:cache", 0) - mini_before_cache
        )
        time.sleep(1.25)
        run_scenario(
            "cache-expired",
            torznab("oracle-main", t="search", q="cache", cache="true"),
            "POST /v1/search",
            "expired cache entry causes a fresh provider request",
        )
        observed["cache-expired"]["fixtureRequests"] = (
            fixture_server.generations.get("main:cache", 0) - before_cache
        )
        mini_observed["cache-expired"]["fixtureRequests"] = (
            fixture_server.generations.get("mini-main:cache", 0) - mini_before_cache
        )
        bypass_before = fixture_server.generations.get("main:cache", 0)
        mini_bypass_before = fixture_server.generations.get("mini-main:cache", 0)
        run_scenario(
            "cache-bypass-first",
            torznab("oracle-main", t="search", q="cache", cache="false"),
            "POST /v1/search",
            "product cache policy is internal and has no raw switch",
        )
        run_scenario(
            "cache-bypass-second",
            torznab("oracle-main", t="search", q="cache", cache="false"),
            "POST /v1/search",
            "fresh requests do not expose the upstream cache switch",
        )
        observed["cache-bypass-second"]["fixtureRequests"] = (
            fixture_server.generations.get("main:cache", 0) - bypass_before
        )
        mini_observed["cache-bypass-second"]["fixtureRequests"] = (
            fixture_server.generations.get("mini-main:cache", 0) - mini_bypass_before
        )

        generation_results = {}
        completion_order = []
        mini_generation_results = {}
        mini_completion_order = []

        def generation_request(label, query):
            response = request(
                pristine_port,
                "GET",
                torznab("oracle-main", t="search", q=query, cache="false"),
                timeout=5,
            )
            generation_results[label] = response
            completion_order.append(label)

        def mini_generation_request(label, query):
            body = mini_search_body(query, ["showrss"])
            response = request(
                mini_port,
                "POST",
                "/v1/search",
                body,
                {**profile_a_headers, "Content-Type": "application/json"},
                timeout=5,
            )
            mini_generation_results[label] = response
            mini_completion_order.append(label)

        slow_thread = threading.Thread(
            target=generation_request, args=("slow", "slow-generation")
        )
        mini_slow_thread = threading.Thread(
            target=mini_generation_request, args=("slow", "slow-generation")
        )
        slow_thread.start()
        mini_slow_thread.start()
        deadline = time.monotonic() + 2
        while (
            fixture_server.generations.get("main:slow-generation", 0) == 0
            or fixture_server.generations.get("mini-main:slow-generation", 0) == 0
        ) and time.monotonic() < deadline:
            time.sleep(0.01)
        fast_thread = threading.Thread(
            target=generation_request, args=("fast", "fast-generation")
        )
        mini_fast_thread = threading.Thread(
            target=mini_generation_request, args=("fast", "fast-generation")
        )
        fast_thread.start()
        mini_fast_thread.start()
        for thread in (slow_thread, fast_thread, mini_slow_thread, mini_fast_thread):
            thread.join(timeout=6)
        if any(
            thread.is_alive()
            for thread in (slow_thread, fast_thread, mini_slow_thread, mini_fast_thread)
        ):
            raise AssertionError("stale-generation fixture did not finish")
        for label in ("slow", "fast"):
            scenario_index += 1
            path = torznab(
                "oracle-main", t="search", q=f"{label}-generation", cache="false"
            )
            save_transcript(
                transcripts,
                f"{scenario_index:02d}-pristine-stale-generation-{label}",
                "GET",
                path,
                {},
                None,
                generation_results[label],
                redactions,
            )
            body = mini_search_body(f"{label}-generation", ["showrss"])
            mini_headers = {**profile_a_headers, "Content-Type": "application/json"}
            save_transcript(
                transcripts,
                f"{scenario_index:02d}-mini-stale-generation-{label}",
                "POST",
                "/v1/search",
                mini_headers,
                body,
                mini_generation_results[label],
                redactions,
            )
        observed["stale-generation"] = {
            "completionOrder": completion_order,
            "slow": canonical_response(generation_results["slow"]),
            "fast": canonical_response(generation_results["fast"]),
        }
        mini_observed["stale-generation"] = {
            "completionOrder": mini_completion_order,
            "slow": canonical_mini_response(mini_generation_results["slow"]),
            "fast": canonical_mini_response(mini_generation_results["fast"]),
        }
        semantic_diffs["stale-generation"] = {
            "pristine": observed["stale-generation"],
            "mini": mini_observed["stale-generation"],
            "diff": normalized_semantic_diff(
                observed["stale-generation"], mini_observed["stale-generation"]
            ),
            "normalization": "both services may finish stale work last; the browser consumer owns generation suppression",
        }
        mappings.append({
            "scenario": "stale-generation",
            "original": "two overlapping GET Torznab searches, slow then fast",
            "ported": "two POST /v1/search generations on one UI surface",
            "normalization": "the oracle may finish stale work last; the port discards the stale generation",
            "executedMini": "two overlapping POST /v1/search requests, slow then fast",
            "statuses": {
                "pristine": [
                    generation_results[label]["status"] for label in ("slow", "fast")
                ],
                "mini": [
                    mini_generation_results[label]["status"]
                    for label in ("slow", "fast")
                ],
            },
            "executedSideBySide": True,
        })

        run_scenario(
            "hanging-provider-timeout",
            torznab("oracle-main", t="search", q="hang", cache="false"),
            "POST /v1/search with a bounded provider deadline",
            "client timeout/cancellation becomes bounded provider state",
            timeout=0.5,
        )

        parsed_malicious = parse_torznab(
            malicious["body"], "oracle-main", "Oracle Main"
        )
        malicious_link = parsed_malicious["results"][0]["_link"]
        target = urllib.parse.urlsplit(malicious_link)
        first_download = request(
            pristine_port,
            "GET",
            target.path + ("?" + target.query if target.query else ""),
        )
        second_download = request(
            pristine_port,
            "GET",
            target.path + ("?" + target.query if target.query else ""),
        )
        mini_malicious = json.loads(mini_raw["malicious-fields"]["body"])
        if mini_raw["malicious-fields"]["status"] != 200 or not mini_malicious.get(
            "results"
        ):
            raise AssertionError(
                "Mini did not return an opaque malicious-field fixture result"
            )
        if RAW_URL_SECRET.encode() in mini_raw["malicious-fields"]["body"]:
            raise AssertionError("Mini exposed a raw acquisition URL")
        result_id = mini_malicious["results"][0]["resultId"]
        redactions.append((result_id, "<redacted-opaque-result-id>"))
        resolve_path = f"/v1/results/{result_id}/resolve"
        profile_b_result = request(
            mini_profile_b_port,
            "POST",
            resolve_path,
            b"",
            profile_b_headers,
        )
        first_mini_resolve = request(
            mini_port, "POST", resolve_path, b"", profile_a_headers
        )
        second_mini_resolve = request(
            mini_port, "POST", resolve_path, b"", profile_a_headers
        )
        for label, pristine_response, mini_response in (
            ("first", first_download, first_mini_resolve),
            ("second", second_download, second_mini_resolve),
        ):
            scenario_index += 1
            save_transcript(
                transcripts,
                f"{scenario_index:02d}-pristine-acquisition-reuse-{label}",
                "GET",
                malicious_link,
                {},
                None,
                pristine_response,
                redactions,
            )
            save_transcript(
                transcripts,
                f"{scenario_index:02d}-mini-acquisition-reuse-{label}",
                "POST",
                resolve_path,
                profile_a_headers,
                b"",
                mini_response,
                redactions,
            )
        observed["acquisition-url-reuse"] = {
            "firstStatus": first_download["status"],
            "secondStatus": second_download["status"],
            "sameBytes": first_download["body"] == second_download["body"],
        }
        mini_observed["acquisition-url-reuse"] = {
            "first": canonical_mini_response(first_mini_resolve),
            "second": canonical_mini_response(second_mini_resolve),
            "oneShot": first_mini_resolve["status"] == 200
            and second_mini_resolve["status"] == 404,
        }
        semantic_diffs["acquisition-url-reuse"] = {
            "pristine": observed["acquisition-url-reuse"],
            "mini": mini_observed["acquisition-url-reuse"],
            "diff": normalized_semantic_diff(
                observed["acquisition-url-reuse"],
                mini_observed["acquisition-url-reuse"],
            ),
            "normalization": "Mini intentionally replaces reusable proxy URLs with one-shot opaque profile-scoped IDs",
        }
        mappings.append({
            "scenario": "acquisition-url-reuse",
            "original": "repeat GET of redacted pristine proxy URL",
            "ported": "POST /v1/results/:opaque-result-id/resolve",
            "executedMini": "repeat POST /v1/results/:opaque-result-id/resolve",
            "statuses": {
                "pristine": [first_download["status"], second_download["status"]],
                "mini": [first_mini_resolve["status"], second_mini_resolve["status"]],
            },
            "normalization": "the port intentionally adds one-shot, expiry, and profile scope",
            "executedSideBySide": True,
        })

        record_mini_evidence(
            "cross-profile-result-isolation",
            "POST",
            resolve_path,
            b"",
            profile_b_headers,
            "pristine proxy URLs are service-global and reusable",
            "a result issued to profile A is unknown to profile B",
            response=profile_b_result,
            port=mini_profile_b_port,
        )
        reconnected_health = record_mini_evidence(
            "same-profile-http-reconnection",
            "GET",
            "/v1/health",
            None,
            profile_a_headers,
            "pristine keeps one process-global data root",
            "a second authenticated connection reaches the same service and data root",
        )
        reconnected_health_document = json.loads(reconnected_health["body"])
        security_evidence["same-profile-http-reconnection"].update({
            "sameInstanceId": reconnected_health_document.get("instanceId")
            == mini_health_document.get("instanceId"),
            "sameDataRootId": reconnected_health_document.get("dataRootId")
            == mini_health_document.get("dataRootId"),
        })
        if not all(
            security_evidence["same-profile-http-reconnection"][key]
            for key in ("sameInstanceId", "sameDataRootId")
        ):
            raise AssertionError("same-profile Mini HTTP reconnection changed identity")
        unknown_id = "E" * 32
        expired_path = f"/v1/results/{unknown_id}/resolve"
        expired = record_mini_evidence(
            "expired-opaque-result",
            "POST",
            expired_path,
            b"",
            profile_a_headers,
            "pristine exposes a reusable acquisition proxy URL",
            "expired and unknown opaque IDs share a bounded 404 contract",
        )
        if (
            expired["status"] != 404
            or json.loads(expired["body"]).get("error") != "unknown-or-expired-result"
        ):
            raise AssertionError("expired opaque result contract is not bounded")
        security_evidence["expired-opaque-result"]["sourceContract"] = (
            mini_result_store_contract(mini_runtime)
        )

        capability_cases = [
            (
                "capability-origin-boundary",
                mini_port,
                {**profile_a_headers, "Origin": "https://example.invalid"},
                403,
            ),
            (
                "capability-host-boundary",
                mini_port,
                {**profile_a_headers, "Host": f"localhost:{mini_port}"},
                403,
            ),
            (
                "cross-profile-capability-a-to-b",
                mini_profile_b_port,
                profile_a_headers,
                401,
            ),
            (
                "cross-profile-capability-b-to-a",
                mini_port,
                profile_b_headers,
                401,
            ),
        ]
        for name, port, headers, expected_status in capability_cases:
            denied = record_mini_evidence(
                name,
                "GET",
                "/v1/sources",
                None,
                headers,
                "pristine accepts an API key or passkey on its public Torznab route",
                "Mini binds bearer capabilities to loopback host/origin and one profile service",
                port=port,
            )
            if denied["status"] != expected_status:
                raise AssertionError(f"Mini capability boundary failed: {name}")
        query_secret = record_mini_evidence(
            "capability-query-secret-boundary",
            "GET",
            "/v1/sources?capability=forbidden",
            None,
            profile_a_headers,
            "pristine accepts query-string API credentials",
            "Mini rejects query-string secrets even with a valid bearer capability",
        )
        if query_secret["status"] != 400:
            raise AssertionError("Mini accepted a query-string capability")

        removed_routes = [
            ("GET", "/UI/Dashboard"),
            ("GET", "/api/v2.0/indexers/showrss/Config"),
            ("POST", "/api/v2.0/indexers/showrss/Config"),
            ("POST", "/api/v2.0/indexers/showrss/Test"),
            ("DELETE", "/api/v2.0/indexers/showrss"),
            ("GET", "/api/v2.0/indexers/showrss/results/torznab/api"),
            ("POST", "/api/v2.0/server/config"),
            ("POST", "/api/v2.0/server/update"),
        ]
        removed_statuses = {}
        for index, (method, path) in enumerate(removed_routes):
            body = b"{}" if method == "POST" else None
            headers = {
                **profile_a_headers,
                **({"Content-Type": "application/json"} if body else {}),
            }
            removed = record_mini_evidence(
                f"removed-route-{index + 1}",
                method,
                path,
                body,
                headers,
                "pristine exposes mutable dashboard/configuration/update or raw Torznab surfaces",
                "Mini deliberately removes the route",
            )
            removed_statuses[f"{method} {path}"] = removed["status"]
        if set(removed_statuses.values()) != {404}:
            raise AssertionError("a removed Mini route remained reachable")
        write_json(artifacts / "removed-route-statuses.json", removed_statuses)

        if fixture_server.entity_leak_requests:
            raise AssertionError("a tracker parser resolved an external XML entity")
        observed["external-entity-network"] = {
            "requests": fixture_server.entity_leak_requests
        }
        observed["error-code-200-source-contract"] = source_contract(pristine_source)
        mini_observed["external-entity-network"] = {
            "requests": fixture_server.entity_leak_requests,
            "providerResponse": canonical_mini_response(mini_raw["tracker-entity-xml"]),
        }
        source_contract_response = request(
            mini_port,
            "GET",
            "/api/v2.0/indexers//results/torznab/api",
            headers=profile_a_headers,
        )
        record_mini_evidence(
            "error-code-200-source-contract",
            "GET",
            "/api/v2.0/indexers//results/torznab/api",
            None,
            profile_a_headers,
            observed["error-code-200-source-contract"],
            "Mini has no raw Torznab controller and returns 404",
            response=source_contract_response,
        )
        mini_observed["error-code-200-source-contract"] = security_evidence[
            "error-code-200-source-contract"
        ]
        semantic_diffs["external-entity-network"] = {
            "pristine": observed["external-entity-network"],
            "mini": mini_observed["external-entity-network"],
            "diff": normalized_semantic_diff(
                observed["external-entity-network"],
                mini_observed["external-entity-network"],
            ),
            "normalization": "both retained-engine calls must cause zero external entity-resolution requests",
        }
        mappings.append({
            "scenario": "external-entity-network",
            "original": "entity-bearing local tracker XML",
            "ported": "retained engine response consumed by the bounded XML client",
            "executedMini": "POST /v1/search with entity-bearing deterministic tracker XML",
            "statuses": {
                "pristine": pristine_raw["tracker-entity-xml"]["status"],
                "mini": mini_raw["tracker-entity-xml"]["status"],
            },
            "normalization": "DTD/entity input is rejected and causes zero entity-resolution requests",
            "executedSideBySide": True,
        })
        contradictory_payload = b"""<?xml version="1.0"?><rss xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><item><title>Contradictory peers</title><guid>contradictory</guid><torznab:attr name="category" value="2000"/><torznab:attr name="seeders" value="10"/><torznab:attr name="peers" value="3"/><torznab:attr name="infohash" value="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"/></item></channel></rss>"""
        contradictory = parse_torznab(
            contradictory_payload, "oracle-wire", "Oracle Wire"
        )["results"][0]
        observed["contradictory-peer-client-guard"] = {
            "seeders": contradictory["seeders"],
            "peers": 3,
            "normalizedLeechers": contradictory["leechers"],
        }
        mini_peer_items = mini_observed["peer-counts"].get("items", [])
        mini_contradictory = next(
            item
            for item in mini_peer_items
            if item["title"] == "Negative leechers normalized"
        )
        mini_observed["contradictory-peer-client-guard"] = {
            "seeders": mini_contradictory["seeders"],
            "normalizedLeechers": mini_contradictory["normalizedLeechers"],
        }
        semantic_diffs["contradictory-peer-client-guard"] = {
            "pristine": observed["contradictory-peer-client-guard"],
            "mini": mini_observed["contradictory-peer-client-guard"],
            "diff": normalized_semantic_diff(
                observed["contradictory-peer-client-guard"],
                mini_observed["contradictory-peer-client-guard"],
            ),
            "normalization": "both consumers clamp contradictory total peers below seeders to zero leechers",
        }
        mappings.append({
            "scenario": "contradictory-peer-client-guard",
            "original": "recorded Torznab item with seeders=10 and total peers=3",
            "ported": "POST /v1/search normalized result",
            "executedMini": "POST /v1/search query=peer-counts",
            "statuses": {
                "pristine": pristine_raw["peer-counts"]["status"],
                "mini": mini_raw["peer-counts"]["status"],
            },
            "normalization": "derive max(0, peers - seeders)",
            "executedSideBySide": True,
        })

        validate_matrix(observed)
        validate_mini_matrix(mini_observed, security_evidence, removed_statuses)
        missing_mini = sorted(set(observed) - set(mini_observed))
        if missing_mini:
            raise AssertionError(
                f"adversarial scenarios were not executed against Mini: {missing_mini}"
            )
        for name in set(observed) & set(mini_observed):
            semantic_diffs.setdefault(name, {})
            semantic_diffs[name]["pristine"] = observed[name]
            semantic_diffs[name]["mini"] = mini_observed[name]
            semantic_diffs[name]["diff"] = normalized_semantic_diff(
                observed[name], mini_observed[name]
            )
        write_json(artifacts / "normalized-semantic-error-diffs.json", semantic_diffs)
        validate_mini_semantics(observed, mini_observed)

        listener_filter = " or ".join(
            f"sport = :{port}"
            for port in (
                pristine_port,
                mini_port,
                mini_profile_b_port,
                shipping_mini_port,
                fixture_port,
            )
        )
        run_command(["ss", "-ltnp", listener_filter], logs / "loopback-listeners.log")
        listener_text = (logs / "loopback-listeners.log").read_text(encoding="utf-8")
        if any(
            f"127.0.0.1:{port}" not in listener_text
            for port in (
                pristine_port,
                mini_port,
                mini_profile_b_port,
                shipping_mini_port,
            )
        ):
            raise AssertionError("a service loopback listener was not observed")
        if f"{args.fixture_address}:{fixture_port}" not in listener_text:
            raise AssertionError("the deterministic fixture listener was not observed")
        if any(
            marker in listener_text
            for port in (
                pristine_port,
                mini_port,
                mini_profile_b_port,
                shipping_mini_port,
            )
            for marker in (f"0.0.0.0:{port}", f"[::]:{port}", f"*:{port}")
        ):
            raise AssertionError("a Jackett service exposed a wildcard listener")

        expected = json.loads(expected_path.read_text(encoding="utf-8"))
        write_json(artifacts / "canonical-pristine-observed.json", observed)
        write_json(artifacts / "canonical-pristine-expected.json", expected)
        write_json(artifacts / "canonical-mini-observed.json", mini_observed)
        write_json(artifacts / "security-boundary-evidence.json", security_evidence)
        diff = "".join(
            difflib.unified_diff(
                canonical_json(expected).splitlines(keepends=True),
                canonical_json(observed).splitlines(keepends=True),
                fromfile="pinned-expected",
                tofile="pristine-observed",
            )
        )
        (artifacts / "canonical-pristine.diff").write_text(diff, encoding="utf-8")
        write_json(artifacts / "request-mapping.json", mappings)
        write_json(
            artifacts / "fixture-requests.redacted.json",
            json.loads(
                redact_text(canonical_json(fixture_server.requests), redactions)
            ),
        )
        write_json(
            artifacts / "fixture-responses.redacted.json",
            json.loads(
                redact_text(canonical_json(fixture_server.responses), redactions)
            ),
        )
        redacted_config = dict(server_config)
        redacted_config["APIKey"] = "<redacted>"
        redacted_config["InstanceId"] = "<redacted>"
        write_json(artifacts / "pristine-config.redacted.json", redacted_config)
        metadata = {
            "schemaVersion": 1,
            "oracleOnly": False,
            "sourceCommit": COMMIT,
            "sourceVersion": VERSION,
            "sourceArchiveSha256": SOURCE_SHA256,
            "sourceManifestSha256": source_manifest_evidence["manifestSha256"],
            "sourceManifestEntryCount": source_manifest_evidence["entryCount"],
            "platform": "linux-x86_64-glibc",
            "executionMode": "rootless-oci-internal-network",
            "ociIsolation": oci_evidence,
            "ports": {
                "fixture": fixture_port,
                "pristine": pristine_port,
                "miniProfileA": mini_port,
                "miniProfileB": mini_profile_b_port,
                "miniShipping": shipping_mini_port,
            },
            "runtimes": {
                "pristineExecutableSha256": sha256_file(pristine_executable),
                "miniExecutableSha256": sha256_file(mini_executable),
                "miniManifestSha256": sha256_file(mini_manifest_path),
                "miniRuntimeInventorySha256": mini_manifest["runtimeSha256"],
                "miniFixtureExecutableSha256": sha256_file(mini_fixture_executable),
                "miniFixtureManifestSha256": sha256_file(mini_fixture_manifest_path),
                "miniFixtureRuntimeInventorySha256": mini_fixture_manifest[
                    "runtimeSha256"
                ],
                "pristineBuildRecordSha256": sha256_file(pristine_build_record_path),
                "pristineRuntimeInventorySha256": pristine_build_record[
                    "runtimeInventorySha256"
                ],
                "pristineSdkPlatformDigest": pristine_build_record["sdkPlatformDigest"],
            },
            "miniOverlay": {
                "catalogSha256": sha256_file(mini_fixture_runtime / "catalog.json"),
                "definitionSha256": {
                    indexer_id: sha256_file(
                        mini_fixture_runtime / "Definitions" / f"{indexer_id}.yml"
                    )
                    for indexer_id in sorted(MINI_SOURCES)
                },
                "enabledSources": sorted(MINI_SOURCES),
                "separatelyBuilt": True,
                "productionRuntimeSha256": mini_fixture_manifest[
                    "productionRuntimeSha256"
                ],
            },
            "profileIsolation": {
                "dataRootIdsDistinct": True,
                "profileADataRootIdSha256": hashlib.sha256(
                    mini_health_document["dataRootId"].encode()
                ).hexdigest(),
                "profileBDataRootIdSha256": hashlib.sha256(
                    mini_profile_b_health_document["dataRootId"].encode()
                ).hexdigest(),
            },
            "managerLifecycleGate": {
                "test": "managed-services/jackett-mini/test/process.test.mjs",
                "requiresRuntime": True,
                "freshLauncherRevalidatesPidStartTimeInstanceDataRootAndExecutable": True,
            },
            "expectedSnapshotSha256": sha256_file(expected_path),
            "cacheTtlSeconds": {"pristine": 1, "mini": 300},
            "scenarioCounts": {
                "pristine": len(observed),
                "miniPaired": len(mini_observed),
                "miniSecurityBoundary": len(security_evidence),
            },
            "normalizations": [
                "ports",
                "elapsed timing",
                "opaque IDs",
                "error descriptions",
                "redacted secrets, acquisition paths, and input paths",
            ],
            "contactedImplementations": [
                "pristine-jackett-v0.24.2360",
                "jackett-mini-v0.24.2360",
                "deterministic-local-fixture",
            ],
            "prohibitedImplementations": ["browser-runtime", "torrent-runtime"],
        }
        write_json(artifacts / "run-metadata.json", metadata)
        if diff:
            raise AssertionError("unexplained pristine adversarial snapshot difference")
        success = True
    except Exception:
        (artifacts / "failure.txt").write_text(traceback.format_exc(), encoding="utf-8")
        raise
    finally:
        if bootstrap and bootstrap.poll() is None:
            cleanup["processes"]["bootstrapExitCode"] = stop_process(bootstrap)
        if bootstrap_log and not bootstrap_log.closed:
            bootstrap_log.close()
        processes = (
            ("pristine", process, process_log),
            ("miniProfileA", mini_process, mini_process_log),
            ("miniProfileB", mini_profile_b_process, mini_profile_b_process_log),
            ("miniShipping", shipping_mini_process, shipping_mini_process_log),
        )
        orphaned = {}
        for label, service_process, service_log in processes:
            if service_process:
                exit_code = stop_process(service_process)
                remaining = process_group_members(service_process)
                cleanup["processes"][label] = {
                    "exitCode": exit_code,
                    "remainingProcessGroupMembers": remaining,
                }
                if remaining:
                    orphaned[label] = remaining
            if service_log:
                service_log.close()
        fixture_server.shutdown()
        fixture_server.server_close()
        fixture_thread.join(timeout=6)
        cleanup["fixtureStopped"] = not fixture_thread.is_alive()
        for label, address, port in (
            ("pristine", "127.0.0.1", pristine_port),
            ("miniProfileA", "127.0.0.1", mini_port),
            ("miniProfileB", "127.0.0.1", mini_profile_b_port),
            ("miniShipping", "127.0.0.1", shipping_mini_port),
            ("fixture", args.fixture_address, fixture_port),
        ):
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
                probe.settimeout(0.2)
                cleanup["ports"][label] = (
                    "closed" if probe.connect_ex((address, port)) != 0 else "open"
                )
        for label, directory in (
            ("pristine", pristine_data),
            ("miniProfileA", mini_data),
            ("miniProfileB", mini_profile_b_data),
            ("miniShipping", shipping_mini_data),
        ):
            shutil.rmtree(directory, ignore_errors=True)
            cleanup["dataRootsRemoved"][label] = not directory.exists()
        cleanup["testRuntimeRemoved"] = True
        cleanup["comparisonSucceeded"] = success
        cleanup["noOrphanedProcessGroups"] = not orphaned
        cleanup_succeeded = (
            cleanup["fixtureStopped"]
            and set(cleanup["ports"].values()) == {"closed"}
            and all(cleanup["dataRootsRemoved"].values())
            and cleanup["testRuntimeRemoved"]
            and not orphaned
        )
        cleanup["cleanupSucceeded"] = cleanup_succeeded
        write_json(artifacts / "cleanup.json", cleanup)
        for path in artifacts.rglob("*"):
            if path.is_file():
                path.write_bytes(redact_bytes(path.read_bytes(), redactions))
                path.chmod(0o600)
        secret_markers = [
            secret.encode()
            for secret, replacement in redactions
            if replacement.startswith("<redacted-")
        ]
        path_markers = [
            secret.encode()
            for secret, replacement in redactions
            if not replacement.startswith("<redacted-")
        ]
        secret_leaks = []
        path_leaks = []
        for path in artifacts.rglob("*"):
            if path.is_file():
                payload = path.read_bytes()
                if any(marker in payload for marker in secret_markers):
                    secret_leaks.append(str(path.relative_to(artifacts)))
                if any(marker in payload for marker in path_markers):
                    path_leaks.append(str(path.relative_to(artifacts)))
        write_json(
            artifacts / "leakage-scan.json",
            {"markersScanned": len(secret_markers), "leaks": secret_leaks},
        )
        write_json(
            artifacts / "path-leakage-scan.json",
            {"markersScanned": len(path_markers), "leaks": path_leaks},
        )
        if success and (secret_leaks or path_leaks or not cleanup_succeeded):
            raise AssertionError(
                f"comparison cleanup failed: secretLeaks={secret_leaks}, pathLeaks={path_leaks}, cleanup={cleanup}"
            )

    print(artifacts)


if __name__ == "__main__":
    main()
