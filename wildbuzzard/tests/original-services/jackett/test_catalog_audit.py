# SPDX-License-Identifier: AGPL-3.0-or-later

import copy
import hashlib
import json
import pathlib
import tempfile
import unittest

from catalog_audit import audit_catalog


class CatalogAuditTest(unittest.TestCase):
    def fixture(self, root):
        source = root / "source"
        runtime = root / "runtime"
        definitions = runtime / "Definitions"
        definitions.mkdir(parents=True)
        entries = []
        for indexer_id, eligibility, access, credentials, content in (
            ("safe", "enabled-public", "public", False, "general"),
            ("adult", "excluded-adult-only", "public", False, "adult-only"),
            ("credentialed", "excluded-credentialed", "public", True, "general"),
            ("private", "excluded-non-public", "private", True, "general"),
        ):
            relative = pathlib.Path("definitions") / f"{indexer_id}.yml"
            path = source / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(f"id: {indexer_id}\n", encoding="utf-8")
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            entries.append({
                "indexerId": indexer_id,
                "sourcePath": relative.as_posix(),
                "sourceKind": "cardigann-yaml",
                "definitionSha256": digest,
                "eligibility": eligibility,
                "access": access,
                "requiresCredentials": credentials,
                "requiresExternalSolver": False,
                "contentClass": content,
            })
            if eligibility == "enabled-public":
                (definitions / relative.name).write_bytes(path.read_bytes())
        catalog = {
            "jackettCommit": "0" * 40,
            "policySha256": "1" * 64,
            "enabledIndexerIds": ["safe"],
            "entries": entries,
        }
        catalog_path = root / "catalog.json"
        catalog_path.write_text(json.dumps(catalog), encoding="utf-8")
        return source, runtime, catalog_path, catalog

    def test_reports_every_active_and_excluded_id(self):
        with tempfile.TemporaryDirectory() as directory:
            source, runtime, catalog_path, _catalog = self.fixture(
                pathlib.Path(directory)
            )
            report = audit_catalog(catalog_path, source, runtime)
            self.assertEqual(report["enabledIndexerIds"], ["safe"])
            self.assertEqual(
                report["excludedIndexerIds"]["excluded-adult-only"], ["adult"]
            )
            self.assertEqual(
                report["excludedIndexerIds"]["excluded-credentialed"],
                ["credentialed"],
            )
            classified = set(report["enabledIndexerIds"])
            for ids in report["excludedIndexerIds"].values():
                classified.update(ids)
            self.assertEqual(classified, {"safe", "adult", "credentialed", "private"})

    def test_rejects_duplicate_invalid_and_policy_drift(self):
        mutations = {
            "duplicate": lambda catalog: catalog["entries"].append(
                copy.deepcopy(catalog["entries"][0])
            ),
            "content class": lambda catalog: catalog["entries"][0].update(
                contentClass="unreviewed"
            ),
            "mechanical policy": lambda catalog: catalog["entries"][0].update(
                requiresCredentials=True
            ),
        }
        for expected, mutate in mutations.items():
            with self.subTest(
                expected=expected
            ), tempfile.TemporaryDirectory() as directory:
                source, runtime, catalog_path, catalog = self.fixture(
                    pathlib.Path(directory)
                )
                mutate(catalog)
                catalog_path.write_text(json.dumps(catalog), encoding="utf-8")
                with self.assertRaisesRegex(RuntimeError, expected):
                    audit_catalog(catalog_path, source, runtime)

    def test_rejects_runtime_definition_drift(self):
        with tempfile.TemporaryDirectory() as directory:
            source, runtime, catalog_path, _catalog = self.fixture(
                pathlib.Path(directory)
            )
            (runtime / "Definitions" / "raw.yml").write_text(
                "id: raw\n", encoding="utf-8"
            )
            with self.assertRaisesRegex(RuntimeError, "runtime definitions"):
                audit_catalog(catalog_path, source, runtime)


if __name__ == "__main__":
    unittest.main()
