# SPDX-License-Identifier: MPL-2.0

from __future__ import annotations

import base64
import json
import os
import pathlib
import re
import runpy
import shutil
import socket
import subprocess
import sys
import tarfile
import tempfile
import threading
import unittest
import zipfile

HERE = pathlib.Path(__file__).resolve().parent
CHECKOUT = HERE.parents[3]
SOURCE_ROOT = CHECKOUT / "wildbuzzard" / "third_party" / "agpl" / "searxng"


def invalid_release_archive(root: pathlib.Path, name: str) -> pathlib.Path:
    release = root / "release" / "wildbuzzard"
    runtime = release / "runtime" / "search"
    runtime.mkdir(parents=True)
    browser = release / "wildbuzzard"
    browser.write_text("#!/bin/sh\n", encoding="utf-8")
    browser.chmod(0o755)
    (release / "application.ini").write_text(
        "Version=validation-test\n", encoding="utf-8"
    )
    with zipfile.ZipFile(runtime / "wildbuzzard-searxng-runtime.zip", "w") as archive:
        archive.writestr("wildbuzzard-runtime.json", "{}\n")
    notices = release / "notices" / "source"
    notices.mkdir(parents=True)
    (notices / "wildbuzzard-searxng-2026.8.6+b023a28ba-source.tar.xz").write_bytes(
        b"invalid"
    )
    (notices / "searxng-release.cdx.json").write_text(
        "{}\n", encoding="utf-8"
    )
    package = root / name
    with tarfile.open(package, "w:gz") as archive:
        archive.add(root / "release" / "wildbuzzard", arcname="wildbuzzard")
    return package


def release_archive_without_searxng(root: pathlib.Path, name: str) -> pathlib.Path:
    release = root / "release" / "wildbuzzard"
    release.mkdir(parents=True)
    browser = release / "wildbuzzard"
    browser.write_text("#!/bin/sh\n", encoding="utf-8")
    browser.chmod(0o755)
    (release / "application.ini").write_text(
        "Version=validation-test\n", encoding="utf-8"
    )
    package = root / name
    with tarfile.open(package, "w:gz") as archive:
        archive.add(release, arcname="wildbuzzard")
    return package


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
        self.assertIn('RUSTC="$RUST_PREFIX/bin/rustc"', script)

    def test_shipping_execution_has_no_oci_tool(self) -> None:
        paths = (
            CHECKOUT / "wildbuzzard" / "scripts" / "build-searxng-runtime.sh",
            CHECKOUT / "wildbuzzard" / "scripts" / "build-searxng-native-deps.sh",
            CHECKOUT / "wildbuzzard" / "scripts" / "build-linux-external.sh",
            CHECKOUT / "wildbuzzard" / "scripts" / "package-appimage.sh",
            CHECKOUT / "wildbuzzard" / "scripts" / "package-deb.sh",
            CHECKOUT
            / "wildbuzzard"
            / "scripts"
            / "validate-searxng-runtime-archive.py",
            CHECKOUT
            / "wildbuzzard"
            / "managed-services"
            / "searxng"
            / "searxng_service.py",
            CHECKOUT
            / "wildbuzzard"
            / "browser"
            / "components"
            / "websearch"
            / "SearXNGRuntime.sys.mjs",
        )
        pattern = re.compile(
            r"\b(?:podman|buildah|nerdctl)\b|\bdocker\s+(?:build|run)\b"
        )
        for path in paths:
            self.assertIsNone(pattern.search(path.read_text(encoding="utf-8")), path)

    def test_browser_and_appimage_ship_the_native_runtime(self) -> None:
        configure = (CHECKOUT / "wildbuzzard" / "moz.configure").read_text(
            encoding="utf-8"
        )
        mozbuild = (CHECKOUT / "wildbuzzard" / "moz.build").read_text(encoding="utf-8")
        external = (
            CHECKOUT / "wildbuzzard" / "scripts" / "build-linux-external.sh"
        ).read_text(encoding="utf-8")
        package_manifest = (
            CHECKOUT / "browser" / "installer" / "package-manifest.in"
        ).read_text(encoding="utf-8")
        appimage = (
            CHECKOUT / "wildbuzzard" / "scripts" / "package-appimage.sh"
        ).read_text(encoding="utf-8")
        debian = (CHECKOUT / "wildbuzzard" / "scripts" / "package-deb.sh").read_text(
            encoding="utf-8"
        )
        appimage_validator = (
            CHECKOUT / "wildbuzzard" / "scripts" / "validate-searxng-runtime-archive.py"
        ).read_text(encoding="utf-8")
        self.assertIn("--with-wildbuzzard-searxng-runtime", configure)
        self.assertIn("--with-wildbuzzard-searxng-source", configure)
        self.assertIn('FINAL_TARGET_FILES.runtime["search"]', mozbuild)
        self.assertIn('FINAL_TARGET_FILES.notices["source"]', mozbuild)
        self.assertIn("--searxng-runtime", external)
        self.assertIn("--searxng-source", external)
        self.assertIn("validate-searxng-runtime-archive.py", external)
        self.assertIn(
            "@BINPATH@/runtime/search/wildbuzzard-searxng-runtime.zip",
            package_manifest,
        )
        self.assertIn(
            "@BINPATH@/notices/source/wildbuzzard-searxng-2026.8.6+b023a28ba-source.tar.xz",
            package_manifest,
        )
        self.assertIn(
            "@BINPATH@/notices/source/searxng-release.cdx.json",
            package_manifest,
        )
        self.assertIn("validate-searxng-runtime-archive.py", appimage)
        self.assertIn("validate-searxng-runtime-archive.py", debian)
        self.assertIn(
            "notices/source/wildbuzzard-searxng-2026.8.6+b023a28ba-source.tar.xz",
            appimage,
        )
        self.assertIn(
            "notices/source/wildbuzzard-searxng-2026.8.6+b023a28ba-source.tar.xz",
            debian,
        )
        self.assertIn('"${searxng_runtime}"', appimage)
        self.assertIn(
            "cf7dfaa9e4768131407e35baeda277a4f55784172290903c19ad3f524dd8a587",
            appimage_validator,
        )

    def test_appimage_rejects_an_invalid_runtime_before_packaging(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            package = invalid_release_archive(root, "wildbuzzard.tar.gz")
            marker = root / "appimagetool-ran"
            appimagetool = root / "appimagetool"
            appimagetool.write_text(f"#!/bin/sh\ntouch -- {marker}\n", encoding="utf-8")
            appimagetool.chmod(0o755)
            result = subprocess.run(
                [
                    CHECKOUT / "wildbuzzard" / "scripts" / "package-appimage.sh",
                    "--dist-dir",
                    root,
                    "--output-dir",
                    root / "output",
                    "--appimagetool",
                    appimagetool,
                    "--package",
                    package,
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("SearXNG runtime validation failed", result.stderr)
            self.assertFalse(marker.exists())

    def test_release_actions_require_searxng_inputs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            for action in ("package", "appimage", "all"):
                result = subprocess.run(
                    [
                        CHECKOUT
                        / "wildbuzzard"
                        / "scripts"
                        / "build-linux-external.sh",
                        "--action",
                        action,
                        "--build-root",
                        pathlib.Path(temporary) / action,
                    ],
                    capture_output=True,
                    text=True,
                    check=False,
                )
                self.assertEqual(result.returncode, 2)
                self.assertIn(
                    "requires --searxng-runtime and --searxng-source",
                    result.stderr,
                )

    def test_appimage_rejects_a_release_without_searxng(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            package = release_archive_without_searxng(root, "wildbuzzard.tar.gz")
            marker = root / "appimagetool-ran"
            appimagetool = root / "appimagetool"
            appimagetool.write_text(
                f"#!/bin/sh\ntouch -- {marker}\n", encoding="utf-8"
            )
            appimagetool.chmod(0o755)
            result = subprocess.run(
                [
                    CHECKOUT / "wildbuzzard" / "scripts" / "package-appimage.sh",
                    "--dist-dir",
                    root,
                    "--output-dir",
                    root / "output",
                    "--appimagetool",
                    appimagetool,
                    "--package",
                    package,
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("missing a required SearXNG", result.stderr)
            self.assertFalse(marker.exists())

    def test_debian_rejects_an_invalid_runtime_before_packaging(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            package = invalid_release_archive(
                root, "wildbuzzard-1.0.en-US.linux-x86_64.tar.gz"
            )
            dist = root / "dist"
            dist.mkdir()
            package.rename(dist / package.name)
            result = subprocess.run(
                [
                    CHECKOUT / "wildbuzzard" / "scripts" / "package-deb.sh",
                    "--dist-dir",
                    dist,
                    "--output-dir",
                    root / "output",
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("SearXNG runtime validation failed", result.stderr)

    def test_debian_rejects_a_release_without_searxng(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            package = release_archive_without_searxng(
                root, "wildbuzzard-1.0.en-US.linux-x86_64.tar.gz"
            )
            dist = root / "dist"
            dist.mkdir()
            package.rename(dist / package.name)
            result = subprocess.run(
                [
                    CHECKOUT / "wildbuzzard" / "scripts" / "package-deb.sh",
                    "--dist-dir",
                    dist,
                    "--output-dir",
                    root / "output",
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("missing a required SearXNG", result.stderr)

    def test_browser_keeps_search_capability_out_of_content_urls(self) -> None:
        supervisor = (
            CHECKOUT
            / "wildbuzzard"
            / "browser"
            / "components"
            / "websearch"
            / "SearXNGRuntime.sys.mjs"
        ).read_text(encoding="utf-8")
        agent = (
            CHECKOUT
            / "wildbuzzard"
            / "browser"
            / "extensions"
            / "agent-sidebar"
            / "experiment-apis"
            / "wildbuzzardAgent.js"
        ).read_text(encoding="utf-8")
        web_access = (
            CHECKOUT / "agent" / "extensions" / "web-access" / "connection.ts"
        ).read_text(encoding="utf-8")
        self.assertIn('request.setRequestHeader("Authorization"', supervisor)
        self.assertIn('command,\n        "--data-root"', supervisor)
        self.assertNotIn('runLifecycle(runtime, "stop")', supervisor)
        self.assertNotIn('runLifecycle(runtime, "restart")', supervisor)
        self.assertIn("get correspondingSourcePath()", supervisor)
        self.assertIn("SearXNGRuntime.connectionPath", agent)
        self.assertIn("WILDBUZZARD_SEARCH_CONNECTION_FILE", agent)
        self.assertIn('headers.set("Authorization"', web_access)
        self.assertIn("${connection.address}:${connection.port}${path}", web_access)
        self.assertNotIn("connection.token}${path}", web_access)

    def test_only_pristine_comparator_uses_a_container(self) -> None:
        comparator = (HERE / "compare_searxng.py").read_text(encoding="utf-8")
        self.assertIn('"pristine-container-create"', comparator)
        self.assertEqual(len(re.findall(r'\*podman,\s+"create"', comparator)), 1)
        self.assertEqual(comparator.count('[*podman, "start"'), 1)
        self.assertNotIn("native-container", comparator)
        self.assertNotIn('"exec"', comparator)
        self.assertNotIn("/opt/wildbuzzard-http-probe.py", comparator)
        self.assertNotIn("container_http_probe.py", comparator)
        self.assertNotIn('"pristine-image-build"', comparator)
        self.assertNotRegex(comparator, r'\*podman,\s*"build"')
        self.assertIn("prepare_pristine_source_overlay(work)", comparator)
        self.assertIn(
            'f"{pristine_source_overlay}:/usr/local/searxng/searx:ro"',
            comparator,
        )
        self.assertIn("PLATFORM_REFERENCE,", comparator)
        self.assertIn('probe = HERE / "host_http_probe.py"', comparator)
        self.assertIn("unix_socket=pristine_socket", comparator)
        self.assertIn("create_pristine_socket_root()", comparator)
        self.assertNotIn('work / "pristine-socket"', comparator)
        self.assertIn('"pristineSocketDirectoryRemoved"', comparator)
        self.assertIn('"--uds-permissions",\n                "0o600",', comparator)
        self.assertEqual(comparator.count("HostClient("), 2)
        self.assertIn("native_process = subprocess.Popen(", comparator)
        self.assertIn('str(native_runtime / "bin" / "searxng-service")', comparator)
        self.assertIn("pid != client.process.pid", comparator)
        self.assertIn('"containerized": False', comparator)
        self.assertFalse((HERE / "Containerfile.pristine").exists())

    def test_pristine_socket_path_is_short_and_independent_of_artifacts(self) -> None:
        comparator = runpy.run_path(
            str(HERE / "compare_searxng.py"), run_name="searxng_comparator_contract"
        )
        with tempfile.TemporaryDirectory() as temporary:
            artifacts = pathlib.Path(temporary) / ("a" * 80) / ("b" * 80)
            artifacts.mkdir(parents=True)
            socket_root, socket_path = comparator["create_pristine_socket_root"]()
            try:
                self.assertLessEqual(
                    len(os.fsencode(socket_path)),
                    comparator["MAX_UNIX_SOCKET_PATH_BYTES"],
                )
                self.assertFalse(socket_path.is_relative_to(artifacts))
                self.assertEqual(socket_root.stat().st_mode & 0o777, 0o700)
            finally:
                shutil.rmtree(socket_root)

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
