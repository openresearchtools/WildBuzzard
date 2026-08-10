# SPDX-License-Identifier: GPL-2.0-only

import pathlib
import tempfile
import unittest

from bind_fixture_origin import PLACEHOLDER, bind_fixture_origin


class BindFixtureOriginTest(unittest.TestCase):
    def test_production_build_disables_fixture_endpoint(self):
        with tempfile.TemporaryDirectory() as directory:
            source = pathlib.Path(directory) / "PublicNetworkPolicy.cs"
            source.write_text(f'const string Origin = "{PLACEHOLDER}";\n')
            bind_fixture_origin(source, "")
            self.assertEqual(source.read_text(), 'const string Origin = "";\n')

    def test_fixture_build_binds_exact_loopback_origin(self):
        with tempfile.TemporaryDirectory() as directory:
            source = pathlib.Path(directory) / "PublicNetworkPolicy.cs"
            source.write_text(f'const string Origin = "{PLACEHOLDER}";\n')
            bind_fixture_origin(source, "http://127.0.0.1:18080")
            self.assertIn("http://127.0.0.1:18080", source.read_text())

    def test_rejects_unreviewed_origin_and_invalid_template(self):
        with tempfile.TemporaryDirectory() as directory:
            source = pathlib.Path(directory) / "PublicNetworkPolicy.cs"
            source.write_text(f'const string Origin = "{PLACEHOLDER}";\n')
            with self.assertRaisesRegex(ValueError, "reviewed"):
                bind_fixture_origin(source, "http://127.0.0.1:18081")
            source.write_text("missing\n")
            with self.assertRaisesRegex(ValueError, "missing or duplicated"):
                bind_fixture_origin(source, "")


if __name__ == "__main__":
    unittest.main()
