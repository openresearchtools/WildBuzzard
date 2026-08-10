# SPDX-License-Identifier: AGPL-3.0-or-later

import json
import pathlib
import subprocess
import tempfile
import unittest

SCRIPT_DIR = pathlib.Path(__file__).resolve().parent


class PrepareMiniFixturePackageTest(unittest.TestCase):
    def test_fixture_is_separate_and_mechanically_bound(self):
        shipping = {
            "jackettVersion": "v0.24.2360",
            "jackettCommit": "0" * 40,
            "adultCategoryRange": [6000, 6999],
            "policySha256": "1" * 64,
            "enabledIndexerIds": ["showrss", "linuxtracker", "other"],
            "entries": [
                {
                    "indexerId": indexer_id,
                    "name": indexer_id,
                    "sourcePath": f"src/{indexer_id}.yml",
                    "sourceKind": "cardigann-yaml",
                    "eligibility": "enabled-public",
                    "reasons": ["reviewed"],
                }
                for indexer_id in ("showrss", "linuxtracker", "other")
            ],
        }
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            catalog = root / "shipping.json"
            catalog.write_text(json.dumps(shipping), encoding="utf-8")
            template = root / "fixture.yml.in"
            template.write_text(
                "id: __INDEXER_ID__\nname: __INDEXER_NAME__\nlinks:\n  - __FIXTURE_ORIGIN__/\nsource: __FIXTURE_SOURCE__\n",
                encoding="utf-8",
            )
            output = root / "fixture"
            subprocess.run(
                [
                    "python3",
                    str(SCRIPT_DIR / "prepare-mini-fixture-package.py"),
                    "--shipping-catalog",
                    str(catalog),
                    "--template",
                    str(template),
                    "--output",
                    str(output),
                ],
                check=True,
            )
            fixture = json.loads((output / "catalog.json").read_text())
            binding = json.loads((output / "fixture-binding.json").read_text())
            self.assertTrue(binding["testFixture"])
            self.assertEqual(binding["fixtureOrigin"], "http://127.0.0.1:18080")
            self.assertEqual(binding["shippingPolicySha256"], "1" * 64)
            self.assertEqual(fixture["enabledIndexerIds"], ["linuxtracker", "showrss"])
            self.assertEqual(
                sorted(path.name for path in (output / "Definitions").iterdir()),
                ["linuxtracker.yml", "showrss.yml"],
            )
            self.assertIn(
                "source: mini-main",
                (output / "Definitions/showrss.yml").read_text(encoding="utf-8"),
            )
            self.assertIn(
                "source: mini-alternate",
                (output / "Definitions/linuxtracker.yml").read_text(
                    encoding="utf-8"
                ),
            )


if __name__ == "__main__":
    unittest.main()
