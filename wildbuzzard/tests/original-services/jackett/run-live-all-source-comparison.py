#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later

import argparse
import concurrent.futures
import contextlib
import datetime
import difflib
import hashlib
import http.client
import importlib.util
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

HERE = pathlib.Path(__file__).resolve().parent
QUERY = "ubuntu"
LIMIT = 20
CONFIGURATION_TIMEOUT_SECONDS = 180
MAX_RESPONSE_BYTES = 16 * 1024 * 1024
ORACLE_IMAGE = "mcr.microsoft.com/dotnet/sdk@sha256:6e6542a43b6bf3c5ecfa80dd33c79c9fd09d58f95f4ebacd14fa056275b25164"


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


CANONICAL = load("jackett_live_canonical", HERE / "canonicalize.py")
PRISTINE = load("jackett_live_pristine", HERE / "pristine_runtime.py")


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def verify_pristine_source(root):
    manifest_path = HERE.parents[2] / "third_party/gpl2/jackett/upstream/SOURCE-MANIFEST.sha256"
    if sha256(manifest_path) != PRISTINE.SOURCE_MANIFEST_SHA256:
        raise RuntimeError("pristine source manifest identity mismatch")
    expected = {}
    for line in manifest_path.read_text(encoding="utf-8").splitlines():
        match = re.fullmatch(r"([0-9a-f]{64})  (.+)", line)
        if not match:
            raise RuntimeError("pristine source manifest is malformed")
        digest, relative = match.groups()
        path = pathlib.PurePosixPath(relative)
        if path.is_absolute() or ".." in path.parts or relative in expected:
            raise RuntimeError("pristine source manifest path is unsafe")
        expected[relative] = digest
    actual = {}
    for path in root.rglob("*"):
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode) or not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
            raise RuntimeError("pristine source contains a link or special file")
        if stat.S_ISREG(info.st_mode):
            actual[path.relative_to(root).as_posix()] = sha256(path)
    if actual != expected:
        raise RuntimeError("pristine source tree differs from its pinned manifest")
    return {
        "sourceArchiveSha256": PRISTINE.SOURCE_SHA256,
        "sourceManifestSha256": PRISTINE.SOURCE_MANIFEST_SHA256,
        "sourceManifestEntryCount": len(expected),
    }


def verify_mini_runtime(root, manifest_path, manifest):
    files = []
    for path in sorted(root.rglob("*")):
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode) or not (
            stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)
        ):
            raise RuntimeError("Mini runtime contains a link or special file")
        if not stat.S_ISREG(info.st_mode) or path == manifest_path:
            continue
        files.append(
            {
                "path": path.relative_to(root).as_posix(),
                "sha256": sha256(path),
                "size": info.st_size,
                "executable": bool(info.st_mode & 0o111),
            }
        )
    digest = hashlib.sha256(
        json.dumps(files, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    if files != manifest.get("files") or digest != manifest.get("runtimeSha256"):
        raise RuntimeError("Mini runtime inventory differs from its manifest")


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    path.chmod(0o600)


def write_text(path, value):
    path.write_text(value, encoding="utf-8")
    path.chmod(0o600)


def choose_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def request(port, method, path, body=None, headers=None, timeout=35, capture_errors=False, barrier=None):
    payload = body if isinstance(body, bytes) or body is None else json.dumps(body, separators=(",", ":")).encode()
    request_headers = dict(headers or {})
    if payload is not None:
        request_headers.update({"Content-Type": "application/json", "Content-Length": str(len(payload))})
    exchange = {
        "request": {
            "method": method,
            "path": path,
            "headers": sorted(request_headers.items()),
            "body": (payload or b"").decode("utf-8", "replace"),
        }
    }
    if barrier is not None:
        barrier.wait()
    started = time.monotonic()
    exchange["request"]["startedUnixNs"] = time.time_ns()
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    try:
        connection.request(method, path, payload, request_headers)
        response = connection.getresponse()
        response_body = response.read(MAX_RESPONSE_BYTES + 1)
        if len(response_body) > MAX_RESPONSE_BYTES:
            raise RuntimeError("live response exceeded limit")
        exchange["response"] = {
            "status": response.status,
            "headers": list(response.getheaders()),
            "body": response_body.decode("utf-8", "replace"),
            "elapsedMs": round((time.monotonic() - started) * 1000, 3),
        }
        return exchange
    except Exception as error:
        if not capture_errors:
            raise
        exchange["response"] = {
            "transportError": type(error).__name__,
            "message": str(error),
            "elapsedMs": round((time.monotonic() - started) * 1000, 3),
        }
        return exchange
    finally:
        connection.close()


def redact(value, replacements):
    if isinstance(value, dict):
        return {key: redact(item, replacements) for key, item in value.items()}
    if isinstance(value, list):
        return [redact(item, replacements) for item in value]
    if isinstance(value, tuple):
        return [redact(item, replacements) for item in value]
    if not isinstance(value, str):
        return value
    for source, replacement in replacements:
        if not source:
            continue
        if len(source) < 16:
            raise ValueError("refusing to redact a low-entropy value")
        variants = {
            source,
            urllib.parse.quote(source, safe=""),
            urllib.parse.quote_plus(source, safe=""),
            json.dumps(source, ensure_ascii=False)[1:-1],
        }
        for variant in sorted(variants, key=len, reverse=True):
            value = value.replace(variant, replacement)
    return value


def paired_requests(pristine, mini):
    barrier = threading.Barrier(3)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        pristine_future = executor.submit(request, *pristine, capture_errors=True, barrier=barrier)
        mini_future = executor.submit(request, *mini, capture_errors=True, barrier=barrier)
        barrier.wait()
        pristine_exchange = pristine_future.result()
        mini_exchange = mini_future.result()
    skew = abs(
        pristine_exchange["request"]["startedUnixNs"]
        - mini_exchange["request"]["startedUnixNs"]
    ) / 1_000_000
    return pristine_exchange, mini_exchange, round(skew, 3)


def response_status(exchange):
    return exchange.get("response", {}).get("status")


def environmental_failure(source_id):
    return {
        "failureClass": "transport-or-site",
        "partial": True,
        "providers": [{"id": source_id, "state": "failure"}],
        "results": [],
    }


def contract_failure(source_id):
    return {
        "failureClass": "contract",
        "partial": True,
        "providers": [{"id": source_id, "state": "failure"}],
        "results": [],
    }


def configuration_failure(configuration):
    fetched, configured = configuration
    if response_status(fetched) != 200:
        return {
            "stage": "configuration-get",
            "status": response_status(fetched),
            "transportError": fetched.get("response", {}).get("transportError"),
        }
    if response_status(configured) != 204:
        return {
            "stage": "configuration-post",
            "status": response_status(configured),
            "transportError": configured.get("response", {}).get("transportError"),
        }
    return None


def normalize_pristine(exchange, source_id, source_name, configuration):
    setup_failure = configuration_failure(configuration)
    response = exchange.get("response", {})
    if setup_failure:
        return environmental_failure(source_id), {
            "class": "transport-or-site",
            **setup_failure,
        }
    if "transportError" in response:
        return environmental_failure(source_id), {
            "class": "transport-or-site",
            "stage": "search",
            "transportError": response["transportError"],
            "message": response.get("message"),
        }
    try:
        parsed = CANONICAL.parse_torznab(response.get("body", "").encode(), source_id, source_name)
    except Exception as error:
        return contract_failure(source_id), {
            "class": "contract",
            "stage": "response-parse",
            "status": response.get("status"),
            "error": f"{type(error).__name__}: {error}",
        }
    if parsed.get("kind") == "error":
        failure_class = "transport-or-site" if parsed.get("code") == 900 else "contract"
        normalized = environmental_failure(source_id) if failure_class == "transport-or-site" else contract_failure(source_id)
        return normalized, {
            "class": failure_class,
            "stage": "search",
            "status": response.get("status"),
            "torznabCode": parsed.get("code"),
            "description": parsed.get("description", "").splitlines()[0],
        }
    if response.get("status") != 200:
        return contract_failure(source_id), {
            "class": "contract",
            "stage": "search",
            "status": response.get("status"),
            "error": "non-200 response contained a result feed",
        }
    return {
        "partial": False,
        "providers": [{"id": source_id, "state": "ok"}],
        "results": CANONICAL.product_results(parsed),
    }, {"class": "success", "status": response.get("status")}


def normalize_mini(exchange, source_id):
    response = exchange.get("response", {})
    if "transportError" in response:
        return environmental_failure(source_id), {
            "class": "transport-or-site",
            "stage": "search",
            "transportError": response["transportError"],
            "message": response.get("message"),
        }
    if response.get("status") != 200:
        return contract_failure(source_id), {
            "class": "contract",
            "stage": "search",
            "status": response.get("status"),
        }
    try:
        normalized = CANONICAL.canonicalize_mini(response.get("body", "").encode())
    except Exception as error:
        return contract_failure(source_id), {
            "class": "contract",
            "stage": "response-parse",
            "status": response.get("status"),
            "error": f"{type(error).__name__}: {error}",
        }
    providers = normalized.get("providers", [])
    if len(providers) != 1 or providers[0].get("id") != source_id:
        return contract_failure(source_id), {
            "class": "contract",
            "stage": "provider-status",
            "providers": providers,
        }
    state = providers[0].get("state")
    if state in {"error", "timeout"} and not normalized.get("results"):
        return environmental_failure(source_id), {
            "class": "transport-or-site",
            "stage": "search",
            "status": response.get("status"),
            "providerState": state,
        }
    if state != "ok" or normalized.get("partial") or any(
        result.get("providerId") != source_id for result in normalized.get("results", [])
    ):
        return contract_failure(source_id), {
            "class": "contract",
            "stage": "provider-status",
            "status": response.get("status"),
            "providerState": state,
        }
    normalized["results"] = sorted(
        normalized.get("results", []),
        key=lambda result: (
            result["seeders"] is None,
            -(result["seeders"] or 0),
            result["providerId"],
            result["name"].casefold(),
        ),
    )
    return normalized, {
        "class": "success",
        "status": response.get("status"),
        "providerState": state,
    }


def without_published_at(value):
    document = json.loads(json.dumps(value))
    for result in document.get("results", []):
        result.pop("publishedAt", None)
    return document


def compare_outcome(pristine, mini, pristine_signal, mini_signal):
    if pristine == mini:
        classes = {pristine_signal["class"], mini_signal["class"]}
        if classes == {"success"}:
            return "semantic-parity"
        if classes == {"transport-or-site"}:
            return "equivalent-environmental-failure"
        if classes == {"contract"}:
            return "equivalent-contract-failure"
        return "contract-mismatch"
    classes = {pristine_signal["class"], mini_signal["class"]}
    if classes == {"success"}:
        if without_published_at(pristine) == without_published_at(mini):
            return "volatile-published-at-mismatch"
        return "result-mismatch"
    if "success" in classes and "transport-or-site" in classes:
        return "availability-mismatch"
    return "contract-mismatch"


def wait_health(port, process=None):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if process is not None and process.poll() is not None:
            raise RuntimeError("service exited during startup")
        try:
            response = request(port, "GET", "/health", timeout=1)
            if response["response"]["status"] == 200:
                return
        except (OSError, TimeoutError):
            pass
        time.sleep(0.1)
    raise RuntimeError("service health timeout")


def wait_mini(port, capability, process):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError("Mini exited during startup")
        try:
            response = request(port, "GET", "/v1/health", headers={"Authorization": f"Bearer {capability}"}, timeout=1)
            if response["response"]["status"] == 200:
                return
        except (OSError, TimeoutError):
            pass
        time.sleep(0.1)
    raise RuntimeError("Mini health timeout")


def stop_host(process):
    if process is None:
        return {"exitCode": None, "remaining": []}
    for sig, timeout in ((signal.SIGINT, 5), (signal.SIGTERM, 10), (signal.SIGKILL, 5)):
        if process.poll() is not None:
            break
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, sig)
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            continue
    remaining = []
    for item in pathlib.Path("/proc").iterdir():
        if not item.name.isdigit():
            continue
        try:
            fields = (item / "stat").read_text().split(")", 1)[1].split()
            if int(fields[2]) == process.pid:
                remaining.append(int(item.name))
        except (FileNotFoundError, IndexError, ValueError):
            pass
    return {"exitCode": process.poll(), "remaining": sorted(remaining)}


def podman(runtime):
    command = [shutil.which("podman") or "podman"]
    if runtime:
        command.extend(("--runtime", str(pathlib.Path(runtime).resolve(strict=True))))
    if subprocess.check_output([*command, "info", "--format", "{{.Host.Security.Rootless}}"], text=True).strip() != "true":
        raise RuntimeError("pristine oracle Podman is not rootless")
    subprocess.run([*command, "pull", ORACLE_IMAGE], check=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    return command


def pristine_command(command, name, token, runtime, source, overlays, data, port):
    return [
        *command, "run", "--name", name, "--label", f"org.wildbuzzard.jackett-oracle-run={token}",
        "--network", "host", "--read-only", "--userns=keep-id", "--cap-drop=all",
        "--security-opt=no-new-privileges", "--security-opt=label=disable", "--pids-limit=512",
        "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=1g", "-e", "HOME=/data", "-e", "LANG=C.UTF-8",
        "-e", "LC_ALL=C.UTF-8", "-e", "TZ=UTC", "-e", "XDG_CONFIG_HOME=/inputs/overlays/xdg",
        "-v", f"{runtime}:/inputs/pristine-runtime:ro", "-v", f"{source}:/inputs/pristine-source:ro",
        "-v", f"{overlays}:/inputs/overlays:ro", "-v", f"{data}:/data:rw",
        "--entrypoint", "/inputs/pristine-runtime/jackett", ORACLE_IMAGE, "--ListenPrivate", "--Port", str(port),
        "--PIDFile", "/data/jackett.pid", "--NoUpdates", "--NoRestart", "--DataFolder", "/data",
    ]


def start_container(command, log_path):
    log = log_path.open("wb")
    process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    return process, log


def stop_container(command, name, process):
    subprocess.run([*command, "stop", "--time", "10", name], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if process is not None:
        with contextlib.suppress(subprocess.TimeoutExpired):
            process.wait(timeout=15)
    removed = subprocess.run([*command, "rm", "--force", name], stdout=subprocess.PIPE, stderr=subprocess.STDOUT).returncode == 0
    return {"clientExitCode": process.poll() if process else None, "removed": removed}


def cookie(response, name):
    import http.cookies
    values = http.cookies.SimpleCookie()
    for key, value in response["response"]["headers"]:
        if key.lower() == "set-cookie":
            values.load(value)
    return values[name].value


def configure_source(port, source_id, dashboard_headers):
    path = f"/api/v2.0/indexers/{source_id}/Config"
    fetched = request(
        port,
        "GET",
        path,
        headers=dashboard_headers,
        timeout=35,
        capture_errors=True,
    )
    if response_status(fetched) != 200:
        return fetched, {
            "request": {"method": "POST", "path": path},
            "response": {"skipped": "configuration GET failed"},
        }
    body = fetched["response"]["body"].encode()
    configured = request(
        port,
        "POST",
        path,
        body=body,
        headers={**dashboard_headers, "Content-Type": "application/json"},
        timeout=CONFIGURATION_TIMEOUT_SECONDS,
        capture_errors=True,
    )
    return fetched, configured


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pristine-runtime", required=True, type=pathlib.Path)
    parser.add_argument("--pristine-build-record", required=True, type=pathlib.Path)
    parser.add_argument("--pristine-source", required=True, type=pathlib.Path)
    parser.add_argument("--mini-runtime", required=True, type=pathlib.Path)
    parser.add_argument("--mini-manifest", required=True, type=pathlib.Path)
    parser.add_argument("--artifact-root", required=True, type=pathlib.Path)
    parser.add_argument("--oci-runtime")
    args = parser.parse_args()
    os.umask(0o077)
    pristine_runtime = args.pristine_runtime.resolve(strict=True)
    pristine_build_record_path = args.pristine_build_record.resolve(strict=True)
    pristine_source = args.pristine_source.resolve(strict=True)
    pristine_build_record = PRISTINE.verify_runtime(
        pristine_runtime,
        pristine_build_record_path,
        HERE / "fixtures/pristine-runtime-pin.json",
    )
    source_evidence = verify_pristine_source(pristine_source)
    mini_runtime = args.mini_runtime.resolve(strict=True)
    mini_manifest_path = args.mini_manifest.resolve(strict=True)
    if mini_manifest_path.parent != mini_runtime:
        raise RuntimeError("Mini manifest is not in its runtime root")
    mini_manifest = json.loads(mini_manifest_path.read_text(encoding="utf-8"))
    if mini_manifest.get("testFixture") or mini_manifest.get("executableName") != "jackett-mini":
        raise RuntimeError("live comparison requires a production Mini runtime")
    verify_mini_runtime(mini_runtime, mini_manifest_path, mini_manifest)
    mini_executable = (mini_runtime / mini_manifest["executableName"]).resolve(
        strict=True
    )
    if sha256(mini_executable) != next(
        item["sha256"]
        for item in mini_manifest["files"]
        if item["path"] == mini_manifest["executableName"]
    ):
        raise RuntimeError("Mini executable identity mismatch")
    catalog_path = mini_runtime / "catalog.json"
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    enabled = [
        entry
        for entry in catalog["entries"]
        if entry["eligibility"] == "enabled-public"
    ]
    if (
        [entry["indexerId"] for entry in enabled] != catalog["enabledIndexerIds"]
        or any(entry["contentClass"] == "adult-only" for entry in enabled)
        or any(
            entry["requiresCredentials"] or entry["requiresExternalSolver"]
            for entry in enabled
        )
    ):
        raise RuntimeError("eligible catalog is not the exact provider-level policy")
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    artifacts = (
        args.artifact_root.resolve()
        / f"live-all-source-comparison-{stamp}-{secrets.token_hex(4)}"
    )
    transcripts, logs, pristine_data, mini_data, overlays = [
        artifacts / name
        for name in (
            "transcripts",
            "logs",
            "pristine-data",
            "mini-data",
            "overlays",
        )
    ]
    for directory in (
        transcripts,
        logs,
        pristine_data,
        mini_data,
        overlays,
        overlays / "xdg",
    ):
        directory.mkdir(parents=True, mode=0o700, exist_ok=True)
    pristine_port, mini_port = choose_port(), choose_port()
    while mini_port == pristine_port:
        mini_port = choose_port()
    capability = secrets.token_urlsafe(32)
    capability_path = mini_data / "capability"
    capability_path.write_text(capability + "\n", encoding="ascii")
    capability_path.chmod(0o600)
    command = podman(args.oci_runtime)
    inspect = json.loads(
        subprocess.check_output([*command, "image", "inspect", ORACLE_IMAGE])
    )[0]
    run_token = secrets.token_hex(16)
    container_name = f"wildbuzzard-jackett-live-{run_token}"
    oracle_command = pristine_command(
        command,
        container_name,
        run_token,
        pristine_runtime,
        pristine_source,
        overlays,
        pristine_data,
        pristine_port,
    )
    pristine_process = mini_process = pristine_log = mini_log = None
    cleanup = {}
    success = False
    try:
        pristine_process, pristine_log = start_container(
            oracle_command, logs / "pristine-bootstrap.log"
        )
        wait_health(pristine_port, pristine_process)
        cleanup["bootstrap"] = stop_container(command, container_name, pristine_process)
        pristine_process = None
        pristine_log.close()
        pristine_log = None
        server_config = json.loads(
            (pristine_data / "ServerConfig.json").read_text(encoding="utf-8")
        )
        api_key = server_config["APIKey"]
        pristine_process, pristine_log = start_container(
            oracle_command, logs / "pristine-service.log"
        )
        wait_health(pristine_port, pristine_process)
        login = request(pristine_port, "GET", "/UI/Login")
        test_cookie = cookie(login, "TestCookie")
        tested = request(
            pristine_port,
            "GET",
            "/UI/TestCookie",
            headers={"Cookie": f"TestCookie={test_cookie}"},
        )
        finished = request(
            pristine_port,
            "GET",
            "/UI/Login?cookiesChecked=1",
            headers={"Cookie": f"TestCookie={test_cookie}"},
        )
        dashboard_cookie = cookie(finished, "Jackett")
        dashboard_headers = {"Cookie": f"Jackett={dashboard_cookie}"}
        mini_log = (logs / "mini-service.log").open("wb")
        mini_process = subprocess.Popen(
            [
                str(mini_executable),
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
            ],
            cwd=mini_runtime,
            env={
                "HOME": str(mini_data),
                "LANG": "C.UTF-8",
                "LC_ALL": "C.UTF-8",
                "TZ": "UTC",
            },
            stdout=mini_log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        wait_mini(mini_port, capability, mini_process)
        mini_pid = int((mini_data / "jackett.pid").read_text(encoding="ascii"))
        if mini_pid != mini_process.pid or not os.path.samefile(
            pathlib.Path(f"/proc/{mini_pid}/exe"), mini_executable
        ):
            raise RuntimeError("Mini PID identity differs from the host process")
        container_inspect = json.loads(
            subprocess.check_output([*command, "container", "inspect", container_name])
        )[0]
        launch_evidence = {
            "schemaVersion": 1,
            "recordedUnixNs": time.time_ns(),
            "driverPid": os.getpid(),
            "miniHostPid": mini_process.pid,
            "miniExecutableSha256": sha256(mini_executable),
            "pristinePodmanClientPid": pristine_process.pid,
            "pristineContainerName": container_name,
            "pristineContainerId": container_inspect["Id"],
            "pristineContainerPid": container_inspect["State"]["Pid"],
            "oracleImage": ORACLE_IMAGE,
            "logs": {
                "mini": (logs / "mini-service.log").relative_to(artifacts).as_posix(),
                "pristine": (logs / "pristine-service.log")
                .relative_to(artifacts)
                .as_posix(),
            },
        }
        write_json(artifacts / "launch-evidence.json", launch_evidence)
        write_json(
            artifacts / "run-state.json",
            {"phase": "running", "completedSources": 0, **launch_evidence},
        )
        replacements = [
            (api_key, "REDACTED_API_KEY"),
            (capability, "REDACTED_CAPABILITY"),
            (dashboard_cookie, "REDACTED_DASHBOARD_COOKIE"),
        ]
        setup = {"login": login, "test": tested, "finish": finished}
        write_json(transcripts / "setup-login.json", redact(setup, replacements))
        reports = []
        mappings = []
        for index, entry in enumerate(enabled, 1):
            source_id = entry["indexerId"]
            directory = transcripts / f"{index:02d}-{source_id}"
            directory.mkdir(mode=0o700)
            try:
                configuration = configure_source(
                    pristine_port, source_id, dashboard_headers
                )
                write_json(
                    directory / "pristine-config-get.json",
                    redact(configuration[0], replacements),
                )
                write_json(
                    directory / "pristine-config-post.json",
                    redact(configuration[1], replacements),
                )
                query = urllib.parse.urlencode(
                    {
                        "apikey": api_key,
                        "t": "search",
                        "q": QUERY,
                        "limit": LIMIT,
                        "offset": 0,
                        "cache": "true",
                    }
                )
                pristine_path = (
                    f"/api/v2.0/indexers/{source_id}/results/torznab/api?{query}"
                )
                mini_body = {
                    "query": QUERY,
                    "sourceIds": [source_id],
                    "limit": LIMIT,
                }
                pristine_response, mini_response, start_skew = paired_requests(
                    (pristine_port, "GET", pristine_path, None, None, 35),
                    (
                        mini_port,
                        "POST",
                        "/v1/search",
                        mini_body,
                        {"Authorization": f"Bearer {capability}"},
                        35,
                    ),
                )
                write_json(
                    directory / "pristine.json",
                    redact(pristine_response, replacements),
                )
                write_json(directory / "mini.json", redact(mini_response, replacements))
                pristine_canonical, pristine_signal = normalize_pristine(
                    pristine_response,
                    source_id,
                    entry["name"],
                    configuration,
                )
                mini_canonical, mini_signal = normalize_mini(
                    mini_response, source_id
                )
                write_json(directory / "pristine-normalized.json", pristine_canonical)
                write_json(directory / "mini-normalized.json", mini_canonical)
                write_json(
                    directory / "diagnostics.json",
                    {
                        "startSkewMs": start_skew,
                        "pristine": pristine_signal,
                        "mini": mini_signal,
                    },
                )
                pristine_text = json.dumps(
                    pristine_canonical, indent=2, sort_keys=True
                ).splitlines(True)
                mini_text = json.dumps(
                    mini_canonical, indent=2, sort_keys=True
                ).splitlines(True)
                diff = "".join(
                    difflib.unified_diff(
                        pristine_text,
                        mini_text,
                        fromfile="pristine",
                        tofile="mini",
                    )
                )
                write_text(directory / "normalized.diff", diff)
                outcome = compare_outcome(
                    pristine_canonical,
                    mini_canonical,
                    pristine_signal,
                    mini_signal,
                )
                relative = directory.relative_to(artifacts).as_posix()
                reports.append(
                    {
                        "id": source_id,
                        "name": entry["name"],
                        "contentClass": entry["contentClass"],
                        "pristineStatus": response_status(pristine_response),
                        "miniStatus": response_status(mini_response),
                        "pristineClass": pristine_signal["class"],
                        "miniClass": mini_signal["class"],
                        "pristineResultCount": len(
                            pristine_canonical.get("results", [])
                        ),
                        "miniResultCount": len(mini_canonical.get("results", [])),
                        "normalizedEqual": not diff,
                        "startSkewMs": start_skew,
                        "outcome": outcome,
                        "artifacts": relative,
                    }
                )
                mappings.append(
                    {
                        "sourceId": source_id,
                        "query": QUERY,
                        "limit": LIMIT,
                        "pristine": "GET Torznab t=search&q=ubuntu&limit=20&offset=0&cache=true",
                        "mini": "POST /v1/search {query:ubuntu,sourceIds:[%s],limit:20}"
                        % source_id,
                        "pairedStartSkewMs": start_skew,
                        "artifacts": relative,
                    }
                )
            except Exception as error:
                write_text(directory / "harness-failure.txt", traceback.format_exc())
                reports.append(
                    {
                        "id": source_id,
                        "name": entry["name"],
                        "contentClass": entry["contentClass"],
                        "outcome": "harness-failure",
                        "error": f"{type(error).__name__}: {error}",
                        "artifacts": directory.relative_to(artifacts).as_posix(),
                    }
                )
            write_json(
                artifacts / "run-state.json",
                {
                    "phase": "running",
                    "completedSources": index,
                    "currentSource": source_id,
                    **launch_evidence,
                },
            )
        counts = {}
        for item in reports:
            counts[item["outcome"]] = counts.get(item["outcome"], 0) + 1
        write_json(artifacts / "request-mapping.json", mappings)
        write_json(
            artifacts / "source-report.json",
            {
                "schemaVersion": 1,
                "quarantinedNonGating": True,
                "query": QUERY,
                "limit": LIMIT,
                "eligibleSourceCount": len(enabled),
                "outcomeCounts": counts,
                "sources": reports,
            },
        )
        write_json(
            artifacts / "run-metadata.json",
            {
                "schemaVersion": 1,
                "oracleImage": ORACLE_IMAGE,
                "oracleImageId": inspect.get("Id"),
                "oracleImageDigest": ORACLE_IMAGE.rsplit("@sha256:", 1)[1],
                "oraclePlatform": f"{inspect.get('Os')}/{inspect.get('Architecture')}",
                **source_evidence,
                "pristineBuildRecordSha256": sha256(pristine_build_record_path),
                "pristineRuntimeInventorySha256": pristine_build_record[
                    "runtimeInventorySha256"
                ],
                "pristineExecutableSha256": sha256(pristine_runtime / "jackett"),
                "miniExecutableSha256": sha256(mini_executable),
                "miniManifestSha256": sha256(mini_manifest_path),
                "miniRuntimeInventorySha256": mini_manifest["runtimeSha256"],
                "catalogSha256": sha256(catalog_path),
                "catalogPolicySha256": catalog["policySha256"],
                "eligibleSourceCount": len(enabled),
                "resultCategoryPolicy": "preserve-all-results-from-enabled-general-and-mixed-general-providers",
                "execution": {
                    "pristine": "rootless-OCI-only",
                    "mini": "direct-host-process",
                },
                "ports": {"pristine": pristine_port, "mini": mini_port},
                "launch": launch_evidence,
            },
        )
        leaks = []
        for path in sorted((transcripts, logs)):
            for candidate in path.rglob("*"):
                if not candidate.is_file():
                    continue
                content = candidate.read_bytes()
                for label, secret in (
                    ("api-key", api_key),
                    ("capability", capability),
                    ("dashboard-cookie", dashboard_cookie),
                ):
                    if secret.encode() in content:
                        leaks.append(
                            {
                                "file": candidate.relative_to(artifacts).as_posix(),
                                "secret": label,
                            }
                        )
        write_json(artifacts / "secret-leakage-scan.json", {"matches": leaks})
        if leaks or len(reports) != len(enabled) or len(mappings) != len(enabled):
            raise RuntimeError("live evidence is incomplete or contains a secret")
        success = True
    except Exception:
        write_text(artifacts / "failure.txt", traceback.format_exc())
        raise
    finally:
        cleanup["mini"] = stop_host(mini_process)
        if mini_log:
            mini_log.close()
        if pristine_process is not None:
            cleanup["service"] = stop_container(command, container_name, pristine_process)
        if pristine_log:
            pristine_log.close()
        cleanup["containerAbsent"] = (
            subprocess.run(
                [*command, "container", "exists", container_name],
                stdout=subprocess.DEVNULL,
            ).returncode
            == 1
        )
        for name, port in (("pristine", pristine_port), ("mini", mini_port)):
            with socket.socket() as probe:
                cleanup[f"{name}PortClosed"] = (
                    probe.connect_ex(("127.0.0.1", port)) != 0
                )
        shutil.rmtree(pristine_data, ignore_errors=True)
        shutil.rmtree(mini_data, ignore_errors=True)
        cleanup["dataRootsRemoved"] = (
            not pristine_data.exists() and not mini_data.exists()
        )
        cleanup["succeeded"] = success
        write_json(artifacts / "cleanup.json", cleanup)
        if (artifacts / "launch-evidence.json").exists():
            write_json(
                artifacts / "run-state.json",
                {
                    "phase": "completed" if success else "failed",
                    "completedSources": len(enabled) if success else None,
                    **launch_evidence,
                },
            )
        inventory = []
        for path in sorted(artifacts.rglob("*")):
            if path.is_file() and path.name != "evidence-inventory.json":
                inventory.append(
                    {
                        "path": path.relative_to(artifacts).as_posix(),
                        "sha256": sha256(path),
                        "size": path.stat().st_size,
                    }
                )
        write_json(
            artifacts / "evidence-inventory.json",
            {"schemaVersion": 1, "files": inventory},
        )
    print(artifacts)


if __name__ == "__main__":
    main()
