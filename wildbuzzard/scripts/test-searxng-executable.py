#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import re
import signal
import socket
import stat
import subprocess
import time
import urllib.parse


EXPECTED_COUNTS = {
    "totalEntries": 343,
    "totalModules": 222,
    "eligibleEntries": 332,
    "eligibleModules": 211,
    "credentialRequiredEntries": 11,
    "credentialRequiredModules": 11,
    "eligibleUpstreamInactiveEntries": 56,
}


def command(
    *args: str, check: bool = True, **kwargs: object
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, check=check, text=True, **kwargs)


def http(
    socket_path: pathlib.Path,
    path: str,
    timeout: float = 20,
    method: str = "GET",
    data: str | None = None,
) -> bytes:
    arguments = [
        "curl",
        "--fail",
        "--silent",
        "--show-error",
        "--max-time",
        str(timeout),
        "--unix-socket",
        str(socket_path),
    ]
    if method != "GET":
        arguments.extend(("--request", method))
    if data is not None:
        arguments.extend(("--data", data))
    arguments.append(f"http://localhost{path}")
    return command(
        *arguments,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    ).stdout.encode()


def wait_for_health(socket_path: pathlib.Path, timeout: float = 45) -> float:
    start = time.monotonic()
    deadline = start + timeout
    while time.monotonic() < deadline:
        try:
            if http(socket_path, "/healthz", 1) == b"OK":
                return time.monotonic() - start
        except subprocess.CalledProcessError:
            pass
        time.sleep(0.1)
    raise RuntimeError("SearXNG health check timed out")


def appimage_environment() -> dict[str, str]:
    environment = os.environ.copy()
    environment["APPIMAGE_EXTRACT_AND_RUN"] = "1"
    environment.pop("NO_CLEANUP", None)
    return environment


def service_arguments(root: pathlib.Path) -> list[str]:
    state = root / "state"
    return [
        "--install-dir",
        str(root / "install"),
        "--state-dir",
        str(state),
        "--cache-dir",
        str(root / "cache"),
        "--connection-file",
        str(state / "connection.json"),
        "--socket",
        str(state / "s"),
    ]


def control_arguments(root: pathlib.Path) -> list[str]:
    state = root / "state"
    return [
        "--install-dir",
        str(root / "install"),
        "--state-dir",
        str(state),
        "--connection-file",
        str(state / "connection.json"),
    ]


def descendants(pid: int) -> set[int]:
    result: set[int] = set()
    pending = [pid]
    while pending:
        parent = pending.pop()
        try:
            value = pathlib.Path(f"/proc/{parent}/task/{parent}/children").read_text(
                encoding="ascii"
            )
        except FileNotFoundError:
            continue
        for item in value.split():
            child = int(item)
            if child not in result:
                result.add(child)
                pending.append(child)
    return result


def extraction_path(artifact: pathlib.Path) -> pathlib.Path:
    digest = hashlib.md5(artifact.read_bytes(), usedforsecurity=False).hexdigest()
    return pathlib.Path("/tmp") / f"appimage_extracted_{digest}"


def assert_mode(path: pathlib.Path, mode: int, kind: str) -> None:
    status = os.stat(path, follow_symlinks=False)
    if stat.S_IMODE(status.st_mode) != mode:
        raise RuntimeError(f"wrong mode for {path}: {stat.S_IMODE(status.st_mode):04o}")
    if kind == "directory" and not stat.S_ISDIR(status.st_mode):
        raise RuntimeError(f"not a directory: {path}")
    if kind == "file" and not stat.S_ISREG(status.st_mode):
        raise RuntimeError(f"not a file: {path}")
    if kind == "socket" and not stat.S_ISSOCK(status.st_mode):
        raise RuntimeError(f"not a socket: {path}")


def assert_absent(paths: list[pathlib.Path]) -> None:
    stale = [str(path) for path in paths if os.path.lexists(path)]
    if stale:
        raise RuntimeError(f"stale lifecycle paths: {stale}")


def wait_for_absent(paths: list[pathlib.Path], timeout: float = 10) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline and any(os.path.lexists(path) for path in paths):
        time.sleep(0.05)
    assert_absent(paths)


def run_detached(artifact: pathlib.Path, root: pathlib.Path) -> dict[str, object]:
    started = time.monotonic()
    result = command(
        str(artifact),
        "start",
        *service_arguments(root),
        env=appimage_environment(),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    startup_seconds = time.monotonic() - started
    record = json.loads(result.stdout)
    socket_path = root / "state" / "s"
    if http(socket_path, "/healthz") != b"OK":
        raise RuntimeError("invalid health response")

    for path in (root, root / "install", root / "state", root / "cache"):
        assert_mode(path, 0o700, "directory")
    assert_mode(socket_path, 0o600, "socket")
    for name in ("connection.json", "settings.yml", "service.log"):
        assert_mode(root / "state" / name, 0o600, "file")
    assert_absent([extraction_path(artifact)])

    pid = int(record["pid"])
    pids = {pid, *descendants(pid)}
    tcp = command("ss", "-ltnp", stdout=subprocess.PIPE).stdout
    unix = command("ss", "-lxnp", stdout=subprocess.PIPE).stdout
    if any(f"pid={service_pid}," in tcp for service_pid in pids):
        raise RuntimeError("SearXNG opened a TCP listener")
    if str(socket_path) not in unix:
        raise RuntimeError("SearXNG Unix socket is not listening")

    github_path = "/search?" + urllib.parse.urlencode({
        "q": "firefox",
        "format": "json",
        "engines": "github",
    })
    github = json.loads(http(socket_path, github_path))
    if not github["results"] or github["unresponsive_engines"]:
        raise RuntimeError("GitHub search failed")
    wikipedia_path = "/search?" + urllib.parse.urlencode({
        "q": "Mozilla Firefox",
        "format": "json",
        "engines": "wikipedia",
    })
    wikipedia = json.loads(http(socket_path, wikipedia_path))
    if not wikipedia["infoboxes"] or wikipedia["unresponsive_engines"]:
        raise RuntimeError("Wikipedia search failed")

    preferences = http(socket_path, "/preferences").decode()
    if (
        'action="/preferences"' not in preferences
        or 'src="/static/' not in preferences
        or "http://localhost" in preferences
    ):
        raise RuntimeError("preferences did not use private relative routes")
    html = http(
        socket_path,
        "/search",
        method="POST",
        data="q=firefox&engines=github",
    ).decode()
    if 'src="/static/' not in html or "http://localhost" in html:
        raise RuntimeError("HTML search did not use private relative routes")
    static_match = re.search(r'(?:href|src)="([^\"]*/static/[^\"]+)"', html)
    if not static_match:
        raise RuntimeError("HTML search has no static asset")
    static_path = urllib.parse.urlparse(static_match.group(1)).path
    if not http(socket_path, static_path):
        raise RuntimeError("static asset request failed")

    config = json.loads(http(socket_path, "/config"))
    loaded_names = {item["name"] for item in config["engines"]}
    catalog = json.loads(
        (root / "install/share/wildbuzzard/searxng/engine-catalog.json").read_text()
    )
    if catalog["counts"] != EXPECTED_COUNTS:
        raise RuntimeError("unexpected engine catalog counts")
    eligible_names = {
        item["name"] for item in catalog["engines"] if not item["requiresCredentials"]
    }
    keyed_names = {
        item["name"] for item in catalog["engines"] if item["requiresCredentials"]
    }
    if (
        len(loaded_names) != 274
        or not loaded_names <= eligible_names
        or loaded_names & keyed_names
    ):
        raise RuntimeError("unexpected runtime engine load state")

    cancelled = command(
        "curl",
        "--fail",
        "--silent",
        "--max-time",
        "0.001",
        "--unix-socket",
        str(socket_path),
        f"http://localhost{github_path}",
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    if cancelled.returncode == 0 or http(socket_path, "/healthz") != b"OK":
        raise RuntimeError("request cancellation regression")

    command(
        str(artifact),
        "stop",
        *control_arguments(root),
        env=appimage_environment(),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    deadline = time.monotonic() + 15
    while pathlib.Path(f"/proc/{pid}").exists() and time.monotonic() < deadline:
        time.sleep(0.05)
    if pathlib.Path(f"/proc/{pid}").exists():
        raise RuntimeError("detached SearXNG process survived stop")
    wait_for_absent([
        socket_path,
        root / "state/settings.yml",
        root / "state/connection.json",
        extraction_path(artifact),
    ])
    return {
        "startupSeconds": round(startup_seconds, 3),
        "loadedEngines": len(loaded_names),
        "githubResults": len(github["results"]),
        "githubFirstUrl": github["results"][0]["url"],
        "wikipediaInfoboxes": len(wikipedia["infoboxes"]),
        "wikipediaFirst": wikipedia["infoboxes"][0]["infobox"],
        "servicePids": sorted(pids),
        "tcpListeners": 0,
    }


def run_signal_cleanup(artifact: pathlib.Path, root: pathlib.Path) -> dict[str, object]:
    root.mkdir(mode=0o700)
    log = (root / "foreground.log").open("w", encoding="utf-8")
    process = subprocess.Popen(
        [str(artifact), "run", *service_arguments(root)],
        env=appimage_environment(),
        stdin=subprocess.DEVNULL,
        stdout=log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
        text=True,
    )
    socket_path = root / "state/s"
    try:
        startup_seconds = wait_for_health(socket_path)
        os.killpg(process.pid, signal.SIGINT)
        return_code = process.wait(timeout=20)
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
        log.close()
    wait_for_absent([
        socket_path,
        root / "state/settings.yml",
        root / "state/connection.json",
        extraction_path(artifact),
    ])
    return {"startupSeconds": round(startup_seconds, 3), "exitCode": return_code}


def run_invalid_path(artifact: pathlib.Path, root: pathlib.Path) -> dict[str, object]:
    state = root / "state"
    result = command(
        str(artifact),
        "run",
        "--install-dir",
        str(root / "install"),
        "--state-dir",
        str(state),
        "--cache-dir",
        str(root / "cache"),
        "--connection-file",
        str(state / "connection.json"),
        "--socket",
        str(root / "outside.sock"),
        env=appimage_environment(),
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if result.returncode == 0 or result.stderr.count(
        "File exists and file size matches"
    ):
        raise RuntimeError("invalid socket path did not fail cleanly")
    if len(result.stderr.splitlines()) != 1:
        raise RuntimeError("invalid socket path emitted noisy diagnostics")
    assert_absent([root / "outside.sock", extraction_path(artifact)])
    return {"exitCode": result.returncode, "stderrLines": 1, "skipLines": 0}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifact", required=True, type=pathlib.Path)
    parser.add_argument("--work-dir", required=True, type=pathlib.Path)
    args = parser.parse_args()
    artifact = args.artifact.resolve(strict=True)
    work_dir = args.work_dir.absolute()
    work_dir.mkdir(mode=0o700, parents=True, exist_ok=False)
    work_dir.chmod(0o700)
    report = {
        "schema": 1,
        "artifact": str(artifact),
        "artifactBytes": artifact.stat().st_size,
        "artifactSha256": hashlib.sha256(artifact.read_bytes()).hexdigest(),
        "detached": run_detached(artifact, work_dir / "detached"),
        "signalCleanup": run_signal_cleanup(artifact, work_dir / "signal"),
        "invalidPath": run_invalid_path(artifact, work_dir / "invalid"),
    }
    output = json.dumps(report, sort_keys=True, indent=2) + "\n"
    (work_dir / "report.json").write_text(output, encoding="utf-8")
    print(output, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
