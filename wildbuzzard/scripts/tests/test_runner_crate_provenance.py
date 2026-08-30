#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later

import gzip
import hashlib
import importlib.util
import io
import json
import pathlib
import shutil
import tarfile
import tempfile
import unittest


HERE = pathlib.Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    "runner_crate_provenance",
    HERE.parents[1] / "scripts" / "runner_crate_provenance.py",
)
PROVENANCE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROVENANCE)
RUNNER = HERE.parents[1] / "components" / "wildbuzzard-cli" / "runner"


def canonical_json(value):
    return json.dumps(value, indent=2, sort_keys=True) + "\n"


def tar_member(name, value):
    member = tarfile.TarInfo(name)
    member.size = len(value)
    member.mode = 0o644
    member.mtime = 0
    member.uid = 0
    member.gid = 0
    return member, io.BytesIO(value)


class RunnerCrateProvenanceTests(unittest.TestCase):
    def actual_paths(self):
        third_party = RUNNER / "third_party"
        return (
            RUNNER / "Cargo.lock",
            third_party / "THIRD-PARTY.json",
            third_party / "licenses",
        )

    def copy_actual(self, root):
        runner = root / "runner"
        runner.mkdir()
        shutil.copy2(RUNNER / "Cargo.lock", runner / "Cargo.lock")
        shutil.copytree(RUNNER / "third_party", runner / "third_party")
        return (
            runner / "Cargo.lock",
            runner / "third_party/THIRD-PARTY.json",
            runner / "third_party/licenses",
        )

    def make_fixture(self, root):
        runner = root / "runner"
        license_root = runner / "third_party/licenses"
        cache = root / "cache"
        license_root.mkdir(parents=True)
        cache.mkdir()
        license_bytes = b"demo license\n"
        license_path = license_root / "MIT.txt"
        license_path.write_bytes(license_bytes)
        prefix = "demo-1.2.3"
        cargo = b"""[package]
name = "demo"
version = "1.2.3"
license = "MIT"
repository = "https://example.test/demo"
"""
        vcs = json.dumps(
            {"git": {"sha1": "a" * 40}, "path_in_vcs": ""},
            sort_keys=True,
        ).encode()
        crate_buffer = io.BytesIO()
        with gzip.GzipFile(
            fileobj=crate_buffer, mode="wb", filename="", mtime=0
        ) as compressed:
            with tarfile.open(
                fileobj=compressed, mode="w", format=tarfile.USTAR_FORMAT
            ) as archive:
                for name, value in (
                    (f"{prefix}/.cargo_vcs_info.json", vcs),
                    (f"{prefix}/Cargo.toml", cargo),
                    (f"{prefix}/LICENSE", license_bytes),
                    (f"{prefix}/src/lib.rs", b"pub fn demo() {}\n"),
                ):
                    archive.addfile(*tar_member(name, value))
        crate_bytes = crate_buffer.getvalue()
        crate_digest = hashlib.sha256(crate_bytes).hexdigest()
        crate_path = cache / f"{prefix}.crate"
        crate_path.write_bytes(crate_bytes)
        lock = runner / "Cargo.lock"
        lock.write_text(
            f"""version = 4

[[package]]
name = "demo"
version = "1.2.3"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "{crate_digest}"

[[package]]
name = "wildbuzzard-native-client"
version = "0.1.0"
dependencies = [
 "demo",
]
""",
            encoding="utf-8",
        )
        inventory = {
            "cargoLock": {
                "path": "Cargo.lock",
                "sha256": PROVENANCE.sha256_file(lock),
            },
            "packages": [
                {
                    "license": "MIT",
                    "licenseFiles": [
                        {
                            "installedPath": "licenses/MIT.txt",
                            "sha256": hashlib.sha256(license_bytes).hexdigest(),
                            "sourcePath": "LICENSE",
                        }
                    ],
                    "name": "demo",
                    "repository": "https://example.test/demo",
                    "source": "registry+https://github.com/rust-lang/crates.io-index",
                    "sourceArchive": {
                        "sha256": crate_digest,
                        "url": "https://static.crates.io/crates/demo/demo-1.2.3.crate",
                    },
                    "vcs": {"commit": "a" * 40, "path": ""},
                    "version": "1.2.3",
                }
            ],
            "schema": 1,
            "sourceBundle": {
                "file": "wildbuzzard-runner-crates-source.tar.xz",
                "sha256": "0" * 64,
            },
        }
        inventory_path = runner / "third_party/THIRD-PARTY.json"
        inventory_path.write_text(canonical_json(inventory), encoding="utf-8")
        return lock, inventory_path, license_root, cache, inventory

    def test_checked_in_inventory_exactly_covers_lock_and_license_bytes(self):
        inventory = PROVENANCE.validate_inventory(*self.actual_paths())
        self.assertEqual(len(inventory["packages"]), 11)

    def test_rejects_lock_inventory_license_and_extra_file_drift(self):
        with tempfile.TemporaryDirectory() as directory:
            lock, inventory_path, license_root = self.copy_actual(
                pathlib.Path(directory)
            )
            inventory = json.loads(inventory_path.read_text(encoding="utf-8"))
            inventory["packages"].pop()
            inventory_path.write_text(canonical_json(inventory), encoding="utf-8")
            with self.assertRaises(PROVENANCE.ValidationError):
                PROVENANCE.validate_inventory(lock, inventory_path, license_root)

        with tempfile.TemporaryDirectory() as directory:
            lock, inventory_path, license_root = self.copy_actual(
                pathlib.Path(directory)
            )
            (license_root / "fixture.txt").write_text("unexpected\n", encoding="utf-8")
            with self.assertRaises(PROVENANCE.ValidationError):
                PROVENANCE.validate_inventory(lock, inventory_path, license_root)

        with tempfile.TemporaryDirectory() as directory:
            lock, inventory_path, license_root = self.copy_actual(
                pathlib.Path(directory)
            )
            license_path = license_root / "MIT-dtolnay-serde.txt"
            license_path.write_text("tampered\n", encoding="utf-8")
            with self.assertRaises(PROVENANCE.ValidationError):
                PROVENANCE.validate_inventory(lock, inventory_path, license_root)

    def test_source_bundle_is_reproducible_complete_and_digest_pinned(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            lock, inventory_path, license_root, cache, inventory = self.make_fixture(
                root
            )
            packages = PROVENANCE.validate_inventory(
                lock, inventory_path, license_root
            )["packages"]
            first_dir = root / "first"
            second_dir = root / "second"
            first_dir.mkdir()
            second_dir.mkdir()
            first = first_dir / "wildbuzzard-runner-crates-source.tar.xz"
            second = second_dir / "wildbuzzard-runner-crates-source.tar.xz"
            crate_paths = [cache / "demo-1.2.3.crate"]
            PROVENANCE.write_source_bundle(first, packages, crate_paths)
            PROVENANCE.write_source_bundle(second, packages, crate_paths)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            inventory["sourceBundle"]["sha256"] = PROVENANCE.sha256_file(first)
            inventory_path.write_text(canonical_json(inventory), encoding="utf-8")
            checked = PROVENANCE.validate_inventory(lock, inventory_path, license_root)
            PROVENANCE.verify_source_bundle(first, checked, license_root)
            first.write_bytes(first.read_bytes() + b"tampered")
            with self.assertRaises(PROVENANCE.ValidationError):
                PROVENANCE.verify_source_bundle(first, checked, license_root)


if __name__ == "__main__":
    unittest.main()
