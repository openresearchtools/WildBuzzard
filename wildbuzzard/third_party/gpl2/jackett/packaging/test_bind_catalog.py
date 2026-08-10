# SPDX-License-Identifier: GPL-2.0-only

import hashlib
import pathlib
import tempfile
import unittest

from bind_catalog import PLACEHOLDER, bind_catalog


class BindCatalogTest(unittest.TestCase):
    def test_binds_exact_catalog_digest_once(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            source = root / "CatalogPolicy.cs"
            catalog = root / "catalog.json"
            source.write_text(f'const string Expected = "{PLACEHOLDER}";\n')
            catalog.write_bytes(b'{"immutable":true}\n')
            expected = hashlib.sha256(catalog.read_bytes()).hexdigest()

            self.assertEqual(bind_catalog(source, catalog), expected)
            self.assertIn(expected, source.read_text())

    def test_rejects_missing_or_duplicate_placeholder(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            source = root / "CatalogPolicy.cs"
            catalog = root / "catalog.json"
            catalog.write_text("{}\n")
            for value in ("none\n", f"{PLACEHOLDER} {PLACEHOLDER}\n"):
                source.write_text(value)
                with self.assertRaisesRegex(ValueError, "missing or duplicated"):
                    bind_catalog(source, catalog)


if __name__ == "__main__":
    unittest.main()
