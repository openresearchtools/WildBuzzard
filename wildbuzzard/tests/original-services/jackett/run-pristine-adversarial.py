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
import xml.etree.ElementTree as ET

from canonicalize import MAX_XML_BYTES, TorznabError, parse_torznab, parse_xml

COMMIT = "0cd8622b735922a909a128d8d6943bb8565a640f"
VERSION = "0.24.2360"
SOURCE_SHA256 = "3816fea39546b5fa440d3e33b856e73500ee6129e91b14d839fc0f04c7f9bd3e"
MAX_RESPONSE_BYTES = 16 * 1024 * 1024
ADULT_CATEGORIES = [6000, 6010, 6020, 6030, 6040, 6045, 6050, 6060, 6070, 6080, 6090]
RAW_URL_SECRET = "raw-url-oracle-secret"
TRACKER_USERNAME = "tracker-user-oracle-secret"
TRACKER_PASSKEY = "tracker-passkey-oracle-secret"


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
    if any(int(inside) == 0 and int(outside) == 0 for inside, outside, _length in entries):
        raise RuntimeError("the pristine oracle requires a rootless user namespace")
    return {
        "uidMap": uid_map,
        "gidMap": pathlib.Path("/proc/self/gid_map").read_text(encoding="ascii").strip(),
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


def run_command(command, log_path=None, check=True):
    completed = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False)
    if log_path:
        log_path.write_bytes(completed.stdout)
    if check and completed.returncode != 0:
        raise RuntimeError(f"command failed ({completed.returncode}): {' '.join(command)}")
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
    if process and process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)
    return process.returncode if process else None


def request(port, method, path, body=None, headers=None, timeout=20):
    headers = dict(headers or {})
    if body is not None and not isinstance(body, bytes):
        body = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
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
    return redact_bytes(value.encode("utf-8", errors="replace"), redactions).decode("utf-8", errors="replace")


def redacted_headers(headers, redactions):
    safe = []
    for key, value in headers.items() if isinstance(headers, dict) else headers:
        if key.lower() in {"authorization", "cookie", "set-cookie"}:
            value = "<redacted>"
        else:
            value = redact_text(value, redactions)
        safe.append([key, value])
    return safe


def save_transcript(directory, name, method, path, headers, request_body, response, redactions):
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


def fixture_item(origin, source, title, category="safe", category2=None, infohash=None,
                 seeders="4", leechers="2", download=True):
    infohash = infohash or hashlib.sha1(f"{source}:{title}".encode()).hexdigest().upper()
    details_id = hashlib.sha1(title.encode()).hexdigest()[:16]
    parts = [
        "<item>",
        f"<title>{title}</title>",
        f"<details>{origin}/details/{source}/{details_id}</details>",
        f"<published>2026-08-10T12:00:00Z</published>",
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
        parts.append(f'<enclosure url="{origin}/acquire/{source}/{details_id}?token={RAW_URL_SECRET}"/>')
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
        return (prefix + "<padding>" + "X" * (MAX_XML_BYTES + 1024) + "</padding>" + suffix).encode()
    if query == "adult-categories":
        items = []
        for category in ADULT_CATEGORIES:
            items.append(fixture_item(origin, source, f"Adult {category}", f"adult{category}"))
        return (prefix + "".join(items) + suffix).encode()
    if query == "mixed-categories":
        return (prefix + fixture_item(origin, source, "Mixed safe and adult", "safe", "adult6010") + suffix).encode()
    if query == "missing-category":
        return (prefix + fixture_item(origin, source, "Missing category", None) + suffix).encode()
    if query == "adult-provider-generic":
        return (prefix + fixture_item(origin, source, "Adult provider generic", "generic") + suffix).encode()
    if query == "peer-counts":
        absent = fixture_item(origin, source, "Peers absent", seeders=None, leechers=None)
        contradictory = fixture_item(origin, source, "Negative leechers normalized", seeders="10", leechers="-7")
        return (prefix + absent + contradictory + suffix).encode()
    if query == "duplicates":
        item = fixture_item(
            origin,
            source,
            f"Duplicate from {source}",
            infohash="0123456789ABCDEF0123456789ABCDEF01234567",
        )
        return (prefix + item + suffix).encode()
    if query == "partial" and source == "alternate":
        return b"<rss><channel><item>broken"
    if query == "malicious":
        title = "&lt;script&gt;alert(1)&lt;/script&gt; &#x202E; untrusted\nvalue"
        return (prefix + fixture_item(origin, source, title, "safe", "not-a-category") + suffix).encode()
    if query == "cache":
        return (prefix + fixture_item(origin, source, f"Cache generation {generation}") + suffix).encode()
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
        self.server.requests.append({"method": "GET", "path": self.path, "headerNames": sorted(self.headers.keys())})
        if parsed.path == "/oracle":
            source = query.get("source", ["main"])[0]
            search = query.get("q", [""])[0]
            key = f"{source}:{search}"
            self.server.generations[key] = self.server.generations.get(key, 0) + 1
            generation = self.server.generations[key]
            if search == "redirect-once":
                target = "/oracle?" + urllib.parse.urlencode({"source": source, "q": "redirect-target"})
                self._respond(302, b"", {"Location": target})
                return
            if search == "redirect-loop":
                self._respond(302, b"", {"Location": self.path})
                return
            if search == "tls-failure":
                target = f"https://{self.server.server_address[0]}:{self.server.server_address[1]}/oracle?source={source}&q=tls-target"
                self._respond(302, b"", {"Location": target})
                return
            if search == "hang":
                time.sleep(5)
            if search == "slow-generation":
                time.sleep(0.6)
            payload = fixture_xml(self.server.origin, source, search, generation)
            self._respond(200, payload, {"Content-Type": "application/xml; charset=utf-8"})
            return
        if parsed.path == "/api.php":
            if query.get("query") == ["rate-limit"]:
                self._respond(429, b'{"error":"rate limited"}', {"Content-Type": "application/json", "Retry-After": "7"})
                return
            document = [{
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
            }]
            self._respond(200, json.dumps(document, separators=(",", ":")).encode(), {"Content-Type": "application/json"})
            return
        if parsed.path.startswith("/acquire/"):
            self._respond(200, fixture_torrent(self.server.origin), {"Content-Type": "application/x-bittorrent"})
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


def configure_indexer(port, indexer_id, dashboard_headers, transcripts, redactions, mutate=None):
    path = f"/api/v2.0/indexers/{indexer_id}/Config"
    fetched = request(port, "GET", path, headers=dashboard_headers)
    save_transcript(transcripts, f"setup-{indexer_id}-get", "GET", path, dashboard_headers, None, fetched, redactions)
    if fetched["status"] != 200:
        raise AssertionError(f"configuration for {indexer_id} could not be read")
    document = json.loads(fetched["body"])
    if mutate:
        mutate(document)
    body = json.dumps(document, separators=(",", ":")).encode()
    headers = {**dashboard_headers, "Content-Type": "application/json"}
    configured = request(port, "POST", path, body, headers, timeout=20)
    save_transcript(transcripts, f"setup-{indexer_id}-post", "POST", path, headers, body, configured, redactions)
    if configured["status"] != 204:
        raise AssertionError(f"configuration for {indexer_id} failed: {configured['status']}")


def content_type(response):
    for key, value in response["headers"]:
        if key.lower() == "content-type":
            return value.split(";", 1)[0].lower()
    return None


def header_value(response, name):
    return next((value for key, value in response["headers"] if key.lower() == name.lower()), None)


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
            if local_name(element.tag) in {"category", "subcat"} and element.attrib.get("id", "").isdigit():
                categories.append(int(element.attrib["id"]))
        result["categoryIds"] = sorted(set(categories))
        return result
    if root_name != "rss":
        return result
    items = []
    for item in (element for element in root.iter() if local_name(element.tag) == "item"):
        attributes = {}
        for child in item:
            if local_name(child.tag) == "attr":
                attributes.setdefault(child.attrib.get("name", "").lower(), []).append(child.attrib.get("value", ""))
        categories = []
        for value in attributes.get("category", []):
            categories.extend(int(token) for token in value.split(",") if token.strip().isdigit())
        title = next(((child.text or "") for child in item if local_name(child.tag) == "title"), "")
        indexer = next((child.attrib.get("id") for child in item if local_name(child.tag) == "jackettindexer"), None)
        seeders = int(attributes["seeders"][0]) if attributes.get("seeders") else None
        peers = int(attributes["peers"][0]) if attributes.get("peers") else None
        infohash = (attributes.get("infohash") or [None])[0]
        items.append({
            "title": title,
            "indexerId": indexer,
            "categoryIds": sorted(set(categories)),
            "seeders": seeders,
            "peers": peers,
            "normalizedLeechers": max(0, peers - seeders) if peers is not None and seeders is not None else None,
            "infoHash": infohash.upper() if infohash else None,
        })
    result["items"] = sorted(items, key=lambda item: ((item["indexerId"] or ""), item["title"]))
    return result


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


def validate_matrix(observed):
    responses = [value for value in observed.values() if isinstance(value, dict)]
    error_codes = {value.get("errorCode") for value in responses}
    statuses = {value.get("status") for value in responses}
    if not {100, 201, 203, 900}.issubset(error_codes):
        raise AssertionError(f"missing Torznab error codes: {error_codes}")
    if not {400, 429}.issubset(statuses):
        raise AssertionError(f"missing adversarial HTTP statuses: {statuses}")
    if observed["error-code-200-source-contract"]["unreachableFilterBranch"]["torznabCode"] != 200:
        raise AssertionError("the pinned source-level code-200 contract is absent")
    adult = {
        category
        for item in observed["adult-category-matrix"]["items"]
        for category in item["categoryIds"]
        if category < 100000
    }
    if adult != set(ADULT_CATEGORIES):
        raise AssertionError(f"adult category matrix mismatch: {sorted(adult)}")
    for name in ("tracker-malformed-xml", "tracker-deep-xml", "tracker-entity-xml", "tracker-oversized-xml"):
        if observed[name]["clientGuard"]["accepted"]:
            raise AssertionError(f"unsafe XML passed the client guard: {name}")
    if observed["external-entity-network"]["requests"] != 0:
        raise AssertionError("external XML entity caused a network request")
    if observed["hanging-provider-timeout"]["outcome"] != "timeout":
        raise AssertionError("hanging provider was not bounded")
    if observed["tracker-tls-failure"].get("errorCode") != 900 or observed["redirect-loop"].get("errorCode") != 900:
        raise AssertionError("transport errors did not retain code 900")
    peer_items = {item["title"]: item for item in observed["peer-counts"]["items"]}
    if peer_items["Peers absent"]["peers"] is not None:
        raise AssertionError("absent peer values were not preserved")
    if observed["contradictory-peer-client-guard"]["normalizedLeechers"] != 0:
        raise AssertionError("contradictory peer counts did not clamp to zero")
    if observed["cache-hit"]["fixtureRequests"] != 1 or observed["cache-expired"]["fixtureRequests"] != 2:
        raise AssertionError("cache hit/expiry semantics changed")
    if observed["cache-bypass-second"]["fixtureRequests"] != 2:
        raise AssertionError("cache=false did not fetch twice")
    if observed["stale-generation"]["completionOrder"] != ["fast", "slow"]:
        raise AssertionError("stale generation did not finish after the newer request")
    if observed["acquisition-url-reuse"] != {"firstStatus": 200, "secondStatus": 200, "sameBytes": True}:
        raise AssertionError("pristine acquisition URL reuse semantics changed")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pristine-runtime", required=True, type=pathlib.Path)
    parser.add_argument("--pristine-source", required=True, type=pathlib.Path)
    parser.add_argument("--artifact-root", required=True, type=pathlib.Path)
    parser.add_argument("--direct-rootless", action="store_true")
    parser.add_argument("--fixture-address", default="127.0.0.1")
    args = parser.parse_args()
    if not args.direct_rootless:
        raise RuntimeError("use run-pristine-adversarial-rootless.sh")
    os.umask(0o077)

    script_dir = pathlib.Path(__file__).resolve().parent
    expected_path = script_dir / "fixtures/pristine-adversarial-expected.json"
    template = script_dir / "fixtures/adversarial-indexer.yml.in"
    pristine_runtime = args.pristine_runtime.resolve(strict=True)
    pristine_source = args.pristine_source.resolve(strict=True)
    pristine_executable = pristine_runtime / "jackett"
    if not pristine_executable.is_file():
        raise RuntimeError("the pinned pristine Jackett executable is required")

    run_id = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + secrets.token_hex(4)
    artifacts = args.artifact_root.resolve() / f"pristine-adversarial-{run_id}"
    transcripts = artifacts / "transcripts"
    logs = artifacts / "logs"
    overlays = artifacts / "overlays"
    pristine_data = artifacts / "pristine-data"
    for directory in (transcripts, logs, overlays, pristine_data):
        directory.mkdir(parents=True, mode=0o700)
        directory.chmod(0o700)

    write_json(logs / "rootless-namespace.json", rootless_namespace_identity())
    run_command(["ip", "-json", "address", "show"], logs / "network-namespace.json")
    fixture_server = http.server.ThreadingHTTPServer((args.fixture_address, 0), FixtureHandler)
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
    render_definition(template, definitions / "oracle-main.yml", "oracle-main", "Oracle Main", fixture_server.origin, "main")
    render_definition(template, definitions / "oracle-alternate.yml", "oracle-alternate", "Oracle Alternate", fixture_server.origin, "alternate")
    render_definition(template, definitions / "oracle-adult.yml", "oracle-adult", "Oracle Adult Only", fixture_server.origin, "adult-provider")

    pristine_port = choose_port("127.0.0.1")
    bootstrap = None
    bootstrap_log = None
    process = None
    process_log = None
    process_log_path = logs / "pristine-jackett.log"
    bootstrap_log_path = logs / "pristine-jackett-bootstrap.log"
    redactions = [
        (RAW_URL_SECRET, "<redacted-raw-url>"),
        (TRACKER_USERNAME, "<redacted-tracker-user>"),
        (TRACKER_PASSKEY, "<redacted-tracker-passkey>"),
    ]
    cleanup = {"ports": {}, "processes": {}, "fixtureStopped": False, "dataRootRemoved": False}
    success = False
    observed = {}
    mappings = []

    environment = {
        "HOME": str(pristine_data),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "TZ": "UTC",
        "XDG_CONFIG_HOME": str(overlays / "xdg"),
    }
    command = [
        str(pristine_executable), "--ListenPrivate", "--Port", str(pristine_port),
        "--PIDFile", str(pristine_data / "jackett.pid"), "--NoUpdates", "--NoRestart",
        "--DataFolder", str(pristine_data),
    ]

    try:
        bootstrap, bootstrap_log = start_process(command, pristine_runtime, environment, bootstrap_log_path)
        wait_for_health(pristine_port)
        cleanup["processes"]["bootstrapIdentity"] = process_identity(bootstrap)
        cleanup["processes"]["bootstrapExitCode"] = stop_process(bootstrap)
        bootstrap_log.close()

        server_config_path = pristine_data / "ServerConfig.json"
        server_config = json.loads(server_config_path.read_text(encoding="utf-8"))
        server_config["CacheEnabled"] = True
        server_config["CacheTtl"] = 1
        server_config_path.write_text(json.dumps(server_config, separators=(",", ":")), encoding="utf-8")
        server_config_path.chmod(0o600)
        api_key = server_config["APIKey"]
        redactions.append((api_key, "<redacted-api-key>"))

        process, process_log = start_process(command, pristine_runtime, environment, process_log_path)
        health = wait_for_health(pristine_port)
        write_json(logs / "pristine-process-identity.json", process_identity(process))
        save_transcript(transcripts, "setup-health", "GET", "/health", {}, None, health, redactions)

        login_start = request(pristine_port, "GET", "/UI/Login")
        test_cookie = response_cookie(login_start, "TestCookie")
        test_headers = {"Cookie": f"TestCookie={test_cookie}"}
        login_test = request(pristine_port, "GET", "/UI/TestCookie", headers=test_headers)
        login_finish = request(pristine_port, "GET", "/UI/Login?cookiesChecked=1", headers=test_headers)
        dashboard_cookie = response_cookie(login_finish, "Jackett")
        if len(dashboard_cookie) >= 16:
            redactions.append((dashboard_cookie, "<redacted-dashboard-cookie>"))
        dashboard_headers = {"Cookie": f"Jackett={dashboard_cookie}"}
        save_transcript(transcripts, "setup-login-start", "GET", "/UI/Login", {}, None, login_start, redactions)
        save_transcript(transcripts, "setup-login-test", "GET", "/UI/TestCookie", test_headers, None, login_test, redactions)
        save_transcript(transcripts, "setup-login-finish", "GET", "/UI/Login?cookiesChecked=1", test_headers, None, login_finish, redactions)

        configure_indexer(pristine_port, "oracle-main", dashboard_headers, transcripts, redactions)
        configure_indexer(pristine_port, "oracle-alternate", dashboard_headers, transcripts, redactions)

        def filelist_config(document):
            values = {"sitelink": fixture_server.origin + "/", "username": TRACKER_USERNAME, "passkey": TRACKER_PASSKEY}
            for item in document:
                if item.get("id") in values:
                    item["value"] = values[item["id"]]

        configure_indexer(pristine_port, "filelist", dashboard_headers, transcripts, redactions, filelist_config)

        scenario_index = 0

        def run_scenario(name, path, ported, normalization, timeout=20, guard=None):
            nonlocal scenario_index
            scenario_index += 1
            response = request(pristine_port, "GET", path, timeout=timeout)
            save_transcript(transcripts, f"{scenario_index:02d}-{name}", "GET", path, {}, None, response, redactions)
            canonical = canonical_response(response)
            if guard is not None:
                canonical["clientGuard"] = guard_result(guard)
            observed[name] = canonical
            mappings.append({
                "scenario": name,
                "original": "GET " + redact_text(path, redactions),
                "ported": ported,
                "normalization": normalization,
                "oracleOnly": True,
            })
            return response

        def torznab(indexer, **params):
            values = {"apikey": api_key, **params}
            return f"/api/v2.0/indexers/{indexer}/results/torznab/api?" + urllib.parse.urlencode(values)

        run_scenario("valid-apikey", torznab("oracle-main", t="caps"), "GET /v1/sources + bearer capability", "caps become immutable source status")
        run_scenario("valid-passkey-alias", "/api/v2.0/indexers/oracle-main/results/torznab/api?" + urllib.parse.urlencode({"passkey": api_key, "t": "caps"}), "GET /v1/sources?passkey=forbidden", "alias succeeds only on the pristine oracle")
        run_scenario("missing-apikey", "/api/v2.0/indexers/oracle-main/results/torznab/api?t=caps", "GET /v1/sources without bearer capability", "Torznab 100 maps to product authentication denial")
        run_scenario("invalid-apikey", "/api/v2.0/indexers/oracle-main/results/torznab/api?apikey=invalid&t=caps", "GET /v1/sources with invalid bearer capability", "Torznab 100 maps to product authentication denial")
        run_scenario("omitted-indexer-route", "/api/v2.0/indexers//results/torznab/api?" + urllib.parse.urlencode({"apikey": api_key, "t": "caps"}), "POST /v1/search with no source IDs", "the public route does not expose the source code-200 filter branch")
        run_scenario("unsupported-indexer", torznab("not-an-indexer", t="caps"), "POST /v1/search with an unknown source ID", "Torznab 201 maps to bounded validation failure")
        run_scenario("unsupported-mode", torznab("oracle-main", t="not-a-mode"), "POST /v1/search with unsupported operation", "Torznab 201 maps to bounded validation failure")
        run_scenario("unavailable-indexers-mode", torznab("oracle-main", t="indexers"), "GET /v1/sources", "the validation filter returns Torznab 201 before the controller's unavailable-function branch")
        run_scenario("unavailable-tmdb-function", torznab("oracle-main", t="movie", q="fixture", tmdbid="123"), "POST /v1/search with an unsupported typed media parameter", "Torznab 203 maps to bounded provider capability validation")
        run_scenario("invalid-imdb-parameter", torznab("oracle-main", t="movie", imdbid="invalid"), "POST /v1/search with invalid typed media parameter", "Torznab 201/203 maps to bounded validation failure")

        for fault in ("malformed", "deep", "entity", "oversized"):
            payload = fixture_xml(fixture_server.origin, "main", fault)
            run_scenario(
                f"tracker-{fault}-xml",
                torznab("oracle-main", t="search", q=fault, cache="false"),
                "POST /v1/search using the retained provider engine",
                "upstream shape is recorded; the independent client guard rejects unsafe XML",
                guard=payload,
            )
        run_scenario("tracker-tls-failure", torznab("oracle-main", t="search", q="tls-failure", cache="false"), "POST /v1/search", "transport failure maps to a bounded provider error")
        run_scenario("redirect-once", torznab("oracle-main", t="search", q="redirect-once", cache="false"), "POST /v1/search", "the retained provider follows the bounded redirect")
        run_scenario("redirect-loop", torznab("oracle-main", t="search", q="redirect-loop", cache="false"), "POST /v1/search", "redirect exhaustion maps to a bounded provider error")
        run_scenario("http-429-retry-after", torznab("filelist", t="search", q="rate-limit", cache="false"), "POST /v1/search", "HTTP 429/code 900 and Retry-After map to rate-limited provider state")
        run_scenario("peer-counts", torznab("oracle-main", t="search", q="peer-counts", cache="false"), "POST /v1/search", "peers is total; derive max(0, peers - seeders) and preserve absent values")
        run_scenario("adult-category-matrix", torznab("oracle-main", t="search", q="adult-categories", cache="false"), "POST /v1/search", "all 6000-series results are dropped by product policy")
        run_scenario("mixed-safe-adult-category", torznab("oracle-main", t="search", q="mixed-categories", cache="false"), "POST /v1/search", "one adult category drops the complete result")
        run_scenario("missing-category", torznab("oracle-main", t="search", q="missing-category", cache="false"), "POST /v1/search", "missing categories remain explicit and policy-bounded")
        malicious = run_scenario("malicious-fields", torznab("oracle-main", t="search", q="malicious", cache="false"), "POST /v1/search", "sanitize text and replace acquisition URLs with opaque IDs")

        caps = observed["valid-apikey"]
        custom_id = int.from_bytes(hashlib.sha1(b"safe").digest()[:2], "little") + 100000
        if custom_id not in caps.get("categoryIds", []):
            raise AssertionError("fixture did not expose a custom per-indexer category")
        run_scenario("custom-category", torznab("oracle-main", t="search", q="custom-category", cat=str(custom_id), cache="false"), "POST /v1/search with caps-driven source category", "custom categories remain per-indexer and never pass through /all")
        run_scenario("duplicate-infohash-alternates", torznab("all", t="search", q="duplicates", cache="false"), "POST /v1/search", "deduplicate BTIH while retaining alternate provider provenance")
        run_scenario("partial-success", torznab("all", t="search", q="partial", cache="false"), "POST /v1/search", "successful providers and bounded failure states form a partial response")
        configure_indexer(pristine_port, "oracle-adult", dashboard_headers, transcripts, redactions)
        run_scenario("adult-provider-generic-8000", torznab("oracle-adult", t="search", q="adult-provider-generic", cache="false"), "POST /v1/search", "provider classification drops adult-only sources even when the result says 8000")

        before_cache = fixture_server.generations.get("main:cache", 0)
        run_scenario("cache-first", torznab("oracle-main", t="search", q="cache", cache="true"), "POST /v1/search", "first retained-engine cache population")
        run_scenario("cache-hit", torznab("oracle-main", t="search", q="cache", cache="true"), "POST /v1/search", "same query reuses the intentional cache")
        observed["cache-hit"]["fixtureRequests"] = fixture_server.generations.get("main:cache", 0) - before_cache
        time.sleep(1.25)
        run_scenario("cache-expired", torznab("oracle-main", t="search", q="cache", cache="true"), "POST /v1/search", "expired cache entry causes a fresh provider request")
        observed["cache-expired"]["fixtureRequests"] = fixture_server.generations.get("main:cache", 0) - before_cache
        bypass_before = fixture_server.generations.get("main:cache", 0)
        run_scenario("cache-bypass-first", torznab("oracle-main", t="search", q="cache", cache="false"), "POST /v1/search", "product cache policy is internal and has no raw switch")
        run_scenario("cache-bypass-second", torznab("oracle-main", t="search", q="cache", cache="false"), "POST /v1/search", "fresh requests do not expose the upstream cache switch")
        observed["cache-bypass-second"]["fixtureRequests"] = fixture_server.generations.get("main:cache", 0) - bypass_before

        generation_results = {}
        completion_order = []

        def generation_request(label, query):
            response = request(pristine_port, "GET", torznab("oracle-main", t="search", q=query, cache="false"), timeout=5)
            generation_results[label] = response
            completion_order.append(label)

        slow_thread = threading.Thread(target=generation_request, args=("slow", "slow-generation"))
        slow_thread.start()
        deadline = time.monotonic() + 2
        while fixture_server.generations.get("main:slow-generation", 0) == 0 and time.monotonic() < deadline:
            time.sleep(0.01)
        fast_thread = threading.Thread(target=generation_request, args=("fast", "fast-generation"))
        fast_thread.start()
        slow_thread.join(timeout=6)
        fast_thread.join(timeout=6)
        if slow_thread.is_alive() or fast_thread.is_alive():
            raise AssertionError("stale-generation fixture did not finish")
        for label in ("slow", "fast"):
            scenario_index += 1
            path = torznab("oracle-main", t="search", q=f"{label}-generation", cache="false")
            save_transcript(transcripts, f"{scenario_index:02d}-stale-generation-{label}", "GET", path, {}, None, generation_results[label], redactions)
        observed["stale-generation"] = {
            "completionOrder": completion_order,
            "slow": canonical_response(generation_results["slow"]),
            "fast": canonical_response(generation_results["fast"]),
        }
        mappings.append({
            "scenario": "stale-generation",
            "original": "two overlapping GET Torznab searches, slow then fast",
            "ported": "two POST /v1/search generations on one UI surface",
            "normalization": "the oracle may finish stale work last; the port discards the stale generation",
            "oracleOnly": True,
        })

        run_scenario("hanging-provider-timeout", torznab("oracle-main", t="search", q="hang", cache="false"), "POST /v1/search with a bounded provider deadline", "client timeout/cancellation becomes bounded provider state", timeout=0.5)

        parsed_malicious = parse_torznab(malicious["body"], "oracle-main", "Oracle Main")
        malicious_link = parsed_malicious["results"][0]["_link"]
        target = urllib.parse.urlsplit(malicious_link)
        first_download = request(pristine_port, "GET", target.path + ("?" + target.query if target.query else ""))
        second_download = request(pristine_port, "GET", target.path + ("?" + target.query if target.query else ""))
        for label, response in (("first", first_download), ("second", second_download)):
            scenario_index += 1
            save_transcript(transcripts, f"{scenario_index:02d}-acquisition-reuse-{label}", "GET", malicious_link, {}, None, response, redactions)
        observed["acquisition-url-reuse"] = {
            "firstStatus": first_download["status"],
            "secondStatus": second_download["status"],
            "sameBytes": first_download["body"] == second_download["body"],
        }
        mappings.append({
            "scenario": "acquisition-url-reuse",
            "original": "repeat GET of redacted pristine proxy URL",
            "ported": "POST /v1/results/:opaque-result-id/resolve",
            "normalization": "the port intentionally adds one-shot, expiry, and profile scope",
            "oracleOnly": True,
        })

        if fixture_server.entity_leak_requests:
            raise AssertionError("the pristine tracker parser resolved an external XML entity")
        observed["external-entity-network"] = {"requests": fixture_server.entity_leak_requests}
        observed["error-code-200-source-contract"] = source_contract(pristine_source)
        mappings.append({
            "scenario": "error-code-200-source-contract",
            "original": "pinned ResultsController source branch behind a required {indexerId} route",
            "ported": "POST /v1/search validation",
            "normalization": "the source branch is retained as evidence; the live omitted route returns 404",
            "oracleOnly": True,
        })
        mappings.append({
            "scenario": "external-entity-network",
            "original": "entity-bearing local tracker XML",
            "ported": "retained engine response consumed by the bounded XML client",
            "normalization": "DTD/entity input is rejected and causes zero entity-resolution requests",
            "oracleOnly": True,
        })
        contradictory_payload = b'''<?xml version="1.0"?><rss xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><item><title>Contradictory peers</title><guid>contradictory</guid><torznab:attr name="category" value="2000"/><torznab:attr name="seeders" value="10"/><torznab:attr name="peers" value="3"/><torznab:attr name="infohash" value="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"/></item></channel></rss>'''
        contradictory = parse_torznab(contradictory_payload, "oracle-wire", "Oracle Wire")["results"][0]
        observed["contradictory-peer-client-guard"] = {
            "seeders": contradictory["seeders"],
            "peers": 3,
            "normalizedLeechers": contradictory["leechers"],
        }
        mappings.append({
            "scenario": "contradictory-peer-client-guard",
            "original": "recorded Torznab item with seeders=10 and total peers=3",
            "ported": "POST /v1/search normalized result",
            "normalization": "derive max(0, peers - seeders)",
            "oracleOnly": True,
        })

        validate_matrix(observed)

        run_command(["ss", "-ltnp", f"sport = :{pristine_port} or sport = :{fixture_port}"], logs / "loopback-listeners.log")
        listener_text = (logs / "loopback-listeners.log").read_text(encoding="utf-8")
        if f"127.0.0.1:{pristine_port}" not in listener_text or f"{args.fixture_address}:{fixture_port}" not in listener_text:
            raise AssertionError("oracle listeners were not observed")
        if any(marker in listener_text for marker in (f"0.0.0.0:{pristine_port}", f"[::]:{pristine_port}", f"*:{pristine_port}")):
            raise AssertionError("pristine Jackett exposed a wildcard listener")

        expected = json.loads(expected_path.read_text(encoding="utf-8"))
        write_json(artifacts / "canonical-observed.json", observed)
        write_json(artifacts / "canonical-expected.json", expected)
        diff = "".join(difflib.unified_diff(
            canonical_json(expected).splitlines(keepends=True),
            canonical_json(observed).splitlines(keepends=True),
            fromfile="pinned-expected",
            tofile="pristine-observed",
        ))
        (artifacts / "canonical.diff").write_text(diff, encoding="utf-8")
        write_json(artifacts / "request-mapping.json", mappings)
        write_json(artifacts / "fixture-requests.redacted.json", json.loads(redact_text(canonical_json(fixture_server.requests), redactions)))
        write_json(artifacts / "fixture-responses.redacted.json", json.loads(redact_text(canonical_json(fixture_server.responses), redactions)))
        redacted_config = dict(server_config)
        redacted_config["APIKey"] = "<redacted>"
        redacted_config["InstanceId"] = "<redacted>"
        write_json(artifacts / "pristine-config.redacted.json", redacted_config)
        metadata = {
            "schemaVersion": 1,
            "oracleOnly": True,
            "sourceCommit": COMMIT,
            "sourceVersion": VERSION,
            "sourceArchiveSha256": SOURCE_SHA256,
            "platform": "linux-x86_64-glibc",
            "executionMode": "direct-rootless-user-network-namespace",
            "ports": {"fixture": fixture_port, "pristine": pristine_port},
            "pristineExecutableSha256": sha256_file(pristine_executable),
            "expectedSnapshotSha256": sha256_file(expected_path),
            "cacheTtlSeconds": 1,
            "normalizations": ["ports", "elapsed timing", "error descriptions", "redacted secrets and acquisition paths"],
            "contactedImplementations": ["pristine-jackett-v0.24.2360", "deterministic-local-fixture"],
            "prohibitedImplementations": ["jackett-mini", "browser-runtime", "torrent-runtime"],
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
        if process:
            cleanup["processes"]["oracleExitCode"] = stop_process(process)
        if process_log:
            process_log.close()
        fixture_server.shutdown()
        fixture_server.server_close()
        fixture_thread.join(timeout=6)
        cleanup["fixtureStopped"] = not fixture_thread.is_alive()
        for label, address, port in (("pristine", "127.0.0.1", pristine_port), ("fixture", args.fixture_address, fixture_port)):
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
                probe.settimeout(0.2)
                cleanup["ports"][label] = "closed" if probe.connect_ex((address, port)) != 0 else "open"
        for log_path in (
            bootstrap_log_path,
            process_log_path,
            artifacts / "failure.txt",
        ):
            if log_path.exists():
                log_path.write_bytes(redact_bytes(log_path.read_bytes(), redactions))
                log_path.chmod(0o600)
        shutil.rmtree(pristine_data, ignore_errors=True)
        cleanup["dataRootRemoved"] = not pristine_data.exists()
        cleanup["oracleSucceeded"] = success
        write_json(artifacts / "cleanup.json", cleanup)
        leak_markers = [secret.encode() for secret, _replacement in redactions]
        leaks = []
        for path in artifacts.rglob("*"):
            if path.is_file():
                payload = path.read_bytes()
                if any(marker in payload for marker in leak_markers):
                    leaks.append(str(path.relative_to(artifacts)))
        write_json(artifacts / "leakage-scan.json", {"markersScanned": len(leak_markers), "leaks": leaks})
        if leaks and success:
            raise AssertionError(f"oracle evidence leaked secrets: {leaks}")

    print(artifacts)


if __name__ == "__main__":
    main()
