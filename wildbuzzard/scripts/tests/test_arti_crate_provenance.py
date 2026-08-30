# SPDX-License-Identifier: AGPL-3.0-or-later

import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).parents[1] / "arti_crate_provenance.py"
SPEC = importlib.util.spec_from_file_location("arti_crate_provenance", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def digest(value):
    return hashlib.sha256(value).hexdigest()


class ArtiCrateProvenanceTests(unittest.TestCase):
    def make_fixture(self, root):
        source = root / "arti"
        local = source / "crates" / "arti-local"
        local.mkdir(parents=True)
        (source / "LICENSE-APACHE").write_text("Apache license\n", encoding="utf-8")
        (source / "LICENSE-MIT").write_text("MIT license\n", encoding="utf-8")
        (local / "Cargo.toml").write_text(
            """[package]
name = "arti-local"
version = "2.5.1"
license = "MIT OR Apache-2.0"
repository = "https://example.invalid/arti"
""",
            encoding="utf-8",
        )
        lock = """version = 4

[[package]]
name = "arti-local"
version = "2.5.1"

[[package]]
name = "registry-crate"
version = "1.2.3"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
"""
        (source / "Cargo.lock").write_text(lock, encoding="utf-8")

        vendor = root / "vendor"
        crate = vendor / "registry-crate-1.2.3"
        crate.mkdir(parents=True)
        files = {
            "Cargo.toml": b"""[package]
name = "registry-crate"
version = "1.2.3"
license = "BSD-3-Clause"
repository = "https://example.invalid/registry-crate"
homepage = "https://example.invalid/registry-crate/home"
""",
            "LICENSE": b"Registry license\n",
            "src/lib.rs": b"pub fn value() -> u8 { 1 }\n",
        }
        for name, value in files.items():
            path = crate / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(value)
        (crate / ".cargo-checksum.json").write_text(
            json.dumps(
                {
                    "files": {
                        name: digest(value) for name, value in sorted(files.items())
                    },
                    "package": "a" * 64,
                },
                separators=(",", ":"),
                sort_keys=True,
            ),
            encoding="utf-8",
        )

        bundle = root / MODULE.VENDOR_ARCHIVE
        MODULE.write_source_archive(vendor, bundle)
        pins = root / "arti.toml"
        self.write_pins(
            pins,
            cargo_lock=digest(lock.encode()),
            cargo_vendor="0" * 64,
            inventory="0" * 64,
        )
        legal = root / "legal"
        MODULE.generate_inventory(source, vendor, bundle, legal, pins)
        inventory_digest = MODULE.sha256_file(legal / "THIRD-PARTY.json")
        self.write_pins(
            pins,
            cargo_lock=digest(lock.encode()),
            cargo_vendor=MODULE.sha256_file(bundle),
            inventory=inventory_digest,
        )
        return source, vendor, bundle, legal, pins

    def write_pins(self, path, *, cargo_lock, cargo_vendor, inventory):
        path.write_text(
            "\n".join([
                f'source_sha256 = "{"b" * 64}"',
                f'cargo_lock_sha256 = "{cargo_lock}"',
                f'cargo_vendor_sha256 = "{cargo_vendor}"',
                f'cargo_license_inventory_sha256 = "{inventory}"',
                "",
            ]),
            encoding="utf-8",
        )

    def validate(self, source, legal, pins):
        return MODULE.validate_inventory(
            source / "Cargo.lock",
            legal / "THIRD-PARTY.json",
            legal / "licenses",
            pins,
        )

    def test_inventory_covers_local_and_registry_crates_and_exact_licenses(self):
        with tempfile.TemporaryDirectory() as directory:
            source, vendor, _, legal, pins = self.make_fixture(Path(directory))
            inventory = self.validate(source, legal, pins)
            self.assertEqual(
                [package["name"] for package in inventory["packages"]],
                ["arti-local", "registry-crate"],
            )
            self.assertEqual(
                {package["sourceArtifact"] for package in inventory["packages"]},
                {"arti", "cargoVendor"},
            )
            MODULE.compare_source_metadata(
                source,
                vendor,
                inventory,
                source / "Cargo.lock",
                legal / "licenses",
            )

    def test_rejects_missing_tampered_or_extra_installed_license(self):
        with tempfile.TemporaryDirectory() as directory:
            source, _, _, legal, pins = self.make_fixture(Path(directory))
            license_path = next((legal / "licenses").iterdir())
            original = license_path.read_bytes()
            license_path.write_bytes(b"tampered")
            with self.assertRaisesRegex(MODULE.ValidationError, "digest mismatch"):
                self.validate(source, legal, pins)
            license_path.write_bytes(original)
            (legal / "licenses" / ("f" * 64 + ".txt")).write_text(
                "extra\n", encoding="utf-8"
            )
            with self.assertRaisesRegex(MODULE.ValidationError, "missing or extra"):
                self.validate(source, legal, pins)

    def test_rejects_vendor_file_not_bound_by_cargo_checksum_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            source, vendor, _, legal, pins = self.make_fixture(Path(directory))
            (vendor / "registry-crate-1.2.3" / "unexpected").write_text(
                "not checksummed\n", encoding="utf-8"
            )
            inventory = self.validate(source, legal, pins)
            with self.assertRaisesRegex(MODULE.ValidationError, "file set or digest"):
                MODULE.compare_source_metadata(
                    source,
                    vendor,
                    inventory,
                    source / "Cargo.lock",
                    legal / "licenses",
                )

    def test_vendor_source_archive_is_reproducible_and_exact(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _, vendor, first, _, pins = self.make_fixture(root)
            second_root = root / "second"
            second_root.mkdir()
            second = second_root / MODULE.VENDOR_ARCHIVE
            MODULE.write_source_archive(vendor, second)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            expected = MODULE.load_pins(pins)["cargo_vendor_sha256"]
            MODULE.verify_source_archive(second, expected, vendor)
            second.write_bytes(second.read_bytes() + b"tampered")
            with self.assertRaisesRegex(MODULE.ValidationError, "digest mismatch"):
                MODULE.verify_source_archive(second, expected)


if __name__ == "__main__":
    unittest.main()
