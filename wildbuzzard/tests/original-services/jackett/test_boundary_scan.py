# SPDX-License-Identifier: AGPL-3.0-or-later

import json
import pathlib
import tempfile
import unittest

from boundary_scan import scan_sources, verify_runtime


class BoundaryScanTest(unittest.TestCase):
    def test_product_name_and_protocol_client_are_allowed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / "JackettMiniRuntime.sys.mjs").write_text(
                'const route = "/v1/search";\n', encoding="utf-8"
            )
            report = scan_sources([root])
            self.assertEqual(report["fileCount"], 1)

    def test_each_process_boundary_violation_is_rejected(self):
        fixtures = {
            "assembly": "using Jackett.Common.Models;",
            "clr": "hostfxr_initialize_for_runtime_config();",
            "dashboard": 'fetch("/UI/Dashboard");',
            "package": 'include("third_party/gpl2/jackett/patches/series");',
        }
        for name, payload in fixtures.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                root = pathlib.Path(directory)
                (root / "fixture.js").write_text(payload, encoding="utf-8")
                with self.assertRaisesRegex(RuntimeError, "boundary violations"):
                    scan_sources([root])

    def test_test_and_documentation_references_are_ignored(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / "test").mkdir()
            (root / "test" / "contract.js").write_text(
                'fetch("/UI/Dashboard")', encoding="utf-8"
            )
            (root / "BOUNDARY.md").write_text(
                "Jackett.Common hostfxr", encoding="utf-8"
            )
            self.assertEqual(scan_sources([root])["fileCount"], 0)

    def test_runtime_inventory_accepts_only_reviewed_definitions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            runtime = root / "runtime"
            definitions = runtime / "Definitions"
            definitions.mkdir(parents=True)
            (definitions / "safe.yml").write_text("id: safe\n", encoding="utf-8")
            catalog = root / "catalog.json"
            catalog.write_text(
                json.dumps({
                    "entries": [
                        {
                            "eligibility": "enabled-public",
                            "sourceKind": "cardigann-yaml",
                            "sourcePath": "definitions/v2/safe.yml",
                        }
                    ]
                }),
                encoding="utf-8",
            )
            self.assertEqual(verify_runtime(runtime, catalog)["definitionCount"], 1)
            (definitions / "raw.yml").write_text("id: raw\n", encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "active set"):
                verify_runtime(runtime, catalog)

    def test_runtime_inventory_rejects_dashboard_and_updater(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            runtime = root / "runtime"
            runtime.mkdir()
            catalog = root / "catalog.json"
            catalog.write_text(json.dumps({"entries": []}), encoding="utf-8")
            for forbidden in ("Content", "Jackett.Updater"):
                with self.subTest(forbidden=forbidden):
                    path = runtime / forbidden
                    path.mkdir()
                    (path / "payload").write_bytes(b"x")
                    with self.assertRaisesRegex(RuntimeError, "forbidden path"):
                        verify_runtime(runtime, catalog)
                    (path / "payload").unlink()
                    path.rmdir()


if __name__ == "__main__":
    unittest.main()
