#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.


import argparse
import base64
import concurrent.futures
import datetime
import hashlib
import http.server
import json
import os
import pathlib
import re
import secrets
import shlex
import subprocess
import sys
import threading
import time
import urllib.parse
import xml.etree.ElementTree as ET

DATA_ROOT = pathlib.Path("/run/media/user/Data")
PACKAGES = {
    "buzzard-search",
    "buzzard-minijtt",
    "buzzard-torrent",
    "wildbuzzard",
}
PLATFORMS = {
    "ubuntu2404": ("ubuntu", "24.04"),
    "debian13": ("debian", "13"),
}
SAFE_NAME = re.compile(r"^[A-Za-z0-9_.+~-]+\.deb$")


def run_host(command, *, check=True, timeout=60):
    result = subprocess.run(
        list(map(str, command)),
        check=False,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if check and result.returncode != 0:
        detail = (
            result.stderr.strip() or result.stdout.strip() or "no diagnostic output"
        )
        raise RuntimeError(
            f"host command failed ({result.returncode}): {shlex.join(map(str, command))}: {detail}"
        )
    return result


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_png(path, label, *, minimum_size=45):
    if not path.is_file() or path.stat().st_size < minimum_size:
        raise RuntimeError(f"{label} screenshot is missing or empty")
    with path.open("rb") as source:
        header = source.read(24)
        source.seek(-12, os.SEEK_END)
        trailer = source.read(12)
    if (
        header[:8] != b"\x89PNG\r\n\x1a\n"
        or header[8:12] != b"\x00\x00\x00\x0d"
        or header[12:16] != b"IHDR"
        or trailer != b"\x00\x00\x00\x00IEND\xaeB`\x82"
    ):
        raise RuntimeError(f"{label} screenshot is not a PNG image")
    if (
        int.from_bytes(header[16:20], "big") == 0
        or int.from_bytes(header[20:24], "big") == 0
    ):
        raise RuntimeError(f"{label} screenshot has invalid dimensions")


def require_data_path(path, *, create=False):
    value = path.expanduser().resolve()
    try:
        value.relative_to(DATA_ROOT)
    except ValueError as error:
        raise ValueError(f"path must stay on {DATA_ROOT}: {value}") from error
    if create:
        value.mkdir(parents=True, exist_ok=True)
    return value


def package_field(path, field):
    return run_host(["dpkg-deb", "-f", path, field]).stdout.strip()


def relationship_names(value):
    return {
        alternative.strip().split(maxsplit=1)[0]
        for group in value.split(",")
        for alternative in group.split("|")
        if alternative.strip()
    }


def artifact_manifest(directory):
    directory = require_data_path(directory)
    debs = sorted(directory.glob("*.deb"))
    entries = []
    for path in debs:
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"artifact must be a regular file: {path}")
        require_data_path(path)
        package = package_field(path, "Package")
        if package not in PACKAGES:
            raise ValueError(
                f"unexpected Debian package in artifact directory: {package}"
            )
        if not SAFE_NAME.fullmatch(path.name):
            raise ValueError(f"unsafe artifact filename: {path.name}")
        entries.append({
            "filename": path.name,
            "package": package,
            "version": package_field(path, "Version"),
            "architecture": package_field(path, "Architecture"),
            "sha256": sha256(path),
            "size": path.stat().st_size,
        })
    counts = {
        package: sum(entry["package"] == package for entry in entries)
        for package in PACKAGES
    }
    if any(count != 1 for count in counts.values()):
        raise ValueError(
            f"artifact directory must contain one exact package set; found {counts}"
        )
    if any(entry["architecture"] != "amd64" for entry in entries):
        raise ValueError("all release artifacts must be amd64 packages")
    browser = next(entry for entry in entries if entry["package"] == "wildbuzzard")
    browser_path = directory / browser["filename"]
    dependency_names = relationship_names(package_field(browser_path, "Depends"))
    optional_clis = {"buzzard-search", "buzzard-minijtt"}
    if "buzzard-torrent" not in dependency_names:
        raise ValueError("wildbuzzard package does not depend on buzzard-torrent")
    unexpected_dependencies = dependency_names & optional_clis
    if unexpected_dependencies:
        raise ValueError(
            "wildbuzzard package hard-depends on optional CLIs: "
            + ", ".join(sorted(unexpected_dependencies))
        )
    suggestion_names = relationship_names(package_field(browser_path, "Suggests"))
    if suggestion_names != optional_clis:
        raise ValueError(
            "wildbuzzard package suggestions must be exactly: "
            + ", ".join(sorted(optional_clis))
        )
    return {
        "schemaVersion": 1,
        "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "artifacts": sorted(entries, key=lambda entry: entry["package"]),
    }


class Guest:
    def __init__(self, uri, domain):
        self.uri = uri
        self.domain = domain

    def virsh(self, *arguments, check=True, timeout=60):
        return run_host(
            ["virsh", "-c", self.uri, *arguments], check=check, timeout=timeout
        )

    def qga(self, payload):
        result = self.virsh(
            "qemu-agent-command",
            self.domain,
            json.dumps(payload, separators=(",", ":")),
        )
        value = json.loads(result.stdout)
        if "error" in value:
            raise RuntimeError(f"QGA error for {self.domain}: {value['error']}")
        return value.get("return")

    def ping(self):
        self.qga({"execute": "guest-ping"})

    def exec(self, command, *, timeout=1200, check=True):
        started = self.qga({
            "execute": "guest-exec",
            "arguments": {
                "path": "/bin/bash",
                "arg": ["-lc", command],
                "capture-output": True,
            },
        })
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            status = self.qga({
                "execute": "guest-exec-status",
                "arguments": {"pid": started["pid"]},
            })
            if status.get("exited"):
                if status.get("out-truncated") or status.get("err-truncated"):
                    raise RuntimeError(
                        f"QGA command output was truncated in {self.domain}"
                    )
                stdout = base64.b64decode(status.get("out-data", "")).decode(
                    errors="replace"
                )
                stderr = base64.b64decode(status.get("err-data", "")).decode(
                    errors="replace"
                )
                code = status.get("exitcode", 128 + status.get("signal", 0))
                if check and code != 0:
                    detail = stderr.strip() or stdout.strip() or "no diagnostic output"
                    raise RuntimeError(
                        f"guest command failed in {self.domain} ({code}): {command}: {detail}"
                    )
                return code, stdout, stderr
            time.sleep(0.25)
        raise TimeoutError(
            f"guest command timed out in {self.domain} after {timeout} seconds: {command}"
        )

    def push(self, source, destination):
        handle = self.qga({
            "execute": "guest-file-open",
            "arguments": {"path": destination, "mode": "w"},
        })
        try:
            with source.open("rb") as stream:
                for chunk in iter(lambda: stream.read(64 * 1024), b""):
                    value = self.qga({
                        "execute": "guest-file-write",
                        "arguments": {
                            "handle": handle,
                            "buf-b64": base64.b64encode(chunk).decode("ascii"),
                        },
                    })
                    if value.get("count") != len(chunk):
                        raise RuntimeError(
                            f"short QGA write to {self.domain}:{destination}"
                        )
            self.qga({"execute": "guest-file-flush", "arguments": {"handle": handle}})
        finally:
            self.qga({"execute": "guest-file-close", "arguments": {"handle": handle}})

    def pull(self, source, destination):
        destination.parent.mkdir(parents=True, exist_ok=True)
        handle = self.qga({
            "execute": "guest-file-open",
            "arguments": {"path": source, "mode": "r"},
        })
        try:
            with destination.open("wb") as stream:
                while True:
                    value = self.qga({
                        "execute": "guest-file-read",
                        "arguments": {"handle": handle, "count": 256 * 1024},
                    })
                    stream.write(base64.b64decode(value.get("buf-b64", "")))
                    if value.get("eof"):
                        break
        finally:
            self.qga({"execute": "guest-file-close", "arguments": {"handle": handle}})


class ArtifactServer:
    def __init__(self, paths):
        self.paths = {path.name: path.resolve() for path in paths}
        self.token = secrets.token_hex(16)

    def __enter__(self):
        paths = self.paths
        prefix = f"/{self.token}/"

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                parsed = urllib.parse.urlsplit(self.path)
                if not parsed.path.startswith(prefix):
                    self.send_error(404)
                    return
                name = urllib.parse.unquote(parsed.path.removeprefix(prefix))
                path = paths.get(name)
                if path is None or "/" in name:
                    self.send_error(404)
                    return
                self.send_response(200)
                self.send_header(
                    "Content-Type", "application/vnd.debian.binary-package"
                )
                self.send_header("Content-Length", str(path.stat().st_size))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                try:
                    with path.open("rb") as source:
                        for chunk in iter(lambda: source.read(1024 * 1024), b""):
                            self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def log_message(self, _format, *_arguments):
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        port = self.server.server_address[1]
        return f"http://10.0.2.2:{port}/{self.token}"

    def __exit__(self, _type, _value, _traceback):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=10)


def parse_vm(value):
    if "=" not in value:
        raise argparse.ArgumentTypeError("VM must be LABEL=DOMAIN")
    label, domain = value.split("=", 1)
    if label not in PLATFORMS or not domain:
        raise argparse.ArgumentTypeError(f"VM label must be one of {sorted(PLATFORMS)}")
    return label, domain


def domain_storage_preflight(guest):
    try:
        root = ET.fromstring(guest.virsh("dumpxml", guest.domain).stdout)
    except ET.ParseError as error:
        raise RuntimeError(f"could not parse libvirt XML for {guest.domain}") from error
    os_type = root.find("./os/type")
    if os_type is None or os_type.get("arch") != "x86_64":
        raise RuntimeError(f"VM is not x86_64: {guest.domain}")
    if not root.findall("./devices/interface[@type='user']"):
        raise RuntimeError(f"VM has no QEMU user-network interface: {guest.domain}")
    writable_disks = []
    for disk in root.findall("./devices/disk[@device='disk']"):
        if disk.find("readonly") is not None:
            continue
        writable_disks.append(disk)
        source = disk.find("source")
        source_name = source.get("file") if source is not None else None
        if disk.get("type") != "file" or not source_name:
            raise RuntimeError(f"VM has a writable non-file disk: {guest.domain}")
        source_path = pathlib.Path(source_name)
        if not source_path.is_absolute() or not source_path.is_file():
            raise RuntimeError(f"VM disk is missing or not absolute: {source_name}")
        require_data_path(source_path)
        driver = disk.find("driver")
        backing = disk.find("backingStore")
        backing_source = backing.find("source") if backing is not None else None
        if (
            driver is None
            or driver.get("type") != "qcow2"
            or backing_source is None
            or not backing_source.get("file")
        ):
            raise RuntimeError(
                f"VM does not use a disposable qcow2 overlay: {guest.domain}"
            )
        for item in disk.findall("./backingStore//source"):
            backing_name = item.get("file")
            if not backing_name:
                raise RuntimeError(f"VM has a non-file backing store: {guest.domain}")
            backing_path = pathlib.Path(backing_name)
            if not backing_path.is_absolute() or not backing_path.is_file():
                raise RuntimeError(
                    f"VM backing file is missing or not absolute: {backing_name}"
                )
            require_data_path(backing_path)
    if not writable_disks:
        raise RuntimeError(f"VM has no writable system disk: {guest.domain}")


def vm_preflight(uri, label, domain, *, allow_installed=False):
    guest = Guest(uri, domain)
    state = guest.virsh("domstate", domain).stdout.strip()
    if state != "running":
        raise RuntimeError(f"VM is not running: {domain} ({state})")
    domain_storage_preflight(guest)
    guest.ping()
    expected_id, expected_version = PLATFORMS[label]
    _, stdout, _ = guest.exec(
        '. /etc/os-release; printf \'%s\\t%s\\t%s\\n\' "$ID" "$VERSION_ID" "$(dpkg --print-architecture)"',
        timeout=30,
    )
    if stdout.strip() != f"{expected_id}\t{expected_version}\tamd64":
        raise RuntimeError(
            f"VM {domain} is not the expected {label} baseline: {stdout.strip()}"
        )
    guest.exec(
        "for pid in $(pgrep -x gnome-shell); do "
        "uid=$(awk '/^Uid:/ {print $2; exit}' /proc/$pid/status); "
        'if [ "${uid:-0}" -ge 1000 ]; then exit 0; fi; '
        "done; exit 1",
        timeout=30,
    )
    if not allow_installed:
        query = shlex.join([
            "dpkg-query",
            "-W",
            "-f",
            "${binary:Package}\\t${Status}\\n",
            *sorted(PACKAGES),
        ])
        _, installed_output, _ = guest.exec(query, timeout=30, check=False)
        installed = sorted(
            line.split("\t", 1)[0].split(":", 1)[0]
            for line in installed_output.splitlines()
            if line.endswith("\tinstall ok installed")
        )
        if installed:
            raise RuntimeError(
                f"VM is not fresh; custom packages are installed: {installed}"
            )
    return guest


def pull_results(guest, guest_results, host_results):
    _, stdout, _ = guest.exec(
        f"find {guest_results!s} -type f -printf '%P\\n' | LC_ALL=C sort",
        timeout=60,
    )
    for line in stdout.splitlines():
        relative = pathlib.PurePosixPath(line)
        if relative.is_absolute() or ".." in relative.parts:
            raise RuntimeError(f"unsafe guest result path: {line}")
        guest.pull(
            f"{guest_results}/{relative}", host_results.joinpath(*relative.parts)
        )


def wake_display(guest):
    guest.virsh(
        "send-key",
        guest.domain,
        "--codeset",
        "linux",
        "KEY_WAKEUP",
        timeout=30,
    )
    time.sleep(1)


def validate_vm(
    args, manifest_path, host_root, guest_script, artifact_base_url, label, domain
):
    host_results = host_root / label
    host_results.mkdir(parents=True, exist_ok=True)
    guest = None
    guest_results = None
    try:
        guest = vm_preflight(
            args.connect, label, domain, allow_installed=args.allow_installed
        )
        run_id = host_root.name
        guest_root = f"/var/tmp/wildbuzzard-release-validation/{run_id}/{label}"
        guest_staging = f"{guest_root}/artifacts"
        guest_results = f"{guest_root}/results"
        guest.exec(f"install -d -m 0700 {guest_staging} {guest_results}", timeout=30)
        guest.push(manifest_path, f"{guest_root}/artifacts.json")
        guest.push(guest_script, f"{guest_root}/guest-validate.py")
        wake_display(guest)
        expected_id, expected_version = PLATFORMS[label]
        command = [
            "/usr/bin/python3",
            f"{guest_root}/guest-validate.py",
            "--manifest",
            f"{guest_root}/artifacts.json",
            "--staging",
            guest_staging,
            "--results",
            guest_results,
            "--artifact-base-url",
            artifact_base_url,
            "--expected-id",
            expected_id,
            "--expected-version",
            expected_version,
            "--search-query",
            args.search_query,
        ]
        if args.allow_installed:
            command.append("--allow-installed")
        code, stdout, stderr = guest.exec(
            shlex.join(command), timeout=2400, check=False
        )
        (host_results / "guest-command.stdout").write_text(stdout, encoding="utf-8")
        (host_results / "guest-command.stderr").write_text(stderr, encoding="utf-8")
        if code != 0:
            raise RuntimeError(f"guest validator failed in {domain} ({code})")
        pull_results(guest, guest_results, host_results)
        wake_display(guest)
        screenshot = host_results / "gnome-browser.png"
        guest.virsh("screenshot", domain, screenshot, "--screen", "0", timeout=120)
        verify_png(screenshot, f"libvirt display for {domain}", minimum_size=8192)
        report = json.loads((host_results / "report.json").read_text(encoding="utf-8"))
        return {
            "label": label,
            "domain": domain,
            "ok": report.get("ok") is True,
            "report": report,
        }
    except Exception as error:
        if guest is not None and guest_results is not None:
            try:
                pull_results(guest, guest_results, host_results)
            except Exception as pull_error:
                (host_results / "pull-error.txt").write_text(
                    str(pull_error) + "\n", encoding="utf-8"
                )
        if guest is not None:
            try:
                guest.virsh(
                    "screenshot",
                    domain,
                    host_results / "failure-screen.png",
                    "--screen",
                    "0",
                    timeout=120,
                )
            except Exception as screenshot_error:
                (host_results / "screenshot-error.txt").write_text(
                    str(screenshot_error) + "\n", encoding="utf-8"
                )
        (host_results / "failure.txt").write_text(str(error) + "\n", encoding="utf-8")
        return {"label": label, "domain": domain, "ok": False, "error": str(error)}


def main():
    parser = argparse.ArgumentParser(
        description=(
            "Install and validate one exact WildBuzzard Debian artifact set in "
            "Ubuntu 24.04 and Debian 13 GNOME VMs."
        )
    )
    parser.add_argument("--artifact-dir", required=True, type=pathlib.Path)
    parser.add_argument("--vm", action="append", required=True, type=parse_vm)
    parser.add_argument("--connect", default="qemu:///session")
    parser.add_argument(
        "--output-root",
        type=pathlib.Path,
        default=DATA_ROOT
        / "VirtualMachines"
        / "wildbuzzard-release-validation"
        / "results",
    )
    parser.add_argument("--search-query", default="Debian Linux")
    parser.add_argument("--allow-installed", action="store_true")
    parser.add_argument("--preflight-only", action="store_true")
    args = parser.parse_args()
    if args.connect != "qemu:///session":
        parser.error("--connect must be qemu:///session")
    vms = dict(args.vm)
    if set(vms) != set(PLATFORMS) or len(args.vm) != len(PLATFORMS):
        parser.error(
            f"pass exactly one --vm for each label: {', '.join(sorted(PLATFORMS))}"
        )
    artifact_dir = require_data_path(args.artifact_dir)
    manifest = artifact_manifest(artifact_dir)
    for label, domain in vms.items():
        vm_preflight(args.connect, label, domain, allow_installed=args.allow_installed)
    if args.preflight_only:
        print(
            json.dumps(
                {"ok": True, "artifacts": manifest, "vms": vms},
                indent=2,
                sort_keys=True,
            )
        )
        return 0
    stamp = (
        datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        + f"-{os.getpid()}"
    )
    output_root = require_data_path(args.output_root, create=True)
    host_root = require_data_path(output_root / stamp, create=True)
    manifest_path = host_root / "artifacts.json"
    manifest_path.write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    guest_script = require_data_path(
        pathlib.Path(__file__).with_name("release-vm-guest-validate.py")
    )
    if not guest_script.is_file():
        raise RuntimeError(f"missing guest validator: {guest_script}")
    artifact_paths = [
        artifact_dir / entry["filename"] for entry in manifest["artifacts"]
    ]
    with ArtifactServer(artifact_paths) as artifact_base_url:
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            futures = [
                executor.submit(
                    validate_vm,
                    args,
                    manifest_path,
                    host_root,
                    guest_script,
                    artifact_base_url,
                    label,
                    domain,
                )
                for label, domain in sorted(vms.items())
            ]
            results = [future.result() for future in futures]
    summary = {
        "schemaVersion": 1,
        "ok": all(result["ok"] for result in results),
        "artifactManifest": str(manifest_path),
        "results": results,
    }
    (host_root / "summary.json").write_text(
        json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(
        json.dumps(
            {"ok": summary["ok"], "resultDirectory": str(host_root)}, sort_keys=True
        )
    )
    return 0 if summary["ok"] else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as error:
        print(f"release-vm-validate: {error}", file=sys.stderr)
        raise SystemExit(1)
