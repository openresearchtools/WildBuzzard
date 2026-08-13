# SPDX-License-Identifier: MPL-2.0

from __future__ import annotations

import base64
import hashlib
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

HERE = pathlib.Path(__file__).resolve().parent
CHECKOUT = HERE.parents[3]
SOURCE_ROOT = CHECKOUT / "wildbuzzard" / "third_party" / "agpl" / "searxng"
SEARXNG_NAME = "wildbuzzard-searxng-2026.8.6+b023a28ba-linux-x86_64.AppImage"
SEARXNG_SOURCE_NAME = "wildbuzzard-searxng-2026.8.6+b023a28ba-source.tar.xz"
SEARXNG_SBOM_NAME = "wildbuzzard-searxng-2026.8.6+b023a28ba-sbom.cdx.json"


def host_native_release_archive(
    root: pathlib.Path,
    name: str,
    *,
    missing: tuple[str, ...] = (),
    searxng_state: str = "valid",
) -> pathlib.Path:
    release = root / "release" / "wildbuzzard"
    release.mkdir(parents=True)
    browser = release / "wildbuzzard"
    browser.write_text("#!/bin/sh\n", encoding="utf-8")
    browser.chmod(0o755)
    (release / "application.ini").write_text("Version=1.0\n", encoding="utf-8")
    files = (
        "runtime/pi-web/wildbuzzard-pi-web-runtime.zip",
        "runtime/torrent/wildbuzzard-torrent-runtime.zip",
        "runtime/jackett-mini/wildbuzzard-jackett-mini-runtime.zip",
        "runtime/tor/arti",
        "runtime/tor/arti.toml",
        "notices/source/wildbuzzard-arti-2.5.1-provenance.zip",
    )
    for relative in files:
        if relative in missing:
            continue
        path = release / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"test\n")
        if relative == "runtime/tor/arti":
            path.chmod(0o755)
    search = release / "runtime" / "search"
    search.mkdir(parents=True, exist_ok=True)
    executable = search / SEARXNG_NAME
    if searxng_state != "missing":
        if searxng_state == "symlink":
            target = search / "target.AppImage"
            target.write_bytes(b"test\n")
            target.chmod(0o755)
            executable.symlink_to(target.name)
        else:
            executable.write_bytes(
                b"tampered\n" if searxng_state == "tampered" else b"test\n"
            )
            executable.chmod(0o644 if searxng_state == "mode" else 0o755)
    if searxng_state == "obsolete":
        (search / "wildbuzzard-searxng-runtime.zip").write_bytes(b"obsolete\n")
    package = root / name
    package.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(package, "w:gz") as archive:
        archive.add(release, arcname="wildbuzzard")
    return package


def fake_packaging_tools(root: pathlib.Path) -> tuple[pathlib.Path, dict[str, str]]:
    fake_bin = root / "tools with spaces Ω"
    fake_bin.mkdir(parents=True)
    python = fake_bin / "python3"
    python.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    python.chmod(0o755)
    appimagetool = fake_bin / "appimagetool"
    appimagetool.write_text(
        "#!/bin/sh\n"
        'printf "%s\\n" "$APPIMAGE_EXTRACT_AND_RUN" "$ARCH" "$1" "$2" > "$TEST_MARKER"\n'
        ': > "$2"\n',
        encoding="utf-8",
    )
    appimagetool.chmod(0o755)
    environment = os.environ.copy()
    environment["PATH"] = f"{fake_bin}:/usr/bin:/bin"
    return appimagetool, environment


def searxng_release_inputs(
    root: pathlib.Path,
) -> tuple[pathlib.Path, pathlib.Path, pathlib.Path]:
    source = root / SEARXNG_SOURCE_NAME
    sbom = root / SEARXNG_SBOM_NAME
    source.write_bytes(b"complete source\n")
    sbom.write_bytes(b'{"bomFormat":"CycloneDX"}\n')
    source.chmod(0o644)
    sbom.chmod(0o644)
    lock = root / "release-assets.lock.json"
    lock.write_text(
        json.dumps(
            {
                "schema": 1,
                "source": {
                    "artifact": source.name,
                    "artifactBytes": source.stat().st_size,
                    "artifactSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                    "mode": "0644",
                },
                "sbom": {
                    "artifact": sbom.name,
                    "artifactBytes": sbom.stat().st_size,
                    "artifactSha256": hashlib.sha256(sbom.read_bytes()).hexdigest(),
                    "mode": "0644",
                },
            },
            sort_keys=True,
        ),
        encoding="utf-8",
    )
    return source, sbom, lock


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
        )
        pattern = re.compile(
            r"\b(?:podman|buildah|nerdctl)\b|\bdocker\s+(?:build|run)\b"
        )
        for path in paths:
            self.assertIsNone(pattern.search(path.read_text(encoding="utf-8")), path)

    def test_browser_and_outer_packages_ship_one_searxng_executable(self) -> None:
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
        packager = (
            CHECKOUT / "toolkit" / "mozapps" / "installer" / "packager.py"
        ).read_text(encoding="utf-8")
        agent_experiment = (
            CHECKOUT
            / "wildbuzzard"
            / "browser"
            / "extensions"
            / "agent-sidebar"
            / "experiment-apis"
            / "wildbuzzardAgent.js"
        ).read_text(encoding="utf-8")
        appimage = (
            CHECKOUT / "wildbuzzard" / "scripts" / "package-appimage.sh"
        ).read_text(encoding="utf-8")
        debian = (CHECKOUT / "wildbuzzard" / "scripts" / "package-deb.sh").read_text(
            encoding="utf-8"
        )
        self.assertIn("--with-wildbuzzard-searxng-executable", configure)
        self.assertIn("validate-searxng-executable.py", configure)
        self.assertIn('FINAL_TARGET_FILES.runtime["search"]', mozbuild)
        self.assertIn("copy_validated_searxng_executable.py", mozbuild)
        self.assertIn("--searxng-executable", external)
        self.assertIn("validate-searxng-executable.py", external)
        self.assertIn("--searxng-release-source", external)
        self.assertIn("--searxng-release-sbom", external)
        self.assertIn("validate-searxng-release-assets.py", external)
        self.assertIn(
            'WILDBUZZARD_SEARXNG_TEST_EXECUTABLE="${searxng_executable}"',
            external,
        )
        self.assertIn(
            f"@BINPATH@/runtime/search/{SEARXNG_NAME}",
            package_manifest,
        )
        self.assertIn(
            "@BINPATH@/runtime/jackett-mini/wildbuzzard-jackett-mini-runtime.zip",
            package_manifest,
        )
        self.assertIn("validate-searxng-executable.py", appimage)
        self.assertIn("validate-pi-web-runtime-archive.py", appimage)
        self.assertIn("pi-web-runtime-lock.json", appimage)
        self.assertIn("validate-searxng-executable.py", debian)
        self.assertIn("validate-pi-web-runtime-archive.py", debian)
        self.assertIn("pi-web-runtime-lock.json", debian)
        self.assertIn(SEARXNG_NAME, appimage)
        self.assertIn(SEARXNG_NAME, debian)
        self.assertIn('MOZ_APP_BASENAME") == "WildBuzzard"', packager)
        self.assertIn(SEARXNG_NAME, packager)
        self.assertIn('"bin/runtime/tor/arti"', packager)
        self.assertIn("preserve_executables=preserve_executables", packager)
        self.assertIn(
            'Cu.importGlobalProperties(["TextDecoder", "TextEncoder"]);',
            agent_experiment,
        )
        self.assertIn(
            "for (const [entry, metadata] of bundle.centralEntries)",
            agent_experiment,
        )
        self.assertNotIn("zip.findEntries(null)", agent_experiment)
        self.assertIn(
            "bytes = new Uint8Array(\n            NetUtil.readInputStream",
            agent_experiment,
        )
        self.assertIn("commandExecutable.normalize();", agent_experiment)
        self.assertIn("commandScript.normalize();", agent_experiment)
        for runtime_path in (
            "runtime/pi-web/wildbuzzard-pi-web-runtime.zip",
            "runtime/torrent/wildbuzzard-torrent-runtime.zip",
            "runtime/jackett-mini/wildbuzzard-jackett-mini-runtime.zip",
            "runtime/tor/arti",
            "runtime/tor/arti.toml",
        ):
            self.assertIn(runtime_path, appimage)
        for source in (
            configure,
            mozbuild,
            external,
            package_manifest,
            appimage,
            debian,
        ):
            self.assertNotIn("--searxng-runtime", source)
            self.assertNotIn("--searxng-source", source)
        self.assertNotIn("wildbuzzard-searxng-runtime.zip", package_manifest)
        self.assertNotIn(
            "wildbuzzard-searxng-2026.8.6+b023a28ba-source.tar.xz", package_manifest
        )
        self.assertNotIn("searxng-release.cdx.json", package_manifest)

    def test_release_assets_are_validated_and_staged_separately(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            source, sbom, lock = searxng_release_inputs(root)
            output = root / "artifacts"
            result = subprocess.run(
                [
                    sys.executable,
                    "-I",
                    "-B",
                    CHECKOUT / "wildbuzzard/scripts/validate-searxng-release-assets.py",
                    "--source",
                    source,
                    "--sbom",
                    sbom,
                    "--lock",
                    lock,
                    "--output-dir",
                    output,
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            for original in (source, sbom):
                staged = output / original.name
                self.assertEqual(staged.read_bytes(), original.read_bytes())
                self.assertEqual(staged.stat().st_mode & 0o777, 0o644)
                checksum = output / f"{original.name}.sha256"
                self.assertTrue(
                    checksum.read_text(encoding="utf-8").endswith(
                        f"  {original.name}\n"
                    )
                )

    def test_release_asset_validator_rejects_tamper_mode_and_symlink(self) -> None:
        for state in ("tampered", "mode", "symlink"):
            with self.subTest(state=state), tempfile.TemporaryDirectory() as temporary:
                root = pathlib.Path(temporary)
                source, sbom, lock = searxng_release_inputs(root)
                if state == "tampered":
                    source.write_bytes(b"tampered source\n")
                elif state == "mode":
                    source.chmod(0o600)
                else:
                    target = root / "source-target"
                    source.rename(target)
                    source.symlink_to(target.name)
                result = subprocess.run(
                    [
                        sys.executable,
                        "-I",
                        "-B",
                        CHECKOUT
                        / "wildbuzzard/scripts/validate-searxng-release-assets.py",
                        "--source",
                        source,
                        "--sbom",
                        sbom,
                        "--lock",
                        lock,
                    ],
                    capture_output=True,
                    text=True,
                    check=False,
                )
                self.assertNotEqual(result.returncode, 0)

    def test_appimage_rejects_a_tampered_executable_before_packaging(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            package = host_native_release_archive(
                root, "wildbuzzard.tar.gz", searxng_state="tampered"
            )
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
                    "requires --searxng-executable",
                    result.stderr,
                )

    def test_external_rejects_missing_mode_and_symlink_inputs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            executable = root / SEARXNG_NAME
            executable.write_bytes(b"test\n")
            executable.chmod(0o755)
            cases = (
                (root / "missing.AppImage", "regular file"),
                (root / "mode.AppImage", "mode 0755"),
                (root / "link.AppImage", "regular file"),
            )
            cases[1][0].write_bytes(b"test\n")
            cases[1][0].chmod(0o644)
            cases[2][0].symlink_to(executable)
            for path, expected in cases:
                result = subprocess.run(
                    [
                        CHECKOUT / "wildbuzzard/scripts/build-linux-external.sh",
                        "--searxng-executable",
                        path,
                    ],
                    capture_output=True,
                    text=True,
                    check=False,
                )
                self.assertEqual(result.returncode, 2)
                self.assertIn(expected, result.stderr)

    def test_external_rejects_a_tampered_executable(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            executable = pathlib.Path(temporary) / SEARXNG_NAME
            executable.write_bytes(b"tampered\n")
            executable.chmod(0o755)
            result = subprocess.run(
                [
                    CHECKOUT / "wildbuzzard/scripts/build-linux-external.sh",
                    "--searxng-executable",
                    executable,
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertNotEqual(result.returncode, 0)

    def test_release_actions_require_all_host_native_runtimes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            searxng_executable = root / SEARXNG_NAME
            searxng_executable.write_bytes(b"invalid")
            searxng_executable.chmod(0o755)
            source, sbom, _ = searxng_release_inputs(root)
            fake_bin = root / "bin"
            fake_bin.mkdir()
            python = fake_bin / "python3"
            python.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            python.chmod(0o755)
            environment = os.environ.copy()
            environment["PATH"] = f"{fake_bin}:/usr/bin:/bin"
            result = subprocess.run(
                [
                    CHECKOUT / "wildbuzzard" / "scripts" / "build-linux-external.sh",
                    "--action",
                    "appimage",
                    "--build-root",
                    root / "build",
                    "--searxng-executable",
                    searxng_executable,
                    "--searxng-release-source",
                    source,
                    "--searxng-release-sbom",
                    sbom,
                ],
                capture_output=True,
                text=True,
                check=False,
                env=environment,
            )
            self.assertEqual(result.returncode, 2)
            self.assertIn("requires --pi-web-runtime", result.stderr)

    def test_release_actions_require_searxng_release_assets(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            executable = root / SEARXNG_NAME
            executable.write_bytes(b"invalid")
            executable.chmod(0o755)
            fake_bin = root / "bin"
            fake_bin.mkdir()
            python = fake_bin / "python3"
            python.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            python.chmod(0o755)
            environment = os.environ.copy()
            environment["PATH"] = f"{fake_bin}:/usr/bin:/bin"
            result = subprocess.run(
                [
                    CHECKOUT / "wildbuzzard/scripts/build-linux-external.sh",
                    "--action",
                    "package",
                    "--build-root",
                    root / "build",
                    "--searxng-executable",
                    executable,
                ],
                capture_output=True,
                text=True,
                check=False,
                env=environment,
            )
            self.assertEqual(result.returncode, 2)
            self.assertIn("requires --searxng-release-source", result.stderr)

    def test_appimage_rejects_a_release_without_searxng(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            package = host_native_release_archive(
                root, "wildbuzzard.tar.gz", searxng_state="missing"
            )
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
            self.assertIn("missing the required SearXNG executable", result.stderr)
            self.assertFalse(marker.exists())

    def test_appimage_rejects_wrong_mode_and_symlink_executables(self) -> None:
        for state, expected in (
            ("mode", "must have mode 0755"),
            ("symlink", "missing the required SearXNG executable"),
        ):
            with self.subTest(state=state), tempfile.TemporaryDirectory() as temporary:
                root = pathlib.Path(temporary)
                package = host_native_release_archive(
                    root, "wildbuzzard.tar.gz", searxng_state=state
                )
                marker = root / "appimagetool-ran"
                appimagetool = root / "appimagetool"
                appimagetool.write_text(
                    f"#!/bin/sh\ntouch -- {marker}\n", encoding="utf-8"
                )
                appimagetool.chmod(0o755)
                result = subprocess.run(
                    [
                        CHECKOUT / "wildbuzzard/scripts/package-appimage.sh",
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
                self.assertIn(expected, result.stderr)
                self.assertFalse(marker.exists())

    def test_appimage_requires_every_host_native_runtime(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            missing = "runtime/jackett-mini/wildbuzzard-jackett-mini-runtime.zip"
            package = host_native_release_archive(
                root, "wildbuzzard.tar.gz", missing=(missing,)
            )
            appimagetool, environment = fake_packaging_tools(root)
            marker = root / "appimagetool-ran"
            environment["TEST_MARKER"] = str(marker)
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
                env=environment,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(
                f"missing required host-native runtime: {missing}", result.stderr
            )
            self.assertFalse(marker.exists())

    def test_appimage_handles_spaces_unicode_and_extract_and_run(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            package = host_native_release_archive(
                root, "distribution path Ω/wildbuzzard release Ω.tar.gz"
            )
            output = root / "output path Ω"
            appimagetool, environment = fake_packaging_tools(root)
            marker = root / "appimagetool arguments"
            environment["TEST_MARKER"] = str(marker)
            result = subprocess.run(
                [
                    CHECKOUT / "wildbuzzard" / "scripts" / "package-appimage.sh",
                    "--dist-dir",
                    package.parent,
                    "--output-dir",
                    output,
                    "--appimagetool",
                    appimagetool,
                    "--package",
                    package,
                ],
                capture_output=True,
                text=True,
                check=False,
                env=environment,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            appimage = output / "WildBuzzard-1.0-x86_64.AppImage"
            self.assertTrue(appimage.exists())
            self.assertEqual(
                marker.read_text(encoding="utf-8").splitlines(),
                [
                    "1",
                    "x86_64",
                    str(output / "appimage-staging" / "WildBuzzard.AppDir"),
                    str(appimage),
                ],
            )
            nested = (
                output
                / "appimage-staging"
                / "WildBuzzard.AppDir"
                / "usr"
                / "lib"
                / "wildbuzzard"
                / "runtime"
                / "search"
                / SEARXNG_NAME
            )
            self.assertEqual(nested.stat().st_mode & 0o777, 0o755)

    def test_appimage_rejects_the_obsolete_runtime_zip(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            package = host_native_release_archive(
                root, "wildbuzzard.tar.gz", searxng_state="obsolete"
            )
            appimagetool, environment = fake_packaging_tools(root)
            environment["TEST_MARKER"] = str(root / "appimagetool-ran")
            result = subprocess.run(
                [
                    CHECKOUT / "wildbuzzard/scripts/package-appimage.sh",
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
                env=environment,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("obsolete SearXNG payload", result.stderr)

    def test_debian_rejects_a_tampered_executable_before_packaging(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            package = host_native_release_archive(
                root,
                "wildbuzzard-1.0.en-US.linux-x86_64.tar.gz",
                searxng_state="tampered",
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

    def test_debian_rejects_a_release_without_searxng(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            package = host_native_release_archive(
                root,
                "wildbuzzard-1.0.en-US.linux-x86_64.tar.gz",
                searxng_state="missing",
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
            self.assertIn("missing the required SearXNG executable", result.stderr)

    def test_debian_requires_pi_web_runtime(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            package = host_native_release_archive(
                root,
                "wildbuzzard-1.0.en-US.linux-x86_64.tar.gz",
                missing=("runtime/pi-web/wildbuzzard-pi-web-runtime.zip",),
            )
            dist = root / "dist"
            dist.mkdir()
            package.rename(dist / package.name)
            _, environment = fake_packaging_tools(root)
            result = subprocess.run(
                [
                    CHECKOUT / "wildbuzzard/scripts/package-deb.sh",
                    "--dist-dir",
                    dist,
                    "--output-dir",
                    root / "output",
                ],
                capture_output=True,
                text=True,
                check=False,
                env=environment,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("missing a required host-native runtime", result.stderr)

    def test_debian_rejects_wrong_mode_and_symlink_executables(self) -> None:
        for state, expected in (
            ("mode", "must have mode 0755"),
            ("symlink", "missing the required SearXNG executable"),
        ):
            with self.subTest(state=state), tempfile.TemporaryDirectory() as temporary:
                root = pathlib.Path(temporary)
                package = host_native_release_archive(
                    root,
                    "wildbuzzard-1.0.en-US.linux-x86_64.tar.gz",
                    searxng_state=state,
                )
                dist = root / "dist"
                dist.mkdir()
                package.rename(dist / package.name)
                result = subprocess.run(
                    [
                        CHECKOUT / "wildbuzzard/scripts/package-deb.sh",
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
                self.assertIn(expected, result.stderr)

    def test_debian_embeds_only_the_executable_with_mode_0755(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            package = host_native_release_archive(
                root, "wildbuzzard-1.0.en-US.linux-x86_64.tar.gz"
            )
            dist = root / "dist"
            dist.mkdir()
            package.rename(dist / package.name)
            _, environment = fake_packaging_tools(root)
            result = subprocess.run(
                [
                    CHECKOUT / "wildbuzzard/scripts/package-deb.sh",
                    "--dist-dir",
                    dist,
                    "--output-dir",
                    root / "output",
                ],
                capture_output=True,
                text=True,
                check=False,
                env=environment,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            extracted = root / "extracted"
            subprocess.run(
                [
                    "dpkg-deb",
                    "--extract",
                    root / "output/wildbuzzard_1.0_amd64.deb",
                    extracted,
                ],
                check=True,
            )
            product = extracted / "opt" / "wildbuzzard"
            nested = product / "runtime" / "search" / SEARXNG_NAME
            self.assertEqual(nested.stat().st_mode & 0o777, 0o755)
            self.assertFalse(
                (product / "runtime/search/wildbuzzard-searxng-runtime.zip").exists()
            )
            self.assertFalse(
                (
                    product
                    / "notices/source/wildbuzzard-searxng-2026.8.6+b023a28ba-source.tar.xz"
                ).exists()
            )
            self.assertFalse(
                (product / "notices/source/searxng-release.cdx.json").exists()
            )

    def test_agent_search_uses_only_the_browser_control_capability(self) -> None:
        manager = (
            CHECKOUT
            / "wildbuzzard"
            / "browser"
            / "components"
            / "websearch"
            / "SearXNGManager.sys.mjs"
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
            CHECKOUT / "agent" / "extensions" / "web-access" / "searxng.ts"
        ).read_text(encoding="utf-8")
        self.assertIn("requestSearXNGUDS", manager)
        self.assertIn('common.push(\n        "--cache-dir"', manager)
        self.assertNotIn("127.0.0.1", manager)
        self.assertNotIn("SearXNGRuntime", agent)
        self.assertIn("WILDBUZZARD_BROWSER_CONTROL_FILE", agent)
        self.assertIn('await call(\n      "native_search"', web_access)
        self.assertNotIn("requestSearchService", web_access)
        self.assertNotIn("process.env", web_access)

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
