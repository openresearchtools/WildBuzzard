# SPDX-License-Identifier: MPL-2.0

import hashlib
import importlib.util
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location("tor_provenance", ROOT / "wildbuzzard/scripts/tor-runtime-provenance.py")
TOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TOR)


class TorRuntimePackagingTests(unittest.TestCase):
    def fixture(self, directory):
        binary = directory / "tor"
        binary.write_bytes(b"source-built Tor test binary")
        config = ROOT / "wildbuzzard/third_party/tor.toml"
        legal = ROOT / "wildbuzzard/third_party/tor-notices"
        inventory = legal / "THIRD-PARTY.json"
        provenance = directory / "tor-provenance.zip"
        manifest = dict(schema=1, upstream=TOR.pins(config), binarySha256=TOR.digest(binary.read_bytes()), inventorySha256=TOR.digest(inventory.read_bytes()))
        with zipfile.ZipFile(provenance, "w") as archive:
            archive.writestr(TOR.MANIFEST, json.dumps(manifest))
            archive.write(config, "tor.toml")
            archive.write(inventory, "THIRD-PARTY.json")
            for package in json.loads(inventory.read_text())["packages"]:
                for entry in package["licenseFiles"]:
                    archive.write(legal / entry["installedPath"], entry["installedPath"])
        return binary, config, config, provenance, inventory

    def test_binary_license_and_source_binding(self):
        with tempfile.TemporaryDirectory() as directory:
            args = self.fixture(Path(directory))
            TOR.validate(*args)
            args[0].write_bytes(b"changed binary")
            with self.assertRaisesRegex(ValueError, "does not match"):
                TOR.validate(*args)

    def test_rejects_provenance_for_another_release(self):
        with tempfile.TemporaryDirectory() as directory:
            args = list(self.fixture(Path(directory)))
            installed = Path(directory) / "tor.toml"
            installed.write_text(args[1].read_text().replace(TOR.VERSION, "0.4.9.10"))
            args[2] = installed
            with self.assertRaisesRegex(ValueError, "release pin"):
                TOR.validate(*args)

    def test_rejects_extra_archive_entries(self):
        with tempfile.TemporaryDirectory() as directory:
            args = self.fixture(Path(directory))
            with zipfile.ZipFile(args[3], "a") as archive:
                archive.writestr("../unexpected", "payload")
            with self.assertRaisesRegex(ValueError, "extra entries"):
                TOR.validate(*args)

    def test_all_dependency_licenses_match_inventory(self):
        legal = ROOT / "wildbuzzard/third_party/tor-notices"
        for package in json.loads((legal / "THIRD-PARTY.json").read_text())["packages"]:
            for entry in package["licenseFiles"]:
                self.assertEqual(hashlib.sha256((legal / entry["installedPath"]).read_bytes()).hexdigest(), entry["sha256"])


if __name__ == "__main__":
    unittest.main()
