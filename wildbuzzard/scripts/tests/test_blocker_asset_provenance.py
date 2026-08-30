#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later

import importlib.util
import io
import pathlib
import tarfile
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
REPOSITORY = HERE.parents[2]
SPEC = importlib.util.spec_from_file_location(
    "blocker_asset_provenance",
    HERE.parents[1] / "scripts" / "blocker_asset_provenance.py",
)
PROVENANCE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROVENANCE)


class BlockerAssetProvenanceTests(unittest.TestCase):
    def test_outputs_match_exact_source_lock(self):
        paths = PROVENANCE.repository_paths(REPOSITORY)
        lock = PROVENANCE.load_lock(paths["lock"])
        self.assertEqual(lock["sources"]["uBlockOrigin"]["tag"], "1.71.0")
        for relative, record in lock["outputs"].items():
            PROVENANCE.verify_file_record(
                paths["outputs"] / pathlib.PurePosixPath(relative).name,
                record,
                relative,
            )

    def test_updater_uses_lock_instead_of_moving_upstreams(self):
        paths = PROVENANCE.repository_paths(REPOSITORY)
        updater = paths["generator"].read_text(encoding="utf-8")
        self.assertIn("SOURCE_LOCK_PATH", updater)
        self.assertNotIn("refs/heads/master", updater)
        self.assertNotIn("resolveLatestUblockTag", updater)
        self.assertNotIn('git", ["ls-remote"', updater)

    def test_package_and_release_gates_are_registered(self):
        paths = PROVENANCE.repository_paths(REPOSITORY)
        self.assertIn(
            "wildbuzzard-blocker-assets-source.tar.xz",
            paths["notice"].read_text(encoding="utf-8"),
        )
        release = (REPOSITORY / "wildbuzzard/ci/create-release-manifest.py").read_text(
            encoding="utf-8"
        )
        self.assertIn('"blockerAssetSource"', release)
        self.assertIn("verify_blocker_asset_source", release)

    def test_rejects_unsafe_source_archive_member(self):
        with tempfile.TemporaryDirectory() as directory:
            archive_path = pathlib.Path(directory) / "unsafe.tar.gz"
            with tarfile.open(archive_path, "w:gz") as archive:
                info = tarfile.TarInfo("../outside")
                info.size = 1
                archive.addfile(info, io.BytesIO(b"x"))
            with tarfile.open(archive_path, "r:gz") as archive:
                with self.assertRaises(PROVENANCE.ValidationError):
                    PROVENANCE.safe_archive_members(archive, archive_path.name)


if __name__ == "__main__":
    unittest.main()
