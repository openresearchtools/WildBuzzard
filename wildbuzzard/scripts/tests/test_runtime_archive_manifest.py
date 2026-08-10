# SPDX-License-Identifier: AGPL-3.0-or-later

import importlib.util
import json
import os
import stat
import tempfile
import unittest
import warnings
import zipfile
from pathlib import Path

SCRIPT = Path(__file__).parents[1] / "runtime-archive-manifest.py"
SPEC = importlib.util.spec_from_file_location("runtime_manifest", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class RuntimeArchiveManifestTest(unittest.TestCase):
    def archive(self, entries, manifest):
        temporary = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
        temporary.close()
        path = Path(temporary.name)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            with zipfile.ZipFile(path, "w") as archive:
                archive.writestr(MODULE.MANIFEST, json.dumps(manifest))
                for entry, data, mode in entries:
                    info = zipfile.ZipInfo(entry)
                    info.create_system = 3
                    info.external_attr = mode << 16
                    archive.writestr(info, data)
        self.addCleanup(path.unlink)
        return path

    def manifest(self, files, executables=()):
        source = next(iter(files))
        return {
            "schema": 4,
            "files": {name: MODULE.digest(data) for name, data in files.items()},
            "executableAllowlist": list(executables),
            "correspondingSource": source,
            "sourceSha256": MODULE.digest(files[source]),
            "licenseLocations": [source],
        }

    def test_accepts_matching_inventory(self):
        data = b"payload"
        archive = self.archive(
            [("bin/tool", data, stat.S_IFREG | 0o755)],
            self.manifest({"bin/tool": data}, ["bin/tool"]),
        )
        MODULE.verify(archive)

    def test_rejects_duplicate_traversal_and_symlink(self):
        data = b"payload"
        manifest = self.manifest({"bin/tool": data})
        duplicate = self.archive(
            [
                ("bin/tool", data, stat.S_IFREG | 0o644),
                ("bin/tool", data, stat.S_IFREG | 0o644),
            ],
            manifest,
        )
        traversal = self.archive([("../tool", data, stat.S_IFREG | 0o644)], manifest)
        symlink = self.archive([("bin/tool", data, stat.S_IFLNK | 0o777)], manifest)
        for archive in (duplicate, traversal, symlink):
            with self.subTest(archive=archive), self.assertRaises(ValueError):
                MODULE.verify(archive)

    def test_rejects_digest_executable_and_unexpected_file(self):
        data = b"payload"
        digest = self.archive(
            [("bin/tool", b"changed", stat.S_IFREG | 0o644)],
            self.manifest({"bin/tool": data}),
        )
        executable = self.archive(
            [("bin/tool", data, stat.S_IFREG | 0o755)],
            self.manifest({"bin/tool": data}),
        )
        unexpected = self.archive(
            [
                ("bin/tool", data, stat.S_IFREG | 0o644),
                ("extra", data, stat.S_IFREG | 0o644),
            ],
            self.manifest({"bin/tool": data}),
        )
        for archive in (digest, executable, unexpected):
            with self.subTest(archive=archive), self.assertRaises(ValueError):
                MODULE.verify(archive)

    def test_build_rejects_links(self):
        for link_type in ("symbolic", "hard"):
            with self.subTest(
                link_type=link_type
            ), tempfile.TemporaryDirectory() as temporary_root:
                root = Path(temporary_root)
                target = root / "target"
                target.write_bytes(b"payload")
                link = root / "link"
                if link_type == "symbolic":
                    link.symlink_to(target.name)
                else:
                    os.link(target, link)
                metadata = root / "metadata.json"
                metadata.write_text("{}")
                with self.assertRaises(ValueError):
                    MODULE.build(root, metadata)


if __name__ == "__main__":
    unittest.main()
