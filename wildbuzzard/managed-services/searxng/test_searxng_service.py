# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import contextlib
import copy
import http.client
import json
import os
import pathlib
import secrets
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from types import SimpleNamespace
from unittest import mock

import searxng_service

POLICY = {
    "schema": 1,
    "searxngCommit": "b023a28bab8839dba9eac96e9a51cc91bbd0a267",
    "safeSearch": 1,
    "engines": [
        {
            "name": "fixture engine",
            "module": "demo_offline",
            "requiresCredentials": False,
            "purpose": "deterministic local comparison fixture",
        }
    ],
}


class FakeService:
    def __init__(self) -> None:
        self.port = 0
        self.token = "test-capability"
        self.backend_socket = pathlib.Path("/not-used")
        self.private_socket = None
        self.nonces: set[str] = set()

    def public_identity(self) -> dict[str, object]:
        return {"component": "searxng", "protocolVersion": 1}

    def backend_healthy(self) -> bool:
        return True

    def mark_healthy(self) -> None:
        return

    def consume_auth_nonce(self, nonce: str) -> bool:
        if nonce in self.nonces:
            return False
        self.nonces.add(nonce)
        return True

    def allow_search(self) -> bool:
        return True


class EnginePolicyTest(unittest.TestCase):
    def test_valid_policy_generates_private_settings(self) -> None:
        engines = searxng_service.validate_engine_policy(POLICY)
        settings = searxng_service.settings_text("secret", 49152, engines)
        self.assertIn('      - "fixture engine"', settings)
        self.assertIn('    engine: "demo_offline"', settings)
        self.assertIn("  safe_search: 1", settings)
        self.assertIn("  enable_metrics: false", settings)
        self.assertIn("  formats:\n    - html\n    - json", settings)
        self.assertIn("  base_url: http://127.0.0.1:49152/", settings)
        self.assertIn("plugins: {}", settings)

    def test_runtime_environment_is_deterministic(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            runtime = root / "runtime"
            data = root / "data"
            runtime.mkdir()
            data.mkdir()
            environment = searxng_service.runtime_environment(runtime, data)
        self.assertEqual(environment["PYTHONHASHSEED"], "0")
        self.assertEqual(environment["TZ"], "UTC")
        self.assertEqual(environment["LC_ALL"], "C.UTF-8")
        self.assertEqual(environment["HOME"], str(data / "home"))

    def test_credentials_are_rejected(self) -> None:
        policy = copy.deepcopy(POLICY)
        policy["engines"][0]["requiresCredentials"] = True
        with self.assertRaisesRegex(RuntimeError, "may not require credentials"):
            searxng_service.validate_engine_policy(policy)

    def test_unknown_fields_are_rejected(self) -> None:
        policy = copy.deepcopy(POLICY)
        policy["engines"][0]["apiKey"] = "secret"
        with self.assertRaisesRegex(RuntimeError, "invalid fields"):
            searxng_service.validate_engine_policy(policy)


class ProxyCancellationTest(unittest.TestCase):
    def handler(self) -> searxng_service.GatewayHandler:
        handler = searxng_service.GatewayHandler.__new__(searxng_service.GatewayHandler)
        handler.command = "POST"
        handler.path = "/search"
        handler.headers = {}
        handler.close_connection = False
        handler.server = mock.Mock()
        handler.server.service.backend_socket = pathlib.Path("/backend.sock")
        handler.send_response = mock.Mock()
        handler.send_header = mock.Mock()
        handler.end_headers = mock.Mock()
        handler.wfile = mock.Mock()
        return handler

    def test_cancelled_proxy_closes_backend_without_secondary_response(self) -> None:
        handler = self.handler()
        backend = mock.Mock()
        backend.sock = mock.Mock(spec=socket.socket)
        with contextlib.ExitStack() as stack:
            stack.enter_context(
                mock.patch.object(handler, "_client_disconnected", return_value=False)
            )
            stack.enter_context(
                mock.patch.object(handler, "_wait_for_backend", return_value=False)
            )
            send_json = stack.enter_context(mock.patch.object(handler, "_send_json"))
            stack.enter_context(
                mock.patch.object(
                    searxng_service,
                    "UnixHTTPConnection",
                    return_value=backend,
                )
            )
            handler._proxy(b"q=cancel")
        backend.close.assert_called_once_with()
        send_json.assert_not_called()

    def test_downstream_broken_pipe_is_quiet_after_backend_release(self) -> None:
        handler = self.handler()
        response = mock.Mock()
        response.status = 200
        response.getheader.return_value = "2"
        response.getheaders.return_value = [("Content-Type", "text/plain")]
        response.read.return_value = b"OK"
        backend = mock.Mock()
        backend.sock = mock.Mock(spec=socket.socket)
        backend.getresponse.return_value = response
        handler.wfile.write.side_effect = BrokenPipeError
        with contextlib.ExitStack() as stack:
            stack.enter_context(
                mock.patch.object(handler, "_client_disconnected", return_value=False)
            )
            stack.enter_context(
                mock.patch.object(handler, "_wait_for_backend", return_value=True)
            )
            stack.enter_context(
                mock.patch.object(
                    searxng_service,
                    "UnixHTTPConnection",
                    return_value=backend,
                )
            )
            handler._proxy(b"q=cancel")
        backend.close.assert_called_once_with()
        self.assertTrue(handler.close_connection)


class BackendSocketPathTest(unittest.TestCase):
    def test_long_non_ascii_state_root_uses_short_private_socket(self) -> None:
        service = searxng_service.SearXNGService.__new__(searxng_service.SearXNGService)
        service.data_root_id = "test-data-root"
        service.owner_instance_id = "test-owner"
        service.state_root = pathlib.Path("/tmp") / ("配置-" + "x" * 180)
        service.backend_socket_root = None
        service.backend_socket = None
        service.backend_socket_directory_identity = None
        self.assertGreater(
            len(os.fsencode(service.state_root / "searxng.sock")),
            searxng_service.MAX_UNIX_SOCKET_PATH_BYTES,
        )
        service.allocate_backend_socket()
        root = service.backend_socket_root
        socket_path = service.backend_socket
        self.assertIsNotNone(root)
        self.assertIsNotNone(socket_path)
        try:
            self.assertEqual(root.parent, searxng_service.BACKEND_SOCKET_PARENT)
            self.assertTrue(
                root.name.startswith(
                    searxng_service.backend_socket_prefix(
                        service.data_root_id, service.owner_instance_id
                    )
                )
            )
            self.assertEqual(stat.S_IMODE(root.lstat().st_mode), 0o700)
            self.assertFalse(root.is_symlink())
            self.assertLessEqual(
                len(os.fsencode(socket_path)),
                searxng_service.MAX_UNIX_SOCKET_PATH_BYTES,
            )
            self.assertFalse(os.path.lexists(socket_path))
        finally:
            service.release_backend_socket()
        self.assertFalse(os.path.lexists(root))

    def test_socket_directories_are_unique_and_identity_bound(self) -> None:
        allocations = [
            searxng_service.create_backend_socket_path("data-root", "owner"),
            searxng_service.create_backend_socket_path("data-root", "owner"),
            searxng_service.create_backend_socket_path("other-data-root", "owner"),
        ]
        try:
            roots = [allocation[0] for allocation in allocations]
            self.assertEqual(len(set(roots)), 3)
            self.assertTrue(
                roots[0].name.startswith(
                    searxng_service.backend_socket_prefix("data-root", "owner")
                )
            )
            self.assertTrue(
                roots[1].name.startswith(
                    searxng_service.backend_socket_prefix("data-root", "owner")
                )
            )
            self.assertTrue(
                roots[2].name.startswith(
                    searxng_service.backend_socket_prefix("other-data-root", "owner")
                )
            )
        finally:
            for root, socket_path, identity in allocations:
                searxng_service.remove_backend_socket_path(root, socket_path, identity)

    def test_cleanup_refuses_replaced_or_symlinked_directory(self) -> None:
        root, socket_path, identity = searxng_service.create_backend_socket_path(
            "data-root", "owner"
        )
        root.rmdir()
        root.mkdir(mode=0o700)
        marker = root / "preserve"
        marker.write_text("preserve", encoding="ascii")
        with self.assertRaisesRegex(RuntimeError, "identity changed"):
            searxng_service.remove_backend_socket_path(root, socket_path, identity)
        self.assertEqual(marker.read_text(encoding="ascii"), "preserve")
        marker.unlink()
        root.rmdir()

        root, socket_path, identity = searxng_service.create_backend_socket_path(
            "data-root", "owner"
        )
        with tempfile.TemporaryDirectory() as temporary:
            target = pathlib.Path(temporary)
            root.rmdir()
            root.symlink_to(target, target_is_directory=True)
            with self.assertRaisesRegex(RuntimeError, "identity changed"):
                searxng_service.remove_backend_socket_path(root, socket_path, identity)
            self.assertTrue(root.is_symlink())
            self.assertTrue(target.is_dir())
            root.unlink()

    def test_allocation_skips_existing_symlink(self) -> None:
        prefix = searxng_service.backend_socket_prefix("data-root", "owner")
        collision = searxng_service.BACKEND_SOCKET_PARENT / (prefix + "a" * 32)
        allocation = None
        with tempfile.TemporaryDirectory() as temporary:
            collision.symlink_to(temporary, target_is_directory=True)
            try:
                with mock.patch.object(
                    searxng_service.secrets,
                    "token_hex",
                    side_effect=["a" * 32, "b" * 32],
                ):
                    allocation = searxng_service.create_backend_socket_path(
                        "data-root", "owner"
                    )
                self.assertEqual(allocation[0].name, prefix + "b" * 32)
                self.assertTrue(collision.is_symlink())
            finally:
                if allocation is not None:
                    searxng_service.remove_backend_socket_path(*allocation)
                collision.unlink(missing_ok=True)


class ConnectionRecordTest(unittest.TestCase):
    def test_service_record_uses_epoch_milliseconds(self) -> None:
        service = searxng_service.SearXNGService.__new__(searxng_service.SearXNGService)
        service.port = 49152
        service.token = "a" * 43
        service.start_time = "12345"
        service.executable_path = pathlib.Path("/opt/runtime/python/bin/python3")
        service.executable_sha256 = "0" * 64
        service.data_root_id = "data-root"
        service.owner_instance_id = "owner"
        service.created_at = searxng_service.epoch_milliseconds()
        service.last_health_at = service.created_at + 1
        service.private_socket = pathlib.Path("/tmp/private.sock")
        service.private_socket_status = mock.Mock(
            return_value=SimpleNamespace(st_dev=7, st_ino=11)
        )
        record = service.connection_record()
        self.assertIs(type(record["createdAt"]), int)
        self.assertIs(type(record["lastHealthAt"]), int)
        self.assertGreaterEqual(record["lastHealthAt"], record["createdAt"])
        self.assertEqual(set(record), searxng_service.CONNECTION_FIELDS)

    def test_connection_record_has_canonical_json_bytes(self) -> None:
        service = searxng_service.SearXNGService.__new__(searxng_service.SearXNGService)
        service.port = 49152
        service.token = "a" * 43
        service.start_time = "12345"
        service.executable_path = pathlib.Path("/runtime/python/bin/python3")
        service.executable_sha256 = "0" * 64
        service.data_root_id = "data-root"
        service.owner_instance_id = "owner"
        service.created_at = 1786320000000
        service.last_health_at = 1786320001000
        service.private_socket = pathlib.Path("/tmp/private.sock")
        service.private_socket_status = mock.Mock(
            return_value=SimpleNamespace(st_dev=7, st_ino=11)
        )
        with mock.patch.object(searxng_service.os, "getpid", return_value=1234):
            record = service.connection_record()
        with tempfile.TemporaryDirectory() as temporary:
            path = pathlib.Path(temporary) / "connection.json"
            searxng_service.atomic_json(path, record)
            self.assertEqual(
                path.read_text(encoding="utf-8"),
                '{"address":"127.0.0.1","createdAt":1786320000000,'
                '"dataRootId":"data-root",'
                '"executablePath":"/runtime/python/bin/python3",'
                f'"executableSha256":"{"0" * 64}",'
                '"lastHealthAt":1786320001000,"ownerInstanceId":"owner",'
                '"pid":1234,"port":49152,'
                '"privateSocket":"/tmp/private.sock",'
                '"privateSocketDevice":7,"privateSocketInode":11,'
                '"processStartTime":"12345",'
                '"protocolVersion":1,'
                '"runtimeVersion":"2026.8.6+b023a28ba",'
                f'"token":"{"a" * 43}","version":1}}\n',
            )


class LifecycleControllerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        root = pathlib.Path(self.temporary.name)
        self.controller = searxng_service.SearXNGController.__new__(
            searxng_service.SearXNGController
        )
        self.controller.runtime_root = root / "runtime"
        self.controller.runtime_root.mkdir()
        self.controller.data_root = root / "data"
        self.controller.data_root.mkdir()
        self.controller.cache_root = root / "cache"
        self.controller.cache_root.mkdir()
        self.controller.state_root = root / "state"
        self.controller.state_root.mkdir()
        self.controller.connection_path = self.controller.state_root / "connection.json"
        self.controller.control_lock_path = self.controller.state_root / "control.lock"
        self.controller.launch_lock_path = self.controller.state_root / "launch.lock"
        self.controller.owner_instance_id = "test-owner"
        self.controller.executable_path = pathlib.Path(sys.executable).resolve()
        self.controller.executable_sha256 = searxng_service.sha256_file(
            self.controller.executable_path
        )
        self.controller.manifest = {}
        (self.controller.data_root / "data-root-id").write_text(
            "test-data-root\n", encoding="ascii"
        )
        (self.controller.data_root / "data-root-id").chmod(0o600)
        self.socket_allocation = searxng_service.create_private_socket_path(
            "gateway", "test-data-root", self.controller.owner_instance_id
        )
        self.private_listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.private_listener.bind(str(self.socket_allocation[1]))
        self.socket_allocation[1].chmod(0o600)
        self.private_listener.listen(1)

    def tearDown(self) -> None:
        self.private_listener.close()
        searxng_service.remove_backend_socket_path(*self.socket_allocation)
        self.temporary.cleanup()

    def record(self) -> dict[str, object]:
        now = searxng_service.epoch_milliseconds()
        socket_status = os.stat(self.socket_allocation[1], follow_symlinks=False)
        return {
            "version": 1,
            "protocolVersion": searxng_service.PROTOCOL_VERSION,
            "runtimeVersion": searxng_service.RUNTIME_VERSION,
            "address": searxng_service.ADDRESS,
            "port": 49152,
            "token": "a" * 43,
            "pid": os.getpid(),
            "processStartTime": searxng_service.process_start_time(os.getpid()),
            "executablePath": str(self.controller.executable_path),
            "executableSha256": self.controller.executable_sha256,
            "dataRootId": "test-data-root",
            "ownerInstanceId": self.controller.owner_instance_id,
            "createdAt": now,
            "lastHealthAt": now,
            "privateSocket": str(self.socket_allocation[1]),
            "privateSocketDevice": socket_status.st_dev,
            "privateSocketInode": socket_status.st_ino,
        }

    def test_record_validation_binds_process_and_owner_identity(self) -> None:
        record = self.record()
        self.assertIs(self.controller.validate_record(record), record)
        wrong_owner = {**record, "ownerInstanceId": "another-owner"}
        with self.assertRaisesRegex(RuntimeError, "identity mismatch"):
            self.controller.validate_record(wrong_owner)
        stale = {**record, "processStartTime": "0"}
        with self.assertRaises(searxng_service.ServiceNotRunning):
            self.controller.validate_record(stale)

    def test_record_validation_rejects_non_integer_timestamps(self) -> None:
        record = self.record()
        for field in ("createdAt", "lastHealthAt"):
            for invalid in (
                float(record[field]),
                True,
                0,
                searxng_service.MAX_EPOCH_MILLISECONDS + 1,
            ):
                with self.subTest(field=field, invalid=invalid):
                    with self.assertRaisesRegex(RuntimeError, "identity mismatch"):
                        self.controller.validate_record({**record, field: invalid})

    def test_start_reuses_authenticated_process_without_spawning(self) -> None:
        record = self.record()
        self.controller.read_record = mock.Mock(return_value=record)
        self.controller.validate_record = mock.Mock(return_value=record)
        self.controller.request_identity = mock.Mock(return_value={"ok": True})
        with mock.patch.object(searxng_service.subprocess, "Popen") as popen:
            self.assertIs(self.controller._start(), record)
        popen.assert_not_called()
        self.controller.validate_record.assert_called_once_with(record)
        self.controller.request_identity.assert_called_once_with(record, "/v1/health")

    def test_start_spawns_a_closed_detached_serve_process(self) -> None:
        record = self.record()
        self.controller.read_record = mock.Mock(side_effect=[None, record])
        self.controller.validate_record = mock.Mock(return_value=record)
        self.controller.request_identity = mock.Mock(return_value={"ok": True})
        self.controller.launch_lock_available = mock.Mock(return_value=True)
        self.controller.daemon_command = mock.Mock(return_value=["python", "serve"])
        self.controller.daemon_environment = mock.Mock(return_value={"PATH": "/bin"})
        process = mock.Mock()
        process.poll.return_value = None
        with mock.patch.object(
            searxng_service.subprocess, "Popen", return_value=process
        ) as popen:
            self.assertIs(self.controller._start(), record)
        popen.assert_called_once_with(
            ["python", "serve"],
            cwd=self.controller.runtime_root,
            env={"PATH": "/bin"},
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
            start_new_session=True,
        )

    def test_stop_authenticates_and_revalidates_before_pidfd_signal(self) -> None:
        record = self.record()
        self.controller.read_record = mock.Mock(return_value=record)
        self.controller.validate_record = mock.Mock(return_value=record)
        self.controller.request_identity = mock.Mock(return_value={})
        self.controller.remove_stale_record = mock.Mock()
        self.controller.open_pidfd = mock.Mock(return_value=71)
        with contextlib.ExitStack() as stack:
            kill = stack.enter_context(mock.patch.object(searxng_service.os, "kill"))
            close = stack.enter_context(mock.patch.object(searxng_service.os, "close"))
            pidfd_send_signal = stack.enter_context(
                mock.patch.object(searxng_service.signal, "pidfd_send_signal")
            )
            wait_for_exit = stack.enter_context(
                mock.patch.object(
                    searxng_service, "wait_for_process_exit", return_value=True
                )
            )
            self.assertIs(self.controller._stop(), record)
        self.controller.request_identity.assert_called_once_with(record, "/v1/identity")
        self.controller.open_pidfd.assert_called_once_with(record["pid"])
        self.assertEqual(self.controller.validate_record.call_count, 2)
        pidfd_send_signal.assert_called_once_with(71, signal.SIGTERM, None, 0)
        wait_for_exit.assert_called_once_with(
            record["pid"], record["processStartTime"], 71, 10
        )
        kill.assert_not_called()
        close.assert_called_once_with(71)

    def test_identity_swap_never_signals_reused_pid(self) -> None:
        record = self.record()
        events = []

        def validate(_record: dict[str, object]) -> dict[str, object]:
            events.append("validate")
            if events.count("validate") == 2:
                raise searxng_service.ServiceNotRunning("identity swapped")
            return record

        def identity(_record: dict[str, object], _path: str) -> dict[str, object]:
            events.append("identity")
            return {}

        def open_pidfd(_pid: int) -> int:
            events.append("pidfd")
            return 72

        self.controller.read_record = mock.Mock(return_value=record)
        self.controller.validate_record = mock.Mock(side_effect=validate)
        self.controller.request_identity = mock.Mock(side_effect=identity)
        self.controller.open_pidfd = mock.Mock(side_effect=open_pidfd)
        self.controller.remove_stale_record = mock.Mock()
        with contextlib.ExitStack() as stack:
            kill = stack.enter_context(mock.patch.object(searxng_service.os, "kill"))
            close = stack.enter_context(mock.patch.object(searxng_service.os, "close"))
            pidfd_send_signal = stack.enter_context(
                mock.patch.object(searxng_service.signal, "pidfd_send_signal")
            )
            wait = stack.enter_context(
                mock.patch.object(searxng_service, "wait_for_process_exit")
            )
            self.assertIs(self.controller._stop(), record)
        self.assertEqual(events, ["validate", "identity", "pidfd", "validate"])
        pidfd_send_signal.assert_not_called()
        kill.assert_not_called()
        wait.assert_not_called()
        close.assert_called_once_with(72)
        self.controller.remove_stale_record.assert_called_once_with(record)

    def test_live_wrong_pid_record_is_never_signalled(self) -> None:
        child = subprocess.Popen(
            ["/bin/sleep", "30"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            record = {
                **self.record(),
                "pid": child.pid,
                "processStartTime": searxng_service.process_start_time(child.pid),
            }
            self.controller.read_record = mock.Mock(return_value=record)
            with mock.patch.object(searxng_service.os, "kill") as kill:
                with self.assertRaisesRegex(RuntimeError, "executable mismatch"):
                    self.controller._stop()
            kill.assert_not_called()
        finally:
            child.terminate()
            child.wait(timeout=5)

    def test_private_socket_peer_swap_sends_no_capability_bytes(self) -> None:
        allocation = searxng_service.create_private_socket_path(
            "gateway", "test-data-root", self.controller.owner_instance_id
        )
        script = """
import os, socket, sys
path = sys.argv[1]
listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
listener.bind(path)
os.chmod(path, 0o600)
listener.listen(1)
print("ready", flush=True)
connection, _ = listener.accept()
connection.settimeout(2)
try:
    payload = connection.recv(65536)
except TimeoutError:
    payload = b"timeout"
print(payload.hex(), flush=True)
connection.close()
listener.close()
"""
        peer = subprocess.Popen(
            [sys.executable, "-I", "-B", "-c", script, str(allocation[1])],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            self.assertEqual(peer.stdout.readline().strip(), "ready")
            status = os.stat(allocation[1], follow_symlinks=False)
            record = {
                **self.record(),
                "token": "peer-swap-capability-" + "a" * 32,
                "privateSocket": str(allocation[1]),
                "privateSocketDevice": status.st_dev,
                "privateSocketInode": status.st_ino,
            }
            with self.assertRaisesRegex(RuntimeError, "health check failed"):
                self.controller.request_identity(record, "/v1/identity")
            captured = peer.stdout.readline().strip()
            self.assertEqual(captured, "")
            self.assertNotIn(record["token"].encode().hex(), captured)
            peer.wait(timeout=5)
        finally:
            if peer.poll() is None:
                peer.terminate()
                peer.wait(timeout=5)
            peer.stdout.close()
            peer.stderr.close()
            searxng_service.remove_backend_socket_path(*allocation)

    def test_sigkill_handoff_never_contacts_rebound_public_port(self) -> None:
        capture = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        capture.bind(("127.0.0.1", 0))
        capture.listen(1)
        capture.settimeout(0.2)
        allocation = searxng_service.create_private_socket_path(
            "gateway", "test-data-root", self.controller.owner_instance_id
        )
        service = FakeService()
        service.token = "sigkill-capability-" + "b" * 32
        service.private_socket = allocation[1]
        gateway = searxng_service.PrivateGateway(service)
        thread = threading.Thread(target=gateway.serve_forever, daemon=True)
        thread.start()
        try:
            socket_status = os.stat(allocation[1], follow_symlinks=False)
            record = {
                **self.record(),
                "port": capture.getsockname()[1],
                "token": service.token,
                "privateSocket": str(allocation[1]),
                "privateSocketDevice": socket_status.st_dev,
                "privateSocketInode": socket_status.st_ino,
            }
            service.public_identity = lambda: {
                "component": searxng_service.COMPONENT,
                "protocolVersion": record["protocolVersion"],
                "runtimeVersion": record["runtimeVersion"],
                "pid": record["pid"],
                "processStartTime": record["processStartTime"],
                "executableSha256": record["executableSha256"],
                "dataRootId": record["dataRootId"],
                "ownerInstanceId": record["ownerInstanceId"],
            }
            self.controller.read_record = mock.Mock(return_value=record)
            self.controller.remove_stale_record = mock.Mock()
            self.controller.open_pidfd = mock.Mock(return_value=91)
            with contextlib.ExitStack() as stack:
                pidfd_signal = stack.enter_context(
                    mock.patch.object(searxng_service.signal, "pidfd_send_signal")
                )
                stack.enter_context(mock.patch.object(searxng_service.os, "close"))
                stack.enter_context(
                    mock.patch.object(
                        searxng_service,
                        "wait_for_process_exit",
                        side_effect=[False, True],
                    )
                )
                self.assertIs(self.controller._stop(), record)
            self.assertEqual(
                [call.args[1] for call in pidfd_signal.call_args_list],
                [signal.SIGTERM, signal.SIGKILL],
            )
            with self.assertRaises(TimeoutError):
                capture.accept()
        finally:
            gateway.shutdown()
            gateway.server_close()
            thread.join(timeout=5)
            capture.close()
            searxng_service.remove_backend_socket_path(*allocation)

    def test_pidfd_unavailable_never_signals(self) -> None:
        record = self.record()
        self.controller.read_record = mock.Mock(return_value=record)
        self.controller.validate_record = mock.Mock(return_value=record)
        self.controller.request_identity = mock.Mock(return_value={})
        self.controller.open_pidfd = mock.Mock(return_value=None)
        with mock.patch.object(searxng_service.os, "kill") as kill:
            with self.assertRaisesRegex(RuntimeError, "signaling is unavailable"):
                self.controller._stop()
        kill.assert_not_called()

    def test_daemon_command_selects_serve_once(self) -> None:
        command = self.controller.daemon_command()
        self.assertEqual(command.count("serve"), 1)


class PrivateGatewayBoundaryTest(unittest.TestCase):
    def setUp(self) -> None:
        self.service = FakeService()
        self.allocation = searxng_service.create_private_socket_path(
            "gateway", "private-data", "private-owner"
        )
        self.service.private_socket = self.allocation[1]
        self.gateway = searxng_service.PrivateGateway(self.service)
        self.thread = threading.Thread(target=self.gateway.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.gateway.shutdown()
        self.gateway.server_close()
        self.thread.join(timeout=5)
        searxng_service.remove_backend_socket_path(*self.allocation)

    def request(
        self,
        path: str,
        *,
        authenticated: bool = True,
        host: str = "localhost",
        nonce: str | None = None,
    ) -> tuple[int, dict[str, object], http.client.HTTPMessage]:
        nonce = nonce or secrets.token_urlsafe(24)
        headers = {"Host": host, "Connection": "close"}
        if authenticated:
            signature = searxng_service.request_authentication(
                self.service.token, "GET", path, b"", nonce
            )
            headers.update({
                "Authorization": (
                    f"{searxng_service.AUTHORIZATION_SCHEME} {signature}"
                ),
                "Sec-Fetch-Site": "none",
                "X-WildBuzzard-Nonce": nonce,
            })
            self.assertNotIn(self.service.token, headers["Authorization"])
        connection = searxng_service.UnixHTTPConnection(
            self.service.private_socket, timeout=1
        )
        connection.request("GET", path, headers=headers)
        response = connection.getresponse()
        payload = response.read()
        response_headers = response.headers
        connection.close()
        if authenticated and response.status != 401 and host == "localhost":
            expected = searxng_service.response_authentication(
                self.service.token,
                nonce,
                response.status,
                response.getheader("Content-Type", ""),
                payload,
            )
            self.assertEqual(
                response.getheader("X-WildBuzzard-Response-Authentication"),
                expected,
            )
        return response.status, json.loads(payload), response_headers

    def test_identity_requires_private_authenticated_transport(self) -> None:
        status, body, _ = self.request("/v1/identity", authenticated=False)
        self.assertEqual(status, 401)
        self.assertEqual(body, {"error": "capability-required"})
        status, body, _ = self.request("/v1/identity")
        self.assertEqual(status, 200)
        self.assertEqual(body["component"], "searxng")

    def test_nonce_replay_and_wrong_host_fail_closed(self) -> None:
        nonce = secrets.token_urlsafe(24)
        status, _, _ = self.request("/v1/health", nonce=nonce)
        self.assertEqual(status, 200)
        status, body, _ = self.request("/v1/health", nonce=nonce)
        self.assertEqual(status, 401)
        self.assertEqual(body, {"error": "capability-required"})
        status, body, _ = self.request("/v1/health", host="attacker.invalid")
        self.assertEqual(status, 403)
        self.assertEqual(body, {"error": "forbidden"})

    def test_original_api_is_available_only_on_authenticated_socket(self) -> None:
        for path in ("/config", "/search?q=test&format=json"):
            status, body, _ = self.request(path)
            self.assertEqual(status, 502)
            self.assertEqual(body, {"error": "upstream-unavailable"})
        status, body, _ = self.request("/metrics")
        self.assertEqual(status, 404)
        self.assertEqual(body, {"error": "not-found"})


class PublicGatewayBoundaryTest(unittest.TestCase):
    def setUp(self) -> None:
        self.service = FakeService()
        self.gateway = searxng_service.Gateway(self.service)
        self.service.port = self.gateway.server_address[1]
        self.thread = threading.Thread(target=self.gateway.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.gateway.shutdown()
        self.gateway.server_close()
        self.thread.join(timeout=5)

    def request(
        self, path: str, *, authorization: bool = False, host: str | None = None
    ) -> tuple[int, dict[str, object]]:
        connection = http.client.HTTPConnection(
            "127.0.0.1", self.service.port, timeout=1.0
        )
        headers = {"Host": host or f"127.0.0.1:{self.service.port}"}
        if authorization:
            headers["Authorization"] = f"Bearer {self.service.token}"
        connection.request("GET", path, headers=headers)
        response = connection.getresponse()
        body = json.loads(response.read())
        connection.close()
        return response.status, body

    def test_private_routes_are_absent_from_the_public_port(self) -> None:
        status, body = self.request("/v1/identity")
        self.assertEqual(status, 404)
        self.assertEqual(body, {"error": "not-found"})
        status, body = self.request("/v1/identity", authorization=True)
        self.assertEqual(status, 403)
        self.assertEqual(body, {"error": "forbidden"})

    def test_metrics_is_not_exposed(self) -> None:
        status, body = self.request("/metrics")
        self.assertEqual(status, 404)
        self.assertEqual(body, {"error": "not-found"})

    def test_only_token_free_html_search_is_public(self) -> None:
        status, body = self.request("/search?q=test&format=json")
        self.assertEqual(status, 404)
        self.assertEqual(body, {"error": "not-found"})
        status, body = self.request("/search?q=test&format=html")
        self.assertEqual(status, 502)
        self.assertEqual(body, {"error": "upstream-unavailable"})

    def test_host_boundary_rejects_dns_rebinding(self) -> None:
        status, body = self.request(
            "/v1/identity", authorization=True, host="attacker.invalid"
        )
        self.assertEqual(status, 403)
        self.assertEqual(body, {"error": "forbidden"})

    def test_stalled_clients_release_request_slots(self) -> None:
        self.gateway.request_slots = threading.BoundedSemaphore(2)
        stalled = []
        overflow = None
        with contextlib.ExitStack() as stack:
            stack.enter_context(
                mock.patch.object(
                    searxng_service, "ACCEPTED_SOCKET_TIMEOUT_SECONDS", 0.5
                )
            )
            stack.enter_context(
                mock.patch.object(searxng_service, "REQUEST_SLOT_WAIT_SECONDS", 0.05)
            )
            try:
                partial_requests = (
                    b"GET / HTTP/1.1\r\nHost:",
                    (
                        f"POST /search HTTP/1.1\r\n"
                        f"Host: 127.0.0.1:{self.service.port}\r\n"
                        "Content-Type: application/x-www-form-urlencoded\r\n"
                        "Content-Length: 10\r\n\r\nx"
                    ).encode(),
                )
                for partial_request in partial_requests:
                    client = socket.create_connection(
                        ("127.0.0.1", self.service.port), timeout=1.0
                    )
                    client.sendall(partial_request)
                    stalled.append(client)
                deadline = time.monotonic() + 1
                while time.monotonic() < deadline:
                    if not self.gateway.request_slots.acquire(blocking=False):
                        break
                    self.gateway.request_slots.release()
                    time.sleep(0.01)
                else:
                    self.fail("stalled clients did not occupy the request slots")

                overflow = socket.create_connection(
                    ("127.0.0.1", self.service.port), timeout=1.0
                )
                overflow.settimeout(0.3)
                overflow.sendall(
                    f"GET / HTTP/1.1\r\n"
                    f"Host: 127.0.0.1:{self.service.port}\r\n"
                    "\r\n".encode()
                )
                try:
                    self.assertEqual(overflow.recv(1), b"")
                except ConnectionResetError:
                    pass
                except TimeoutError:
                    self.fail("request-slot exhaustion blocked the accept thread")

                deadline = time.monotonic() + 2
                while time.monotonic() < deadline:
                    try:
                        status, body = self.request("/")
                    except (OSError, http.client.HTTPException):
                        time.sleep(0.02)
                        continue
                    if status == 502 and body.get("error") == "upstream-unavailable":
                        break
                else:
                    self.fail("request slots did not recover after stalled clients")
            finally:
                if overflow is not None:
                    overflow.close()
                for client in stalled:
                    client.close()


if __name__ == "__main__":
    unittest.main()
