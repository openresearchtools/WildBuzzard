#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import argparse
import contextlib
import ctypes
import fcntl
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
import threading
import time


RUNTIME_VERSION = "2026.8.6+b023a28ba"
UPSTREAM_COMMIT = "b023a28bab8839dba9eac96e9a51cc91bbd0a267"
MAX_RUNTIME_BYTES = 2 * 1024 * 1024 * 1024
MAX_RECORD_BYTES = 32 * 1024
MAX_UNIX_SOCKET_PATH_BYTES = 107
START_TIMEOUT_SECONDS = 45
RECORD_FIELDS = {
    "schema",
    "runtimeVersion",
    "upstreamCommit",
    "pid",
    "processStartTime",
    "executablePath",
    "installedRoot",
    "socketPath",
    "settingsPath",
    "catalogSha256",
    "createdAt",
    "instanceToken",
}


def sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def strict_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    value: dict[str, object] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError(f"duplicate JSON field: {key}")
        value[key] = item
    return value


def read_json(path: pathlib.Path, maximum: int | None = None) -> dict[str, object]:
    status = os.stat(path, follow_symlinks=False)
    if not stat.S_ISREG(status.st_mode) or (
        maximum is not None and status.st_size > maximum
    ):
        raise RuntimeError(f"invalid JSON file: {path}")
    try:
        value = json.loads(
            path.read_text(encoding="utf-8"),
            object_pairs_hook=strict_object,
            parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)),
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        raise RuntimeError(f"invalid JSON file: {path}") from error
    if not isinstance(value, dict):
        raise RuntimeError(f"invalid JSON object: {path}")
    return value


def private_directory(path: pathlib.Path) -> pathlib.Path:
    if path.is_symlink():
        raise RuntimeError(f"refusing symlink directory: {path}")
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.chmod(0o700)
    resolved = path.resolve(strict=True)
    status = os.stat(resolved, follow_symlinks=False)
    if (
        not stat.S_ISDIR(status.st_mode)
        or status.st_uid != os.getuid()
        or stat.S_IMODE(status.st_mode) != 0o700
    ):
        raise RuntimeError(f"invalid private directory: {path}")
    return resolved


def atomic_text(path: pathlib.Path, value: str) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{secrets.token_hex(8)}")
    descriptor = os.open(
        temporary,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW,
        0o600,
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            descriptor = -1
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        path.chmod(0o600)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        temporary.unlink(missing_ok=True)


def atomic_json(path: pathlib.Path, value: dict[str, object]) -> None:
    atomic_text(path, json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n")


def process_start_time(pid: int) -> str:
    value = pathlib.Path(f"/proc/{pid}/stat").read_text(encoding="ascii")
    return value[value.rfind(")") + 2 :].split()[19]


def runtime_paths(
    runtime_root: pathlib.Path,
) -> tuple[pathlib.Path, pathlib.Path, pathlib.Path]:
    metadata = runtime_root / "share" / "wildbuzzard" / "searxng"
    return (
        runtime_root / "wildbuzzard-executable.json",
        metadata / "engine-catalog.json",
        metadata / "sbom.cdx.json",
    )


def validate_catalog(value: dict[str, object]) -> list[dict[str, object]]:
    counts = value.get("counts")
    engines = value.get("engines")
    expected_counts = {
        "totalEntries": 343,
        "totalModules": 222,
        "eligibleEntries": 332,
        "eligibleModules": 211,
        "credentialRequiredEntries": 11,
        "credentialRequiredModules": 11,
    }
    if (
        value.get("schema") != 1
        or value.get("upstreamCommit") != UPSTREAM_COMMIT
        or not isinstance(counts, dict)
        or any(counts.get(key) != expected for key, expected in expected_counts.items())
        or not isinstance(engines, list)
        or len(engines) != 343
    ):
        raise RuntimeError("invalid SearXNG engine catalog")
    fields = {
        "name",
        "module",
        "shortcut",
        "disabledUpstream",
        "inactiveUpstream",
        "requiresCredentials",
        "upstreamPath",
        "upstreamSha256",
    }
    names: set[str] = set()
    eligible: list[dict[str, object]] = []
    for engine in engines:
        if (
            not isinstance(engine, dict)
            or set(engine) != fields
            or not isinstance(engine.get("name"), str)
            or not isinstance(engine.get("module"), str)
            or not isinstance(engine.get("requiresCredentials"), bool)
            or engine["name"] in names
        ):
            raise RuntimeError("invalid SearXNG engine catalog entry")
        names.add(engine["name"])
        if not engine["requiresCredentials"]:
            eligible.append(engine)
    if (
        len(names) != 343
        or len(eligible) != 332
        or len({item["module"] for item in eligible}) != 211
    ):
        raise RuntimeError("invalid SearXNG engine catalog counts")
    return eligible


def verify_runtime(
    runtime_root: pathlib.Path,
) -> tuple[dict[str, object], list[dict[str, object]]]:
    runtime_root = runtime_root.resolve(strict=True)
    manifest_path, catalog_path, sbom_path = runtime_paths(runtime_root)
    manifest = read_json(manifest_path)
    files = manifest.get("files")
    if (
        manifest.get("schema") != 1
        or manifest.get("component") != "wildbuzzard-searxng-executable"
        or manifest.get("runtimeVersion") != RUNTIME_VERSION
        or manifest.get("upstreamCommit") != UPSTREAM_COMMIT
        or not isinstance(files, list)
        or not files
    ):
        raise RuntimeError("invalid WildBuzzard SearXNG executable manifest")
    expected: dict[str, tuple[int, str]] = {}
    total_size = 0
    for entry in files:
        if not isinstance(entry, dict) or set(entry) != {"path", "size", "sha256"}:
            raise RuntimeError("invalid executable file inventory")
        relative = entry.get("path")
        size = entry.get("size")
        digest = entry.get("sha256")
        if (
            not isinstance(relative, str)
            or not isinstance(size, int)
            or isinstance(size, bool)
            or size < 0
            or not isinstance(digest, str)
            or len(digest) != 64
            or relative in expected
            or pathlib.PurePosixPath(relative).is_absolute()
            or any(
                part in ("", ".", "..")
                for part in pathlib.PurePosixPath(relative).parts
            )
        ):
            raise RuntimeError("invalid executable file identity")
        expected[relative] = (size, digest)
        total_size += size
    if total_size >= MAX_RUNTIME_BYTES or manifest.get("unpackedBytes") != total_size:
        raise RuntimeError("SearXNG executable payload exceeds its size gate")
    actual: set[str] = set()
    for path in runtime_root.rglob("*"):
        relative = path.relative_to(runtime_root).as_posix()
        if path.is_symlink() or (
            path != manifest_path and not path.is_dir() and not path.is_file()
        ):
            raise RuntimeError(f"unexpected runtime file type: {relative}")
        if path.is_file() and path != manifest_path:
            actual.add(relative)
    if actual != set(expected):
        raise RuntimeError("SearXNG executable file inventory mismatch")
    for relative, (size, digest) in expected.items():
        path = runtime_root.joinpath(*pathlib.PurePosixPath(relative).parts)
        status = os.stat(path, follow_symlinks=False)
        if status.st_size != size or sha256_file(path) != digest:
            raise RuntimeError(f"SearXNG executable payload mismatch: {relative}")
    if sha256_file(catalog_path) != manifest.get("engineCatalogSha256"):
        raise RuntimeError("SearXNG engine catalog digest mismatch")
    catalog = read_json(catalog_path)
    eligible = validate_catalog(catalog)
    sbom = read_json(sbom_path)
    components = sbom.get("components")
    metadata = sbom.get("metadata")
    application = metadata.get("component") if isinstance(metadata, dict) else None
    if (
        sbom.get("bomFormat") != "CycloneDX"
        or sbom.get("specVersion") != "1.6"
        or not isinstance(components, list)
        or not isinstance(application, dict)
        or application.get("name") != "SearXNG"
        or application.get("version") != RUNTIME_VERSION
        or application.get("purl") != f"pkg:github/searxng/searxng@{UPSTREAM_COMMIT}"
    ):
        raise RuntimeError("invalid embedded SearXNG SBOM")
    upstream = runtime_root / "share" / "wildbuzzard" / "searxng" / "UPSTREAM.toml"
    if f'commit = "{UPSTREAM_COMMIT}"' not in upstream.read_text(encoding="utf-8"):
        raise RuntimeError("embedded SearXNG attribution does not match the pin")
    return manifest, eligible


def install_runtime(
    source_root: pathlib.Path, install_root: pathlib.Path
) -> pathlib.Path:
    manifest, _ = verify_runtime(source_root)
    install_root = install_root.absolute()
    parent = private_directory(install_root.parent)
    if install_root.exists():
        installed_manifest, _ = verify_runtime(install_root)
        if installed_manifest != manifest:
            raise RuntimeError("installed SearXNG runtime identity mismatch")
        return install_root.resolve(strict=True)
    if install_root.is_symlink():
        raise RuntimeError("refusing symlink SearXNG install path")
    temporary = parent / f".{install_root.name}.{os.getpid()}.{secrets.token_hex(8)}"
    try:
        shutil.copytree(source_root, temporary, symlinks=False)
        temporary.chmod(0o700)
        installed_manifest, _ = verify_runtime(temporary)
        if installed_manifest != manifest:
            raise RuntimeError("copied SearXNG runtime identity mismatch")
        os.replace(temporary, install_root)
        descriptor = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)
    return install_root.resolve(strict=True)


def extracted_app_dir(runtime_root: pathlib.Path) -> pathlib.Path | None:
    app_dir_value = os.environ.get("APPDIR")
    appimage_value = os.environ.get("APPIMAGE")
    if (
        "APPIMAGE_EXTRACT_AND_RUN" not in os.environ
        or not app_dir_value
        or not appimage_value
    ):
        return None
    app_dir = pathlib.Path(app_dir_value).absolute()
    if app_dir.is_symlink() or not re.fullmatch(
        r"appimage_extracted_[0-9a-f]{32}", app_dir.name
    ):
        raise RuntimeError("invalid extracted AppImage directory")
    status = os.stat(app_dir, follow_symlinks=False)
    if not stat.S_ISDIR(status.st_mode) or status.st_uid != os.getuid():
        raise RuntimeError("invalid extracted AppImage directory owner")
    expected_runtime = app_dir / "usr" / "lib" / "wildbuzzard-searxng"
    if runtime_root != expected_runtime.resolve(strict=True):
        raise RuntimeError("extracted AppImage runtime identity mismatch")
    appimage = pathlib.Path(appimage_value).resolve(strict=True)
    digest = hashlib.md5(usedforsecurity=False)
    with appimage.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    if app_dir.name != f"appimage_extracted_{digest.hexdigest()}":
        raise RuntimeError("extracted AppImage digest mismatch")
    return app_dir


def release_extracted_appimage(runtime_root: pathlib.Path) -> pathlib.Path | None:
    app_dir = extracted_app_dir(runtime_root)
    if app_dir is None:
        return None
    expected = {
        ".DirIcon",
        "AppRun",
        "usr",
        "wildbuzzard-searxng.desktop",
        "wildbuzzard-searxng.svg",
    }
    children = list(app_dir.iterdir())
    if {child.name for child in children} != expected:
        raise RuntimeError("unexpected extracted AppImage contents")
    for child in children:
        if child.is_dir() and not child.is_symlink():
            shutil.rmtree(child)
        else:
            child.unlink()
    app_dir.rmdir()
    app_dir.symlink_to("/dev/null")
    return app_dir


def reexec_installed(
    runtime_root: pathlib.Path,
    cleanup_path: pathlib.Path,
    parent_pid: int,
    parent_start: str,
) -> None:
    command = list(sys.argv)
    try:
        runtime_index = command.index("--runtime-root") + 1
    except ValueError as error:
        raise RuntimeError("missing runtime root argument") from error
    launcher = runtime_root / "libexec" / "searxng_executable.py"
    python = runtime_root / "python" / "bin" / "python3"
    command[0] = str(launcher)
    command[runtime_index] = str(runtime_root)
    command = [str(python), "-I", "-B", *command]
    environment = os.environ.copy()
    for name in (
        "APPDIR",
        "APPIMAGE",
        "ARGV0",
        "APPIMAGE_EXTRACT_AND_RUN",
        "NO_CLEANUP",
    ):
        environment.pop(name, None)
    environment["LD_LIBRARY_PATH"] = str(runtime_root / "python" / "lib")
    environment["OPENSSL_MODULES"] = str(runtime_root / "python" / "lib")
    environment["PATH"] = str(runtime_root / "python" / "bin")
    environment["WILDBUZZARD_APPIMAGE_CLEANUP"] = str(cleanup_path)
    environment["WILDBUZZARD_APPIMAGE_PARENT_PID"] = str(parent_pid)
    environment["WILDBUZZARD_APPIMAGE_PARENT_START"] = parent_start
    os.execve(command[0], command, environment)


def configure_parent_death_signal() -> None:
    os.setsid()
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(1, signal.SIGTERM, 0, 0, 0) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


def cleanup_extracted_link_after_parent() -> None:
    value = os.environ.get("WILDBUZZARD_APPIMAGE_CLEANUP")
    pid_value = os.environ.get("WILDBUZZARD_APPIMAGE_PARENT_PID")
    start = os.environ.get("WILDBUZZARD_APPIMAGE_PARENT_START")
    if not value or not pid_value or not start:
        return
    pid = int(pid_value)
    try:
        status = pathlib.Path(f"/proc/{pid}/stat").read_text(encoding="ascii")
        state = status[status.rfind(")") + 2 :].split()[0]
        if state != "Z" and process_start_time(pid) == start:
            return
    except (FileNotFoundError, ProcessLookupError):
        pass
    path = pathlib.Path(value)
    try:
        link_status = os.stat(path, follow_symlinks=False)
    except FileNotFoundError:
        return
    if (
        not stat.S_ISLNK(link_status.st_mode)
        or link_status.st_uid != os.getuid()
        or os.readlink(path) != "/dev/null"
        or not re.fullmatch(r"appimage_extracted_[0-9a-f]{32}", path.name)
    ):
        raise RuntimeError("invalid extracted AppImage cleanup link")
    path.unlink()


def settings_text(secret: str, eligible: list[dict[str, object]]) -> str:
    keep_only = "\n".join(
        f"      - {json.dumps(engine['name'])}" for engine in eligible
    )
    return f"""use_default_settings:
  engines:
    keep_only:
{keep_only}
general:
  debug: false
  instance_name: WildBuzzard Search
  enable_metrics: false
search:
  safe_search: 1
  autocomplete: ""
  favicon_resolver: ""
  formats:
    - html
    - json
server:
  port: 0
  bind_address: 127.0.0.1
  base_url: moz-searxng://local/
  limiter: false
  public_instance: false
  secret_key: {json.dumps(secret)}
  image_proxy: false
  method: GET
ui:
  query_in_title: false
preferences:
  lock:
    - autocomplete
    - favicon_resolver
    - safesearch
    - method
    - image_proxy
    - query_in_title
plugins: {{}}
"""


def runtime_environment(
    runtime_root: pathlib.Path, state_root: pathlib.Path, cache_root: pathlib.Path
) -> dict[str, str]:
    return {
        "HOME": str(private_directory(state_root / "data")),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "LD_LIBRARY_PATH": str(runtime_root / "python" / "lib"),
        "OPENSSL_MODULES": str(runtime_root / "python" / "lib"),
        "PATH": str(runtime_root / "python" / "bin"),
        "PYTHONHASHSEED": "0",
        "PYTHONNOUSERSITE": "1",
        "TMPDIR": str(cache_root),
        "TZ": "UTC",
    }


class UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, socket_path: pathlib.Path, timeout: float = 3.0):
        super().__init__("localhost", timeout=timeout)
        self.socket_path = socket_path

    def connect(self) -> None:
        connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.settimeout(self.timeout)
        connection.connect(str(self.socket_path))
        self.sock = connection


def health(socket_path: pathlib.Path) -> bool:
    connection = UnixHTTPConnection(socket_path)
    try:
        connection.request("GET", "/healthz", headers={"Host": "localhost"})
        response = connection.getresponse()
        return response.status == 200 and response.read(16) == b"OK"
    except (OSError, http.client.HTTPException):
        return False
    finally:
        connection.close()


def validate_service_paths(
    state_root: pathlib.Path,
    cache_root: pathlib.Path,
    connection_path: pathlib.Path,
    socket_path: pathlib.Path,
) -> tuple[pathlib.Path, pathlib.Path, pathlib.Path, pathlib.Path]:
    state_root = private_directory(state_root)
    cache_root = private_directory(cache_root)
    connection_path = connection_path.absolute()
    socket_path = socket_path.absolute()
    if connection_path.parent.resolve(strict=True) != state_root:
        raise RuntimeError(
            "connection record must be inside the private state directory"
        )
    if socket_path.parent.resolve(strict=True) != state_root:
        raise RuntimeError("SearXNG socket must be inside the private state directory")
    if len(os.fsencode(socket_path)) > MAX_UNIX_SOCKET_PATH_BYTES:
        raise RuntimeError("SearXNG socket path is too long")
    return state_root, cache_root, connection_path, socket_path


def safe_remove_socket(path: pathlib.Path) -> None:
    try:
        status = os.stat(path, follow_symlinks=False)
    except FileNotFoundError:
        return
    if (
        not stat.S_ISSOCK(status.st_mode)
        or status.st_uid != os.getuid()
        or stat.S_IMODE(status.st_mode) != 0o600
    ):
        raise RuntimeError("refusing to remove an invalid SearXNG socket")
    path.unlink()


def record_for(
    runtime_root: pathlib.Path,
    manifest: dict[str, object],
    socket_path: pathlib.Path,
    settings_path: pathlib.Path,
    instance_token: str,
) -> dict[str, object]:
    return {
        "schema": 1,
        "runtimeVersion": RUNTIME_VERSION,
        "upstreamCommit": UPSTREAM_COMMIT,
        "pid": os.getpid(),
        "processStartTime": process_start_time(os.getpid()),
        "executablePath": str(pathlib.Path(sys.executable).resolve(strict=True)),
        "installedRoot": str(runtime_root),
        "socketPath": str(socket_path),
        "settingsPath": str(settings_path),
        "catalogSha256": manifest["engineCatalogSha256"],
        "createdAt": time.time_ns() // 1_000_000,
        "instanceToken": instance_token,
    }


def read_record(path: pathlib.Path) -> dict[str, object] | None:
    try:
        status = os.stat(path, follow_symlinks=False)
    except FileNotFoundError:
        return None
    if (
        not stat.S_ISREG(status.st_mode)
        or status.st_uid != os.getuid()
        or status.st_mode & 0o077
        or status.st_size > MAX_RECORD_BYTES
    ):
        raise RuntimeError("invalid SearXNG connection record")
    value = read_json(path, MAX_RECORD_BYTES)
    if set(value) != RECORD_FIELDS:
        raise RuntimeError("invalid SearXNG connection record fields")
    return value


def validate_record(
    record: dict[str, object], runtime_root: pathlib.Path, state_root: pathlib.Path
) -> bool:
    pid = record.get("pid")
    socket_path = record.get("socketPath")
    if (
        record.get("schema") != 1
        or record.get("runtimeVersion") != RUNTIME_VERSION
        or record.get("upstreamCommit") != UPSTREAM_COMMIT
        or record.get("installedRoot") != str(runtime_root)
        or not isinstance(pid, int)
        or isinstance(pid, bool)
        or pid < 1
        or not isinstance(socket_path, str)
        or pathlib.Path(socket_path).parent != state_root
    ):
        raise RuntimeError("SearXNG connection identity mismatch")
    try:
        process_status = os.stat(f"/proc/{pid}")
        actual_start = process_start_time(pid)
    except (FileNotFoundError, ProcessLookupError):
        return False
    if process_status.st_uid != os.getuid() or actual_start != record.get(
        "processStartTime"
    ):
        raise RuntimeError("SearXNG process identity mismatch")
    executable = pathlib.Path(f"/proc/{pid}/exe").resolve(strict=True)
    if (
        str(executable) != record.get("executablePath")
        or runtime_root not in executable.parents
    ):
        raise RuntimeError("SearXNG executable identity mismatch")
    return True


@contextlib.contextmanager
def exclusive_lock(path: pathlib.Path):
    descriptor = os.open(
        path,
        os.O_RDWR | os.O_CREAT | os.O_CLOEXEC | os.O_NOFOLLOW,
        0o600,
    )
    try:
        status = os.fstat(descriptor)
        if (
            not stat.S_ISREG(status.st_mode)
            or status.st_uid != os.getuid()
            or status.st_mode & 0o077
        ):
            raise RuntimeError("invalid SearXNG lifecycle lock")
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        yield
    finally:
        os.close(descriptor)


def cleanup_record(
    connection_path: pathlib.Path,
    socket_path: pathlib.Path,
    settings_path: pathlib.Path,
    instance_token: str | None,
) -> None:
    record = read_record(connection_path)
    if (
        record is None
        or instance_token is None
        or record.get("instanceToken") == instance_token
    ):
        safe_remove_socket(socket_path)
        settings_path.unlink(missing_ok=True)
        if (
            record is None
            or instance_token is None
            or record.get("instanceToken") == instance_token
        ):
            connection_path.unlink(missing_ok=True)


def serve(args: argparse.Namespace) -> int:
    runtime_root = pathlib.Path(args.runtime_root).resolve(strict=True)
    manifest, eligible = verify_runtime(runtime_root)
    state_root, cache_root, connection_path, socket_path = validate_service_paths(
        pathlib.Path(args.state_dir),
        pathlib.Path(args.cache_dir),
        pathlib.Path(args.connection_file),
        pathlib.Path(args.socket),
    )
    settings_path = state_root / "settings.yml"
    instance_token = secrets.token_hex(32)
    stopped = threading.Event()
    child: subprocess.Popen[bytes] | None = None

    def request_stop(_signum: int, _frame: object) -> None:
        stopped.set()

    signal.signal(signal.SIGINT, request_stop)
    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGHUP, request_stop)
    if getattr(args, "detach_from_appimage", False):
        configure_parent_death_signal()
        parent_pid = int(os.environ["WILDBUZZARD_APPIMAGE_PARENT_PID"])
        if not pathlib.Path(f"/proc/{parent_pid}").exists():
            stopped.set()
    with exclusive_lock(state_root / "launch.lock"):
        if os.path.lexists(socket_path):
            raise RuntimeError("SearXNG socket already exists")
        atomic_text(settings_path, settings_text(instance_token, eligible))
        environment = runtime_environment(runtime_root, state_root, cache_root)
        environment["SEARXNG_SETTINGS_PATH"] = str(settings_path)
        command = [
            str(runtime_root / "python" / "bin" / "python3"),
            "-I",
            "-B",
            "-m",
            "granian",
            "--interface",
            "wsgi",
            "--uds",
            str(socket_path),
            "--uds-permissions",
            "0o600",
            "--no-ws",
            "--workers",
            "1",
            "--blocking-threads",
            "4",
            "searx.webapp:app",
        ]
        try:
            child = subprocess.Popen(
                command,
                cwd=runtime_root,
                env=environment,
                stdin=subprocess.DEVNULL,
                close_fds=True,
                start_new_session=True,
            )
            deadline = time.monotonic() + START_TIMEOUT_SECONDS
            while time.monotonic() < deadline and not stopped.is_set():
                if child.poll() is not None:
                    raise RuntimeError(
                        f"SearXNG exited during startup ({child.returncode})"
                    )
                try:
                    socket_status = os.stat(socket_path, follow_symlinks=False)
                except FileNotFoundError:
                    pass
                else:
                    if (
                        not stat.S_ISSOCK(socket_status.st_mode)
                        or socket_status.st_uid != os.getuid()
                        or stat.S_IMODE(socket_status.st_mode) != 0o600
                    ):
                        raise RuntimeError("invalid private SearXNG socket")
                    if health(socket_path):
                        atomic_json(
                            connection_path,
                            record_for(
                                runtime_root,
                                manifest,
                                socket_path,
                                settings_path,
                                instance_token,
                            ),
                        )
                        break
                time.sleep(0.1)
            else:
                if not stopped.is_set():
                    raise RuntimeError("SearXNG startup timed out")
            while not stopped.is_set():
                return_code = child.poll()
                if return_code is not None:
                    raise RuntimeError(f"SearXNG exited unexpectedly ({return_code})")
                time.sleep(0.2)
        finally:
            if child and child.poll() is None:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(child.pid, signal.SIGTERM)
                try:
                    child.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    with contextlib.suppress(ProcessLookupError):
                        os.killpg(child.pid, signal.SIGKILL)
                    child.wait(timeout=5)
            cleanup_record(connection_path, socket_path, settings_path, instance_token)
    return 0


def service_command(
    runtime_root: pathlib.Path,
    state_root: pathlib.Path,
    cache_root: pathlib.Path,
    connection_path: pathlib.Path,
    socket_path: pathlib.Path,
) -> list[str]:
    return [
        str(runtime_root / "python" / "bin" / "python3"),
        "-I",
        "-B",
        str(runtime_root / "libexec" / "searxng_executable.py"),
        "--runtime-root",
        str(runtime_root),
        "serve",
        "--state-dir",
        str(state_root),
        "--cache-dir",
        str(cache_root),
        "--connection-file",
        str(connection_path),
        "--socket",
        str(socket_path),
    ]


def prepare_controller(
    args: argparse.Namespace,
) -> tuple[pathlib.Path, pathlib.Path, pathlib.Path, pathlib.Path, pathlib.Path]:
    source_root = pathlib.Path(args.runtime_root).resolve(strict=True)
    runtime_root = install_runtime(source_root, pathlib.Path(args.install_dir))
    parent_pid = os.getppid()
    parent_start = process_start_time(parent_pid)
    cleanup_path = release_extracted_appimage(source_root)
    if cleanup_path is not None:
        reexec_installed(runtime_root, cleanup_path, parent_pid, parent_start)
    state_root, cache_root, connection_path, socket_path = validate_service_paths(
        pathlib.Path(args.state_dir),
        pathlib.Path(args.cache_dir),
        pathlib.Path(args.connection_file),
        pathlib.Path(args.socket),
    )
    return runtime_root, state_root, cache_root, connection_path, socket_path


def start(args: argparse.Namespace) -> int:
    runtime_root, state_root, cache_root, connection_path, socket_path = (
        prepare_controller(args)
    )
    with exclusive_lock(state_root / "control.lock"):
        record = read_record(connection_path)
        if record is not None:
            if validate_record(record, runtime_root, state_root) and health(
                socket_path
            ):
                print(json.dumps(record, sort_keys=True))
                return 0
            cleanup_record(
                connection_path, socket_path, state_root / "settings.yml", None
            )
        log_path = state_root / "service.log"
        descriptor = os.open(
            log_path,
            os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_CLOEXEC | os.O_NOFOLLOW,
            0o600,
        )
        command = service_command(
            runtime_root, state_root, cache_root, connection_path, socket_path
        )
        environment = runtime_environment(runtime_root, state_root, cache_root)
        try:
            process = subprocess.Popen(
                command,
                cwd=runtime_root,
                env=environment,
                stdin=subprocess.DEVNULL,
                stdout=descriptor,
                stderr=descriptor,
                close_fds=True,
                start_new_session=True,
            )
        finally:
            os.close(descriptor)
        deadline = time.monotonic() + START_TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError(
                    f"detached SearXNG startup failed ({process.returncode})"
                )
            record = read_record(connection_path)
            if (
                record is not None
                and validate_record(record, runtime_root, state_root)
                and health(socket_path)
            ):
                print(json.dumps(record, sort_keys=True))
                return 0
            time.sleep(0.1)
        with contextlib.suppress(ProcessLookupError):
            os.kill(process.pid, signal.SIGTERM)
        raise RuntimeError("detached SearXNG startup timed out")


def run(args: argparse.Namespace) -> int:
    runtime_root, state_root, cache_root, connection_path, socket_path = (
        prepare_controller(args)
    )
    args.runtime_root = str(runtime_root)
    args.state_dir = str(state_root)
    args.cache_dir = str(cache_root)
    args.connection_file = str(connection_path)
    args.socket = str(socket_path)
    args.detach_from_appimage = "WILDBUZZARD_APPIMAGE_CLEANUP" in os.environ
    try:
        return serve(args)
    finally:
        cleanup_extracted_link_after_parent()


def controller_paths(
    args: argparse.Namespace,
) -> tuple[pathlib.Path, pathlib.Path, pathlib.Path]:
    runtime_root = pathlib.Path(args.install_dir).resolve(strict=True)
    verify_runtime(runtime_root)
    state_root = private_directory(pathlib.Path(args.state_dir))
    connection_path = pathlib.Path(args.connection_file).absolute()
    if connection_path.parent.resolve(strict=True) != state_root:
        raise RuntimeError(
            "connection record must be inside the private state directory"
        )
    return runtime_root, state_root, connection_path


def status(args: argparse.Namespace) -> int:
    runtime_root, state_root, connection_path = controller_paths(args)
    record = read_record(connection_path)
    if record is None or not validate_record(record, runtime_root, state_root):
        return 3
    if not health(pathlib.Path(str(record["socketPath"]))):
        return 4
    print(json.dumps(record, sort_keys=True))
    return 0


def stop(args: argparse.Namespace) -> int:
    runtime_root, state_root, connection_path = controller_paths(args)
    with exclusive_lock(state_root / "control.lock"):
        record = read_record(connection_path)
        if record is None:
            return 0
        if not validate_record(record, runtime_root, state_root):
            cleanup_record(
                connection_path,
                pathlib.Path(str(record["socketPath"])),
                pathlib.Path(str(record["settingsPath"])),
                None,
            )
            return 0
        pid = int(record["pid"])
        os.kill(pid, signal.SIGTERM)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if not pathlib.Path(f"/proc/{pid}").exists():
                break
            time.sleep(0.1)
        else:
            os.kill(pid, signal.SIGKILL)
        deadline = time.monotonic() + 5
        while connection_path.exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        if connection_path.exists():
            cleanup_record(
                connection_path,
                pathlib.Path(str(record["socketPath"])),
                pathlib.Path(str(record["settingsPath"])),
                str(record["instanceToken"]),
            )
    return 0


def add_service_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--install-dir", required=True)
    parser.add_argument("--state-dir", required=True)
    parser.add_argument("--cache-dir", required=True)
    parser.add_argument("--connection-file", required=True)
    parser.add_argument("--socket", required=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime-root", required=True)
    commands = parser.add_subparsers(dest="command", required=True)
    install = commands.add_parser("install")
    install.add_argument("--install-dir", required=True)
    for name in ("start", "run"):
        add_service_arguments(commands.add_parser(name))
    for name in ("status", "stop"):
        command = commands.add_parser(name)
        command.add_argument("--install-dir", required=True)
        command.add_argument("--state-dir", required=True)
        command.add_argument("--connection-file", required=True)
    serve_parser = commands.add_parser("serve")
    serve_parser.add_argument("--state-dir", required=True)
    serve_parser.add_argument("--cache-dir", required=True)
    serve_parser.add_argument("--connection-file", required=True)
    serve_parser.add_argument("--socket", required=True)
    commands.add_parser("catalog")
    return parser.parse_args()


def main() -> int:
    os.umask(0o077)
    args = parse_args()
    if args.command == "install":
        source_root = pathlib.Path(args.runtime_root).resolve(strict=True)
        path = install_runtime(source_root, pathlib.Path(args.install_dir))
        release_extracted_appimage(source_root)
        print(path)
        return 0
    if args.command == "catalog":
        source_root = pathlib.Path(args.runtime_root).resolve(strict=True)
        _, eligible = verify_runtime(source_root)
        release_extracted_appimage(source_root)
        print(
            json.dumps(
                {
                    "eligibleEntries": len(eligible),
                    "eligibleModules": len({item["module"] for item in eligible}),
                },
                sort_keys=True,
            )
        )
        return 0
    if args.command in ("status", "stop"):
        source_root = pathlib.Path(args.runtime_root).resolve(strict=True)
        if extracted_app_dir(source_root) is not None:
            parent_pid = os.getppid()
            parent_start = process_start_time(parent_pid)
            runtime_root = pathlib.Path(args.install_dir).absolute()
            if not runtime_root.exists():
                release_extracted_appimage(source_root)
                return 3 if args.command == "status" else 0
            verify_runtime(runtime_root)
            cleanup_path = release_extracted_appimage(source_root)
            if cleanup_path is None:
                raise RuntimeError("missing extracted AppImage cleanup path")
            reexec_installed(
                runtime_root.resolve(strict=True),
                cleanup_path,
                parent_pid,
                parent_start,
            )
    return {"start": start, "run": run, "status": status, "stop": stop, "serve": serve}[
        args.command
    ](args)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, ValueError) as error:
        print(f"WildBuzzard SearXNG failed: {error}", file=sys.stderr)
        raise SystemExit(1)
