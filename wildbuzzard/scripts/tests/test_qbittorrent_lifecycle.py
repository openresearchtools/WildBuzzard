# SPDX-License-Identifier: AGPL-3.0-or-later

import ctypes
import hashlib
import http.client
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

RUNTIME = os.environ.get("WILDBUZZARD_TEST_TORRENT_RUNTIME")


@unittest.skipUnless(
    RUNTIME, "set WILDBUZZARD_TEST_TORRENT_RUNTIME to the built runtime"
)
class TorrentLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="wbql-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.runtime = Path(RUNTIME).resolve()
        self.key = "qbt_" + "a" * 28
        key_file = self.root / "key"
        key_file.write_text(self.key + "\n")
        key_file.chmod(0o600)
        self.socket_path = self.root / "q"
        self.environment = {
            "HOME": str(self.root / "home"),
            "LANG": "C.UTF-8",
            "PATH": "/usr/bin:/bin",
            "LD_LIBRARY_PATH": str(self.runtime / "lib"),
            "QT_PLUGIN_PATH": str(self.runtime / "plugins"),
            "WILDBUZZARD_QBITTORRENT_API_KEY_FILE": str(key_file),
            "WILDBUZZARD_QBITTORRENT_SOCKET": str(self.socket_path),
            "WILDBUZZARD_QBITTORRENT_LIFETIME": "stdin",
        }
        self.command = [
            str(self.runtime / "bin/qbittorrent-nox"),
            "--confirm-legal-notice",
            f"--profile={self.root / 'profile'}",
            f"--save-path={self.root / 'downloads'}",
        ]

    def start(self):
        process = subprocess.Popen(
            self.command,
            env=self.environment,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        self.addCleanup(self.cleanup_process, process)
        self.wait_ready()
        return process

    @staticmethod
    def cleanup_process(process):
        if process.stdin:
            process.stdin.close()
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)

    def request(
        self, target, body=None, content_type="application/x-www-form-urlencoded"
    ):
        method = "GET" if body is None else "POST"
        body = body or b""
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(3)
            connection.connect(str(self.socket_path))
            connection.sendall(
                (
                    f"{method} {target} HTTP/1.1\r\nHost: localhost\r\n"
                    f"Authorization: Bearer {self.key}\r\nConnection: close\r\n"
                    f"Content-Type: {content_type}\r\nContent-Length: {len(body)}\r\n\r\n"
                ).encode()
                + body
            )
            response = http.client.HTTPResponse(connection)
            response.begin()
            self.assertEqual(response.status, 200)
            return response.read()

    def wait_ready(self):
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            try:
                self.assertEqual(self.request("/api/v2/app/version"), b"v5.2.3")
                return
            except (OSError, AssertionError, ValueError):
                time.sleep(0.1)
        self.fail("torrent engine did not become ready")

    def add_partial_transfer(self):
        piece_size = 65536
        partial = b"A" * (piece_size * 2)
        complete = partial + b"B" * (piece_size * 2)
        downloads = self.root / "downloads"
        downloads.mkdir(exist_ok=True)
        (downloads / "lifetime.bin").write_bytes(partial)
        pieces = b"".join(
            hashlib.sha1(complete[offset : offset + piece_size]).digest()
            for offset in range(0, len(complete), piece_size)
        )
        info = (
            b"d6:lengthi262144e4:name12:lifetime.bin12:piece lengthi65536e6:pieces80:"
            + pieces
            + b"7:privatei1ee"
        )
        self.transfer_hash = hashlib.sha1(info).hexdigest()
        torrent = b"d4:info" + info + b"e"
        body = (
            b'--lifetime\r\nContent-Disposition: form-data; name="savepath"\r\n\r\n'
            + str(downloads).encode()
            + b"\r\n"
            + b'--lifetime\r\nContent-Disposition: form-data; name="torrents"; filename="lifetime.torrent"\r\n'
            b"Content-Type: application/x-bittorrent\r\n\r\n"
            + torrent
            + b"\r\n--lifetime--\r\n"
        )
        self.request(
            "/api/v2/torrents/add", body, "multipart/form-data; boundary=lifetime"
        )
        self.wait_for_partial_transfer()

    def wait_for_partial_transfer(self):
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            transfers = json.loads(self.request("/api/v2/torrents/info"))
            if len(transfers) == 1 and transfers[0]["progress"] == 0.5:
                self.assertEqual(transfers[0]["hash"], self.transfer_hash)
                self.assertEqual(transfers[0]["name"], "lifetime.bin")
                return
            time.sleep(0.1)
        self.fail(f"partial transfer was not restored: {transfers}")

    def test_rejects_daemon_and_missing_lifetime_pipe(self):
        for arguments in ([], ["--daemon"]):
            with self.subTest(arguments=arguments):
                result = subprocess.run(
                    self.command + arguments,
                    env=self.environment,
                    stdin=subprocess.DEVNULL,
                    capture_output=True,
                    timeout=10,
                    check=False,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(b"browser-owned lifetime pipe", result.stderr)

    def test_closing_pipe_saves_state_and_exits(self):
        process = self.start()
        self.assertIsNone(process.poll())
        self.assertEqual(json.loads(self.request("/api/v2/torrents/info")), [])
        self.add_partial_transfer()
        process.stdin.close()
        self.assertEqual(process.wait(timeout=20), 0)
        self.assertTrue(
            (self.root / "profile/qBittorrent/config/qBittorrent.conf").is_file()
        )
        restarted = self.start()
        self.wait_for_partial_transfer()
        restarted.stdin.close()
        self.assertEqual(restarted.wait(timeout=20), 0)

    def test_owner_sigkill_closes_pipe_and_engine_exits(self):
        libc = ctypes.CDLL(None, use_errno=True)
        self.assertEqual(libc.prctl(36, 1, 0, 0, 0), 0)
        self.addCleanup(libc.prctl, 36, 0, 0, 0, 0)
        owner = subprocess.Popen(
            [
                sys.executable,
                "-c",
                "import subprocess,sys,time; p=subprocess.Popen(sys.argv[1:],"
                "stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); "
                "print(p.pid,flush=True); time.sleep(60)",
                *self.command,
            ],
            env=self.environment,
            stdout=subprocess.PIPE,
            text=True,
        )
        self.addCleanup(self.cleanup_process, owner)
        self.addCleanup(owner.stdout.close)
        engine_pid = int(owner.stdout.readline())
        try:
            self.wait_ready()
            self.add_partial_transfer()
            owner.kill()
            owner.wait(timeout=5)
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                pid, status = os.waitpid(engine_pid, os.WNOHANG)
                if pid:
                    self.assertEqual(os.waitstatus_to_exitcode(status), 0)
                    break
                time.sleep(0.1)
            else:
                self.fail("torrent engine survived the owner crash")
            self.start()
            self.wait_for_partial_transfer()
        finally:
            try:
                os.kill(engine_pid, signal.SIGKILL)
                os.waitpid(engine_pid, 0)
            except (ProcessLookupError, ChildProcessError):
                pass


if __name__ == "__main__":
    unittest.main()
