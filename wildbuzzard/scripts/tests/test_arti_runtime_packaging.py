# SPDX-License-Identifier: AGPL-3.0-or-later

import hashlib
import importlib.util
import json
import stat
import tempfile
import unittest
import zipfile
from pathlib import Path

SCRIPTS = Path(__file__).parents[1]
MODULE_PATH = SCRIPTS / "arti-runtime-provenance.py"
SPEC = importlib.util.spec_from_file_location("arti_runtime_provenance", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
COPY_MODULE_PATH = SCRIPTS.parent / "copy_executable.py"
COPY_SPEC = importlib.util.spec_from_file_location("copy_executable", COPY_MODULE_PATH)
COPY_MODULE = importlib.util.module_from_spec(COPY_SPEC)
COPY_SPEC.loader.exec_module(COPY_MODULE)


def sha256(value):
    return hashlib.sha256(value).hexdigest()


class ArtiRuntimePackagingTests(unittest.TestCase):
    def test_executable_copy_preserves_bytes_and_sets_mode(self):
        class Output:
            def __init__(self, path):
                self.name = str(path)

            def avoid_writing_to_file(self):
                pass

            def close(self):
                pass

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            destination = root / "destination"
            source.write_bytes(b"executable bytes")
            source.chmod(0o644)
            COPY_MODULE.main(Output(destination), source)
            self.assertEqual(destination.read_bytes(), source.read_bytes())
            self.assertEqual(stat.S_IMODE(destination.stat().st_mode), 0o755)

    def fixture(self, root):
        binary_bytes = b"source-built arti binary"
        source_bytes = b"Arti source archive"
        vendor_bytes = b"Cargo vendor source archive"
        cargo_lock_digest = "c" * 64
        inventory_value = {
            "schema": 1,
            "cargoLock": {"path": "Cargo.lock", "sha256": cargo_lock_digest},
            "sourceArtifacts": {
                "arti": {
                    "file": MODULE.ARTI_SOURCE,
                    "sha256": sha256(source_bytes),
                },
                "cargoVendor": {
                    "file": MODULE.CARGO_VENDOR_SOURCE,
                    "sha256": sha256(vendor_bytes),
                },
            },
            "packages": [
                {
                    "cargoChecksum": None,
                    "cargoSource": None,
                    "homepage": None,
                    "license": "MIT OR Apache-2.0",
                    "licenseFile": None,
                    "licenseFiles": [],
                    "name": "arti",
                    "repository": "https://example.invalid/arti",
                    "sourceArtifact": "arti",
                    "sourceDirectory": "crates/arti",
                    "version": MODULE.VERSION,
                },
                {
                    "cargoChecksum": "b" * 64,
                    "cargoSource": "registry+https://github.com/rust-lang/crates.io-index",
                    "homepage": None,
                    "license": "MIT",
                    "licenseFile": None,
                    "licenseFiles": [],
                    "name": "subtle",
                    "repository": "https://example.invalid/subtle",
                    "sourceArtifact": "cargoVendor",
                    "sourceDirectory": "subtle-2.6.1",
                    "version": "2.6.1",
                },
            ],
        }
        inventory_bytes = (
            json.dumps(inventory_value, indent=2, sort_keys=True) + "\n"
        ).encode()
        apache_bytes = b"Apache license"
        mit_bytes = b"MIT license"
        binary = root / "arti"
        binary.write_bytes(binary_bytes)
        binary.chmod(0o755)
        source = root / MODULE.ARTI_SOURCE
        source.write_bytes(source_bytes)
        cargo_vendor = root / MODULE.CARGO_VENDOR_SOURCE
        cargo_vendor.write_bytes(vendor_bytes)
        inventory = root / "THIRD-PARTY.json"
        inventory.write_bytes(inventory_bytes)
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
                f'cargo_lock_sha256 = "{cargo_lock_digest}"',
                f'cargo_vendor_sha256 = "{sha256(vendor_bytes)}"',
                f'cargo_license_inventory_sha256 = "{sha256(inventory_bytes)}"',
                f'license_apache_sha256 = "{sha256(apache_bytes)}"',
                f'license_mit_sha256 = "{sha256(mit_bytes)}"',
                f'linux_x86_64_binary_sha256 = "{sha256(binary_bytes)}"',
                "",
            ]),
            encoding="utf-8",
        )
        provenance = root / "provenance.zip"
        MODULE.create(
            binary,
            pin_config,
            source,
            cargo_vendor,
            inventory,
            provenance,
            1_785_790_436,
            root,
        )
        return binary, pin_config, inventory, source, cargo_vendor, provenance

    def validate(self, binary, config, inventory, provenance, installed=None):
        return MODULE.validate(
            binary, config, installed or config, inventory, provenance
        )

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
            binary, config, inventory, _, _, provenance = self.fixture(Path(temporary))
            manifest = self.validate(binary, config, inventory, provenance)
            self.assertEqual(manifest["component"], "arti")
            self.assertEqual(manifest["schemaVersion"], 2)
            self.assertEqual(
                [entry["name"] for entry in manifest["externalSourceArtifacts"]],
                [MODULE.ARTI_SOURCE, MODULE.CARGO_VENDOR_SOURCE],
            )
            with zipfile.ZipFile(provenance) as archive:
                self.assertNotIn(MODULE.ARTI_SOURCE, archive.namelist())
                self.assertNotIn(MODULE.CARGO_VENDOR_SOURCE, archive.namelist())
                components = json.loads(archive.read(MODULE.SBOM))["components"]
            self.assertEqual(
                [component["bom-ref"] for component in components],
                [
                    "wildbuzzard-arti-source-1",
                    "wildbuzzard-arti-source-2",
                    "pkg:cargo/arti@2.5.1",
                    "pkg:cargo/subtle@2.6.1",
                ],
            )

    def test_provenance_archive_is_reproducible(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binary, config, inventory, source, vendor, first = self.fixture(root)
            second = root / "second.zip"
            MODULE.create(
                binary,
                config,
                source,
                vendor,
                inventory,
                second,
                1_785_790_436,
            )
            self.assertEqual(first.read_bytes(), second.read_bytes())

    def test_rejects_tampered_binary_inventory_and_external_sources(self):
        with tempfile.TemporaryDirectory() as temporary:
            binary, config, inventory, source, vendor, provenance = self.fixture(
                Path(temporary)
            )
            binary.write_bytes(b"tampered")
            with self.assertRaisesRegex(ValueError, "binary differs"):
                self.validate(binary, config, inventory, provenance)
            binary.write_bytes(b"source-built arti binary")
            inventory.write_bytes(inventory.read_bytes() + b"tampered")
            with self.assertRaisesRegex(ValueError, "inventory differs"):
                self.validate(binary, config, inventory, provenance)
            inventory.write_bytes(inventory.read_bytes().removesuffix(b"tampered"))
            source.write_bytes(b"tampered")
            with self.assertRaisesRegex(ValueError, "source artifact differs"):
                MODULE.create(
                    binary,
                    config,
                    source,
                    vendor,
                    inventory,
                    Path(temporary) / "other.zip",
                    1_785_790_436,
                )

    def test_rejects_non_executable_binary_or_tampered_config(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binary, config, inventory, _, _, provenance = self.fixture(root)
            binary.chmod(0o644)
            with self.assertRaisesRegex(ValueError, "not executable"):
                self.validate(binary, config, inventory, provenance)
            binary.chmod(0o755)
            installed = root / "installed.toml"
            installed.write_bytes(config.read_bytes() + b"tampered\n")
            with self.assertRaisesRegex(ValueError, "installed Arti pin metadata"):
                self.validate(binary, config, inventory, provenance, installed)

    def test_binary_uses_the_runtime_size_cap(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binary, config, inventory, source, vendor, _ = self.fixture(root)
            value = b"\x7fELF" + b"\0" * MODULE.MAX_MEMBER_SIZE
            binary.write_bytes(value)
            config.write_text(
                config.read_text(encoding="utf-8").replace(
                    sha256(b"source-built arti binary"), sha256(value)
                ),
                encoding="utf-8",
            )
            provenance = root / "large-binary-provenance.zip"
            MODULE.create(
                binary,
                config,
                source,
                vendor,
                inventory,
                provenance,
                1_785_790_436,
            )
            self.validate(binary, config, inventory, provenance)
            with binary.open("r+b") as stream:
                stream.truncate(MODULE.MAX_BINARY_SIZE + 1)
            with self.assertRaisesRegex(ValueError, "unsafe Arti input"):
                self.validate(binary, config, inventory, provenance)

    def test_rejects_tampered_sbom_missing_license_or_unsafe_member(self):
        with tempfile.TemporaryDirectory() as temporary:
            binary, config, inventory, _, _, provenance = self.fixture(Path(temporary))
            self.rewrite(provenance, replace={MODULE.SBOM: b"{}\n"})
            with self.assertRaisesRegex(ValueError, "manifest differs"):
                self.validate(binary, config, inventory, provenance)
        with tempfile.TemporaryDirectory() as temporary:
            binary, config, inventory, _, _, provenance = self.fixture(Path(temporary))
            self.rewrite(provenance, omit=(MODULE.LICENSES[0],))
            with self.assertRaisesRegex(ValueError, "archive layout"):
                self.validate(binary, config, inventory, provenance)
        for name in ("unexpected", "../escape"):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                binary, config, inventory, _, _, provenance = self.fixture(
                    Path(temporary)
                )
                self.rewrite(provenance, extra=(name, b"tampered"))
                with self.assertRaisesRegex(ValueError, "archive layout"):
                    self.validate(binary, config, inventory, provenance)

    def test_rejects_noncanonical_archive_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            binary, config, inventory, _, _, provenance = self.fixture(Path(temporary))
            provenance.write_bytes(provenance.read_bytes() + b"tampered")
            with self.assertRaisesRegex(ValueError, "not canonical"):
                self.validate(binary, config, inventory, provenance)

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
        self.assertIn("--with-wildbuzzard-arti-config", configure)
        self.assertIn("--with-wildbuzzard-arti-provenance", configure)
        self.assertIn("arti-runtime-provenance.py", configure)
        self.assertIn("arti-runtime-provenance.py", appimage_package)
        self.assertIn("arti-runtime-provenance.py", deb_package)
        self.assertIn('arti_binary.script = "copy_executable.py"', mozbuild)


if __name__ == "__main__":
    unittest.main()
