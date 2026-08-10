# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import argparse
import contextlib
import datetime
import difflib
import hashlib
import http.client
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
import sys
import time
import urllib.parse

HERE = pathlib.Path(__file__).resolve().parent
CHECKOUT = HERE.parents[3]
SOURCE_ROOT = CHECKOUT / "wildbuzzard" / "third_party" / "agpl" / "searxng"
INDEX_DIGEST = "sha256:f4c8e59de166ed71f6380c0847c312ca51f0d41996e31d0559163b6b09ecde52"
PLATFORM_DIGEST = (
    "sha256:dc5c10fda6818dfef7abfdf9f451b898242c3321514a9524af215cbedc79c89b"
)
BASE_REVISION = "c63835bd2a5133b30b3752a20eac6b443a918f41"
SOURCE_COMMIT = "b023a28bab8839dba9eac96e9a51cc91bbd0a267"
INDEX_REFERENCE = f"docker.io/searxng/searxng@{INDEX_DIGEST}"
PLATFORM_REFERENCE = f"docker.io/searxng/searxng@{PLATFORM_DIGEST}"
TOKEN_PATTERN = re.compile(r"Bearer [A-Za-z0-9._~-]+")
PORT_PATTERN = re.compile(r"http://127\.0\.0\.1:\d+")


def utc_now() -> str:
    return (
        datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    )


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def write_json(path: pathlib.Path, value: object) -> None:
    path.write_text(
        json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    path.chmod(0o600)


class Recorder:
    def __init__(self, artifacts: pathlib.Path):
        self.artifacts = artifacts
        self.commands: list[dict[str, object]] = []

    def run(
        self,
        name: str,
        command: list[str],
        *,
        cwd: pathlib.Path | None = None,
        check: bool = True,
    ) -> subprocess.CompletedProcess[str]:
        started = time.monotonic()
        result = subprocess.run(
            command,
            cwd=cwd,
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        output_path = self.artifacts / f"command-{len(self.commands):02d}-{name}.log"
        output_path.write_text(result.stdout, encoding="utf-8")
        output_path.chmod(0o600)
        self.commands.append({
            "name": name,
            "argv": command,
            "cwd": str(cwd) if cwd else None,
            "exitCode": result.returncode,
            "durationMilliseconds": round((time.monotonic() - started) * 1000),
            "output": output_path.name,
        })
        if check and result.returncode:
            raise RuntimeError(f"{name} failed with exit code {result.returncode}")
        return result


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime-root", required=True)
    parser.add_argument("--artifacts", required=True)
    parser.add_argument("--timeout", type=float, default=30.0)
    return parser.parse_args()


def validate_paths(args: argparse.Namespace) -> tuple[pathlib.Path, pathlib.Path]:
    runtime_root = pathlib.Path(args.runtime_root).resolve(strict=True)
    artifacts = pathlib.Path(args.artifacts).resolve()
    try:
        artifacts.relative_to(CHECKOUT)
    except ValueError:
        pass
    else:
        raise RuntimeError("Comparison artifacts must be outside the checkout")
    artifacts.mkdir(mode=0o700, parents=True, exist_ok=False)
    artifacts.chmod(0o700)
    manifest = json.loads(
        (runtime_root / "wildbuzzard-runtime.json").read_text(encoding="utf-8")
    )
    if manifest.get("upstreamCommit") != SOURCE_COMMIT:
        raise RuntimeError("Native runtime does not contain the selected SearXNG pin")
    return runtime_root, artifacts


def verify_rootless_podman(recorder: Recorder) -> dict[str, object]:
    if os.geteuid() == 0:
        raise RuntimeError("The pristine comparison must not run as root")
    version = recorder.run("podman-version", ["podman", "version", "--format", "json"])
    info = recorder.run(
        "podman-rootless", ["podman", "info", "--format", "{{.Host.Security.Rootless}}"]
    )
    if info.stdout.strip() != "true":
        raise RuntimeError("Podman is not operating rootlessly")
    return json.loads(version.stdout)


def verify_and_pull_base(recorder: Recorder) -> dict[str, object]:
    manifest_result = recorder.run(
        "pristine-index-manifest", ["podman", "manifest", "inspect", INDEX_REFERENCE]
    )
    manifest = json.loads(manifest_result.stdout)
    matches = [
        item
        for item in manifest.get("manifests", [])
        if item.get("platform", {}).get("os") == "linux"
        and item.get("platform", {}).get("architecture") == "amd64"
    ]
    if len(matches) != 1 or matches[0].get("digest") != PLATFORM_DIGEST:
        raise RuntimeError("Pinned SearXNG image has an unexpected amd64 manifest")
    recorder.run(
        "pristine-image-pull",
        ["podman", "pull", "--platform", "linux/amd64", INDEX_REFERENCE],
    )
    inspect_result = recorder.run(
        "pristine-image-inspect", ["podman", "image", "inspect", PLATFORM_REFERENCE]
    )
    inspect = json.loads(inspect_result.stdout)[0]
    if inspect.get("Digest") != PLATFORM_DIGEST:
        raise RuntimeError("Pulled SearXNG platform digest mismatch")
    labels = inspect.get("Labels") or inspect.get("Config", {}).get("Labels", {})
    if labels.get("org.opencontainers.image.revision") != BASE_REVISION:
        raise RuntimeError("Pinned SearXNG base image revision mismatch")
    return {
        "indexReference": INDEX_REFERENCE,
        "indexDigest": INDEX_DIGEST,
        "platformReference": PLATFORM_REFERENCE,
        "platformDigest": PLATFORM_DIGEST,
        "imageId": inspect.get("Id"),
        "baseRevision": BASE_REVISION,
        "selectedSourceCommit": SOURCE_COMMIT,
        "applicationTreeReplaced": True,
    }


def prepare_build_context(work: pathlib.Path) -> pathlib.Path:
    context = work / "pristine-build-context"
    context.mkdir()
    shutil.copytree(SOURCE_ROOT / "upstream", context / "upstream", symlinks=True)
    shutil.copy2(HERE / "Containerfile.pristine", context / "Containerfile")
    shutil.copy2(HERE / "version_frozen.py", context / "version_frozen.py")
    return context


def prepare_native_runtime(
    runtime_root: pathlib.Path, work: pathlib.Path
) -> pathlib.Path:
    derived = work / "native-fixture-runtime"
    shutil.copytree(runtime_root, derived, symlinks=True)
    policy_source = HERE / "fixture-engine-policy.json"
    policy_target = derived / "share" / "wildbuzzard" / "searxng" / "engine-policy.json"
    shutil.copy2(policy_source, policy_target)
    manifest_path = derived / "wildbuzzard-runtime.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    policy_digest = sha256_file(policy_target)
    manifest["providerPolicySha256"] = policy_digest
    relative = policy_target.relative_to(derived).as_posix()
    matches = [entry for entry in manifest["files"] if entry["path"] == relative]
    if len(matches) != 1:
        raise RuntimeError("Native runtime manifest has no unique engine policy entry")
    matches[0]["sha256"] = policy_digest
    matches[0]["size"] = policy_target.stat().st_size
    manifest_path.write_text(
        json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    return derived


def random_loopback_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def wait_http(port: int, path: str, headers: dict[str, str], timeout: float) -> None:
    deadline = time.monotonic() + timeout
    last_error = "not started"
    while time.monotonic() < deadline:
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=1)
        try:
            connection.request("GET", path, headers=headers)
            response = connection.getresponse()
            response.read()
            if response.status == 200:
                return
            last_error = f"HTTP {response.status}"
        except OSError as error:
            last_error = str(error)
        finally:
            connection.close()
        time.sleep(0.1)
    raise RuntimeError(f"Timed out waiting for {path}: {last_error}")


def read_connection(
    path: pathlib.Path, process: subprocess.Popen[bytes], timeout: float
) -> dict[str, object]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(
                f"Native SearXNG exited during startup ({process.returncode})"
            )
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            time.sleep(0.1)
            continue
        if stat.S_IMODE(path.stat().st_mode) != 0o600:
            raise RuntimeError("Native SearXNG connection record is not mode 0600")
        if record.get("address") != "127.0.0.1" or not isinstance(
            record.get("port"), int
        ):
            raise RuntimeError("Native SearXNG connection record is invalid")
        if not isinstance(record.get("token"), str):
            raise RuntimeError("Native SearXNG connection record has no capability")
        return record
    raise RuntimeError("Timed out waiting for native SearXNG connection record")


def scenarios() -> list[dict[str, object]]:
    full = {
        "q": "WildBuzzard café 東京",
        "categories": "general",
        "engines": "fixture engine",
        "language": "en-US",
        "pageno": "2",
        "time_range": "day",
        "safesearch": "1",
    }
    cases: list[dict[str, object]] = [
        {"name": "health", "method": "GET", "path": "/healthz", "accept": "text/plain"},
        {
            "name": "config",
            "method": "GET",
            "path": "/config",
            "accept": "application/json",
        },
    ]
    for name, method, response_format in (
        ("get-json-all-parameters", "GET", "json"),
        ("post-json-all-parameters", "POST", "json"),
        ("get-html-all-parameters", "GET", "html"),
        ("post-html-all-parameters", "POST", "html"),
    ):
        parameters = {**full, "format": response_format}
        encoded = urllib.parse.urlencode(parameters)
        cases.append({
            "name": name,
            "method": method,
            "path": "/search" + (f"?{encoded}" if method == "GET" else ""),
            "body": encoded.encode() if method == "POST" else b"",
            "contentType": (
                "application/x-www-form-urlencoded" if method == "POST" else None
            ),
            "accept": "application/json" if response_format == "json" else "text/html",
        })
    focused = (
        ("categories", {"q": "category", "categories": "general", "format": "json"}),
        (
            "engine-selection",
            {"q": "engine", "engines": "fixture engine", "format": "json"},
        ),
        ("language", {"q": "language", "language": "de-DE", "format": "json"}),
        ("page", {"q": "page", "pageno": "3", "format": "json"}),
        ("time-range", {"q": "time", "time_range": "week", "format": "json"}),
        ("safe-search", {"q": "safe", "safesearch": "2", "format": "json"}),
        ("empty-query", {"q": "", "format": "json"}),
        ("disabled-format", {"q": "format", "format": "csv"}),
        ("unknown-engine", {"q": "engine", "engines": "absent", "format": "json"}),
    )
    for name, parameters in focused:
        cases.append({
            "name": name,
            "method": "GET",
            "path": "/search?" + urllib.parse.urlencode(parameters),
            "accept": "application/json",
        })
    return cases


def issue_request(
    port: int, case: dict[str, object], capability: str
) -> dict[str, object]:
    headers = {
        "Accept": str(case["accept"]),
        "Authorization": f"Bearer {capability}",
        "Connection": "close",
        "Sec-Fetch-Site": "none",
        "User-Agent": "WildBuzzard-SearXNG-Comparison/1",
    }
    if case.get("contentType"):
        headers["Content-Type"] = str(case["contentType"])
    body = case.get("body", b"")
    if not isinstance(body, bytes):
        raise TypeError("Scenario body must be bytes")
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    started = time.monotonic()
    connection.request(
        str(case["method"]), str(case["path"]), body=body, headers=headers
    )
    response = connection.getresponse()
    payload = response.read()
    duration = round((time.monotonic() - started) * 1000)
    result = {
        "status": response.status,
        "reason": response.reason,
        "headers": list(response.getheaders()),
        "body": payload,
        "durationMilliseconds": duration,
    }
    connection.close()
    return result


def normalized_string(value: str) -> str:
    value = PORT_PATTERN.sub("http://127.0.0.1:<port>", value)
    value = TOKEN_PATTERN.sub("Bearer <redacted>", value)
    return value


def normalize_json(value: object) -> object:
    if isinstance(value, dict):
        return {
            key: normalize_json(item)
            for key, item in sorted(value.items())
            if key not in {"elapsed", "response_time"}
        }
    if isinstance(value, list):
        return [normalize_json(item) for item in value]
    if isinstance(value, str):
        return normalized_string(value)
    return value


def canonical_body(response: dict[str, object]) -> bytes:
    payload = response["body"]
    if not isinstance(payload, bytes):
        raise TypeError("Response body must be bytes")
    headers = {str(name).lower(): str(value) for name, value in response["headers"]}
    media_type = headers.get("content-type", "").split(";", 1)[0].strip()
    if media_type == "application/json":
        try:
            parsed = json.loads(payload)
        except json.JSONDecodeError:
            return payload
        return (
            json.dumps(normalize_json(parsed), sort_keys=True, separators=(",", ":"))
            + "\n"
        ).encode()
    if media_type == "text/html":
        value = normalized_string(payload.decode("utf-8", "replace"))
        value = re.sub(
            r"Response time: [0-9.]+ seconds", "Response time: <elapsed>", value
        )
        value = re.sub(
            r'(<div class="bar-chart-value">)[0-9.]+(</div>)',
            r"\1<elapsed>\2",
            value,
        )
        value = re.sub(r"bar-chart-bar bar\d+", "bar-chart-bar bar<elapsed>", value)
        value = re.sub(r">\s+<", "><", value).strip()
        return (value + "\n").encode()
    return payload


def content_type(response: dict[str, object]) -> str:
    for name, value in response["headers"]:
        if str(name).lower() == "content-type":
            return str(value).split(";", 1)[0].strip().lower()
    return ""


def request_transcript(case: dict[str, object], port: int, capability: str) -> bytes:
    body = case.get("body", b"")
    headers = [
        f"Host: 127.0.0.1:{port}",
        f"Accept: {case['accept']}",
        f"Authorization: Bearer {capability}",
        "Connection: close",
        "Sec-Fetch-Site: none",
        "User-Agent: WildBuzzard-SearXNG-Comparison/1",
    ]
    if case.get("contentType"):
        headers.append(f"Content-Type: {case['contentType']}")
        headers.append(f"Content-Length: {len(body)}")
    value = f"{case['method']} {case['path']} HTTP/1.1\r\n"
    value += "\r\n".join(headers) + "\r\n\r\n"
    return TOKEN_PATTERN.sub("Bearer <redacted>", value).encode() + body


def record_response(
    directory: pathlib.Path, name: str, response: dict[str, object]
) -> None:
    headers = {
        "status": response["status"],
        "reason": response["reason"],
        "headers": response["headers"],
        "durationMilliseconds": response["durationMilliseconds"],
    }
    write_json(directory / f"{name}.response.json", headers)
    payload = response["body"]
    if not isinstance(payload, bytes):
        raise TypeError("Response body must be bytes")
    (directory / f"{name}.response.body").write_bytes(payload)


def compare_scenarios(
    artifacts: pathlib.Path,
    pristine_port: int,
    native_port: int,
    capability: str,
) -> list[dict[str, object]]:
    scenario_root = artifacts / "scenarios"
    scenario_root.mkdir(mode=0o700)
    results = []
    for index, case in enumerate(scenarios(), 1):
        directory = scenario_root / f"{index:02d}-{case['name']}"
        directory.mkdir(mode=0o700)
        pristine = issue_request(pristine_port, case, capability)
        native = issue_request(native_port, case, capability)
        (directory / "pristine.request.http").write_bytes(
            request_transcript(case, pristine_port, capability)
        )
        (directory / "native.request.http").write_bytes(
            request_transcript(case, native_port, capability)
        )
        record_response(directory, "pristine", pristine)
        record_response(directory, "native", native)
        pristine_body = canonical_body(pristine)
        native_body = canonical_body(native)
        (directory / "pristine.canonical.body").write_bytes(pristine_body)
        (directory / "native.canonical.body").write_bytes(native_body)
        equal = (
            pristine["status"] == native["status"]
            and content_type(pristine) == content_type(native)
            and pristine_body == native_body
        )
        diff = "".join(
            difflib.unified_diff(
                pristine_body.decode("utf-8", "replace").splitlines(keepends=True),
                native_body.decode("utf-8", "replace").splitlines(keepends=True),
                fromfile="pristine",
                tofile="native",
            )
        )
        (directory / "canonical.diff").write_text(diff, encoding="utf-8")
        results.append({
            "name": case["name"],
            "method": case["method"],
            "path": case["path"],
            "status": {
                "pristine": pristine["status"],
                "native": native["status"],
            },
            "contentType": {
                "pristine": content_type(pristine),
                "native": content_type(native),
            },
            "canonicalBodySha256": {
                "pristine": sha256_bytes(pristine_body),
                "native": sha256_bytes(native_body),
            },
            "equal": equal,
            "artifacts": directory.relative_to(artifacts).as_posix(),
        })
    return results


def cancellation_probe(port: int, capability: str) -> dict[str, object]:
    body = urllib.parse.urlencode({
        "q": "cancel",
        "format": "json",
        "engines": "fixture engine",
    }).encode()
    request = (
        "POST /search HTTP/1.1\r\n"
        f"Host: 127.0.0.1:{port}\r\n"
        "Accept: application/json\r\n"
        f"Authorization: Bearer {capability}\r\n"
        "Content-Type: application/x-www-form-urlencoded\r\n"
        f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n"
    ).encode() + body
    started = time.monotonic()
    sock = socket.create_connection(("127.0.0.1", port), timeout=5)
    sock.sendall(request)
    sock.close()
    return {
        "cancelledAfter": "request-body-sent",
        "elapsedMilliseconds": round((time.monotonic() - started) * 1000),
    }


def main() -> int:
    args = parse_args()
    runtime_root, artifacts = validate_paths(args)
    recorder = Recorder(artifacts)
    work = artifacts / "work"
    work.mkdir(mode=0o700)
    run_id = secrets.token_hex(8)
    container_name = f"wildbuzzard-searxng-pristine-{run_id}"
    image_tag = f"localhost/wildbuzzard-searxng-pristine:{run_id}"
    native_process: subprocess.Popen[bytes] | None = None
    native_log = None
    container_created = False
    image_created = False
    summary: dict[str, object] = {
        "schema": 1,
        "startedAt": utc_now(),
        "outcome": "infrastructure-failure",
        "sourceCommit": SOURCE_COMMIT,
        "runtimeManifestSha256": sha256_file(runtime_root / "wildbuzzard-runtime.json"),
    }
    cleanup: dict[str, object] = {}
    try:
        summary["podman"] = verify_rootless_podman(recorder)
        summary["pristineImage"] = verify_and_pull_base(recorder)
        recorder.run(
            "source-snapshot-check",
            [
                str(CHECKOUT / "wildbuzzard" / "scripts" / "import-searxng-source.sh"),
                "--check",
            ],
        )
        context = prepare_build_context(work)
        image_created = True
        recorder.run(
            "pristine-image-build",
            [
                "podman",
                "build",
                "--pull=never",
                "--tag",
                image_tag,
                "--file",
                str(context / "Containerfile"),
                str(context),
            ],
        )

        pristine_config = work / "pristine-config"
        pristine_cache = work / "pristine-cache"
        pristine_config.mkdir(mode=0o700)
        pristine_cache.mkdir(mode=0o700)
        settings_path = pristine_config / "settings.yml"
        template = (HERE / "fixture-settings.yml.in").read_text(encoding="utf-8")
        pristine_port = random_loopback_port()
        settings_path.write_text(
            template.replace("@PUBLIC_PORT@", str(pristine_port)), encoding="utf-8"
        )
        settings_path.chmod(0o600)
        container_created = True
        create = recorder.run(
            "pristine-container-create",
            [
                "podman",
                "create",
                "--name",
                container_name,
                "--cap-drop=all",
                "--security-opt",
                "no-new-privileges",
                "--read-only",
                "--tmpfs",
                "/tmp:rw,noexec,nosuid,nodev,size=64m",
                "--publish",
                f"127.0.0.1:{pristine_port}:8080",
                "--volume",
                f"{settings_path}:/etc/searxng/settings.yml:ro",
                "--volume",
                f"{pristine_cache}:/var/cache/searxng:rw",
                "--env",
                "SEARXNG_SETTINGS_PATH=/etc/searxng/settings.yml",
                "--env",
                "TMPDIR=/var/cache/searxng",
                "--entrypoint",
                "/usr/local/searxng/.venv/bin/granian",
                image_tag,
                "--interface",
                "wsgi",
                "--host",
                "0.0.0.0",
                "--port",
                "8080",
                "--no-ws",
                "--workers",
                "1",
                "--blocking-threads",
                "4",
                "searx.webapp:app",
            ],
        )
        if not create.stdout.strip():
            raise RuntimeError("Podman did not return a container identity")
        recorder.run("pristine-container-start", ["podman", "start", container_name])

        native_runtime = prepare_native_runtime(runtime_root, work)
        native_state = work / "native-state"
        native_data = work / "native-data"
        native_cache = work / "native-cache"
        for directory in (native_state, native_data, native_cache):
            directory.mkdir(mode=0o700)
        connection_path = native_state / "connection.json"
        native_command = [
            str(native_runtime / "bin" / "searxng-service"),
            "--data-root",
            str(native_data),
            "--cache-root",
            str(native_cache),
            "--runtime-dir",
            str(native_state),
            "--connection-file",
            str(connection_path),
            "--owner-instance-id",
            f"comparison-{run_id}",
        ]
        native_log = (artifacts / "native-service.log").open("wb")
        native_process = subprocess.Popen(
            native_command,
            stdin=subprocess.DEVNULL,
            stdout=native_log,
            stderr=subprocess.STDOUT,
            close_fds=True,
            start_new_session=True,
        )
        recorder.commands.append({
            "name": "native-service",
            "argv": native_command,
            "output": "native-service.log",
        })
        connection = read_connection(connection_path, native_process, args.timeout)
        native_port = int(connection["port"])
        capability = str(connection["token"])
        common_health_headers = {
            "Authorization": f"Bearer {capability}",
            "Sec-Fetch-Site": "none",
        }
        wait_http(pristine_port, "/healthz", common_health_headers, args.timeout)
        wait_http(native_port, "/v1/health", common_health_headers, args.timeout)

        pristine_redacted = template.replace("@PUBLIC_PORT@", "<port>").replace(
            "comparison-only-secret", "<redacted>"
        )
        native_settings = (native_state / "settings.yml").read_text(encoding="utf-8")
        native_redacted = PORT_PATTERN.sub("http://127.0.0.1:<port>", native_settings)
        native_redacted = re.sub(
            r"(?m)^(  secret_key: ).+$", r'\1"<redacted>"', native_redacted
        )
        (artifacts / "pristine-settings.redacted.yml").write_text(
            pristine_redacted, encoding="utf-8"
        )
        (artifacts / "native-settings.redacted.yml").write_text(
            native_redacted, encoding="utf-8"
        )
        summary["configuration"] = {
            "fixturePolicySha256": sha256_file(HERE / "fixture-engine-policy.json"),
            "pristineRedactedSha256": sha256_bytes(pristine_redacted.encode()),
            "nativeRedactedSha256": sha256_bytes(native_redacted.encode()),
        }
        redacted_connection = {
            key: value for key, value in connection.items() if key != "token"
        }
        redacted_connection["token"] = "<redacted>"
        summary["nativeIdentity"] = redacted_connection
        summary["ports"] = {"pristine": pristine_port, "native": native_port}
        results = compare_scenarios(artifacts, pristine_port, native_port, capability)
        summary["scenarios"] = results
        cancellation = {
            "pristine": cancellation_probe(pristine_port, capability),
            "native": cancellation_probe(native_port, capability),
        }
        summary["cancellation"] = cancellation
        summary["outcome"] = (
            "passed" if all(result["equal"] for result in results) else "parity-failure"
        )
    except Exception as error:
        summary["error"] = f"{type(error).__name__}: {error}"
    finally:
        if native_process:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(native_process.pid, signal.SIGTERM)
            try:
                native_exit = native_process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(native_process.pid, signal.SIGKILL)
                native_exit = native_process.wait(timeout=5)
            cleanup["nativeExitCode"] = native_exit
        if native_log:
            native_log.close()
        if container_created:
            logs = recorder.run(
                "pristine-container-logs",
                ["podman", "logs", container_name],
                check=False,
            )
            (artifacts / "pristine-service.log").write_text(
                logs.stdout, encoding="utf-8"
            )
            stop = recorder.run(
                "pristine-container-stop",
                ["podman", "stop", "--time", "10", container_name],
                check=False,
            )
            cleanup["pristineStopExitCode"] = stop.returncode
            inspect = recorder.run(
                "pristine-container-exit",
                [
                    "podman",
                    "inspect",
                    "--format",
                    "{{.State.ExitCode}}",
                    container_name,
                ],
                check=False,
            )
            cleanup["pristineServiceExitCode"] = inspect.stdout.strip()
            remove = recorder.run(
                "pristine-container-remove",
                ["podman", "rm", "--force", container_name],
                check=False,
            )
            cleanup["containerRemoved"] = remove.returncode == 0
        if image_created:
            remove_image = recorder.run(
                "pristine-image-remove",
                ["podman", "image", "rm", image_tag],
                check=False,
            )
            cleanup["testImageRemoved"] = remove_image.returncode == 0
        shutil.rmtree(work, ignore_errors=True)
        cleanup["workDirectoryRemoved"] = not work.exists()
        summary["commands"] = recorder.commands
        summary["cleanup"] = cleanup
        summary["finishedAt"] = utc_now()
        write_json(artifacts / "summary.json", summary)
    if summary["outcome"] == "passed":
        print(f"SearXNG pristine comparison passed: {artifacts / 'summary.json'}")
        return 0
    print(
        f"SearXNG pristine comparison failed ({summary['outcome']}): "
        f"{artifacts / 'summary.json'}",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
