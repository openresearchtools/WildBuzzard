# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import argparse
import base64
import contextlib
import datetime
import difflib
import hashlib
import json
import os
import pathlib
import re
import secrets
import shutil
import signal
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
CRUN = pathlib.Path("/usr/bin/crun")
DEFAULT_SECCOMP = pathlib.Path("/usr/share/containers/seccomp.json")
DEFAULT_SECCOMP_SHA256 = (
    "886ae167646b7e5db381ecf7c31e6de720a8e8da15cf3202fe1f67f424af2b75"
)
MAX_EPOCH_MILLISECONDS = 8_640_000_000_000_000
CONNECTION_FIELDS = {
    "version",
    "protocolVersion",
    "runtimeVersion",
    "address",
    "port",
    "token",
    "pid",
    "processStartTime",
    "executablePath",
    "executableSha256",
    "dataRootId",
    "ownerInstanceId",
    "createdAt",
    "lastHealthAt",
}
TOKEN_PATTERN = re.compile(r"Bearer [A-Za-z0-9._~-]+", re.IGNORECASE)
PORT_PATTERN = re.compile(r"http://127\.0\.0\.1:\d+")
SENSITIVE_HEADER_PATTERN = re.compile(
    r"(?:auth|cookie|credential|secret|token|api[-_]key)", re.IGNORECASE
)
SENSITIVE_HEADER_LINE_PATTERN = re.compile(
    r"(?im)^((?:authorization|authentication-info|cookie|proxy-authenticate|"
    r"proxy-authorization|set-cookie|www-authenticate|x-api-key|x-auth-token)"
    r":)[^\r\n]*"
)
SENSITIVE_VALUE_PATTERN = re.compile(
    r"(?im)((?:[\"'])?(?:api[-_]?key|capability|credential|secret(?:_key)?|token)"
    r"(?:[\"'])?[ \t]*[:=][ \t]*)"
    r"(?:\"(?:\\.|[^\"\\\r\n])*\"|'(?:\\.|[^'\\\r\n])*'|[^\s,;}\]\r\n]+)"
)
QUERY_PATTERN = re.compile(
    r"(?P<prefix>[?&]|\b)q=(?P<value>[^&\s\"<>]*)", re.IGNORECASE
)


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


def read_key_user() -> str | None:
    uid_prefix = f"{os.getuid()}:"
    return next(
        (
            line
            for line in pathlib
            .Path("/proc/key-users")
            .read_text(encoding="ascii")
            .splitlines()
            if line.lstrip().startswith(uid_prefix)
        ),
        None,
    )


def write_json(path: pathlib.Path, value: object) -> None:
    path.write_text(
        json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    path.chmod(0o600)


def redact_text(value: str, replacements: dict[str, str]) -> str:
    for source, replacement in sorted(
        replacements.items(), key=lambda item: len(item[0]), reverse=True
    ):
        if source:
            value = value.replace(source, replacement)
    value = SENSITIVE_VALUE_PATTERN.sub(r'\1"<redacted>"', value)
    value = normalized_string(value)
    return SENSITIVE_HEADER_LINE_PATTERN.sub(
        lambda match: f"{match.group(1).split(':', 1)[0]}: <redacted>", value
    )


def redact_value(value: object, replacements: dict[str, str]) -> object:
    if isinstance(value, dict):
        return {
            redact_text(key, replacements)
            if isinstance(key, str)
            else key: redact_value(item, replacements)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [redact_value(item, replacements) for item in value]
    if isinstance(value, str):
        return redact_text(value, replacements)
    return value


def record_failure(summary: dict[str, object], error: Exception) -> None:
    message = f"{type(error).__name__}: {error}"
    previous = summary.get("error")
    summary["error"] = f"{previous}; {message}" if previous else message
    summary["outcome"] = "infrastructure-failure"


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


class HostClient:
    def __init__(
        self,
        python: pathlib.Path,
        probe: pathlib.Path,
        environment: dict[str, str],
        process: subprocess.Popen[bytes] | None = None,
        unix_socket: pathlib.Path | None = None,
    ) -> None:
        self.python = python
        self.probe = probe
        self.environment = environment
        self.process = process
        self.unix_socket = unix_socket

    def invoke(
        self, value: dict[str, object], timeout: float = 15
    ) -> dict[str, object]:
        request = dict(value)
        if request.get("mode") == "snapshot":
            if self.process is None:
                raise RuntimeError("Host process snapshot has no root process")
            request["rootPid"] = self.process.pid
        if self.unix_socket is not None and request.get("mode") in {
            "cancel",
            "request",
        }:
            request["unixSocket"] = str(self.unix_socket)
        result = subprocess.run(
            [str(self.python), "-I", "-B", str(self.probe)],
            input=(
                json.dumps(request, sort_keys=True, separators=(",", ":")) + "\n"
            ).encode(),
            capture_output=True,
            env=self.environment,
            timeout=timeout,
            check=False,
        )
        if result.returncode:
            message = result.stderr.decode("utf-8", "replace").strip()
            raise RuntimeError(
                f"Host probe failed with exit code {result.returncode}: {message}"
            )
        try:
            parsed = json.loads(result.stdout)
        except json.JSONDecodeError as error:
            raise RuntimeError("Host probe returned invalid JSON") from error
        if not isinstance(parsed, dict):
            raise RuntimeError("Host probe returned a non-object")
        return parsed

    def running(self) -> bool:
        return self.process is None or self.process.poll() is None


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
    expected_fields = {
        "architecture": "x86_64",
        "compiler": "Zig 0.15.2",
        "compilerTarget": "x86_64-linux-gnu.2.28",
        "component": "searxng",
        "platform": "linux",
        "protocolVersion": 1,
        "pythonVersion": "3.14.6",
        "runtimeVersion": "2026.8.6+b023a28ba",
        "schema": 1,
        "upstreamCommit": SOURCE_COMMIT,
    }
    for key, expected in expected_fields.items():
        if manifest.get(key) != expected:
            raise RuntimeError(f"Native runtime manifest has unexpected {key}")
    lock_fields = {
        "dependencyLockSha256": SOURCE_ROOT / "runtime-requirements.lock",
        "buildToolsLockSha256": SOURCE_ROOT / "build-tools.lock",
        "buildToolSourcesLockSha256": SOURCE_ROOT / "build-tool-sources.lock",
        "nativeSourcesLockSha256": SOURCE_ROOT / "native-sources.lock",
        "toolchainLockSha256": SOURCE_ROOT / "toolchain.lock",
        "granianCargoVendorLockSha256": SOURCE_ROOT / "granian-cargo-vendor.lock",
        "granianCargoComponentsLockSha256": (
            SOURCE_ROOT / "granian-cargo-components.lock"
        ),
        "providerPolicySha256": SOURCE_ROOT / "engine-policy.json",
    }
    runtime_metadata = runtime_root / "share" / "wildbuzzard" / "searxng"
    for field, source in lock_fields.items():
        expected = sha256_file(source)
        if manifest.get(field) != expected:
            raise RuntimeError(f"Native runtime manifest has unexpected {field}")
        bundled = (
            runtime_metadata / source.name
            if source.name != "engine-policy.json"
            else runtime_metadata / "engine-policy.json"
        )
        if sha256_file(bundled) != expected:
            raise RuntimeError(f"Native runtime has unexpected {source.name}")
    service = runtime_root / "libexec" / "searxng_service.py"
    expected_service = (
        CHECKOUT / "wildbuzzard" / "managed-services" / "searxng" / "searxng_service.py"
    )
    if sha256_file(service) != sha256_file(expected_service):
        raise RuntimeError("Native runtime service implementation is stale")
    entries = manifest.get("files")
    if not isinstance(entries, list):
        raise RuntimeError("Native runtime manifest has no file inventory")
    expected_files: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("path"), str):
            raise RuntimeError("Native runtime manifest has an invalid file entry")
        relative = pathlib.PurePosixPath(entry["path"])
        if relative.is_absolute() or any(
            part in {"", ".", ".."} for part in relative.parts
        ):
            raise RuntimeError(f"Native runtime manifest path is unsafe: {relative}")
        relative_text = relative.as_posix()
        if relative_text != entry["path"]:
            raise RuntimeError(
                f"Native runtime manifest path is not canonical: {relative}"
            )
        if relative_text in expected_files:
            raise RuntimeError(
                f"Native runtime manifest path is duplicated: {relative}"
            )
        expected_files.add(relative_text)
        target = runtime_root.joinpath(*relative.parts)
        if target.is_symlink() or not target.is_file():
            raise RuntimeError(f"Native runtime file is missing or linked: {relative}")
        if entry.get("size") != target.stat().st_size:
            raise RuntimeError(f"Native runtime size mismatch: {relative}")
        if entry.get("sha256") != sha256_file(target):
            raise RuntimeError(f"Native runtime digest mismatch: {relative}")
    manifest_path = runtime_root / "wildbuzzard-runtime.json"
    actual_files = set()
    for target in runtime_root.rglob("*"):
        if target.is_symlink():
            raise RuntimeError(f"Native runtime contains a symlink: {target}")
        if target.is_file() and target != manifest_path:
            actual_files.add(target.relative_to(runtime_root).as_posix())
    if actual_files != expected_files:
        raise RuntimeError("Native runtime file inventory is incomplete")
    return runtime_root, artifacts


def prepare_rootless_runtime(
    recorder: Recorder,
    work: pathlib.Path,
    artifacts: pathlib.Path,
    key_user_before: str | None,
) -> tuple[list[str], pathlib.Path, dict[str, object]]:
    crun = CRUN.resolve(strict=True)
    wrapper = work / "crun-no-new-keyring"
    wrapper_text = """#!/bin/bash
set -eu
args=()
for arg in "$@"; do
  args+=("$arg")
  if [[ "$arg" == create ]]; then
    args+=(--no-new-keyring)
  fi
done
exec /usr/bin/crun "${args[@]}"
"""
    wrapper.write_text(wrapper_text, encoding="utf-8")
    wrapper.chmod(0o700)
    (artifacts / "crun-no-new-keyring").write_text(wrapper_text, encoding="utf-8")
    (artifacts / "crun-no-new-keyring").chmod(0o600)

    default_seccomp_sha256 = sha256_file(DEFAULT_SECCOMP)
    if default_seccomp_sha256 != DEFAULT_SECCOMP_SHA256:
        raise RuntimeError("System container seccomp profile does not match the pin")
    source_profile_artifact = artifacts / "seccomp-system-default.json"
    shutil.copy2(DEFAULT_SECCOMP, source_profile_artifact)
    source_profile_artifact.chmod(0o600)
    profile = json.loads(DEFAULT_SECCOMP.read_text(encoding="utf-8"))
    if profile.get("defaultAction") != "SCMP_ACT_ERRNO":
        raise RuntimeError("Default container seccomp action is not deny")
    denied = {"add_key", "keyctl", "request_key"}
    for rule in profile.get("syscalls", []):
        if rule.get("action") != "SCMP_ACT_ALLOW":
            continue
        rule["names"] = [name for name in rule.get("names", []) if name not in denied]
    profile["syscalls"] = [
        rule for rule in profile.get("syscalls", []) if rule.get("names")
    ]
    allowed = {
        name
        for rule in profile["syscalls"]
        if rule.get("action") == "SCMP_ACT_ALLOW"
        for name in rule.get("names", [])
    }
    if allowed & denied:
        raise RuntimeError("Effective seccomp profile permits keyring syscalls")
    seccomp = work / "seccomp-no-keyrings.json"
    write_json(seccomp, profile)
    shutil.copy2(seccomp, artifacts / seccomp.name)
    (artifacts / seccomp.name).chmod(0o600)

    crun_version = recorder.run("crun-version", [str(crun), "--version"])
    security = {
        "crun": str(crun),
        "crunVersion": crun_version.stdout.splitlines()[0],
        "defaultSeccomp": str(DEFAULT_SECCOMP),
        "defaultSeccompArtifact": source_profile_artifact.name,
        "defaultSeccompSha256": default_seccomp_sha256,
        "effectiveSeccompSha256": sha256_file(seccomp),
        "deniedKeyringSyscalls": sorted(denied),
        "keyUserBefore": key_user_before,
        "noNewKeyring": True,
        "wrapperSha256": sha256_file(wrapper),
    }
    return ["podman", "--runtime", str(wrapper)], seccomp, security


def verify_rootless_podman(recorder: Recorder, podman: list[str]) -> dict[str, object]:
    if os.geteuid() == 0:
        raise RuntimeError("The pristine comparison must not run as root")
    version = recorder.run("podman-version", [*podman, "version", "--format", "json"])
    info = recorder.run(
        "podman-rootless", [*podman, "info", "--format", "{{.Host.Security.Rootless}}"]
    )
    if info.stdout.strip() != "true":
        raise RuntimeError("Podman is not operating rootlessly")
    return json.loads(version.stdout)


def parse_json_array(output: str, name: str) -> list[dict[str, object]]:
    try:
        value = json.loads(output)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"Podman returned invalid {name} JSON") from error
    if not isinstance(value, list) or not all(isinstance(item, dict) for item in value):
        raise RuntimeError(f"Podman returned invalid {name} inventory")
    return value


def image_inventory(value: list[dict[str, object]]) -> list[dict[str, object]]:
    return sorted(
        (
            {
                "id": item.get("Id"),
                "names": sorted(item.get("Names") or []),
                "repoDigests": sorted(item.get("RepoDigests") or []),
            }
            for item in value
        ),
        key=lambda item: str(item["id"]),
    )


def container_inventory(value: list[dict[str, object]]) -> list[dict[str, object]]:
    return sorted(
        (
            {
                "id": item.get("Id"),
                "names": sorted(item.get("Names") or []),
            }
            for item in value
        ),
        key=lambda item: str(item["id"]),
    )


def storage_inventory(value: list[dict[str, object]]) -> list[dict[str, object]]:
    fields = (
        "Active",
        "RawReclaimable",
        "RawSize",
        "Total",
        "TotalCount",
        "Type",
    )
    return sorted(
        ({field: item.get(field) for field in fields} for item in value),
        key=lambda item: str(item["Type"]),
    )


def volume_inventory(value: list[dict[str, object]]) -> list[str]:
    names = [item.get("Name") for item in value]
    if not all(isinstance(name, str) for name in names):
        raise RuntimeError("Podman returned an invalid volume name")
    return sorted(str(name) for name in names)


def verify_and_pull_base(recorder: Recorder, podman: list[str]) -> dict[str, object]:
    manifest_result = recorder.run(
        "pristine-index-manifest", [*podman, "manifest", "inspect", INDEX_REFERENCE]
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
        [*podman, "pull", "--platform", "linux/amd64", INDEX_REFERENCE],
    )
    inspect_result = recorder.run(
        "pristine-image-inspect", [*podman, "image", "inspect", PLATFORM_REFERENCE]
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


def wait_http(
    client: HostClient,
    port: int,
    path: str,
    headers: dict[str, str],
    timeout: float,
) -> None:
    deadline = time.monotonic() + timeout
    last_error = "not started"
    while time.monotonic() < deadline:
        try:
            response = client.invoke({
                "mode": "request",
                "method": "GET",
                "path": path,
                "port": port,
                "headers": {**headers, "Host": f"127.0.0.1:{port}"},
            })
            if response.get("status") == 200:
                return
            last_error = f"HTTP {response.get('status')}"
        except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
            last_error = str(error)
        time.sleep(0.1)
    raise RuntimeError(f"Timed out waiting for {path}: {last_error}")


def verify_pristine_network_isolation(
    recorder: Recorder,
    podman: list[str],
    container: str,
) -> dict[str, object]:
    inspect = recorder.run(
        "pristine-network-mode",
        [
            *podman,
            "inspect",
            "--format",
            "{{.HostConfig.NetworkMode}}",
            container,
        ],
    )
    mode = inspect.stdout.strip()
    pid_result = recorder.run(
        "pristine-container-pid",
        [*podman, "inspect", "--format", "{{.State.Pid}}", container],
    )
    try:
        pid = int(pid_result.stdout.strip())
    except ValueError as error:
        raise RuntimeError("Pristine container has no host process identity") from error
    process_net = pathlib.Path(f"/proc/{pid}/net")
    interfaces = sorted(
        line.split(":", 1)[0].strip()
        for line in (process_net / "dev").read_text(encoding="ascii").splitlines()[2:]
        if ":" in line
    )
    ipv4_default = any(
        len(fields := line.split()) > 1 and fields[1] == "00000000"
        for line in (process_net / "route").read_text(encoding="ascii").splitlines()[1:]
    )
    ipv6_default = any(
        len(fields := line.split()) > 1
        and fields[0] == "0" * 32
        and fields[1] == "00"
        and fields[-1] != "lo"
        for line in (process_net / "ipv6_route")
        .read_text(encoding="ascii")
        .splitlines()
    )
    namespace = os.readlink(f"/proc/{pid}/ns/net")
    host_namespace = os.readlink("/proc/self/ns/net")
    if (
        mode != "none"
        or interfaces != ["lo"]
        or ipv4_default
        or ipv6_default
        or namespace == host_namespace
    ):
        raise RuntimeError("Pristine container network isolation is ineffective")
    return {
        "hostNetworkNamespace": host_namespace,
        "interfaces": interfaces,
        "ipv4DefaultRoute": ipv4_default,
        "ipv6DefaultRoute": ipv6_default,
        "networkMode": mode,
        "networkNamespace": namespace,
        "pid": pid,
    }


def read_connection(
    path: pathlib.Path,
    client: HostClient,
    owner_instance_id: str,
    executable_path: pathlib.Path,
    executable_sha256: str,
    timeout: float,
) -> tuple[dict[str, object], dict[str, object]]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not client.running():
            raise RuntimeError("Native SearXNG host process exited during startup")
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            time.sleep(0.1)
            continue
        if stat.S_IMODE(path.stat().st_mode) != 0o600:
            raise RuntimeError("Native SearXNG connection record is not mode 0600")
        if not isinstance(record, dict) or set(record) != CONNECTION_FIELDS:
            raise RuntimeError("Native SearXNG connection record is invalid")
        port = record.get("port")
        pid = record.get("pid")
        token = record.get("token")
        process_start = record.get("processStartTime")
        if (
            record.get("version") != 1
            or record.get("protocolVersion") != 1
            or record.get("runtimeVersion") != "2026.8.6+b023a28ba"
            or record.get("address") != "127.0.0.1"
            or not isinstance(port, int)
            or isinstance(port, bool)
            or port < 1024
            or port > 65535
            or not isinstance(pid, int)
            or isinstance(pid, bool)
            or pid < 1
            or not isinstance(process_start, str)
            or not process_start.isdecimal()
            or record.get("executablePath") != str(executable_path)
            or record.get("executableSha256") != executable_sha256
            or not isinstance(record.get("dataRootId"), str)
            or not record["dataRootId"]
            or record.get("ownerInstanceId") != owner_instance_id
        ):
            raise RuntimeError("Native SearXNG connection record is invalid")
        if not isinstance(token, str) or not re.fullmatch(
            r"[A-Za-z0-9_-]{32,512}", token
        ):
            raise RuntimeError("Native SearXNG connection record has no capability")
        created_at = record.get("createdAt")
        last_health_at = record.get("lastHealthAt")
        if (
            not isinstance(created_at, int)
            or isinstance(created_at, bool)
            or created_at <= 0
            or created_at > MAX_EPOCH_MILLISECONDS
            or not isinstance(last_health_at, int)
            or isinstance(last_health_at, bool)
            or last_health_at > MAX_EPOCH_MILLISECONDS
            or last_health_at < created_at
        ):
            raise RuntimeError("Native SearXNG connection timestamps are invalid")
        identity = client.invoke({"mode": "process", "pid": pid})
        if (
            client.process is None
            or pid != client.process.pid
            or identity.get("processStartTime") != process_start
            or identity.get("executablePath") != record["executablePath"]
            or not isinstance(identity.get("threadCount"), int)
            or int(identity["threadCount"]) < 1
            or not isinstance(identity.get("fdCount"), int)
            or int(identity["fdCount"]) < 1
        ):
            raise RuntimeError("Native host process identity mismatch")
        return record, identity
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
    client: HostClient,
    port: int,
    case: dict[str, object],
    capability: str,
) -> dict[str, object]:
    headers = {
        "Accept": str(case["accept"]),
        "Authorization": f"Bearer {capability}",
        "Connection": "close",
        "Host": f"127.0.0.1:{port}",
        "Sec-Fetch-Site": "none",
        "User-Agent": "WildBuzzard-SearXNG-Comparison/1",
    }
    if case.get("contentType"):
        headers["Content-Type"] = str(case["contentType"])
    body = case.get("body", b"")
    if not isinstance(body, bytes):
        raise TypeError("Scenario body must be bytes")
    result = client.invoke({
        "mode": "request",
        "method": str(case["method"]),
        "path": str(case["path"]),
        "port": port,
        "headers": headers,
        "body": base64.b64encode(body).decode("ascii"),
    })
    encoded = result.get("body")
    if not isinstance(encoded, str):
        raise RuntimeError("Host probe response has no body")
    try:
        result["body"] = base64.b64decode(encoded, validate=True)
    except ValueError as error:
        raise RuntimeError("Host probe response body is invalid") from error
    return result


def normalized_string(value: str) -> str:
    value = PORT_PATTERN.sub("http://127.0.0.1:<port>", value)
    value = TOKEN_PATTERN.sub("Bearer <redacted>", value)
    return value


def redact_bytes(value: bytes, replacements: dict[str, str]) -> bytes:
    return redact_text(value.decode("utf-8", "replace"), replacements).encode()


def redacted_headers(
    headers: list[tuple[object, object]], replacements: dict[str, str]
) -> list[tuple[str, str]]:
    result = []
    for raw_name, raw_value in headers:
        name = str(raw_name)
        value = str(raw_value)
        result.append((
            name,
            "<redacted>"
            if SENSITIVE_HEADER_PATTERN.search(name)
            else redact_text(value, replacements),
        ))
    return result


def allowed_artifact_queries() -> set[str]:
    allowed = {"", "cancel"}
    for case in scenarios():
        parsed = urllib.parse.urlsplit(str(case["path"]))
        parameters = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
        body = case.get("body", b"")
        if isinstance(body, bytes):
            body_parameters = urllib.parse.parse_qs(
                body.decode("ascii"), keep_blank_values=True
            )
            parameters.update(body_parameters)
        allowed.update(parameters.get("q", []))
    return allowed


def sanitize_artifacts(
    artifacts: pathlib.Path, replacements: dict[str, str]
) -> dict[str, object]:
    allowed_queries = allowed_artifact_queries()

    def redact_query(match: re.Match[str]) -> str:
        query = urllib.parse.unquote_plus(match.group("value"))
        if query in allowed_queries:
            return match.group(0)
        return f"{match.group('prefix')}q=<redacted>"

    files = []
    for path in sorted(artifacts.rglob("*")):
        if not path.is_file():
            continue
        value = redact_bytes(path.read_bytes(), replacements).decode("utf-8", "replace")
        path.write_text(QUERY_PATTERN.sub(redact_query, value), encoding="utf-8")
        path.chmod(0o600)
        files.append(path)
    forbidden = [
        source.encode()
        for source in replacements
        if source and not source.startswith("<")
    ]
    for path in files:
        value = path.read_bytes()
        if any(item in value for item in forbidden):
            raise RuntimeError(f"Sensitive value remains in artifact: {path.name}")
        text = value.decode("utf-8", "replace")
        if TOKEN_PATTERN.search(text):
            raise RuntimeError(f"Bearer capability remains in artifact: {path.name}")
        for match in QUERY_PATTERN.finditer(text):
            query = urllib.parse.unquote_plus(match.group("value"))
            if query not in allowed_queries:
                raise RuntimeError(f"Unexpected query remains in artifact {path.name}")
    return {
        "filesScanned": len(files),
        "forbiddenValues": len(forbidden),
        "unexpectedQueries": 0,
    }


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
    directory: pathlib.Path,
    name: str,
    response: dict[str, object],
    replacements: dict[str, str],
) -> None:
    headers = {
        "status": response["status"],
        "reason": response["reason"],
        "headers": redacted_headers(response["headers"], replacements),
        "durationMilliseconds": response["durationMilliseconds"],
    }
    write_json(directory / f"{name}.response.json", headers)
    payload = response["body"]
    if not isinstance(payload, bytes):
        raise TypeError("Response body must be bytes")
    (directory / f"{name}.response.body").write_bytes(
        redact_bytes(payload, replacements)
    )


def compare_scenarios(
    artifacts: pathlib.Path,
    pristine_client: HostClient,
    native_client: HostClient,
    pristine_port: int,
    native_port: int,
    capability: str,
    replacements: dict[str, str],
) -> list[dict[str, object]]:
    scenario_root = artifacts / "scenarios"
    scenario_root.mkdir(mode=0o700)
    results = []
    for index, case in enumerate(scenarios(), 1):
        directory = scenario_root / f"{index:02d}-{case['name']}"
        directory.mkdir(mode=0o700)
        pristine = issue_request(pristine_client, pristine_port, case, capability)
        native = issue_request(native_client, native_port, case, capability)
        (directory / "pristine.request.http").write_bytes(
            redact_bytes(
                request_transcript(case, pristine_port, capability), replacements
            )
        )
        (directory / "native.request.http").write_bytes(
            redact_bytes(
                request_transcript(case, native_port, capability), replacements
            )
        )
        record_response(directory, "pristine", pristine, replacements)
        record_response(directory, "native", native, replacements)
        pristine_body = canonical_body(pristine)
        native_body = canonical_body(native)
        (directory / "pristine.canonical.body").write_bytes(
            redact_bytes(pristine_body, replacements)
        )
        (directory / "native.canonical.body").write_bytes(
            redact_bytes(native_body, replacements)
        )
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
        (directory / "canonical.diff").write_text(
            redact_text(diff, replacements), encoding="utf-8"
        )
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


def cancellation_probe(
    client: HostClient, port: int, capability: str
) -> dict[str, object]:
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
    return client.invoke({
        "mode": "cancel",
        "port": port,
        "request": base64.b64encode(request).decode("ascii"),
    })


def process_keys(snapshot: dict[str, object]) -> list[tuple[object, object, object]]:
    processes = snapshot.get("processes")
    if not isinstance(processes, list):
        raise RuntimeError("Native process snapshot has no process list")
    keys = []
    for process in processes:
        if not isinstance(process, dict):
            raise RuntimeError("Native process snapshot is invalid")
        keys.append((
            process.get("pid"),
            process.get("processStartTime"),
            process.get("executablePath"),
        ))
    return keys


def wait_for_quiescence(
    client: HostClient,
    baseline: dict[str, object],
    timeout: float,
) -> dict[str, object]:
    baseline_keys = process_keys(baseline)
    baseline_threads = baseline.get("threadCount")
    baseline_fds = baseline.get("fdCount")
    if not isinstance(baseline_threads, int) or not isinstance(baseline_fds, int):
        raise RuntimeError("Native process baseline is invalid")
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        snapshot = client.invoke({"mode": "snapshot"})
        threads = snapshot.get("threadCount")
        fds = snapshot.get("fdCount")
        if (
            process_keys(snapshot) == baseline_keys
            and isinstance(threads, int)
            and threads <= baseline_threads
            and isinstance(fds, int)
            and fds <= baseline_fds
        ):
            return snapshot
        time.sleep(0.1)
    raise RuntimeError("Native process did not return to its pre-cancellation state")


def main() -> int:
    args = parse_args()
    runtime_root, artifacts = validate_paths(args)
    artifact_replacements = {
        str(runtime_root): "<runtime-root>",
        str(artifacts): "<artifacts>",
        str(CHECKOUT): "<checkout>",
        str(pathlib.Path.home().resolve()): "<home>",
        "comparison-only-secret": "<installation-secret>",
    }
    recorder = Recorder(artifacts)
    work = artifacts / "work"
    work.mkdir(mode=0o700)
    run_id = secrets.token_hex(8)
    pristine_container = f"wildbuzzard-searxng-pristine-{run_id}"
    image_tag = f"localhost/wildbuzzard-searxng-pristine:{run_id}"
    pristine_container_created = False
    native_process: subprocess.Popen[bytes] | None = None
    native_log = None
    native_log_path = artifacts / "native-service.log"
    image_created = False
    podman: list[str] | None = None
    images_before: list[dict[str, object]] | None = None
    containers_before: list[dict[str, object]] | None = None
    storage_before: list[dict[str, object]] | None = None
    volumes_before: list[dict[str, object]] | None = None
    base_image_was_present = False
    pristine_image_id: str | None = None
    key_user_before = read_key_user()
    rootless_security: dict[str, object] = {
        "keyUserBefore": key_user_before,
    }
    summary: dict[str, object] = {
        "schema": 1,
        "startedAt": utc_now(),
        "outcome": "infrastructure-failure",
        "sourceCommit": SOURCE_COMMIT,
        "runtimeManifestSha256": sha256_file(runtime_root / "wildbuzzard-runtime.json"),
        "rootlessRuntimeSecurity": rootless_security,
    }
    cleanup: dict[str, object] = {}
    try:
        podman, seccomp, security = prepare_rootless_runtime(
            recorder, work, artifacts, key_user_before
        )
        rootless_security.update(security)
        summary["podman"] = verify_rootless_podman(recorder, podman)
        images_before = parse_json_array(
            recorder.run(
                "podman-images-before",
                [*podman, "image", "ls", "--no-trunc", "--format", "json"],
            ).stdout,
            "image",
        )
        containers_before = parse_json_array(
            recorder.run(
                "podman-containers-before",
                [*podman, "ps", "-a", "--no-trunc", "--format", "json"],
            ).stdout,
            "container",
        )
        storage_before = parse_json_array(
            recorder.run(
                "podman-storage-before",
                [*podman, "system", "df", "--format", "json"],
            ).stdout,
            "storage",
        )
        volumes_before = parse_json_array(
            recorder.run(
                "podman-volumes-before",
                [*podman, "volume", "ls", "--format", "json"],
            ).stdout,
            "volume",
        )
        pristine_image = verify_and_pull_base(recorder, podman)
        summary["pristineImage"] = pristine_image
        pristine_image_id = str(pristine_image["imageId"])
        base_image_was_present = any(
            item.get("Id") == pristine_image_id for item in images_before
        )
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
                *podman,
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
        pristine_socket_root = work / "pristine-socket"
        pristine_config.mkdir(mode=0o700)
        pristine_cache.mkdir(mode=0o700)
        pristine_socket_root.mkdir(mode=0o700)
        pristine_socket = pristine_socket_root / "searxng.sock"
        settings_path = pristine_config / "settings.yml"
        template = (HERE / "fixture-settings.yml.in").read_text(encoding="utf-8")
        pristine_port = 8080
        settings_path.write_text(
            template.replace("@PUBLIC_PORT@", str(pristine_port)), encoding="utf-8"
        )
        settings_path.chmod(0o600)
        native_runtime = prepare_native_runtime(runtime_root, work)
        native_state = work / "native-state"
        native_data = work / "native-data"
        native_cache = work / "native-cache"
        for directory in (native_state, native_data, native_cache):
            directory.mkdir(mode=0o700)
        connection_path = native_state / "connection.json"
        owner_instance_id = f"comparison-{run_id}"
        probe = HERE / "host_http_probe.py"

        pristine_container_created = True
        create = recorder.run(
            "pristine-container-create",
            [
                *podman,
                "create",
                "--name",
                pristine_container,
                "--cap-drop=all",
                "--network",
                "none",
                "--security-opt",
                "no-new-privileges",
                "--security-opt",
                f"seccomp={seccomp}",
                "--read-only",
                "--tmpfs",
                "/tmp:rw,noexec,nosuid,nodev,size=64m",
                "--volume",
                f"{settings_path}:/etc/searxng/settings.yml:ro",
                "--volume",
                f"{pristine_cache}:/var/cache/searxng:rw",
                "--volume",
                f"{pristine_socket_root}:/run/wildbuzzard-pristine:rw",
                "--env",
                "PYTHONHASHSEED=0",
                "--env",
                "SEARXNG_SETTINGS_PATH=/etc/searxng/settings.yml",
                "--env",
                "TMPDIR=/var/cache/searxng",
                "--env",
                "TZ=UTC",
                "--entrypoint",
                "/usr/local/searxng/.venv/bin/granian",
                image_tag,
                "--interface",
                "wsgi",
                "--uds",
                "/run/wildbuzzard-pristine/searxng.sock",
                "--uds-permissions",
                "0o600",
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
        recorder.run("pristine-container-start", [*podman, "start", pristine_container])
        native_python = (native_runtime / "python" / "bin" / "python3").resolve(
            strict=True
        )
        native_environment = {
            "HOME": str(native_data),
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
            "LD_LIBRARY_PATH": str(native_runtime / "python" / "lib"),
            "OPENSSL_MODULES": str(native_runtime / "python" / "lib"),
            "PATH": f"{native_runtime / 'python' / 'bin'}:/usr/bin:/bin",
            "PYTHONHASHSEED": "0",
            "TZ": "UTC",
        }
        pristine_client = HostClient(
            native_python,
            probe,
            native_environment,
            unix_socket=pristine_socket,
        )
        native_log = native_log_path.open("wb", buffering=0)
        native_log_path.chmod(0o600)
        native_process = subprocess.Popen(
            [
                str(native_runtime / "bin" / "searxng-service"),
                "serve",
                "--data-root",
                str(native_data),
                "--cache-root",
                str(native_cache),
                "--runtime-dir",
                str(native_state),
                "--connection-file",
                str(connection_path),
                "--owner-instance-id",
                owner_instance_id,
            ],
            cwd=native_runtime,
            env=native_environment,
            stdin=subprocess.DEVNULL,
            stdout=native_log,
            stderr=subprocess.STDOUT,
            close_fds=True,
            start_new_session=True,
        )
        native_client = HostClient(
            native_python,
            probe,
            native_environment,
            process=native_process,
        )
        summary["networkIsolation"] = {
            "pristineContainer": verify_pristine_network_isolation(
                recorder, podman, pristine_container
            )
        }
        summary["nativeExecution"] = {
            "containerized": False,
            "environmentKeys": sorted(native_environment),
            "listenerAddress": "127.0.0.1",
            "scope": "host-process",
        }
        connection, native_process_identity = read_connection(
            connection_path,
            native_client,
            owner_instance_id,
            native_python,
            sha256_file(native_python),
            args.timeout,
        )
        native_port = int(connection["port"])
        capability = str(connection["token"])
        artifact_replacements[capability] = "<capability>"
        common_health_headers = {
            "Authorization": f"Bearer {capability}",
            "Sec-Fetch-Site": "none",
        }
        wait_http(
            pristine_client,
            pristine_port,
            "/healthz",
            common_health_headers,
            args.timeout,
        )
        wait_http(
            native_client,
            native_port,
            "/v1/health",
            common_health_headers,
            args.timeout,
        )
        startup_logs = {
            "native": native_log_path.read_text(encoding="utf-8", errors="replace"),
            "pristine": recorder.run(
                "pristine-startup-logs",
                [*podman, "logs", pristine_container],
                check=False,
            ).stdout,
        }
        forbidden_updater_markers = ("clearurls.xyz", "TRACKER_PATTERNS")
        if any(
            marker in output
            for output in startup_logs.values()
            for marker in forbidden_updater_markers
        ):
            raise RuntimeError("Fixture startup attempted the tracker-rule updater")
        summary["startupUpdater"] = {
            "pluginsConfigured": 0,
            "trackerRuleFetchAttempted": False,
        }

        pristine_redacted = template.replace("@PUBLIC_PORT@", "<port>").replace(
            "comparison-only-secret", "<redacted>"
        )
        native_settings = (native_state / "settings.yml").read_text(encoding="utf-8")
        secret_match = re.search(r"(?m)^  secret_key:\s*(.+?)\s*$", native_settings)
        if not secret_match:
            raise RuntimeError("Native settings have no server secret")
        try:
            native_secret = json.loads(secret_match.group(1))
        except json.JSONDecodeError as error:
            raise RuntimeError(
                "Native settings have an invalid server secret"
            ) from error
        if not isinstance(native_secret, str) or not native_secret:
            raise RuntimeError("Native settings have an invalid server secret")
        artifact_replacements[native_secret] = "<configuration-secret>"
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
        summary["nativeHostProcess"] = native_process_identity
        summary["ports"] = {
            "native": {"port": native_port, "scope": "host-loopback"},
            "pristine": {
                "port": pristine_port,
                "scope": "container-unix-socket",
            },
        }
        results = compare_scenarios(
            artifacts,
            pristine_client,
            native_client,
            pristine_port,
            native_port,
            capability,
            artifact_replacements,
        )
        summary["scenarios"] = results
        native_process_baseline = native_client.invoke({"mode": "snapshot"})
        cancellation = {
            "pristine": cancellation_probe(pristine_client, pristine_port, capability),
            "native": cancellation_probe(native_client, native_port, capability),
        }
        wait_http(
            native_client,
            native_port,
            "/v1/health",
            common_health_headers,
            args.timeout,
        )
        native_process_after = wait_for_quiescence(
            native_client, native_process_baseline, args.timeout
        )
        cancellation_logs = native_log_path.read_text(
            encoding="utf-8", errors="replace"
        )
        if "Traceback" in cancellation_logs or "BrokenPipe" in cancellation_logs:
            raise RuntimeError("Native cancellation emitted a traceback")
        cancellation["nativeProcessState"] = {
            "before": native_process_baseline,
            "after": native_process_after,
            "healthPassed": True,
            "logsClean": True,
        }
        summary["cancellation"] = cancellation
        summary["outcome"] = (
            "passed" if all(result["equal"] for result in results) else "parity-failure"
        )
    except Exception as error:
        record_failure(summary, error)
    finally:
        try:
            if podman is None and pristine_container_created:
                raise RuntimeError("Rootless runtime command was not initialized")
            cleanup_failures = []
            if native_process is not None:
                forced = False
                if native_process.poll() is None:
                    native_process.terminate()
                    try:
                        native_process.wait(timeout=15)
                    except subprocess.TimeoutExpired:
                        forced = True
                        with contextlib.suppress(ProcessLookupError):
                            os.killpg(native_process.pid, signal.SIGKILL)
                        native_process.wait(timeout=5)
                cleanup["nativeHostProcess"] = {
                    "exitCode": native_process.returncode,
                    "forced": forced,
                    "stopped": native_process.returncode == 0,
                }
                if native_process.returncode != 0:
                    cleanup_failures.append(
                        "native host comparison process did not exit cleanly"
                    )
            if native_log is not None:
                native_log.close()
            container_cleanup = {}
            if podman is not None and pristine_container_created:
                logs = recorder.run(
                    "pristine-container-logs",
                    [*podman, "logs", pristine_container],
                    check=False,
                )
                (artifacts / "pristine-service.log").write_text(
                    logs.stdout, encoding="utf-8"
                )
                stop = recorder.run(
                    "pristine-container-stop",
                    [*podman, "stop", "--time", "10", pristine_container],
                    check=False,
                )
                inspect = recorder.run(
                    "pristine-container-exit",
                    [
                        *podman,
                        "inspect",
                        "--format",
                        "{{.State.ExitCode}}",
                        pristine_container,
                    ],
                    check=False,
                )
                remove = recorder.run(
                    "pristine-container-remove",
                    [*podman, "rm", "--force", "--volumes", pristine_container],
                    check=False,
                )
                container_cleanup["pristine"] = {
                    "logsExitCode": logs.returncode,
                    "removeExitCode": remove.returncode,
                    "removed": remove.returncode == 0,
                    "serviceExitCode": inspect.stdout.strip(),
                    "stopExitCode": stop.returncode,
                }
                if remove.returncode:
                    cleanup_failures.append(
                        "failed to remove pristine comparison container"
                    )
            cleanup["containers"] = container_cleanup
            if image_created:
                if podman is None:
                    raise RuntimeError("Rootless runtime command was not initialized")
                remove_image = recorder.run(
                    "pristine-image-remove",
                    [*podman, "image", "rm", image_tag],
                    check=False,
                )
                cleanup["testImageRemoved"] = remove_image.returncode == 0
                if remove_image.returncode:
                    cleanup_failures.append("failed to remove comparison image")
            if (
                podman is not None
                and pristine_image_id is not None
                and not base_image_was_present
            ):
                remove_base = recorder.run(
                    "pristine-base-image-remove",
                    [*podman, "image", "rm", pristine_image_id],
                    check=False,
                )
                cleanup["newBaseImageRemoved"] = remove_base.returncode == 0
                if remove_base.returncode:
                    cleanup_failures.append("failed to remove newly pulled base image")
            if (
                podman is not None
                and images_before is not None
                and containers_before is not None
                and storage_before is not None
                and volumes_before is not None
            ):
                images_after = parse_json_array(
                    recorder.run(
                        "podman-images-after",
                        [
                            *podman,
                            "image",
                            "ls",
                            "--no-trunc",
                            "--format",
                            "json",
                        ],
                    ).stdout,
                    "image",
                )
                containers_after = parse_json_array(
                    recorder.run(
                        "podman-containers-after",
                        [
                            *podman,
                            "ps",
                            "-a",
                            "--no-trunc",
                            "--format",
                            "json",
                        ],
                    ).stdout,
                    "container",
                )
                storage_after = parse_json_array(
                    recorder.run(
                        "podman-storage-after",
                        [*podman, "system", "df", "--format", "json"],
                    ).stdout,
                    "storage",
                )
                volumes_after = parse_json_array(
                    recorder.run(
                        "podman-volumes-after",
                        [*podman, "volume", "ls", "--format", "json"],
                    ).stdout,
                    "volume",
                )
                inventories_match = {
                    "containers": container_inventory(containers_after)
                    == container_inventory(containers_before),
                    "images": image_inventory(images_after)
                    == image_inventory(images_before),
                    "storage": storage_inventory(storage_after)
                    == storage_inventory(storage_before),
                    "volumes": volume_inventory(volumes_after)
                    == volume_inventory(volumes_before),
                }
                cleanup["podmanInventoriesRestored"] = inventories_match
                if not all(inventories_match.values()):
                    cleanup_failures.append(
                        "Podman inventory changed after comparison cleanup"
                    )
            if cleanup_failures:
                raise RuntimeError("; ".join(cleanup_failures))
        except Exception as cleanup_error:
            record_failure(summary, cleanup_error)
        finally:
            try:
                key_user_after = read_key_user()
                key_user_unchanged = key_user_after == key_user_before
                rootless_security["keyUserAfter"] = key_user_after
                rootless_security["keyUserUnchanged"] = key_user_unchanged
                cleanup["keyUserAfter"] = key_user_after
                cleanup["keyUserUnchanged"] = key_user_unchanged
                if not key_user_unchanged:
                    raise RuntimeError(
                        "rootless runtime changed /proc/key-users quota state"
                    )
            except Exception as key_user_error:
                record_failure(summary, key_user_error)
            shutil.rmtree(work, ignore_errors=True)
            cleanup["workDirectoryRemoved"] = not work.exists()
            summary["commands"] = recorder.commands
            summary["cleanup"] = cleanup
            summary["finishedAt"] = utc_now()
            try:
                evidence = sanitize_artifacts(artifacts, artifact_replacements)
                summary["artifactSanitization"] = {
                    **evidence,
                    "filesScanned": int(evidence["filesScanned"]) + 1,
                    "passed": True,
                    "summaryIncludedInFinalScan": True,
                }
            except Exception as sanitization_error:
                record_failure(summary, sanitization_error)
                summary["artifactSanitization"] = {
                    "passed": False,
                    "summaryIncludedInFinalScan": False,
                }
            redacted_summary = redact_value(summary, artifact_replacements)
            if not isinstance(redacted_summary, dict):
                raise TypeError("Redacted comparison summary is not an object")
            summary = redacted_summary
            write_json(artifacts / "summary.json", summary)
            try:
                final_evidence = sanitize_artifacts(artifacts, artifact_replacements)
                expected_count = summary["artifactSanitization"]["filesScanned"]
                if final_evidence["filesScanned"] != expected_count:
                    raise RuntimeError("Final artifact scan count is inconsistent")
            except Exception as sanitization_error:
                record_failure(summary, sanitization_error)
                summary["artifactSanitization"] = {
                    "passed": False,
                    "summaryIncludedInFinalScan": True,
                }
                redacted_summary = redact_value(summary, artifact_replacements)
                if not isinstance(redacted_summary, dict):
                    raise TypeError("Redacted comparison summary is not an object")
                summary = redacted_summary
                write_json(artifacts / "summary.json", summary)
                sanitize_artifacts(artifacts, artifact_replacements)
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
