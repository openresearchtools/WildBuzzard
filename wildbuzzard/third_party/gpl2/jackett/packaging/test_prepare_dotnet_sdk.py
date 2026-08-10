# SPDX-License-Identifier: GPL-2.0-only

import hashlib
import io
import json
import pathlib
import tarfile
import tempfile
import unittest

from prepare_dotnet_sdk import prepare


class PrepareDotnetSdkTest(unittest.TestCase):
    def fixture(self, root, extra=None):
        cache = root / "cache"
        cache.mkdir()
        archive = cache / "sdk.tar.gz"
        entries = [
            ("./dotnet", b"launcher", 0o755, None),
            ("./LICENSE.txt", b"license", 0o644, None),
            ("./ThirdPartyNotices.txt", b"notices", 0o644, None),
        ]
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
            "architecture": "x86_64",
            "releaseMetadata": "https://dotnetcli.blob.core.windows.net/example",
            "rid": "linux-x64",
            "schemaVersion": 1,
            "sha512": hashlib.sha512(archive.read_bytes()).hexdigest(),
            "size": archive.stat().st_size,
            "url": "https://builds.dotnet.microsoft.com/example",
            "version": "test",
        }
        lock_path = root / "lock.json"
        lock_path.write_text(json.dumps(lock), encoding="utf-8")
        return lock_path, cache

    def test_prepares_verified_regular_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            lock, cache = self.fixture(root)
            output = root / "sdk"

            prepare(lock, cache, output)

            self.assertEqual((output / "dotnet").read_bytes(), b"launcher")
            self.assertTrue((output / "dotnet").stat().st_mode & 0o111)
            self.assertTrue((output / "wildbuzzard-dotnet-toolchain.json").is_file())

    def test_rejects_traversal_and_links(self):
        for extra in [
            ("../escape", b"bad", 0o644, None),
            ("link", b"dotnet", 0o777, "symlink"),
        ]:
            with self.subTest(extra=extra[0]), tempfile.TemporaryDirectory() as directory:
                root = pathlib.Path(directory)
                lock, cache = self.fixture(root, extra)
                with self.assertRaisesRegex(ValueError, "unsafe|unsupported"):
                    prepare(lock, cache, root / "sdk")

    def test_rejects_cached_archive_digest_mismatch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            lock, cache = self.fixture(root)
            document = json.loads(lock.read_text(encoding="utf-8"))
            document["sha512"] = "0" * 128
            lock.write_text(json.dumps(document), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "digest mismatch"):
                prepare(lock, cache, root / "sdk")


if __name__ == "__main__":
    unittest.main()
