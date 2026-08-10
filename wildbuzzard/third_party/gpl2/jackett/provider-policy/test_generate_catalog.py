# SPDX-License-Identifier: GPL-2.0-only

import json
import tempfile
import unittest
from pathlib import Path

import generate_catalog


class CatalogGenerationTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        yaml_directory = self.root / "src/Jackett.Common/Definitions"
        native_directory = self.root / "src/Jackett.Common/Indexers/Definitions/Feeds"
        yaml_directory.mkdir(parents=True)
        native_directory.mkdir(parents=True)
        self.yaml_path = yaml_directory / "fixture.yml"
        self.yaml_path.write_text("id: fixture\nname: Fixture\ntype: public\n", encoding="utf-8")
        self.native_path = native_directory / "Nested.cs"
        self.native_path.write_text(
            'namespace Jackett.Common.Indexers.Definitions.Feeds { public class Nested : Base { public override string Id => "nested"; public override string Name => "Nested"; public override string Type => "private"; } }\n',
            encoding="utf-8",
        )
        discovered = generate_catalog.discover(self.root)
        self.reviewed = {
            indexer_id: {
                **entry,
                "contentClass": "general",
                "requiresCredentials": entry["access"] != "public",
                "requiresExternalSolver": False,
                "eligibility": "enabled-public" if entry["access"] == "public" else "excluded-non-public",
                "reasons": ["reviewed fixture"],
            }
            for indexer_id, entry in discovered.items()
        }

    def tearDown(self):
        self.temporary.cleanup()

    def test_nested_native_provider_is_inventoried(self):
        catalog = json.loads(generate_catalog.build_catalog(generate_catalog.discover(self.root), self.reviewed))
        nested = next(entry for entry in catalog["entries"] if entry["indexerId"] == "nested")
        self.assertEqual(nested["nativeType"], "Jackett.Common.Indexers.Definitions.Feeds.Nested")

    def test_definition_hash_change_fails(self):
        self.yaml_path.write_text("id: fixture\nname: Changed\ntype: public\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "definitionSha256 changed"):
            generate_catalog.build_catalog(generate_catalog.discover(self.root), self.reviewed)

    def test_added_definition_fails(self):
        (self.yaml_path.parent / "added.yml").write_text("id: added\nname: Added\ntype: public\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "catalog review mismatch"):
            generate_catalog.build_catalog(generate_catalog.discover(self.root), self.reviewed)

    def test_renamed_definition_fails(self):
        self.yaml_path.write_text("id: renamed\nname: Fixture\ntype: public\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "catalog review mismatch"):
            generate_catalog.build_catalog(generate_catalog.discover(self.root), self.reviewed)


if __name__ == "__main__":
    unittest.main()
