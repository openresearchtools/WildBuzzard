# SPDX-License-Identifier: MPL-2.0

from __future__ import annotations

import base64
import json
import pathlib
import re
import socket
import subprocess
import sys
import tempfile
import threading
import unittest

HERE = pathlib.Path(__file__).resolve().parent
CHECKOUT = HERE.parents[3]
SOURCE_ROOT = CHECKOUT / "wildbuzzard" / "third_party" / "agpl" / "searxng"


class ShippingContractTests(unittest.TestCase):
    def test_cargo_vendor_archive_is_external(self) -> None:
        archive = SOURCE_ROOT / "granian-2.7.9-cargo-vendor.tar.xz"
        self.assertFalse(archive.exists())
        script = (
            CHECKOUT / "wildbuzzard" / "scripts" / "build-searxng-runtime.sh"
        ).read_text(encoding="utf-8")
        self.assertIn(
            'CARGO_VENDOR_ARCHIVE="$CACHE_DIR/cargo-vendor/$CARGO_VENDOR_FILENAME"',
            script,
        )
        self.assertIn('"$RUST_PREFIX/bin/cargo" vendor --locked vendor', script)

    def test_shipping_execution_has_no_oci_tool(self) -> None:
        paths = (
            CHECKOUT / "wildbuzzard" / "scripts" / "build-searxng-runtime.sh",
            CHECKOUT / "wildbuzzard" / "scripts" / "build-searxng-native-deps.sh",
            CHECKOUT
            / "wildbuzzard"
            / "managed-services"
            / "searxng"
            / "searxng_service.py",
        )
        pattern = re.compile(
            r"\b(?:podman|buildah|nerdctl)\b|\bdocker\s+(?:build|run)\b"
        )
        for path in paths:
            self.assertIsNone(pattern.search(path.read_text(encoding="utf-8")), path)

    def test_only_pristine_comparator_uses_a_container(self) -> None:
        comparator = (HERE / "compare_searxng.py").read_text(encoding="utf-8")
        self.assertIn('"pristine-container-create"', comparator)
        self.assertEqual(len(re.findall(r'\*podman,\s+"create"', comparator)), 1)
        self.assertEqual(comparator.count('[*podman, "start"'), 1)
        self.assertNotIn("native-container", comparator)
        self.assertNotIn('"exec"', comparator)
        self.assertNotIn("/opt/wildbuzzard-http-probe.py", comparator)
        self.assertNotIn("container_http_probe.py", comparator)
        self.assertIn('probe = HERE / "host_http_probe.py"', comparator)
        self.assertIn("unix_socket=pristine_socket", comparator)
        self.assertIn('"--uds-permissions",\n                "0o600",', comparator)
        self.assertEqual(comparator.count("HostClient("), 2)
        self.assertIn("native_process = subprocess.Popen(", comparator)
        self.assertIn('str(native_runtime / "bin" / "searxng-service")', comparator)
        self.assertIn("pid != client.process.pid", comparator)
        self.assertIn('"containerized": False', comparator)

    def test_host_probe_reaches_a_unix_socket(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            socket_path = pathlib.Path(temporary) / "service.sock"
            listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            listener.bind(str(socket_path))
            listener.listen(1)

            def serve() -> None:
                connection, _ = listener.accept()
                with connection:
                    request_bytes = b""
                    while b"\r\n\r\n" not in request_bytes:
                        block = connection.recv(65536)
                        if not block:
                            break
                        request_bytes += block
                    connection.sendall(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"
                    )

            server = threading.Thread(target=serve)
            server.start()
            request = {
                "headers": {"Host": "127.0.0.1:8080"},
                "method": "GET",
                "mode": "request",
                "path": "/healthz",
                "port": 8080,
                "unixSocket": str(socket_path),
            }
            result = subprocess.run(
                [sys.executable, "-I", "-B", str(HERE / "host_http_probe.py")],
                input=json.dumps(request).encode(),
                capture_output=True,
                check=True,
            )
            server.join(timeout=5)
            listener.close()
            self.assertFalse(server.is_alive())
            response = json.loads(result.stdout)
            self.assertEqual(response["status"], 200)
            self.assertEqual(base64.b64decode(response["body"]), b"ok")


if __name__ == "__main__":
    unittest.main()
