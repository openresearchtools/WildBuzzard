# SPDX-License-Identifier: AGPL-3.0-or-later

import hashlib
import io
import json
import pathlib
import tarfile
import tempfile
import unittest

from prepare_pristine_release import prepare


class PreparePristineReleaseTest(unittest.TestCase):
    def fixture(self, root, extra=None):
        cache = root / "cache"
        cache.mkdir()
        archive = cache / "jackett.tar.gz"
        entries = [
            ("Jackett/jackett", b"launcher", 0o755, None),
            ("Jackett/Content/index.html", b"html", 0o644, None),
        ]
        entries.extend(
            (f"Jackett/Definitions/source-{index}.yml", b"definition", 0o644, None)
            for index in range(549)
        )
        entries.extend(
            (f"Jackett/runtime/file-{index}.dll", b"runtime", 0o644, None)
            for index in range(411)
        )
        if extra:
            entries.append(extra)
        with tarfile.open(archive, "w:gz") as output:
            for name, data, mode, kind in entries:
                info = tarfile.TarInfo(name)
                info.mode = mode
                if kind == "symlink":
                    info.type = tarfile.SYMTYPE
                    info.linkname = data.decode()
                    output.addfile(info)
                else:
                    info.size = len(data)
                    output.addfile(info, io.BytesIO(data))
        lock = {
            "archive": archive.name,
            "commit": "0cd8622b735922a909a128d8d6943bb8565a640f",
            "platform": "linux/amd64",
            "schemaVersion": 1,
            "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
            "size": archive.stat().st_size,
            "url": "https://github.com/Jackett/Jackett/releases/download/test",
            "version": "v0.24.2360",
        }
        lock_path = root / "lock.json"
        lock_path.write_text(json.dumps(lock), encoding="utf-8")
        return lock_path, cache

    def test_prepares_exact_verified_release(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            lock, cache = self.fixture(root)
            output = root / "runtime"

            prepare(lock, cache, output)

            self.assertEqual((output / "jackett").read_bytes(), b"launcher")
            self.assertTrue((output / "jackett").stat().st_mode & 0o111)
            self.assertEqual(len(list((output / "Definitions").glob("*.yml"))), 549)

    def test_rejects_traversal_and_links(self):
        for extra in [
            ("Jackett/../escape", b"bad", 0o644, None),
            ("Jackett/link", b"jackett", 0o777, "symlink"),
        ]:
            with self.subTest(extra=extra[0]), tempfile.TemporaryDirectory() as directory:
                root = pathlib.Path(directory)
                lock, cache = self.fixture(root, extra)
                with self.assertRaisesRegex(ValueError, "unsafe|unsupported"):
                    prepare(lock, cache, root / "runtime")

    def test_rejects_cached_archive_digest_mismatch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            lock, cache = self.fixture(root)
            document = json.loads(lock.read_text(encoding="utf-8"))
            document["sha256"] = "0" * 64
            lock.write_text(json.dumps(document), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "digest mismatch"):
                prepare(lock, cache, root / "runtime")


if __name__ == "__main__":
    unittest.main()
