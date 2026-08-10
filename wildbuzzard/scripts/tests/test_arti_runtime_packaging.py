# SPDX-License-Identifier: AGPL-3.0-or-later

import hashlib
import importlib.util
import io
import json
import stat
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path

SCRIPTS = Path(__file__).parents[1]
MODULE_PATH = SCRIPTS / "arti-runtime-provenance.py"
SPEC = importlib.util.spec_from_file_location("arti_runtime_provenance", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def sha256(value):
    return hashlib.sha256(value).hexdigest()


class ArtiRuntimePackagingTests(unittest.TestCase):
    def fixture(self, root):
        binary_bytes = b"source-built arti binary"
        cargo_lock = b"""version = 4

[[package]]
name = "arti"
version = "2.5.1"

[[package]]
name = "subtle"
version = "2.6.1"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
"""
        source_buffer = io.BytesIO()
        with tarfile.open(fileobj=source_buffer, mode="w:xz") as archive:
            cargo_entry = tarfile.TarInfo(f"arti-{MODULE.VERSION}/Cargo.lock")
            cargo_entry.size = len(cargo_lock)
            cargo_entry.mode = 0o644
            archive.addfile(cargo_entry, io.BytesIO(cargo_lock))
        source_bytes = source_buffer.getvalue()
        apache_bytes = b"Apache license"
        mit_bytes = b"MIT license"
        binary = root / "arti"
        binary.write_bytes(binary_bytes)
        binary.chmod(0o755)
        source = root / "source.tar.xz"
        source.write_bytes(source_bytes)
        pin_config = root / "wildbuzzard" / "third_party" / "arti.toml"
        pin_config.parent.mkdir(parents=True)
        licenses = root / "third_party" / "arti"
        licenses.mkdir(parents=True)
        (licenses / "LICENSE-APACHE").write_bytes(apache_bytes)
        (licenses / "LICENSE-MIT").write_bytes(mit_bytes)
        pin_config.write_text(
            "\n".join([
                'name = "Arti"',
                'repository = "https://gitlab.torproject.org/tpo/core/arti.git"',
                f'tag = "arti-v{MODULE.VERSION}"',
                f'tag_object = "{"a" * 40}"',
                f'commit = "{"b" * 40}"',
                f'tree = "{"c" * 40}"',
                "source_date_epoch = 1785790436",
                'subtree = "third_party/arti"',
                'rust_version = "1.91"',
                'build_rustc = "rustc test"',
                'build_cargo = "cargo test"',
                'license = "MIT OR Apache-2.0"',
                f'source_sha256 = "{sha256(source_bytes)}"',
                f'cargo_lock_sha256 = "{sha256(cargo_lock)}"',
                f'license_apache_sha256 = "{sha256(apache_bytes)}"',
                f'license_mit_sha256 = "{sha256(mit_bytes)}"',
                f'linux_x86_64_binary_sha256 = "{sha256(binary_bytes)}"',
                "",
            ]),
            encoding="utf-8",
        )
        provenance = root / "provenance.zip"
        MODULE.create(binary, pin_config, source, provenance, 1_785_790_436)
        return binary, pin_config, provenance

    def rewrite(self, archive_path, *, replace=None, omit=(), extra=None):
        replace = replace or {}
        with zipfile.ZipFile(archive_path) as source:
            entries = [
                (entry, replace.get(entry.filename, source.read(entry)))
                for entry in source.infolist()
                if entry.filename not in omit
            ]
        if extra:
            entry = zipfile.ZipInfo(extra[0], (2026, 8, 3, 20, 53, 56))
            entry.create_system = 3
            entry.external_attr = (stat.S_IFREG | 0o644) << 16
            entry.compress_type = zipfile.ZIP_STORED
            entries.append((entry, extra[1]))
        with zipfile.ZipFile(
            archive_path, "w", compression=zipfile.ZIP_STORED
        ) as output:
            for entry, value in entries:
                output.writestr(entry, value)

    def test_create_and_validate_pinned_provenance(self):
        with tempfile.TemporaryDirectory() as temporary:
            binary, config, provenance = self.fixture(Path(temporary))
            manifest = MODULE.validate(binary, config, config, provenance)
            self.assertEqual(manifest["component"], "arti")
            self.assertEqual(manifest["correspondingSource"], MODULE.SOURCE)
            self.assertEqual(manifest["sbom"], MODULE.SBOM)
            self.assertEqual(manifest["licenseLocations"], list(MODULE.LICENSES))
            with zipfile.ZipFile(provenance) as archive:
                sbom = archive.read(MODULE.SBOM)
            components = json.loads(sbom)["components"]
            self.assertEqual(
                [component["bom-ref"] for component in components],
                [
                    "wildbuzzard-arti-source-2.5.1",
                    "pkg:cargo/arti@2.5.1",
                    "pkg:cargo/subtle@2.6.1",
                ],
            )

    def test_provenance_archive_is_reproducible(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binary, config, first = self.fixture(root)
            source = root / "source.tar.xz"
            second = root / "second.zip"
            MODULE.create(binary, config, source, second, 1_785_790_436)
            self.assertEqual(first.read_bytes(), second.read_bytes())

    def test_rejects_tampered_binary(self):
        with tempfile.TemporaryDirectory() as temporary:
            binary, config, provenance = self.fixture(Path(temporary))
            binary.write_bytes(b"tampered")
            with self.assertRaisesRegex(ValueError, "binary differs"):
                MODULE.validate(binary, config, config, provenance)

    def test_rejects_non_executable_binary(self):
        with tempfile.TemporaryDirectory() as temporary:
            binary, config, provenance = self.fixture(Path(temporary))
            binary.chmod(0o644)
            with self.assertRaisesRegex(ValueError, "not executable"):
                MODULE.validate(binary, config, config, provenance)

    def test_rejects_tampered_installed_config(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binary, config, provenance = self.fixture(root)
            installed = root / "installed.toml"
            installed.write_bytes(config.read_bytes() + b"tampered\n")
            with self.assertRaisesRegex(ValueError, "installed Arti pin metadata"):
                MODULE.validate(binary, config, installed, provenance)

    def test_rejects_tampered_source(self):
        with tempfile.TemporaryDirectory() as temporary:
            binary, config, provenance = self.fixture(Path(temporary))
            self.rewrite(provenance, replace={MODULE.SOURCE: b"tampered"})
            with self.assertRaisesRegex(ValueError, "source differs"):
                MODULE.validate(binary, config, config, provenance)

    def test_rejects_tampered_sbom(self):
        with tempfile.TemporaryDirectory() as temporary:
            binary, config, provenance = self.fixture(Path(temporary))
            self.rewrite(provenance, replace={MODULE.SBOM: b"{}\n"})
            with self.assertRaisesRegex(ValueError, "manifest differs"):
                MODULE.validate(binary, config, config, provenance)

    def test_rejects_missing_license(self):
        with tempfile.TemporaryDirectory() as temporary:
            binary, config, provenance = self.fixture(Path(temporary))
            self.rewrite(provenance, omit=(MODULE.LICENSES[0],))
            with self.assertRaisesRegex(ValueError, "archive layout"):
                MODULE.validate(binary, config, config, provenance)

    def test_rejects_unexpected_or_unsafe_member(self):
        for name in ("unexpected", "../escape"):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                binary, config, provenance = self.fixture(Path(temporary))
                self.rewrite(provenance, extra=(name, b"tampered"))
                with self.assertRaisesRegex(ValueError, "archive layout"):
                    MODULE.validate(binary, config, config, provenance)

    def test_rejects_noncanonical_archive_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            binary, config, provenance = self.fixture(Path(temporary))
            provenance.write_bytes(provenance.read_bytes() + b"tampered")
            with self.assertRaisesRegex(ValueError, "not canonical"):
                MODULE.validate(binary, config, config, provenance)

    def test_shipping_integration_declares_provenance_gate(self):
        root = SCRIPTS.parent
        mozbuild = (root / "moz.build").read_text(encoding="utf-8")
        configure = (root / "moz.configure").read_text(encoding="utf-8")
        appimage_package = (SCRIPTS / "package-appimage.sh").read_text(encoding="utf-8")
        deb_package = (SCRIPTS / "package-deb.sh").read_text(encoding="utf-8")
        manifest = (
            root.parent / "browser" / "installer" / "package-manifest.in"
        ).read_text(encoding="utf-8")
        for value in (mozbuild, appimage_package, deb_package, manifest):
            self.assertIn("wildbuzzard-arti-2.5.1-provenance.zip", value)
        self.assertIn("--with-wildbuzzard-arti-provenance", configure)
        self.assertIn("arti-runtime-provenance.py", configure)
        self.assertIn("arti-runtime-provenance.py", appimage_package)
        self.assertIn("arti-runtime-provenance.py", deb_package)


if __name__ == "__main__":
    unittest.main()
