# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import argparse
import collections
import contextlib
import datetime
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
import signal
import socket
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
POLICY_FIELDS = {"name", "module", "requiresCredentials", "purpose"}


def utc_now() -> str:
    return (
        datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    )


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
    return path.resolve(strict=True)


def read_or_create_secret(path: pathlib.Path, size: int = 32) -> str:
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
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
    with os.fdopen(descriptor, "r", encoding="ascii") as stream:
        value = stream.read(256).strip()
    if not value or len(value) > 128:
        raise RuntimeError(f"Invalid secret file: {path}")
    path.chmod(0o600)
    return value


def atomic_json(path: pathlib.Path, value: dict[str, object]) -> None:
    atomic_text(
        path, json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n"
    )


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
engines:
{enabled}
"""


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
        self.request_slots.acquire()
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
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

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
        headers = {
            name: value
            for name, value in self.headers.items()
            if name.lower() in FORWARDED_REQUEST_HEADERS
        }
        headers["Host"] = "localhost"
        headers["X-Forwarded-For"] = ADDRESS
        connection = UnixHTTPConnection(self.service.backend_socket, timeout=30.0)
        try:
            connection.request(
                self.command, self.path, body=body or None, headers=headers
            )
            response = connection.getresponse()
            declared = response.getheader("Content-Length")
            if declared is not None and int(declared) > MAX_RESPONSE_BYTES:
                self._send_json(502, {"error": "upstream-response-too-large"})
                return
            payload = response.read(MAX_RESPONSE_BYTES + 1)
            if len(payload) > MAX_RESPONSE_BYTES:
                self._send_json(502, {"error": "upstream-response-too-large"})
                return
            self.send_response(response.status)
            for name, value in response.getheaders():
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
        except (OSError, http.client.HTTPException, ValueError):
            self._send_json(502, {"error": "upstream-unavailable"})
        finally:
            connection.close()


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
        self.owner_instance_id = args.owner_instance_id
        self.backend_socket = self.state_root / "searxng.sock"
        self.settings_path = self.state_root / "settings.yml"
        self.lock_descriptor: int | None = None
        self.backend: subprocess.Popen[bytes] | None = None
        self.gateway: Gateway | None = None
        self.port = 0
        self.token = secrets.token_urlsafe(32)
        self.created_at = utc_now()
        self.last_health_at = ""
        self.stopping = threading.Event()
        self.record_lock = threading.Lock()
        self.search_lock = threading.Lock()
        self.search_times: collections.deque[float] = collections.deque()
        self.manifest = verify_runtime(self.runtime_root)
        self.executable_path = pathlib.Path(sys.executable).resolve(strict=True)
        self.executable_sha256 = sha256_file(self.executable_path)
        try:
            executable_relative = self.executable_path.relative_to(
                self.runtime_root
            ).as_posix()
        except ValueError as error:
            raise RuntimeError("SearXNG executable is outside the runtime") from error
        executable_entries = [
            entry
            for entry in self.manifest["files"]
            if entry.get("path") == executable_relative
        ]
        if (
            len(executable_entries) != 1
            or executable_entries[0].get("sha256") != self.executable_sha256
        ):
            raise RuntimeError("SearXNG executable identity mismatch")
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

    def acquire_lock(self) -> None:
        lock_path = self.state_root / "launch.lock"
        descriptor = os.open(
            lock_path,
            os.O_RDWR | os.O_CREAT | os.O_CLOEXEC | os.O_NOFOLLOW,
            0o600,
        )
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(descriptor)
            raise RuntimeError("A managed SearXNG owner already holds the launch lock")
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
        self.last_health_at = utc_now()
        self.write_record()

    def backend_healthy(self) -> bool:
        if (
            not self.backend
            or self.backend.poll() is not None
            or not self.backend_socket.exists()
        ):
            return False
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
        self.backend_socket.unlink(missing_ok=True)
        self.gateway = Gateway(self)
        self.port = self.gateway.server_address[1]
        atomic_text(
            self.settings_path, settings_text(self.secret, self.port, self.engines)
        )
        environment = {
            "HOME": str(ensure_private_directory(self.data_root / "home")),
            "LANG": "C.UTF-8",
            "LD_LIBRARY_PATH": str(self.runtime_root / "python" / "lib"),
            "LC_ALL": "C.UTF-8",
            "PATH": str(self.runtime_root / "python" / "bin"),
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
            record = json.loads(self.connection_path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            record = {}
        if record.get("pid") == os.getpid() and hmac.compare_digest(
            str(record.get("token", "")), self.token
        ):
            self.connection_path.unlink(missing_ok=True)
        self.backend_socket.unlink(missing_ok=True)
        self.settings_path.unlink(missing_ok=True)
        if self.lock_descriptor is not None:
            os.close(self.lock_descriptor)
            self.lock_descriptor = None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime-root", required=True)
    parser.add_argument("--data-root", required=True)
    parser.add_argument("--cache-root", required=True)
    parser.add_argument("--runtime-dir", required=True)
    parser.add_argument("--connection-file", required=True)
    parser.add_argument("--owner-instance-id", required=True)
    return parser.parse_args()


def main() -> int:
    service = SearXNGService(parse_args())

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


if __name__ == "__main__":
    raise SystemExit(main())
