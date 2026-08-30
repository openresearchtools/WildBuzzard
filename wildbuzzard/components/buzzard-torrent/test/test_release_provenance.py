#!/usr/bin/env python3

import hashlib
import importlib.util
import pathlib
import tarfile
import tempfile
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[3]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


PROVENANCE = load(
    "generate_qbittorrent_runtime_provenance",
    ROOT / "scripts" / "generate-qbittorrent-runtime-provenance.py",
)
VERIFY = load(
    "verify_qbittorrent_runtime",
    ROOT / "components" / "buzzard-torrent" / "scripts" / "verify-runtime.py",
)


class SourceProvenanceTests(unittest.TestCase):
    def test_parses_signed_debian_source_metadata_and_validates_hashes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            payload = root / "demo_1.0.orig.tar.xz"
            payload.write_bytes(b"exact source")
            sha256 = hashlib.sha256(payload.read_bytes()).hexdigest()
            dsc = root / "demo_1.0-1.dsc"
            dsc.write_text(
                "-----BEGIN PGP SIGNED MESSAGE-----\n"
                "Hash: SHA512\n\n"
                "Format: 3.0 (quilt)\n"
                "Source: demo\n"
                "Version: 1:1.0-1\n"
                "Checksums-Sha256:\n"
                f" {sha256} {payload.stat().st_size} {payload.name}\n"
                "-----BEGIN PGP SIGNATURE-----\n",
                encoding="utf-8",
            )
            (root / "validated").mkdir()
            with mock.patch.object(PROVENANCE.subprocess, "run") as run:
                files = PROVENANCE.validate_source_download(root, "demo", "1:1.0-1")
            run.assert_called_once()
            self.assertEqual({entry["name"] for entry in files}, {dsc.name, payload.name})

    def test_rejects_unlisted_debian_source_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            payload = root / "demo.tar.xz"
            payload.write_bytes(b"source")
            (root / "unexpected").write_bytes(b"not declared")
            dsc = root / "demo.dsc"
            dsc.write_text(
                "Source: demo\nVersion: 1\nChecksums-Sha256:\n"
                f" {hashlib.sha256(payload.read_bytes()).hexdigest()} {payload.stat().st_size} {payload.name}\n",
                encoding="utf-8",
            )
            with self.assertRaises(SystemExit):
                PROVENANCE.validate_source_download(root, "demo", "1")

    def test_system_source_archive_is_reproducible_and_normalized(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            download = root / "download"
            download.mkdir()
            (download / "demo.dsc").write_bytes(b"source metadata")
            first = root / "first.tar.xz"
            second = root / "second.tar.xz"
            manifest = {"schema": 1, "sourcePackages": [{"sourcePackage": "demo"}]}
            for output in (first, second):
                PROVENANCE.deterministic_source_bundle(
                    output,
                    "sources",
                    manifest,
                    {"demo": download},
                    1_700_000_000,
                )
            self.assertEqual(first.read_bytes(), second.read_bytes())
            with tarfile.open(first, "r:xz") as archive:
                for member in archive.getmembers():
                    self.assertEqual((member.uid, member.gid, member.mtime), (0, 0, 1_700_000_000))
                    self.assertFalse(member.issym() or member.islnk())


class RuntimeGateTests(unittest.TestCase):
    def test_runtime_paths_cannot_escape_the_package(self):
        root = pathlib.Path("/tmp/runtime")
        self.assertEqual(
            VERIFY.runtime_path(root, "licenses/component.txt"),
            root / "licenses/component.txt",
        )
        for value in ("", "/etc/passwd", "../outside", "licenses/../outside", "a\\b"):
            with self.subTest(value=value), self.assertRaises(SystemExit):
                VERIFY.runtime_path(root, value)

    def test_source_offer_requires_all_exact_artifact_classes(self):
        sources = {
            "core": {
                "name": "wildbuzzard-qbittorrent-runtime-123456789abc-source.tar.xz",
                "sha256": "d" * 64,
                "size": 4,
            },
            "boost": {
                "name": "wildbuzzard-qbittorrent-boost-1.88.0-source.tar.bz2",
                "sha256": "a" * 64,
                "size": 1,
            },
            "qt": {
                "name": "wildbuzzard-qbittorrent-qtbase-6.10.2-source.tar.xz",
                "sha256": "b" * 64,
                "size": 2,
            },
            "system": {
                "name": "wildbuzzard-qbittorrent-ubuntu-24.04-system-sources-123456789abc.tar.xz",
                "sha256": "c" * 64,
                "size": 3,
            },
        }
        VERIFY.validate_external_sources(sources)
        sources.pop("qt")
        with self.assertRaises(SystemExit):
            VERIFY.validate_external_sources(sources)

    def test_runtime_package_forbids_source_archives(self):
        self.assertIn(".xz", VERIFY.FORBIDDEN_SUFFIXES)
        self.assertIn(".bz2", VERIFY.FORBIDDEN_SUFFIXES)
        self.assertLessEqual(VERIFY.MAX_RUNTIME_BYTES, 128 * 1024 * 1024)

    def test_debian_build_runs_the_runtime_gate_before_and_after_copy(self):
        script = (
            ROOT / "components" / "buzzard-torrent" / "scripts" / "build-deb.sh"
        ).read_text(encoding="utf-8")
        self.assertEqual(script.count('scripts/verify-runtime.py"'), 2)
        self.assertIn("exceeds 96 MiB", script)

    def test_qbittorrent_builder_has_no_unresolved_spdx_placeholders(self):
        script = (ROOT / "scripts" / "build-qbittorrent-runtime.sh").read_text(
            encoding="utf-8"
        )
        generator = (
            ROOT / "scripts" / "generate-qbittorrent-runtime-provenance.py"
        ).read_text(encoding="utf-8")
        self.assertNotIn('"NOASSERTION"', script)
        self.assertNotIn('"NOASSERTION"', generator)


if __name__ == "__main__":
    unittest.main()
