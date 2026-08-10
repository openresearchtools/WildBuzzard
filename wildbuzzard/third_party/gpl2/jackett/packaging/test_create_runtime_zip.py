#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-only

import importlib.util
import os
import tempfile
import unittest
import zipfile
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("create_runtime_zip.py")
SPEC = importlib.util.spec_from_file_location("create_runtime_zip", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class RuntimeZipTests(unittest.TestCase):
    def test_reproducible_exact_inventory(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "runtime"
            root.mkdir()
            (root / "nested").mkdir()
            (root / "nested" / "b").write_bytes(b"bravo")
            executable = root / "a"
            executable.write_bytes(b"alpha")
            executable.chmod(0o755)
            first = Path(temporary) / "first.zip"
            second = Path(temporary) / "second.zip"
            MODULE.create_zip(root, first, 1786253932)
            os.utime(executable, (1, 1))
            MODULE.create_zip(root, second, 1786253932)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            with zipfile.ZipFile(first) as archive:
                self.assertEqual(archive.namelist(), ["a", "nested/b"])
                self.assertEqual(archive.getinfo("a").external_attr >> 16, 0o100755)

    def test_rejects_links_and_hard_links(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            target = root / "target"
            target.write_text("value")
            (root / "link").symlink_to(target)
            with self.assertRaisesRegex(ValueError, "link or special"):
                MODULE.inventory(root)
            (root / "link").unlink()
            os.link(target, root / "hard-link")
            with self.assertRaisesRegex(ValueError, "hard-linked"):
                MODULE.inventory(root)


if __name__ == "__main__":
    unittest.main()
