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

from canonicalize import (
    body_base64,
    canonicalize_mini,
    parse_torznab,
    parse_xml,
    product_results,
)

COMMIT = "0cd8622b735922a909a128d8d6943bb8565a640f"
VERSION = "0.24.2360"
SOURCE_SHA256 = "3816fea39546b5fa440d3e33b856e73500ee6129e91b14d839fc0f04c7f9bd3e"
MAX_RESPONSE_BYTES = 16 * 1024 * 1024


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_json(value):
    return json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"


def write_json(path, value):
    path.write_text(canonical_json(value), encoding="utf-8")


def choose_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


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
            raise RuntimeError("response exceeded comparison limit")
        return {
            "status": response.status,
            "headers": list(response.getheaders()),
            "body": payload,
            "elapsedMs": round((time.monotonic() - started) * 1000, 3),
        }
    finally:
        connection.close()


def redact_bytes(payload, redactions):
    result = payload
    for secret, replacement in redactions:
        if secret:
            result = result.replace(secret.encode("utf-8"), replacement.encode("utf-8"))
    result = re.sub(
        rb"((?:\?|&|&amp;)path=)[^&<\"\s]+", rb"\1<redacted-result-path>", result
    )
    return result


def redact_text(value, redactions):
    result = value
    for secret, replacement in redactions:
        if secret:
            result = result.replace(secret, replacement)
    result = re.sub(
        r"((?:\?|&|&amp;)path=)[^&<\"\s]+", r"\1<redacted-result-path>", result
    )
    return result


def save_transcript(
    directory, name, method, path, headers, request_body, response, redactions
):
    safe_request_body = redact_bytes(request_body or b"", redactions)
    safe_response_body = redact_bytes(response["body"], redactions)
    safe_headers = []
    for key, value in headers.items():
        if key.lower() == "authorization":
            value = "Bearer <redacted-capability>"
        else:
            value = redact_text(value, redactions)
        safe_headers.append([key, value])
    response_headers = [
        [key, redact_text(value, redactions)] for key, value in response["headers"]
    ]
    document = {
        "request": {
            "method": method,
            "path": redact_text(path, redactions),
            "headers": safe_headers,
            "bodyBase64": body_base64(safe_request_body),
        },
        "response": {
            "status": response["status"],
            "headers": response_headers,
            "bodyBase64": body_base64(safe_response_body),
            "elapsedMs": response["elapsedMs"],
        },
    }
    with contextlib.suppress(UnicodeDecodeError):
        document["request"]["bodyText"] = safe_request_body.decode("utf-8")
    with contextlib.suppress(UnicodeDecodeError):
        document["response"]["bodyText"] = safe_response_body.decode("utf-8")
    write_json(directory / f"{name}.json", document)


def fixture_torrent(origin, private=False):
    def byte_string(value):
        return str(len(value)).encode("ascii") + b":" + value

    info = b"d"
    info += b"6:lengthi123e"
    info += b"4:name" + byte_string(b"fixture.file")
    info += b"12:piece lengthi16384e"
    info += b"6:pieces" + byte_string(b"01234567890123456789")
    if private:
        info += b"7:privatei1e"
    info += b"e"
    announce = f"{origin}/announce".encode("ascii")
    return b"d8:announce" + byte_string(announce) + b"4:info" + info + b"e"


class FixtureHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        self.server.requests.append({"method": "GET", "path": self.path})
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path == "/search":
            origin = self.server.origin
            items = [
                {
                    "category": "safe",
                    "title": "Fixture Ω Magnet",
                    "details": f"{origin}/details/magnet",
                    "infoHash": "0123456789abcdef0123456789abcdef01234567",
                    "published": 1786363200,
                    "size": 123456,
                    "seeders": 10,
                    "leechers": 3,
                },
                {
                    "category": "safe",
                    "title": "Fixture Ω Magnet duplicate",
                    "details": f"{origin}/details/duplicate",
                    "infoHash": "0123456789ABCDEF0123456789ABCDEF01234567",
                    "published": 1786363201,
                    "size": 123456,
                    "seeders": 9,
                    "leechers": 4,
                },
                {
                    "category": "adult",
                    "title": "Filtered category 6000",
                    "details": f"{origin}/details/adult",
                    "infoHash": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                    "published": 1786363202,
                    "size": 654321,
                    "seeders": 99,
                    "leechers": 1,
                },
                {
                    "category": "safe",
                    "title": "Fixture Public Torrent",
                    "details": f"{origin}/details/public",
                    "download": f"{origin}/torrents/public.torrent",
                    "published": 1786363203,
                    "size": 234567,
                    "seeders": 2,
                    "leechers": 1,
                },
                {
                    "category": "safe",
                    "title": "Fixture Private Torrent",
                    "details": f"{origin}/details/private",
                    "download": f"{origin}/torrents/private.torrent",
                    "published": 1786363204,
                    "size": 345678,
                    "seeders": 1,
                    "leechers": 1,
                },
            ]
            self._respond(
                200,
                "application/json",
                json.dumps({"items": items}, ensure_ascii=False).encode("utf-8"),
            )
            return
        if parsed.path == "/torrents/public.torrent":
            self._respond(
                200, "application/x-bittorrent", fixture_torrent(self.server.origin)
            )
            return
        if parsed.path == "/torrents/private.torrent":
            self._respond(
                200,
                "application/x-bittorrent",
                fixture_torrent(self.server.origin, private=True),
            )
            return
        self._respond(200, "text/plain; charset=utf-8", b"fixture\n")

    def _respond(self, status, content_type, payload):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_args):
        pass


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


def wait_for_health(port, path, headers=None, timeout=20):
    deadline = time.monotonic() + timeout
    last_error = None
    while time.monotonic() < deadline:
        try:
            response = request(port, "GET", path, headers=headers, timeout=1)
            if response["status"] == 200:
                return response
        except (ConnectionError, OSError, TimeoutError) as error:
            last_error = error
        time.sleep(0.1)
    raise RuntimeError(f"service did not become healthy: {last_error}")


def render_definition(template, destination, indexer_id, name, origin):
    value = template.read_text(encoding="utf-8")
    value = value.replace("__INDEXER_ID__", indexer_id)
    value = value.replace("__INDEXER_NAME__", name)
    value = value.replace("__FIXTURE_ORIGIN__", origin)
    destination.write_text(value, encoding="utf-8")


def mode(path):
    return stat.S_IMODE(path.stat().st_mode)


def response_cookie(response, name):
    cookies = http.cookies.SimpleCookie()
    for key, value in response["headers"]:
        if key.lower() == "set-cookie":
            cookies.load(value)
    if name not in cookies:
        raise AssertionError(f"upstream login did not set {name}")
    return cookies[name].value


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
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)
    return process.returncode


def rootless_namespace_identity():
    uid_map = pathlib.Path("/proc/self/uid_map").read_text(encoding="ascii").strip()
    entries = [line.split() for line in uid_map.splitlines()]
    if not entries or any(len(entry) != 3 for entry in entries):
        raise RuntimeError("invalid user namespace identity")
    if any(
        int(inside) == 0 and int(outside) == 0 for inside, outside, _length in entries
    ):
        raise RuntimeError("direct comparison requires a rootless user namespace")
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
    return {
        "pid": process.pid,
        "linuxProcessStartTime": stat_fields[19],
        "executable": str(executable),
        "executableSha256": sha256_file(executable),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pristine-runtime", required=True, type=pathlib.Path)
    parser.add_argument("--mini-runtime", required=True, type=pathlib.Path)
    parser.add_argument("--mini-manifest", required=True, type=pathlib.Path)
    parser.add_argument("--artifact-root", required=True, type=pathlib.Path)
    parser.add_argument("--direct-rootless", action="store_true")
    parser.add_argument("--fixture-address", default="127.0.0.1")
    args = parser.parse_args()
    if not args.direct_rootless:
        parser.error("run-comparison.py requires --direct-rootless")
    os.umask(0o077)

    script_dir = pathlib.Path(__file__).resolve().parent
    template = script_dir / "fixtures" / "fixture-indexer.yml.in"
    pristine_runtime = args.pristine_runtime.resolve(strict=True)
    mini_runtime = args.mini_runtime.resolve(strict=True)
    mini_manifest_path = args.mini_manifest.resolve(strict=True)
    pristine_executable = pristine_runtime / "jackett"
    mini_executable = mini_runtime / "jackett-mini"
    if not pristine_executable.is_file() or not mini_executable.is_file():
        raise RuntimeError("both executable runtimes are required")

    mini_manifest = json.loads(mini_manifest_path.read_text(encoding="utf-8"))
    mini_entry = next(
        entry for entry in mini_manifest["files"] if entry["path"] == "jackett-mini"
    )
    if sha256_file(mini_executable) != mini_entry["sha256"]:
        raise RuntimeError(
            "Jackett Mini executable does not match its runtime manifest"
        )

    run_id = (
        datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        + "-"
        + secrets.token_hex(4)
    )
    artifacts = args.artifact_root.resolve() / f"comparison-{run_id}"
    transcripts = artifacts / "transcripts"
    logs = artifacts / "logs"
    overlays = artifacts / "overlays"
    pristine_data = artifacts / "pristine-data"
    mini_data = artifacts / "mini-data"
    for directory in (transcripts, logs, overlays, pristine_data, mini_data):
        directory.mkdir(parents=True, mode=0o700)
        directory.chmod(0o700)

    write_json(logs / "rootless-namespace.json", rootless_namespace_identity())
    run_command(["ip", "-json", "address", "show"], logs / "network-namespace.json")

    fixture_server = http.server.ThreadingHTTPServer(
        (args.fixture_address, 0), FixtureHandler
    )
    fixture_server.requests = []
    fixture_port = fixture_server.server_address[1]
    fixture_server.origin = f"http://{args.fixture_address}:{fixture_port}"
    fixture_thread = threading.Thread(target=fixture_server.serve_forever, daemon=True)
    fixture_thread.start()

    original_definitions = overlays / "original-definitions"
    original_definitions.mkdir(mode=0o700)
    original_definition = original_definitions / "wildbuzzard-fixture.yml"
    mini_definition = overlays / "showrss.yml"
    render_definition(
        template,
        original_definition,
        "wildbuzzard-fixture",
        "WildBuzzard Fixture",
        fixture_server.origin,
    )
    render_definition(
        template, mini_definition, "showrss", "showRSS", fixture_server.origin
    )

    test_catalog = json.loads(
        (mini_runtime / "catalog.json").read_text(encoding="utf-8")
    )
    showrss = next(
        entry for entry in test_catalog["entries"] if entry["indexerId"] == "showrss"
    )
    showrss["definitionSha256"] = sha256_file(mini_definition)
    test_catalog_path = overlays / "catalog.json"
    write_json(test_catalog_path, test_catalog)

    capability = secrets.token_urlsafe(32)
    capability_path = mini_data / "capability"
    capability_path.write_text(capability + "\n", encoding="ascii")
    capability_path.chmod(0o600)
    original_port = choose_port()
    mini_port = choose_port()
    while mini_port == original_port:
        mini_port = choose_port()
    suffix = secrets.token_hex(5)
    original_name = f"wildbuzzard-jackett-original-{suffix}"
    mini_name = f"wildbuzzard-jackett-mini-{suffix}"
    service_names = [original_name, mini_name]
    processes = {}
    process_logs = {}
    mappings = []
    redactions = [(capability, "<redacted-capability>")]
    cleanup = {
        "processes": {},
        "ports": {},
        "fixtureStopped": False,
        "dataRootsRemoved": {},
    }
    success = False

    try:
        original_xdg = overlays / "original-xdg/cardigann/definitions"
        original_xdg.mkdir(parents=True, mode=0o700)
        shutil.copy2(original_definition, original_xdg / original_definition.name)
        mini_test_runtime = overlays / "mini-runtime"
        shutil.copytree(mini_runtime, mini_test_runtime)
        shutil.copy2(mini_definition, mini_test_runtime / "Definitions/showrss.yml")
        shutil.copy2(test_catalog_path, mini_test_runtime / "catalog.json")
        environment = {
            "HOME": str(pristine_data),
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
            "TZ": "UTC",
            "XDG_CONFIG_HOME": str(overlays / "original-xdg"),
        }
        mini_environment = {
            "HOME": str(mini_data),
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
            "TZ": "UTC",
        }
        original_command = [
            str(pristine_executable),
            "--ListenPrivate",
            "--Port",
            str(original_port),
            "--PIDFile",
            str(pristine_data / "jackett.pid"),
            "--NoUpdates",
            "--NoRestart",
            "--DataFolder",
            str(pristine_data),
        ]
        mini_command = [
            str(mini_test_runtime / "jackett-mini"),
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
        processes[original_name], process_logs[original_name] = start_process(
            original_command,
            pristine_runtime,
            environment,
            logs / f"{original_name}.log",
        )
        processes[mini_name], process_logs[mini_name] = start_process(
            mini_command, mini_test_runtime, mini_environment, logs / f"{mini_name}.log"
        )
        original_health = wait_for_health(original_port, "/health")
        mini_headers = {"Authorization": f"Bearer {capability}"}
        mini_health = wait_for_health(mini_port, "/v1/health", mini_headers)

        server_config_path = pristine_data / "ServerConfig.json"
        server_config = json.loads(server_config_path.read_text(encoding="utf-8"))
        api_key = server_config["APIKey"]
        redactions.append((api_key, "<redacted-api-key>"))
        redacted_config = dict(server_config)
        redacted_config["APIKey"] = "<redacted>"
        redacted_config["InstanceId"] = "<redacted>"
        write_json(artifacts / "pristine-config.redacted.json", redacted_config)

        login_start = request(original_port, "GET", "/UI/Login")
        test_cookie = response_cookie(login_start, "TestCookie")
        test_cookie_headers = {"Cookie": f"TestCookie={test_cookie}"}
        login_test = request(
            original_port, "GET", "/UI/TestCookie", headers=test_cookie_headers
        )
        login_finish = request(
            original_port,
            "GET",
            "/UI/Login?cookiesChecked=1",
            headers=test_cookie_headers,
        )
        jackett_cookie = response_cookie(login_finish, "Jackett")
        if len(jackett_cookie) >= 16:
            redactions.append((jackett_cookie, "<redacted-dashboard-cookie>"))
        dashboard_headers = {"Cookie": f"Jackett={jackett_cookie}"}
        save_transcript(
            transcripts,
            "00-original-login-start",
            "GET",
            "/UI/Login",
            {},
            None,
            login_start,
            redactions,
        )
        save_transcript(
            transcripts,
            "00-original-login-cookie-test",
            "GET",
            "/UI/TestCookie",
            test_cookie_headers,
            None,
            login_test,
            redactions,
        )
        save_transcript(
            transcripts,
            "00-original-login-finish",
            "GET",
            "/UI/Login?cookiesChecked=1",
            test_cookie_headers,
            None,
            login_finish,
            redactions,
        )

        config_response = request(
            original_port,
            "GET",
            "/api/v2.0/indexers/wildbuzzard-fixture/Config",
            headers=dashboard_headers,
        )
        save_transcript(
            transcripts,
            "00-original-config-get",
            "GET",
            "/api/v2.0/indexers/wildbuzzard-fixture/Config",
            dashboard_headers,
            None,
            config_response,
            redactions,
        )
        if config_response["status"] != 200:
            raise AssertionError("pristine fixture configuration could not be read")
        config_document = json.loads(config_response["body"])
        config_body = json.dumps(config_document, separators=(",", ":")).encode("utf-8")
        config_headers = {**dashboard_headers, "Content-Type": "application/json"}
        configured = request(
            original_port,
            "POST",
            "/api/v2.0/indexers/wildbuzzard-fixture/Config",
            config_body,
            config_headers,
        )
        save_transcript(
            transcripts,
            "01-original-config-post",
            "POST",
            "/api/v2.0/indexers/wildbuzzard-fixture/Config",
            config_headers,
            config_body,
            configured,
            redactions,
        )
        if configured["status"] != 204:
            raise AssertionError("pristine fixture configuration failed")

        save_transcript(
            transcripts,
            "02-original-health",
            "GET",
            "/health",
            {},
            None,
            original_health,
            redactions,
        )
        save_transcript(
            transcripts,
            "02-ported-health",
            "GET",
            "/v1/health",
            mini_headers,
            None,
            mini_health,
            redactions,
        )
        original_health_json = json.loads(original_health["body"])
        mini_health_json = json.loads(mini_health["body"])
        if (
            original_health_json.get("status") != "OK"
            or mini_health_json.get("status") != "ok"
        ):
            raise AssertionError("health semantics differ")
        mappings.append({
            "scenario": "health",
            "original": "GET /health",
            "ported": "GET /v1/health + bearer capability",
            "normalization": "status case; ported identity fields are additive",
        })

        original_caps_path = (
            "/api/v2.0/indexers/wildbuzzard-fixture/results/torznab/api?"
            + urllib.parse.urlencode({"apikey": api_key, "t": "caps"})
        )
        original_caps = request(original_port, "GET", original_caps_path)
        mini_sources = request(mini_port, "GET", "/v1/sources", headers=mini_headers)
        save_transcript(
            transcripts,
            "03-original-caps",
            "GET",
            original_caps_path,
            {},
            None,
            original_caps,
            redactions,
        )
        save_transcript(
            transcripts,
            "03-ported-sources",
            "GET",
            "/v1/sources",
            mini_headers,
            None,
            mini_sources,
            redactions,
        )
        caps_root = parse_xml(original_caps["body"])
        if original_caps["status"] != 200 or caps_root.tag.rsplit("}", 1)[-1] != "caps":
            raise AssertionError("pristine caps failed")
        sources_document = json.loads(mini_sources["body"])
        source = next(
            item for item in sources_document["sources"] if item["id"] == "showrss"
        )
        if source["state"] != "ready" or len(sources_document["sources"]) != 60:
            raise AssertionError("ported source catalog is not complete and ready")
        mappings.append({
            "scenario": "capabilities",
            "original": "GET Torznab t=caps&apikey=<redacted>",
            "ported": "GET /v1/sources + bearer capability",
            "normalization": "raw modes/categories are retained internally; product exposes immutable status only",
        })

        original_indexers_path = (
            "/api/v2.0/indexers/all/results/torznab/api?"
            + urllib.parse.urlencode({
                "apikey": api_key,
                "t": "indexers",
                "configured": "true",
            })
        )
        original_indexers = request(original_port, "GET", original_indexers_path)
        save_transcript(
            transcripts,
            "04-original-indexers",
            "GET",
            original_indexers_path,
            {},
            None,
            original_indexers,
            redactions,
        )
        save_transcript(
            transcripts,
            "04-ported-indexers",
            "GET",
            "/v1/sources",
            mini_headers,
            None,
            mini_sources,
            redactions,
        )
        if (
            b'id="wildbuzzard-fixture"' not in original_indexers["body"]
            or not sources_document["immutable"]
        ):
            raise AssertionError("indexer/source enumeration mismatch")
        mappings.append({
            "scenario": "indexers",
            "original": "GET Torznab t=indexers&configured=true&apikey=<redacted>",
            "ported": "GET /v1/sources + bearer capability",
            "normalization": "mutable upstream configuration is replaced by all 60 immutable eligible sources",
        })

        query_text = "fixture Ω"
        original_search_path = (
            "/api/v2.0/indexers/wildbuzzard-fixture/results/torznab/api?"
            + urllib.parse.urlencode({
                "apikey": api_key,
                "t": "search",
                "q": query_text,
                "limit": "100",
                "offset": "0",
                "cache": "false",
            })
        )
        mini_search_body = json.dumps(
            {"query": query_text, "sourceIds": ["showrss"], "limit": 100},
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        search_headers = {**mini_headers, "Content-Type": "application/json"}
        original_search = request(original_port, "GET", original_search_path)
        mini_search = request(
            mini_port,
            "POST",
            "/v1/search",
            mini_search_body,
            search_headers,
            timeout=35,
        )
        save_transcript(
            transcripts,
            "05-original-search",
            "GET",
            original_search_path,
            {},
            None,
            original_search,
            redactions,
        )
        save_transcript(
            transcripts,
            "05-ported-search",
            "POST",
            "/v1/search",
            search_headers,
            mini_search_body,
            mini_search,
            redactions,
        )
        if original_search["status"] != 200 or mini_search["status"] != 200:
            raise AssertionError("search request failed")
        parsed_original = parse_torznab(original_search["body"], "showrss", "showRSS")
        expected_results = product_results(parsed_original)
        canonical_mini = canonicalize_mini(mini_search["body"])
        canonical_original = {
            "partial": False,
            "providers": [{"id": "showrss", "state": "ok"}],
            "results": expected_results,
        }
        write_json(artifacts / "canonical-original-search.json", canonical_original)
        write_json(artifacts / "canonical-ported-search.json", canonical_mini)
        original_text = canonical_json(canonical_original).splitlines(keepends=True)
        ported_text = canonical_json(canonical_mini).splitlines(keepends=True)
        semantic_diff = "".join(
            difflib.unified_diff(
                original_text,
                ported_text,
                fromfile="pristine-normalized",
                tofile="jackett-mini",
            )
        )
        (artifacts / "canonical-search.diff").write_text(
            semantic_diff, encoding="utf-8"
        )
        if semantic_diff:
            raise AssertionError("unexplained canonical search difference")
        raw_mini_search = json.loads(mini_search["body"])
        if any(
            any(6000 <= category <= 6999 for category in result["categoryIds"])
            for result in raw_mini_search["results"]
        ):
            raise AssertionError("adult category escaped product filtering")
        if (
            len([
                result
                for result in raw_mini_search["results"]
                if result["name"].startswith("Fixture Ω Magnet")
            ])
            != 1
        ):
            raise AssertionError("duplicate infohash was not removed")
        mappings.append({
            "scenario": "search",
            "original": "GET Torznab t=search&q=fixture%20Ω&limit=100&offset=0&cache=false&apikey=<redacted>",
            "ported": "POST /v1/search {query,sourceIds:[showrss],limit} + bearer capability",
            "normalization": "provider alias, opaque IDs, timing, ordering; category 6000 is dropped and duplicate BTIH is collapsed",
        })

        original_items = parsed_original["results"]
        mini_results = raw_mini_search["results"]
        for title, expected_private, sequence in (
            ("Fixture Public Torrent", False, "06"),
            ("Fixture Private Torrent", True, "07"),
        ):
            original_item = next(
                item for item in original_items if item["name"] == title
            )
            mini_item = next(item for item in mini_results if item["name"] == title)
            target = urllib.parse.urlsplit(original_item["_link"])
            original_download = request(
                target.port or original_port,
                "GET",
                target.path + (("?" + target.query) if target.query else ""),
            )
            mini_resolve_path = f"/v1/results/{mini_item['resultId']}/resolve"
            mini_resolve = request(
                mini_port, "POST", mini_resolve_path, b"", mini_headers
            )
            save_transcript(
                transcripts,
                f"{sequence}-original-resolve",
                "GET",
                original_item["_link"],
                {},
                None,
                original_download,
                redactions,
            )
            save_transcript(
                transcripts,
                f"{sequence}-ported-resolve",
                "POST",
                mini_resolve_path,
                mini_headers,
                b"",
                mini_resolve,
                redactions,
            )
            if original_download["status"] != 200:
                raise AssertionError("pristine torrent resolution failed")
            if expected_private:
                if mini_resolve["status"] != 502:
                    raise AssertionError("private torrent was not rejected")
            else:
                resolved = json.loads(mini_resolve["body"])
                if (
                    mini_resolve["status"] != 200
                    or resolved["kind"] != "torrent"
                    or base64.b64decode(resolved["torrentBase64"], validate=True)
                    != original_download["body"]
                ):
                    raise AssertionError("public torrent bytes differ")
                second = request(
                    mini_port, "POST", mini_resolve_path, b"", mini_headers
                )
                save_transcript(
                    transcripts,
                    "06-ported-resolve-second-use",
                    "POST",
                    mini_resolve_path,
                    mini_headers,
                    b"",
                    second,
                    redactions,
                )
                if second["status"] != 404:
                    raise AssertionError("opaque result was not one-shot")
        mappings.append({
            "scenario": "public torrent resolution",
            "original": "GET redacted Jackett dl proxy URL",
            "ported": "POST /v1/results/:opaque/resolve + bearer capability",
            "normalization": "public bencoded bytes must match exactly; ported result ID is one-shot",
        })
        mappings.append({
            "scenario": "private torrent resolution",
            "original": "GET redacted Jackett dl proxy URL",
            "ported": "POST /v1/results/:opaque/resolve + bearer capability",
            "normalization": "intentional product rejection of info.private=1",
        })

        auth_cases = [
            ("08-invalid", "invalid", {"Authorization": "Bearer invalid"}),
            ("09-missing", None, {}),
        ]
        for prefix, original_key, ported_headers in auth_cases:
            query = {"t": "caps"}
            if original_key is not None:
                query["apikey"] = original_key
            original_path = (
                "/api/v2.0/indexers/wildbuzzard-fixture/results/torznab/api?"
                + urllib.parse.urlencode(query)
            )
            original_auth = request(original_port, "GET", original_path)
            mini_auth = request(mini_port, "GET", "/v1/sources", headers=ported_headers)
            save_transcript(
                transcripts,
                f"{prefix}-original-auth",
                "GET",
                original_path,
                {},
                None,
                original_auth,
                redactions,
            )
            save_transcript(
                transcripts,
                f"{prefix}-ported-auth",
                "GET",
                "/v1/sources",
                ported_headers,
                None,
                mini_auth,
                redactions,
            )
            parsed_error = parse_torznab(original_auth["body"], "showrss", "showRSS")
            if (
                original_auth["status"] != 200
                or parsed_error.get("code") != 100
                or mini_auth["status"] != 401
            ):
                raise AssertionError("authentication denial semantics differ")
            mappings.append({
                "scenario": prefix.removeprefix("08-").removeprefix("09-")
                + " authentication",
                "original": "GET Torznab with missing/invalid apikey",
                "ported": "GET /v1/sources with missing/invalid bearer capability",
                "normalization": "upstream HTTP 200 XML error 100 maps to HTTP 401",
            })

        passkey_path = (
            "/api/v2.0/indexers/wildbuzzard-fixture/results/torznab/api?"
            + urllib.parse.urlencode({"passkey": api_key, "t": "caps"})
        )
        passkey_original = request(original_port, "GET", passkey_path)
        passkey_ported = request(
            mini_port, "GET", "/v1/sources?passkey=forbidden", headers=mini_headers
        )
        save_transcript(
            transcripts,
            "10-original-passkey",
            "GET",
            passkey_path,
            {},
            None,
            passkey_original,
            redactions,
        )
        save_transcript(
            transcripts,
            "10-ported-passkey",
            "GET",
            "/v1/sources?passkey=forbidden",
            mini_headers,
            None,
            passkey_ported,
            redactions,
        )
        if passkey_original["status"] != 200 or passkey_ported["status"] != 400:
            raise AssertionError("passkey boundary mismatch")
        mappings.append({
            "scenario": "passkey alias",
            "original": "GET Torznab t=caps&passkey=<redacted>",
            "ported": "GET /v1/sources?passkey=forbidden + bearer capability",
            "normalization": "upstream alias succeeds; product deliberately rejects query-string secrets",
        })

        forbidden_requests = [
            ("GET", "/UI/Dashboard"),
            ("GET", "/api/v2.0/indexers/showrss/Config"),
            ("POST", "/api/v2.0/indexers/showrss/Config"),
            ("POST", "/api/v2.0/indexers/showrss/Test"),
            ("DELETE", "/api/v2.0/indexers/showrss"),
            ("GET", "/api/v2.0/indexers/showrss/results/torznab/api"),
            ("POST", "/api/v2.0/server/config"),
            ("POST", "/api/v2.0/server/update"),
        ]
        forbidden_statuses = {}
        for index, (method, forbidden_path) in enumerate(forbidden_requests, 11):
            forbidden_body = b"{}" if method == "POST" else None
            forbidden_headers = {
                **mini_headers,
                **({"Content-Type": "application/json"} if forbidden_body else {}),
            }
            response = request(
                mini_port, method, forbidden_path, forbidden_body, forbidden_headers
            )
            save_transcript(
                transcripts,
                f"{index:02d}-ported-forbidden",
                method,
                forbidden_path,
                forbidden_headers,
                forbidden_body,
                response,
                redactions,
            )
            forbidden_statuses[f"{method} {forbidden_path}"] = response["status"]
            if response["status"] != 404:
                raise AssertionError(
                    f"forbidden route remained reachable: {forbidden_path}"
                )
        query_capability = request(
            mini_port, "GET", "/v1/sources?capability=forbidden", headers=mini_headers
        )
        save_transcript(
            transcripts,
            "19-ported-query-capability",
            "GET",
            "/v1/sources?capability=forbidden",
            mini_headers,
            None,
            query_capability,
            redactions,
        )
        if query_capability["status"] != 400:
            raise AssertionError("query capability was not rejected")

        excluded_body = json.dumps(
            {"query": "fixture", "sourceIds": ["nekobt"], "limit": 10},
            separators=(",", ":"),
        ).encode()
        excluded = request(
            mini_port, "POST", "/v1/search", excluded_body, search_headers
        )
        save_transcript(
            transcripts,
            "20-ported-excluded-source",
            "POST",
            "/v1/search",
            search_headers,
            excluded_body,
            excluded,
            redactions,
        )
        if excluded["status"] != 400:
            raise AssertionError("excluded source was queryable")

        write_json(
            logs / "original-process-identity.json",
            process_identity(processes[original_name]),
        )
        write_json(
            logs / "mini-process-identity.json", process_identity(processes[mini_name])
        )
        run_command(
            ["ss", "-ltnp", f"sport = :{original_port} or sport = :{mini_port}"],
            logs / "loopback-listeners.log",
        )
        listener_text = (logs / "loopback-listeners.log").read_text(encoding="utf-8")
        if any(
            f"127.0.0.1:{port}" not in listener_text
            for port in (original_port, mini_port)
        ):
            raise AssertionError("service loopback listener was not observed")
        if any(
            marker in listener_text
            for port in (original_port, mini_port)
            for marker in (f"0.0.0.0:{port}", f"[::]:{port}", f"*:{port}")
        ):
            raise AssertionError("service exposed a wildcard listener")

        mappings.append({
            "scenario": "removed product surfaces",
            "original": "dashboard/config/test/update/raw Torznab routes are reference-only",
            "ported": "same paths with bearer capability",
            "normalization": "all deliberately removed routes return 404; query capability returns 400",
        })
        write_json(artifacts / "request-mapping.json", mappings)
        write_json(artifacts / "forbidden-route-statuses.json", forbidden_statuses)
        write_json(artifacts / "fixture-requests.json", fixture_server.requests)
        metadata = {
            "schemaVersion": 1,
            "sourceCommit": COMMIT,
            "sourceVersion": VERSION,
            "sourceArchiveSha256": SOURCE_SHA256,
            "platform": "linux-x86_64-glibc",
            "rootless": True,
            "executionMode": "direct-rootless-user-network-namespace",
            "ports": {
                "fixture": fixture_port,
                "pristine": original_port,
                "ported": mini_port,
            },
            "runtimes": {
                "pristineExecutableSha256": sha256_file(pristine_executable),
                "portedExecutableSha256": sha256_file(mini_executable),
                "portedManifestSha256": sha256_file(mini_manifest_path),
            },
            "redactedConfigSha256": hashlib.sha256(
                canonical_json(redacted_config).encode()
            ).hexdigest(),
            "testOverlays": {
                "pristineDefinitionSha256": sha256_file(original_definition),
                "portedDefinitionSha256": sha256_file(mini_definition),
                "portedCatalogSha256": sha256_file(test_catalog_path),
            },
            "dataModes": {
                "pristineRoot": oct(mode(pristine_data)),
                "pristineConfig": oct(mode(server_config_path)),
                "portedRoot": oct(mode(mini_data)),
                "portedCapability": oct(mode(capability_path)),
            },
            "expectedPristineBuild": "build-pristine-jackett.sh --output DIR --object-dir DIR --log-dir DIR",
            "normalizations": [
                "ports",
                "timestamps",
                "ordering",
                "opaque IDs",
                "elapsed timing",
                "redacted service secrets",
            ],
            "intentionalDifferences": [
                "immutable source catalog",
                "bearer capability",
                "no dashboard/config/update/raw Torznab routes",
                "adult result filtering",
                "duplicate BTIH collapse",
                "private torrent rejection",
                "one-shot opaque resolution",
            ],
        }
        write_json(artifacts / "run-metadata.json", metadata)
        success = True
    except Exception:
        (artifacts / "failure.txt").write_text(traceback.format_exc(), encoding="utf-8")
        raise
    finally:
        for name in service_names:
            process = processes.get(name)
            exit_code = stop_process(process) if process else None
            if name in process_logs:
                process_logs[name].close()
            cleanup["processes"][name] = {
                "execution": "direct-rootless-user-network-namespace",
                "exitCode": exit_code,
            }
        for log_path in (*logs.glob("*"), artifacts / "failure.txt"):
            if log_path.is_file():
                log_path.write_bytes(redact_bytes(log_path.read_bytes(), redactions))
                log_path.chmod(0o600)
        fixture_server.shutdown()
        fixture_server.server_close()
        fixture_thread.join(timeout=5)
        cleanup["fixtureStopped"] = not fixture_thread.is_alive()
        for label, port in (
            ("pristine", original_port),
            ("ported", mini_port),
            ("fixture", fixture_port),
        ):
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
                probe.settimeout(0.2)
                cleanup["ports"][label] = (
                    "closed" if probe.connect_ex(("127.0.0.1", port)) != 0 else "open"
                )
        for label, directory in (("pristine", pristine_data), ("ported", mini_data)):
            shutil.rmtree(directory, ignore_errors=True)
            cleanup["dataRootsRemoved"][label] = not directory.exists()
        shutil.rmtree(overlays / "mini-runtime", ignore_errors=True)
        cleanup["testRuntimeRemoved"] = not (overlays / "mini-runtime").exists()
        cleanup["comparisonSucceeded"] = success
        write_json(artifacts / "cleanup.json", cleanup)
        leak_markers = [
            secret.encode() for secret, _replacement in redactions if secret
        ]
        leaks = []
        for path in artifacts.rglob("*"):
            if path.is_file():
                payload = path.read_bytes()
                if any(marker in payload for marker in leak_markers):
                    leaks.append(str(path.relative_to(artifacts)))
        write_json(
            artifacts / "leakage-scan.json",
            {"markersScanned": len(leak_markers), "leaks": leaks},
        )
        if leaks and success:
            raise AssertionError(f"comparison evidence leaked secrets: {leaks}")

    print(artifacts)


if __name__ == "__main__":
    main()
