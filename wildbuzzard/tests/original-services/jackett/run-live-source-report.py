#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later

import argparse
import collections
import datetime
import hashlib
import http.client
import json
import pathlib
import secrets
import shutil
import socket
import stat
import subprocess
import time
import traceback


IMAGE = "mcr.microsoft.com/dotnet/sdk@sha256:6e6542a43b6bf3c5ecfa80dd33c79c9fd09d58f95f4ebacd14fa056275b25164"
QUERY = "ubuntu"


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def run(command, log_path=None, check=True):
    completed = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False)
    if log_path:
        log_path.write_bytes(completed.stdout)
    if check and completed.returncode:
        raise RuntimeError(f"command failed ({completed.returncode}): {' '.join(command)}")
    return completed


def choose_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def request(port, method, path, capability, body=None, timeout=35):
    payload = None if body is None else json.dumps(body, separators=(",", ":")).encode()
    headers = {"Authorization": f"Bearer {capability}", "Cache-Control": "no-store"}
    if payload is not None:
        headers["Content-Type"] = "application/json"
        headers["Content-Length"] = str(len(payload))
    transcript_headers = [[key, value] for key, value in headers.items()]
    transcript_headers[0][1] = "Bearer <redacted-capability>"
    started = time.monotonic()
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    try:
        connection.request(method, path, payload, headers)
        response = connection.getresponse()
        response_body = response.read(16 * 1024 * 1024 + 1)
        if len(response_body) > 16 * 1024 * 1024:
            raise RuntimeError("live response exceeded limit")
        return {
            "request": {
                "method": method,
                "path": path,
                "headers": transcript_headers,
                "bodyText": payload.decode() if payload else "",
            },
            "response": {
                "status": response.status,
                "headers": list(response.getheaders()),
                "bodyText": response_body.decode("utf-8"),
                "elapsedMs": round((time.monotonic() - started) * 1000, 3),
            },
        }
    finally:
        connection.close()


def wait_for_health(port, capability):
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        try:
            transcript = request(port, "GET", "/v1/health", capability, timeout=1)
            if transcript["response"]["status"] == 200:
                return transcript
        except (ConnectionError, OSError, TimeoutError):
            pass
        time.sleep(0.1)
    raise RuntimeError("Jackett Mini did not become healthy")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mini-runtime", required=True, type=pathlib.Path)
    parser.add_argument("--mini-manifest", required=True, type=pathlib.Path)
    parser.add_argument("--artifact-root", required=True, type=pathlib.Path)
    parser.add_argument("--oci-runtime")
    args = parser.parse_args()

    runtime = args.mini_runtime.resolve(strict=True)
    manifest_path = args.mini_manifest.resolve(strict=True)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    executable = runtime / manifest["executableName"]
    executable_entry = next(entry for entry in manifest["files"] if entry["path"] == manifest["executableName"])
    if sha256(executable) != executable_entry["sha256"]:
        raise RuntimeError("Jackett Mini executable does not match its manifest")

    run_id = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + secrets.token_hex(4)
    artifacts = args.artifact_root.resolve() / f"live-source-report-{run_id}"
    logs = artifacts / "logs"
    transcripts = artifacts / "transcripts"
    data = artifacts / "data"
    for directory in (logs, transcripts, data):
        directory.mkdir(parents=True, mode=0o700)
        directory.chmod(0o700)

    podman = ["podman"]
    if args.oci_runtime:
        podman += ["--runtime", str(pathlib.Path(args.oci_runtime).resolve(strict=True))]
    if run(podman + ["info", "--format", "{{.Host.Security.Rootless}}"], logs / "podman-rootless.log").stdout.strip() != b"true":
        raise RuntimeError("live report requires rootless Podman")
    run(podman + ["version", "--format", "json"], logs / "podman-version.json")
    run(podman + ["image", "inspect", IMAGE], logs / "sdk-image-inspect.json")

    capability = secrets.token_urlsafe(32)
    capability_path = data / "capability"
    capability_path.write_text(capability + "\n", encoding="ascii")
    capability_path.chmod(0o600)
    port = choose_port()
    name = "wildbuzzard-jackett-live-" + secrets.token_hex(5)
    cleanup = {"container": name, "dataRootRemoved": False, "port": "unknown"}
    success = False
    try:
        command = podman + [
            "run", "-d", "--name", name, "--network", "host", "--userns=keep-id",
            "-e", "LANG=C.UTF-8", "-e", "LC_ALL=C.UTF-8", "-e", "TZ=UTC",
            "-v", f"{runtime}:/app:ro", "-v", f"{data}:/data:Z", IMAGE,
            "/app/jackett-mini", "--ListenPrivate", "--Port", str(port),
            "--PIDFile", "/data/jackett.pid", "--NoUpdates", "--NoRestart",
            "--DataFolder", "/data", "--CapabilityFile", "/data/capability",
        ]
        run(command, logs / "container-start.log")
        health = wait_for_health(port, capability)
        sources = request(port, "GET", "/v1/sources", capability)
        search = request(port, "POST", "/v1/search", capability, {"query": QUERY, "limit": 20})
        for name_part, transcript in (("health", health), ("sources", sources), ("search", search)):
            write_json(transcripts / f"{name_part}.json", transcript)
        if any(transcript["response"]["status"] != 200 for transcript in (health, sources, search)):
            raise RuntimeError("live API request failed")

        source_document = json.loads(sources["response"]["bodyText"])
        search_document = json.loads(search["response"]["bodyText"])
        catalog = json.loads((runtime / "catalog.json").read_text(encoding="utf-8"))
        enabled = {entry["indexerId"]: entry for entry in catalog["entries"] if entry["eligibility"] == "enabled-public"}
        source_states = {source["id"]: source for source in source_document["sources"]}
        live_states = {provider["id"]: provider for provider in search_document["providers"]}
        if set(enabled) != set(source_states) or set(enabled) != set(live_states):
            raise RuntimeError("live report did not cover the immutable enabled set")
        adult_results = sum(
            any(6000 <= category <= 6999 for category in result["categoryIds"])
            for result in search_document["results"]
        )
        if adult_results:
            raise RuntimeError("adult-category result escaped live filtering")
        report = {
            "schemaVersion": 1,
            "quarantinedNonGating": True,
            "query": QUERY,
            "catalogSha256": sha256(runtime / "catalog.json"),
            "catalogPolicySha256": catalog["policySha256"],
            "sourceCount": len(enabled),
            "resultCount": len(search_document["results"]),
            "adultCategoryResultCount": adult_results,
            "partial": search_document["partial"],
            "stateCounts": dict(
                sorted(collections.Counter(state["state"] for state in live_states.values()).items())
            ),
            "sources": [
                {
                    "id": indexer_id,
                    "name": enabled[indexer_id]["name"],
                    "access": enabled[indexer_id]["access"],
                    "contentClass": enabled[indexer_id]["contentClass"],
                    "eligibility": enabled[indexer_id]["eligibility"],
                    "configuredState": source_states[indexer_id]["state"],
                    "liveState": live_states[indexer_id]["state"],
                    "elapsedMs": live_states[indexer_id]["elapsedMs"],
                }
                for indexer_id in sorted(enabled)
            ],
        }
        write_json(artifacts / "source-report.json", report)
        run(podman + ["inspect", name], logs / "container-inspect.json")
        run(["ss", "-ltnp", f"sport = :{port}"], logs / "loopback-listener.log")
        listener = (logs / "loopback-listener.log").read_text(encoding="utf-8")
        if f"127.0.0.1:{port}" not in listener or any(value in listener for value in (f"0.0.0.0:{port}", f"[::]:{port}", f"*:{port}")):
            raise RuntimeError("live service listener was not loopback-only")
        write_json(artifacts / "run-metadata.json", {
            "schemaVersion": 1,
            "sourceCommit": manifest["upstreamCommit"],
            "sourceSha256": manifest["sourceSha256"],
            "sdkImage": IMAGE,
            "rootless": True,
            "port": port,
            "runtimeManifestSha256": sha256(manifest_path),
            "runtimeExecutableSha256": sha256(executable),
            "dataRootMode": oct(stat.S_IMODE(data.stat().st_mode)),
            "capabilityMode": oct(stat.S_IMODE(capability_path.stat().st_mode)),
        })
        success = True
    except Exception:
        (artifacts / "failure.txt").write_text(traceback.format_exc(), encoding="utf-8")
        raise
    finally:
        run(podman + ["logs", name], logs / "service.log", check=False)
        cleanup["stopReturnCode"] = run(podman + ["stop", "--time", "10", name], logs / "container-stop.log", check=False).returncode
        cleanup["removeReturnCode"] = run(podman + ["rm", name], logs / "container-remove.log", check=False).returncode
        with socket.socket() as probe:
            cleanup["port"] = "closed" if probe.connect_ex(("127.0.0.1", port)) else "open"
        shutil.rmtree(data, ignore_errors=True)
        cleanup["dataRootRemoved"] = not data.exists()
        cleanup["succeeded"] = success
        write_json(artifacts / "cleanup.json", cleanup)
    print(artifacts)


if __name__ == "__main__":
    main()
