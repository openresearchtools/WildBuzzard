#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later

import base64
import hashlib
import importlib.util
import json
import tempfile
import unittest
import warnings
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "wildbuzzard" / "scripts" / "verify_installable_extension_xpis.py"
SPEC = importlib.util.spec_from_file_location("verify_installable_xpis", SCRIPT)
VERIFY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VERIFY)
PINS = (
    ROOT / "toolkit" / "mozapps" / "extensions" / "internal" / "WildBuzzardXPIPins.json"
)
FIXTURES = ROOT / "toolkit" / "mozapps" / "extensions" / "test" / "xpcshell" / "data"


class InstallableExtensionXPITests(unittest.TestCase):
    def make_xpi(self, root, extension_id, name, marker="canonical"):
        path = root / name
        manifest = {
            "browser_specific_settings": {"gecko": {"id": extension_id}},
            "manifest_version": 2,
            "name": name,
            "version": "0.1.0",
        }
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("manifest.json", json.dumps(manifest))
            archive.writestr("marker.txt", marker)
        return path

    def make_policy(self, root, paths):
        entries = []
        for path in paths:
            extension_id, version, digest = VERIFY.load_xpi(path)
            entries.append({
                "extensionId": extension_id,
                "sha256": digest,
                "version": version,
            })
        policy = {
            "extensions": entries,
            "hashAlgorithm": "sha256",
            "schema": 1,
        }
        path = root / "pins.json"
        path.write_text(json.dumps(policy), encoding="utf-8")
        return path

    def test_accepts_exact_two_pinned_xpis(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            paths = [
                self.make_xpi(root, extension_id, f"{index}.xpi")
                for index, extension_id in enumerate(sorted(VERIFY.EXPECTED_IDS))
            ]
            VERIFY.verify(self.make_policy(root, paths), paths)

    def test_product_fixtures_match_production_pins(self):
        sources = sorted(FIXTURES.glob("wildbuzzard-*.xpi.base64url"))
        self.assertEqual(len(sources), 2)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            paths = []
            for source in sources:
                encoded = b"".join(source.read_bytes().split())
                encoded += b"=" * (-len(encoded) % 4)
                path = root / source.name.removesuffix(".base64url")
                path.write_bytes(
                    base64.b64decode(encoded, altchars=b"-_", validate=True)
                )
                paths.append(path)
            VERIFY.verify(PINS, paths)

    def test_rejects_modified_same_id_xpi(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            paths = [
                self.make_xpi(root, extension_id, f"{index}.xpi")
                for index, extension_id in enumerate(sorted(VERIFY.EXPECTED_IDS))
            ]
            policy = self.make_policy(root, paths)
            modified = self.make_xpi(
                root,
                sorted(VERIFY.EXPECTED_IDS)[0],
                "modified.xpi",
                marker="forged",
            )
            with self.assertRaisesRegex(
                VERIFY.ValidationError, "does not match its browser pin"
            ):
                VERIFY.verify(policy, [modified, paths[1]])

    def test_rejects_extra_identity_and_duplicate_archive_member(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            paths = [
                self.make_xpi(root, extension_id, f"{index}.xpi")
                for index, extension_id in enumerate(sorted(VERIFY.EXPECTED_IDS))
            ]
            policy = json.loads(
                self.make_policy(root, paths).read_text(encoding="utf-8")
            )
            policy["extensions"].append({
                "extensionId": "unexpected@example.com",
                "sha256": hashlib.sha256(b"unexpected").hexdigest(),
                "version": "1.0",
            })
            policy_path = root / "extra-pins.json"
            policy_path.write_text(json.dumps(policy), encoding="utf-8")
            with self.assertRaisesRegex(VERIFY.ValidationError, "exactly the two"):
                VERIFY.load_pins(policy_path)

            duplicate = root / "duplicate.xpi"
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", UserWarning)
                with zipfile.ZipFile(duplicate, "w") as archive:
                    archive.writestr("manifest.json", "{}")
                    archive.writestr("manifest.json", "{}")
            with self.assertRaisesRegex(VERIFY.ValidationError, "invalid XPI members"):
                VERIFY.load_xpi(duplicate)


if __name__ == "__main__":
    unittest.main()
