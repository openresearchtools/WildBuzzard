# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import argparse
import collections
import contextlib
import errno
import fcntl
import hashlib
import hmac
import http.client
import http.server
import json
import os
import pathlib
import re
import secrets
import select
import signal
import socket
import stat
import subprocess
import sys
import threading
import time
import urllib.parse

ADDRESS = "127.0.0.1"
COMPONENT = "searxng"
PROTOCOL_VERSION = 1
RUNTIME_VERSION = "2026.8.6+b023a28ba"
MAX_REQUEST_BYTES = 64 * 1024
MAX_RESPONSE_BYTES = 16 * 1024 * 1024
MAX_CONCURRENT_REQUESTS = 16
MAX_SEARCHES_PER_MINUTE = 120
MAX_CONNECTION_BYTES = 16 * 1024
START_TIMEOUT_SECONDS = 30
ACCEPTED_SOCKET_TIMEOUT_SECONDS = 5.0
REQUEST_SLOT_WAIT_SECONDS = 0.25
MAX_EPOCH_MILLISECONDS = 8_640_000_000_000_000
BACKEND_SOCKET_PARENT = pathlib.Path("/tmp")
MAX_UNIX_SOCKET_PATH_BYTES = 107
BACKEND_SOCKET_DIRECTORY_ATTEMPTS = 128
HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}
FORWARDED_REQUEST_HEADERS = {
    "accept",
    "accept-encoding",
    "accept-language",
    "content-type",
    "cookie",
    "user-agent",
}
ENGINE_NAME = re.compile(r"[a-z0-9][a-z0-9 ._-]{0,63}")
ENGINE_MODULE = re.compile(r"[a-z0-9][a-z0-9_]{0,63}")
OWNER_INSTANCE_ID = re.compile(r"[A-Za-z0-9._~-]{1,128}")
POLICY_FIELDS = {"name", "module", "requiresCredentials", "purpose"}
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


def epoch_milliseconds() -> int:
    return time.time_ns() // 1_000_000


def sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def ensure_private_directory(path: pathlib.Path) -> pathlib.Path:
    if path.is_symlink():
        raise RuntimeError(f"Refusing symlink directory: {path}")
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.chmod(0o700)
    resolved = path.resolve(strict=True)
    status = resolved.stat()
    if not stat.S_ISDIR(status.st_mode) or status.st_uid != os.getuid():
        raise RuntimeError(f"Invalid private directory: {path}")
    return resolved


def backend_socket_prefix(data_root_id: str, owner_instance_id: str) -> str:
    payload = f"{os.getuid()}\0{data_root_id}\0{owner_instance_id}".encode()
    identity = hashlib.sha256(payload).hexdigest()[:24]
    return f"wb-sx-{os.getuid()}-{identity}-"


def validate_backend_socket_directory(
    path: pathlib.Path, identity: tuple[int, int]
) -> os.stat_result:
    try:
        status = os.stat(path, follow_symlinks=False)
    except FileNotFoundError as error:
        raise RuntimeError("Private SearXNG socket directory is missing") from error
    if (
        not stat.S_ISDIR(status.st_mode)
        or status.st_uid != os.getuid()
        or stat.S_IMODE(status.st_mode) != 0o700
        or (status.st_dev, status.st_ino) != identity
    ):
        raise RuntimeError("Private SearXNG socket directory identity changed")
    return status


def create_backend_socket_path(
    data_root_id: str, owner_instance_id: str
) -> tuple[pathlib.Path, pathlib.Path, tuple[int, int]]:
    parent_status = os.stat(BACKEND_SOCKET_PARENT, follow_symlinks=False)
    if (
        not stat.S_ISDIR(parent_status.st_mode)
        or parent_status.st_uid not in (0, os.getuid())
        or (parent_status.st_mode & 0o022 and not parent_status.st_mode & stat.S_ISVTX)
    ):
        raise RuntimeError("Invalid SearXNG socket parent directory")
    prefix = backend_socket_prefix(data_root_id, owner_instance_id)
    for _ in range(BACKEND_SOCKET_DIRECTORY_ATTEMPTS):
        root = BACKEND_SOCKET_PARENT / f"{prefix}{secrets.token_hex(16)}"
        try:
            root.mkdir(mode=0o700)
        except FileExistsError:
            continue
        root.chmod(0o700)
        status = os.stat(root, follow_symlinks=False)
        identity = (status.st_dev, status.st_ino)
        validate_backend_socket_directory(root, identity)
        socket_path = root / "s"
        if len(os.fsencode(socket_path)) > MAX_UNIX_SOCKET_PATH_BYTES:
            root.rmdir()
            raise RuntimeError("Private SearXNG socket path is too long")
        return root, socket_path, identity
    raise RuntimeError("Cannot allocate a private SearXNG socket directory")


def remove_backend_socket_path(
    root: pathlib.Path,
    socket_path: pathlib.Path,
    identity: tuple[int, int],
) -> None:
    try:
        validate_backend_socket_directory(root, identity)
    except RuntimeError:
        if not os.path.lexists(root):
            return
        raise
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
            raise RuntimeError("Invalid private SearXNG backend socket")
        socket_path.unlink()
    try:
        root.rmdir()
    except OSError as error:
        raise RuntimeError("Private SearXNG socket directory is not empty") from error


def read_private_text(path: pathlib.Path, maximum: int) -> str:
    descriptor = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        status = os.fstat(descriptor)
        if (
            not stat.S_ISREG(status.st_mode)
            or status.st_uid != os.getuid()
            or status.st_mode & 0o077
            or status.st_size < 1
            or status.st_size > maximum
        ):
            raise RuntimeError(f"Invalid private file: {path}")
        with os.fdopen(descriptor, "r", encoding="utf-8") as stream:
            descriptor = -1
            try:
                return stream.read(maximum + 1)
            except UnicodeDecodeError as error:
                raise RuntimeError(f"Invalid private file: {path}") from error
    finally:
        if descriptor >= 0:
            os.close(descriptor)


def read_private_json(path: pathlib.Path) -> dict[str, object]:
    try:
        value = json.loads(read_private_text(path, MAX_CONNECTION_BYTES))
    except json.JSONDecodeError as error:
        raise RuntimeError("Invalid SearXNG connection record") from error
    if not isinstance(value, dict):
        raise RuntimeError("Invalid SearXNG connection record")
    return value


def read_or_create_secret(path: pathlib.Path, size: int = 32) -> str:
    try:
        value = read_private_text(path, 256).strip()
    except FileNotFoundError:
        value = secrets.token_hex(size)
        descriptor = os.open(
            path,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW,
            0o600,
        )
        with os.fdopen(descriptor, "w", encoding="ascii") as stream:
            stream.write(value + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        return value
    if not value or len(value) > 128:
        raise RuntimeError(f"Invalid secret file: {path}")
    return value


def atomic_json(path: pathlib.Path, value: dict[str, object]) -> None:
    atomic_text(path, json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n")


def atomic_text(path: pathlib.Path, value: str) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{secrets.token_hex(8)}")
    descriptor = os.open(
        temporary,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW,
        0o600,
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        path.chmod(0o600)
    finally:
        temporary.unlink(missing_ok=True)


def process_start_time(pid: int) -> str:
    value = pathlib.Path(f"/proc/{pid}/stat").read_text(encoding="ascii")
    fields = value[value.rfind(")") + 2 :].split()
    return fields[19]


def wait_for_process_exit(
    pid: int, start_time: str, pidfd: int | None, timeout: float
) -> bool:
    if pidfd is not None:
        poller = select.poll()
        poller.register(pidfd, select.POLLIN)
        return bool(poller.poll(round(timeout * 1000)))
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            if process_start_time(pid) != start_time:
                return True
        except FileNotFoundError:
            return True
        time.sleep(0.1)
    return False


def verify_runtime(runtime_root: pathlib.Path) -> dict[str, object]:
    manifest_path = runtime_root / "wildbuzzard-runtime.json"
    if manifest_path.is_symlink() or not manifest_path.is_file():
        raise RuntimeError("Invalid SearXNG runtime manifest")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if (
        manifest.get("component") != COMPONENT
        or manifest.get("runtimeVersion") != RUNTIME_VERSION
    ):
        raise RuntimeError("SearXNG runtime manifest identity mismatch")
    files = manifest.get("files")
    if not isinstance(files, list) or not files:
        raise RuntimeError("SearXNG runtime manifest has no file inventory")
    actual_files: set[str] = set()
    for path in runtime_root.rglob("*"):
        relative = path.relative_to(runtime_root).as_posix()
        if path.is_symlink():
            raise RuntimeError(f"Unexpected SearXNG runtime symlink: {relative}")
        if path.is_file() and path != manifest_path:
            actual_files.add(relative)
    seen: set[str] = set()
    for entry in files:
        if not isinstance(entry, dict):
            raise RuntimeError("Invalid SearXNG runtime file entry")
        relative = entry.get("path")
        expected = entry.get("sha256")
        if not isinstance(relative, str) or not isinstance(expected, str):
            raise RuntimeError("Invalid SearXNG runtime file identity")
        parts = pathlib.PurePosixPath(relative).parts
        if (
            not parts
            or relative.startswith("/")
            or any(part in ("", ".", "..") for part in parts)
        ):
            raise RuntimeError("Unsafe SearXNG runtime file path")
        if relative in seen:
            raise RuntimeError("Duplicate SearXNG runtime file path")
        seen.add(relative)
        target = runtime_root.joinpath(*parts)
        if not target.is_file():
            raise RuntimeError(f"Unexpected SearXNG runtime file type: {relative}")
        if sha256_file(target) != expected:
            raise RuntimeError(f"SearXNG runtime digest mismatch: {relative}")
    if seen != actual_files:
        raise RuntimeError("SearXNG runtime file inventory mismatch")
    return manifest


def runtime_identity(
    runtime_root: pathlib.Path,
) -> tuple[dict[str, object], pathlib.Path, str]:
    manifest = verify_runtime(runtime_root)
    executable_path = pathlib.Path(sys.executable).resolve(strict=True)
    executable_sha256 = sha256_file(executable_path)
    try:
        executable_relative = executable_path.relative_to(runtime_root).as_posix()
    except ValueError as error:
        raise RuntimeError("SearXNG executable is outside the runtime") from error
    executable_entries = [
        entry for entry in manifest["files"] if entry.get("path") == executable_relative
    ]
    if (
        len(executable_entries) != 1
        or executable_entries[0].get("sha256") != executable_sha256
    ):
        raise RuntimeError("SearXNG executable identity mismatch")
    return manifest, executable_path, executable_sha256


def validate_engine_policy(policy: object) -> list[dict[str, object]]:
    if not isinstance(policy, dict):
        raise RuntimeError("SearXNG engine policy must be an object")
    if (
        policy.get("schema") != 1
        or policy.get("searxngCommit") != "b023a28bab8839dba9eac96e9a51cc91bbd0a267"
    ):
        raise RuntimeError("SearXNG engine policy identity mismatch")
    if policy.get("safeSearch") != 1:
        raise RuntimeError("SearXNG engine policy must enforce safe search level 1")
    engines = policy.get("engines")
    if not isinstance(engines, list) or not engines or len(engines) > 32:
        raise RuntimeError("SearXNG engine policy has an invalid allowlist")
    names: set[str] = set()
    validated: list[dict[str, object]] = []
    for entry in engines:
        if not isinstance(entry, dict) or set(entry) != POLICY_FIELDS:
            raise RuntimeError("SearXNG engine policy entry has invalid fields")
        name = entry.get("name")
        module = entry.get("module")
        purpose = entry.get("purpose")
        if not isinstance(name, str) or not ENGINE_NAME.fullmatch(name):
            raise RuntimeError("SearXNG engine policy has an invalid engine name")
        if name in names:
            raise RuntimeError("SearXNG engine policy has a duplicate engine name")
        if not isinstance(module, str) or not ENGINE_MODULE.fullmatch(module):
            raise RuntimeError("SearXNG engine policy has an invalid engine module")
        if entry.get("requiresCredentials") is not False:
            raise RuntimeError("SearXNG engine policy may not require credentials")
        if not isinstance(purpose, str) or not purpose.strip() or len(purpose) > 256:
            raise RuntimeError("SearXNG engine policy has an invalid purpose")
        names.add(name)
        validated.append(entry)
    return validated


def settings_text(
    secret: str, public_port: int, engines: list[dict[str, object]]
) -> str:
    keep_only = "\n".join(f"      - {json.dumps(entry['name'])}" for entry in engines)
    enabled = "\n".join(
        f"  - name: {json.dumps(entry['name'])}\n"
        f"    engine: {json.dumps(entry['module'])}\n"
        "    disabled: false"
        for entry in engines
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
  base_url: http://127.0.0.1:{public_port}/
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
engines:
{enabled}
"""


def runtime_environment(
    runtime_root: pathlib.Path, data_root: pathlib.Path
) -> dict[str, str]:
    return {
        "HOME": str(ensure_private_directory(data_root / "home")),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "LD_LIBRARY_PATH": str(runtime_root / "python" / "lib"),
        "OPENSSL_MODULES": str(runtime_root / "python" / "lib"),
        "PATH": str(runtime_root / "python" / "bin"),
        "PYTHONHASHSEED": "0",
        "TZ": "UTC",
    }


class UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, socket_path: pathlib.Path, timeout: float = 5.0):
        super().__init__("localhost", timeout=timeout)
        self.socket_path = socket_path

    def connect(self) -> None:
        connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.settimeout(self.timeout)
        connection.connect(str(self.socket_path))
        self.sock = connection


class Gateway(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, service: SearXNGService):
        self.service = service
        self.request_slots = threading.BoundedSemaphore(MAX_CONCURRENT_REQUESTS)
        super().__init__((ADDRESS, 0), GatewayHandler, bind_and_activate=True)

    def process_request(
        self, request: socket.socket, client_address: tuple[str, int]
    ) -> None:
        request.settimeout(ACCEPTED_SOCKET_TIMEOUT_SECONDS)
        if not self.request_slots.acquire(timeout=REQUEST_SLOT_WAIT_SECONDS):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.request_slots.release()
            raise

    def process_request_thread(
        self, request: socket.socket, client_address: tuple[str, int]
    ) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.request_slots.release()


class GatewayHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "WildBuzzard"
    sys_version = ""

    @property
    def service(self) -> SearXNGService:
        return self.server.service  # type: ignore[attr-defined, no-any-return]

    def log_message(self, format: str, *args: object) -> None:
        return

    def do_GET(self) -> None:
        self._handle()

    def do_HEAD(self) -> None:
        self._handle()

    def do_POST(self) -> None:
        self._handle()

    def _send_json(self, status: int, value: dict[str, object]) -> None:
        body = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)
        except OSError:
            self.close_connection = True

    def _client_disconnected(self) -> bool:
        try:
            readable, _, _ = select.select([self.connection], [], [], 0)
            return bool(
                readable
                and self.connection.recv(1, socket.MSG_PEEK | socket.MSG_DONTWAIT)
                == b""
            )
        except (OSError, ValueError):
            return True

    def _wait_for_backend(self, backend: socket.socket, deadline: float) -> bool:
        while True:
            if self._client_disconnected():
                self.close_connection = True
                return False
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("SearXNG backend response timed out")
            readable, _, _ = select.select([backend], [], [], min(remaining, 0.1))
            if readable:
                return True

    def _authorized(self) -> bool:
        header = self.headers.get("Authorization", "")
        prefix = "Bearer "
        return header.startswith(prefix) and hmac.compare_digest(
            header[len(prefix) :], self.service.token
        )

    def _valid_boundary(self, authorized: bool) -> bool:
        expected_host = f"{ADDRESS}:{self.service.port}"
        if not hmac.compare_digest(self.headers.get("Host", ""), expected_host):
            return False
        origin = self.headers.get("Origin")
        if origin and origin != f"http://{expected_host}":
            return False
        fetch_site = self.headers.get("Sec-Fetch-Site", "")
        if not authorized and fetch_site not in ("", "none", "same-origin"):
            return False
        return True

    def _requires_capability(
        self, parsed: urllib.parse.SplitResult, body: bytes
    ) -> bool:
        protected_roots = ("/config", "/stats", "/metrics")
        if parsed.path.startswith("/v1/") or any(
            parsed.path == root or parsed.path.startswith(f"{root}/")
            for root in protected_roots
        ):
            return True
        parameters = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
        if (
            self.command == "POST"
            and self.headers.get_content_type() == "application/x-www-form-urlencoded"
        ):
            parameters.update(
                urllib.parse.parse_qs(
                    body.decode("utf-8", "replace"), keep_blank_values=True
                )
            )
        formats = parameters.get("format", [])
        return any(value != "html" for value in formats)

    def _handle(self) -> None:
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.scheme or parsed.netloc or not parsed.path.startswith("/"):
            self._send_json(400, {"error": "invalid-request-target"})
            return
        length_text = self.headers.get("Content-Length", "0")
        try:
            length = int(length_text)
        except ValueError:
            length = MAX_REQUEST_BYTES + 1
        if length < 0 or length > MAX_REQUEST_BYTES:
            self._send_json(413, {"error": "request-too-large"})
            return
        body = self.rfile.read(length) if length else b""
        authorized = self._authorized()
        if not self._valid_boundary(authorized):
            self._send_json(403, {"error": "forbidden"})
            return
        if parsed.path == "/v1/identity":
            if not authorized:
                self._send_json(401, {"error": "capability-required"})
                return
            self._send_json(200, self.service.public_identity())
            return
        if parsed.path == "/v1/health":
            if not authorized:
                self._send_json(401, {"error": "capability-required"})
                return
            healthy = self.service.backend_healthy()
            if healthy:
                self.service.mark_healthy()
            self._send_json(
                200 if healthy else 503,
                {"ok": healthy, **self.service.public_identity()},
            )
            return
        if parsed.path == "/metrics":
            self._send_json(404, {"error": "not-found"})
            return
        if self._requires_capability(parsed, body) and not authorized:
            self._send_json(401, {"error": "capability-required"})
            return
        if parsed.path == "/search" and not self.service.allow_search():
            self.send_response(429)
            self.send_header("Content-Length", "0")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Retry-After", "60")
            self.end_headers()
            return
        self._proxy(body)

    def _proxy(self, body: bytes) -> None:
        if self._client_disconnected():
            self.close_connection = True
            return
        headers = {
            name: value
            for name, value in self.headers.items()
            if name.lower() in FORWARDED_REQUEST_HEADERS
        }
        headers["Host"] = "localhost"
        headers["X-Forwarded-For"] = ADDRESS
        connection = UnixHTTPConnection(self.service.backend_socket, timeout=30.0)
        upstream: tuple[int, list[tuple[str, str]], bytes] | None = None
        failure: dict[str, object] | None = None
        try:
            connection.request(
                self.command, self.path, body=body or None, headers=headers
            )
            if connection.sock is None:
                raise RuntimeError("SearXNG backend socket is unavailable")
            deadline = time.monotonic() + 30.0
            if not self._wait_for_backend(connection.sock, deadline):
                return
            response = connection.getresponse()
            declared = response.getheader("Content-Length")
            expected_length = int(declared) if declared is not None else None
            if expected_length is not None and (
                expected_length < 0 or expected_length > MAX_RESPONSE_BYTES
            ):
                failure = {"error": "upstream-response-too-large"}
            else:
                payload = response.read(MAX_RESPONSE_BYTES + 1)
                if len(payload) > MAX_RESPONSE_BYTES:
                    failure = {"error": "upstream-response-too-large"}
                else:
                    upstream = (
                        response.status,
                        list(response.getheaders()),
                        payload,
                    )
        except (OSError, http.client.HTTPException, RuntimeError, ValueError):
            failure = {"error": "upstream-unavailable"}
        finally:
            connection.close()
        if failure is not None:
            self._send_json(502, failure)
            return
        if upstream is None:
            return
        status, response_headers, payload = upstream
        try:
            self.send_response(status)
            for name, value in response_headers:
                lowered = name.lower()
                if (
                    lowered in HOP_HEADERS
                    or lowered == "content-length"
                    or lowered.startswith("access-control-")
                ):
                    continue
                self.send_header(name, value)
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(payload)
        except OSError:
            self.close_connection = True


class SearXNGService:
    def __init__(self, args: argparse.Namespace):
        os.umask(0o077)
        self.runtime_root = pathlib.Path(args.runtime_root).resolve(strict=True)
        self.data_root = ensure_private_directory(pathlib.Path(args.data_root))
        self.cache_root = ensure_private_directory(pathlib.Path(args.cache_root))
        self.state_root = ensure_private_directory(pathlib.Path(args.runtime_dir))
        self.connection_path = pathlib.Path(args.connection_file)
        if self.connection_path.parent.resolve(strict=True) != self.state_root:
            raise RuntimeError(
                "Connection record must be inside the private runtime directory"
            )
        if not OWNER_INSTANCE_ID.fullmatch(args.owner_instance_id):
            raise RuntimeError("Invalid SearXNG owner instance identity")
        self.owner_instance_id = args.owner_instance_id
        self.backend_socket_root: pathlib.Path | None = None
        self.backend_socket: pathlib.Path | None = None
        self.backend_socket_directory_identity: tuple[int, int] | None = None
        self.settings_path = self.state_root / "settings.yml"
        self.lock_descriptor: int | None = None
        self.backend: subprocess.Popen[bytes] | None = None
        self.gateway: Gateway | None = None
        self.port = 0
        self.token = secrets.token_urlsafe(32)
        self.created_at = epoch_milliseconds()
        self.last_health_at = 0
        self.stopping = threading.Event()
        self.record_lock = threading.Lock()
        self.search_lock = threading.Lock()
        self.search_times: collections.deque[float] = collections.deque()
        (
            self.manifest,
            self.executable_path,
            self.executable_sha256,
        ) = runtime_identity(self.runtime_root)
        self.start_time = process_start_time(os.getpid())
        self.data_root_id = read_or_create_secret(self.data_root / "data-root-id", 16)
        self.secret = read_or_create_secret(self.data_root / "secret-key")
        policy_path = (
            self.runtime_root
            / "share"
            / "wildbuzzard"
            / "searxng"
            / "engine-policy.json"
        )
        policy = json.loads(policy_path.read_text(encoding="utf-8"))
        if sha256_file(policy_path) != self.manifest.get("providerPolicySha256"):
            raise RuntimeError("SearXNG engine policy digest mismatch")
        self.engines = validate_engine_policy(policy)

    def allocate_backend_socket(self) -> None:
        if (
            self.backend_socket_root is not None
            or self.backend_socket is not None
            or self.backend_socket_directory_identity is not None
        ):
            raise RuntimeError("Private SearXNG backend socket is already allocated")
        (
            self.backend_socket_root,
            self.backend_socket,
            self.backend_socket_directory_identity,
        ) = create_backend_socket_path(self.data_root_id, self.owner_instance_id)

    def release_backend_socket(self) -> None:
        if (
            self.backend_socket_root is None
            or self.backend_socket is None
            or self.backend_socket_directory_identity is None
        ):
            if not (
                self.backend_socket_root is None
                and self.backend_socket is None
                and self.backend_socket_directory_identity is None
            ):
                raise RuntimeError("Private SearXNG backend socket state is incomplete")
            return
        remove_backend_socket_path(
            self.backend_socket_root,
            self.backend_socket,
            self.backend_socket_directory_identity,
        )
        self.backend_socket_root = None
        self.backend_socket = None
        self.backend_socket_directory_identity = None

    def acquire_lock(self) -> None:
        lock_path = self.state_root / "launch.lock"
        descriptor = os.open(
            lock_path,
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
                raise RuntimeError("Invalid SearXNG launch lock")
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(descriptor)
            raise RuntimeError("A managed SearXNG owner already holds the launch lock")
        except Exception:
            os.close(descriptor)
            raise
        self.lock_descriptor = descriptor

    def connection_record(self) -> dict[str, object]:
        return {
            "version": 1,
            "protocolVersion": PROTOCOL_VERSION,
            "runtimeVersion": RUNTIME_VERSION,
            "address": ADDRESS,
            "port": self.port,
            "token": self.token,
            "pid": os.getpid(),
            "processStartTime": self.start_time,
            "executablePath": str(self.executable_path),
            "executableSha256": self.executable_sha256,
            "dataRootId": self.data_root_id,
            "ownerInstanceId": self.owner_instance_id,
            "createdAt": self.created_at,
            "lastHealthAt": self.last_health_at,
        }

    def public_identity(self) -> dict[str, object]:
        return {
            "component": COMPONENT,
            "protocolVersion": PROTOCOL_VERSION,
            "runtimeVersion": RUNTIME_VERSION,
            "pid": os.getpid(),
            "processStartTime": self.start_time,
            "executableSha256": self.executable_sha256,
            "dataRootId": self.data_root_id,
            "ownerInstanceId": self.owner_instance_id,
        }

    def write_record(self) -> None:
        with self.record_lock:
            atomic_json(self.connection_path, self.connection_record())

    def allow_search(self) -> bool:
        now = time.monotonic()
        cutoff = now - 60
        with self.search_lock:
            while self.search_times and self.search_times[0] <= cutoff:
                self.search_times.popleft()
            if len(self.search_times) >= MAX_SEARCHES_PER_MINUTE:
                return False
            self.search_times.append(now)
            return True

    def mark_healthy(self) -> None:
        self.last_health_at = epoch_milliseconds()
        self.write_record()

    def backend_healthy(self) -> bool:
        if (
            not self.backend
            or self.backend.poll() is not None
            or self.backend_socket_root is None
            or self.backend_socket is None
            or self.backend_socket_directory_identity is None
        ):
            return False
        validate_backend_socket_directory(
            self.backend_socket_root, self.backend_socket_directory_identity
        )
        try:
            socket_status = os.stat(self.backend_socket, follow_symlinks=False)
        except FileNotFoundError:
            return False
        if (
            not stat.S_ISSOCK(socket_status.st_mode)
            or socket_status.st_uid != os.getuid()
            or stat.S_IMODE(socket_status.st_mode) != 0o600
        ):
            raise RuntimeError("Invalid private SearXNG backend socket")
        connection = UnixHTTPConnection(self.backend_socket, timeout=1.0)
        try:
            connection.request("GET", "/healthz", headers={"Host": "localhost"})
            response = connection.getresponse()
            return response.status == 200 and response.read(16) == b"OK"
        except (OSError, http.client.HTTPException):
            return False
        finally:
            connection.close()

    def start(self) -> None:
        self.acquire_lock()
        self.allocate_backend_socket()
        self.gateway = Gateway(self)
        self.port = self.gateway.server_address[1]
        atomic_text(
            self.settings_path, settings_text(self.secret, self.port, self.engines)
        )
        environment = {
            **runtime_environment(self.runtime_root, self.data_root),
            "SEARXNG_SETTINGS_PATH": str(self.settings_path),
            "TMPDIR": str(self.cache_root),
        }
        command = [
            str(self.runtime_root / "python" / "bin" / "python3"),
            "-I",
            "-B",
            "-m",
            "granian",
            "--interface",
            "wsgi",
            "--uds",
            str(self.backend_socket),
            "--uds-permissions",
            "0o600",
            "--no-ws",
            "--workers",
            "1",
            "--blocking-threads",
            "4",
            "searx.webapp:app",
        ]
        self.backend = subprocess.Popen(
            command,
            cwd=self.runtime_root,
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
            start_new_session=True,
        )
        for _ in range(300):
            if self.stopping.is_set():
                raise RuntimeError("SearXNG startup interrupted")
            if self.backend_healthy():
                self.mark_healthy()
                return
            if self.backend.poll() is not None:
                raise RuntimeError(
                    f"SearXNG exited during startup ({self.backend.returncode})"
                )
            time.sleep(0.1)
        raise RuntimeError("SearXNG health readiness timed out")

    def serve(self) -> None:
        if not self.gateway:
            raise RuntimeError("SearXNG gateway is not initialized")
        self.gateway.timeout = 0.5
        next_health = time.monotonic() + 30
        while not self.stopping.is_set():
            self.gateway.handle_request()
            if self.backend and self.backend.poll() is not None:
                raise RuntimeError(
                    f"SearXNG exited unexpectedly ({self.backend.returncode})"
                )
            if time.monotonic() >= next_health:
                if self.backend_healthy():
                    self.mark_healthy()
                next_health = time.monotonic() + 30

    def stop(self) -> None:
        self.stopping.set()
        if self.gateway:
            self.gateway.server_close()
        if self.backend and self.backend.poll() is None:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(self.backend.pid, signal.SIGTERM)
            try:
                self.backend.wait(timeout=10)
            except subprocess.TimeoutExpired:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(self.backend.pid, signal.SIGKILL)
                self.backend.wait(timeout=5)
        try:
            record = read_private_json(self.connection_path)
        except (FileNotFoundError, RuntimeError, OSError):
            record = {}
        if record.get("pid") == os.getpid() and hmac.compare_digest(
            str(record.get("token", "")), self.token
        ):
            self.connection_path.unlink(missing_ok=True)
        self.settings_path.unlink(missing_ok=True)
        if self.lock_descriptor is not None:
            os.close(self.lock_descriptor)
            self.lock_descriptor = None
        self.release_backend_socket()


class ServiceNotRunning(RuntimeError):
    pass


@contextlib.contextmanager
def exclusive_lock(path: pathlib.Path, *, blocking: bool = True):
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
            raise RuntimeError("Invalid SearXNG lifecycle lock")
        operation = fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB)
        fcntl.flock(descriptor, operation)
        yield
    finally:
        os.close(descriptor)


class SearXNGController:
    def __init__(self, args: argparse.Namespace):
        os.umask(0o077)
        if not OWNER_INSTANCE_ID.fullmatch(args.owner_instance_id):
            raise RuntimeError("Invalid SearXNG owner instance identity")
        self.runtime_root = pathlib.Path(args.runtime_root).resolve(strict=True)
        self.data_root = ensure_private_directory(pathlib.Path(args.data_root))
        self.cache_root = ensure_private_directory(pathlib.Path(args.cache_root))
        self.state_root = ensure_private_directory(pathlib.Path(args.runtime_dir))
        self.connection_path = pathlib.Path(args.connection_file)
        if self.connection_path.parent.resolve(strict=True) != self.state_root:
            raise RuntimeError(
                "Connection record must be inside the private runtime directory"
            )
        self.owner_instance_id = args.owner_instance_id
        (
            self.manifest,
            self.executable_path,
            self.executable_sha256,
        ) = runtime_identity(self.runtime_root)
        self.control_lock_path = self.state_root / "control.lock"
        self.launch_lock_path = self.state_root / "launch.lock"

    def read_record(self) -> dict[str, object] | None:
        try:
            return read_private_json(self.connection_path)
        except FileNotFoundError:
            return None

    def data_root_id(self) -> str:
        try:
            value = read_private_text(self.data_root / "data-root-id", 256).strip()
        except FileNotFoundError as error:
            raise RuntimeError("SearXNG data identity is missing") from error
        if not value or len(value) > 128:
            raise RuntimeError("SearXNG data identity is invalid")
        return value

    def validate_record(self, record: dict[str, object]) -> dict[str, object]:
        if set(record) != CONNECTION_FIELDS:
            raise RuntimeError("SearXNG connection identity mismatch")
        pid = record.get("pid")
        port = record.get("port")
        token = record.get("token")
        process_time = record.get("processStartTime")
        created_at = record.get("createdAt")
        last_health_at = record.get("lastHealthAt")
        if (
            record.get("version") != 1
            or record.get("protocolVersion") != PROTOCOL_VERSION
            or record.get("runtimeVersion") != RUNTIME_VERSION
            or record.get("address") != ADDRESS
            or not isinstance(port, int)
            or isinstance(port, bool)
            or port < 1024
            or port > 65535
            or not isinstance(token, str)
            or not re.fullmatch(r"[A-Za-z0-9_-]{32,512}", token)
            or not isinstance(pid, int)
            or isinstance(pid, bool)
            or pid < 1
            or not isinstance(process_time, str)
            or not process_time.isdecimal()
            or record.get("executablePath") != str(self.executable_path)
            or not hmac.compare_digest(
                str(record.get("executableSha256", "")), self.executable_sha256
            )
            or not hmac.compare_digest(
                str(record.get("dataRootId", "")), self.data_root_id()
            )
            or not hmac.compare_digest(
                str(record.get("ownerInstanceId", "")), self.owner_instance_id
            )
            or not isinstance(created_at, int)
            or isinstance(created_at, bool)
            or created_at <= 0
            or created_at > MAX_EPOCH_MILLISECONDS
            or not isinstance(last_health_at, int)
            or isinstance(last_health_at, bool)
            or last_health_at > MAX_EPOCH_MILLISECONDS
            or last_health_at < created_at
        ):
            raise RuntimeError("SearXNG connection identity mismatch")
        process_root = pathlib.Path(f"/proc/{pid}")
        try:
            process_status = process_root.stat()
            actual_start_time = process_start_time(pid)
        except (FileNotFoundError, ProcessLookupError):
            raise ServiceNotRunning("SearXNG process is not running") from None
        if actual_start_time != process_time:
            raise ServiceNotRunning("SearXNG process identity is stale")
        if process_status.st_uid != os.getuid():
            raise RuntimeError("SearXNG process owner mismatch")
        try:
            actual_executable = (process_root / "exe").resolve(strict=True)
        except FileNotFoundError:
            raise ServiceNotRunning("SearXNG process is not running") from None
        if actual_executable != self.executable_path:
            raise RuntimeError("SearXNG process executable mismatch")
        return record

    def request_identity(
        self, record: dict[str, object], path: str
    ) -> dict[str, object]:
        connection = http.client.HTTPConnection(ADDRESS, int(record["port"]), timeout=2)
        try:
            connection.request(
                "GET",
                path,
                headers={
                    "Authorization": f"Bearer {record['token']}",
                    "Cache-Control": "no-store",
                    "Sec-Fetch-Site": "none",
                },
            )
            response = connection.getresponse()
            payload = response.read(MAX_CONNECTION_BYTES + 1)
            if response.status != 200 or len(payload) > MAX_CONNECTION_BYTES:
                raise RuntimeError("SearXNG authenticated health check failed")
            value = json.loads(payload)
        except (OSError, http.client.HTTPException, json.JSONDecodeError) as error:
            raise RuntimeError("SearXNG authenticated health check failed") from error
        finally:
            connection.close()
        if not isinstance(value, dict):
            raise RuntimeError("SearXNG authenticated identity is invalid")
        expected = {
            "component": COMPONENT,
            "protocolVersion": PROTOCOL_VERSION,
            "runtimeVersion": RUNTIME_VERSION,
            "pid": record["pid"],
            "processStartTime": record["processStartTime"],
            "executableSha256": record["executableSha256"],
            "dataRootId": record["dataRootId"],
            "ownerInstanceId": record["ownerInstanceId"],
        }
        if any(
            value.get(key) != expected_value for key, expected_value in expected.items()
        ):
            raise RuntimeError("SearXNG authenticated identity mismatch")
        if path == "/v1/health" and value.get("ok") is not True:
            raise RuntimeError("SearXNG authenticated health check failed")
        return value

    def remove_stale_record(self, record: dict[str, object]) -> None:
        current = self.read_record()
        if current is None:
            return
        fields = ("pid", "processStartTime", "token")
        if all(current.get(field) == record.get(field) for field in fields):
            self.connection_path.unlink(missing_ok=True)

    def launch_lock_available(self) -> bool:
        try:
            with exclusive_lock(self.launch_lock_path, blocking=False):
                return True
        except BlockingIOError:
            return False

    def daemon_environment(self) -> dict[str, str]:
        return runtime_environment(self.runtime_root, self.data_root)

    def daemon_command(self) -> list[str]:
        return [
            str(self.executable_path),
            "-I",
            "-B",
            str(pathlib.Path(__file__).resolve(strict=True)),
            "--runtime-root",
            str(self.runtime_root),
            "serve",
            "--data-root",
            str(self.data_root),
            "--cache-root",
            str(self.cache_root),
            "--runtime-dir",
            str(self.state_root),
            "--connection-file",
            str(self.connection_path),
            "--owner-instance-id",
            self.owner_instance_id,
        ]

    def _start(self) -> dict[str, object]:
        record = self.read_record()
        if record is not None:
            try:
                self.validate_record(record)
            except ServiceNotRunning:
                self.remove_stale_record(record)
            else:
                self.request_identity(record, "/v1/health")
                return record
        if not self.launch_lock_available():
            raise RuntimeError("A managed SearXNG launch is already in progress")
        process = subprocess.Popen(
            self.daemon_command(),
            cwd=self.runtime_root,
            env=self.daemon_environment(),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
            start_new_session=True,
        )
        deadline = time.monotonic() + START_TIMEOUT_SECONDS
        try:
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise RuntimeError(
                        f"SearXNG detached startup failed ({process.returncode})"
                    )
                record = self.read_record()
                if record is not None:
                    self.validate_record(record)
                    self.request_identity(record, "/v1/health")
                    return record
                time.sleep(0.1)
            raise RuntimeError("SearXNG detached startup timed out")
        except Exception:
            if process.poll() is None:
                with contextlib.suppress(ProcessLookupError):
                    os.kill(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    with contextlib.suppress(ProcessLookupError):
                        os.kill(process.pid, signal.SIGKILL)
                    process.wait(timeout=5)
            raise

    def start(self) -> dict[str, object]:
        with exclusive_lock(self.control_lock_path):
            return self._start()

    def open_pidfd(self, pid: int) -> int | None:
        pidfd_open = getattr(os, "pidfd_open", None)
        pidfd_send_signal = getattr(signal, "pidfd_send_signal", None)
        if pidfd_open is None or pidfd_send_signal is None:
            return None
        try:
            return pidfd_open(pid, 0)
        except OSError as error:
            if error.errno in (errno.EINVAL, errno.ENOSYS):
                return None
            raise

    def signal_record_process(
        self, record: dict[str, object], pidfd: int | None, signum: int
    ) -> None:
        self.validate_record(record)
        if pidfd is None:
            os.kill(int(record["pid"]), signum)
            return
        pidfd_send_signal = getattr(signal, "pidfd_send_signal", None)
        if pidfd_send_signal is None:
            raise RuntimeError("SearXNG pidfd signaling is unavailable")
        pidfd_send_signal(pidfd, signum, None, 0)

    def _stop(self) -> dict[str, object] | None:
        record = self.read_record()
        if record is None:
            return None
        try:
            self.validate_record(record)
        except ServiceNotRunning:
            self.remove_stale_record(record)
            return None
        self.request_identity(record, "/v1/identity")
        pid = int(record["pid"])
        start_time = str(record["processStartTime"])
        pidfd: int | None = None
        try:
            try:
                pidfd = self.open_pidfd(pid)
                self.signal_record_process(record, pidfd, signal.SIGTERM)
            except (ProcessLookupError, ServiceNotRunning):
                self.remove_stale_record(record)
                return record
            if not wait_for_process_exit(pid, start_time, pidfd, 10):
                try:
                    self.signal_record_process(record, pidfd, signal.SIGKILL)
                except (ProcessLookupError, ServiceNotRunning):
                    self.remove_stale_record(record)
                    return record
                if not wait_for_process_exit(pid, start_time, pidfd, 5):
                    raise RuntimeError("SearXNG process did not stop")
        finally:
            if pidfd is not None:
                os.close(pidfd)
        self.remove_stale_record(record)
        return record

    def stop(self) -> dict[str, object] | None:
        with exclusive_lock(self.control_lock_path):
            return self._stop()

    def restart(self) -> dict[str, object]:
        with exclusive_lock(self.control_lock_path):
            self._stop()
            return self._start()

    def status(self) -> dict[str, object] | None:
        with exclusive_lock(self.control_lock_path):
            record = self.read_record()
            if record is None:
                return None
            try:
                self.validate_record(record)
            except ServiceNotRunning:
                self.remove_stale_record(record)
                return None
            self.request_identity(record, "/v1/health")
            return record


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime-root", required=True)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("start", "status", "stop", "restart", "serve"):
        command = commands.add_parser(name)
        command.add_argument("--data-root", required=True)
        command.add_argument("--cache-root", required=True)
        command.add_argument("--runtime-dir", required=True)
        command.add_argument("--connection-file", required=True)
        command.add_argument("--owner-instance-id", required=True)
    return parser.parse_args()


def lifecycle_status(record: dict[str, object] | None) -> dict[str, object]:
    if record is None:
        return {"component": COMPONENT, "running": False}
    return {
        "component": COMPONENT,
        "running": True,
        "pid": record["pid"],
        "processStartTime": record["processStartTime"],
        "protocolVersion": record["protocolVersion"],
        "runtimeVersion": record["runtimeVersion"],
    }


def run_service(args: argparse.Namespace) -> int:
    service = SearXNGService(args)

    def request_stop(_signum: int, _frame: object) -> None:
        service.stopping.set()

    signal.signal(signal.SIGINT, request_stop)
    signal.signal(signal.SIGTERM, request_stop)
    try:
        service.start()
        service.serve()
        return 0
    finally:
        service.stop()


def main() -> int:
    args = parse_args()
    try:
        if args.command == "serve":
            return run_service(args)
        controller = SearXNGController(args)
        if args.command == "start":
            record = controller.start()
        elif args.command == "status":
            record = controller.status()
            print(json.dumps(lifecycle_status(record), sort_keys=True))
            return 0 if record is not None else 3
        elif args.command == "stop":
            controller.stop()
            record = None
        elif args.command == "restart":
            record = controller.restart()
        else:
            raise RuntimeError("Unsupported SearXNG lifecycle command")
        print(json.dumps(lifecycle_status(record), sort_keys=True))
        return 0
    except RuntimeError as error:
        print(f"SearXNG {args.command} failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
