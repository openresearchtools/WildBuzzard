#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later

import importlib.util
import pathlib
import shutil
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    "verify_browser_legal_payload",
    HERE.parents[1] / "scripts" / "verify_browser_legal_payload.py",
)
LEGAL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LEGAL)


class LegalPayloadTests(unittest.TestCase):
    def make_payload(self, root):
        source = root / "source"
        browser = root / "browser"
        documentation = root / "documentation"
        (source / "wildbuzzard/components/wildbuzzard-cli").mkdir(parents=True)
        (source / "wildbuzzard").mkdir(exist_ok=True)
        (browser / "notices").mkdir(parents=True)
        documentation.mkdir()
        (browser / "application.ini").write_text(
            "[App]\n"
            "Vendor=WildBuzzard\n"
            "Name=WildBuzzard\n"
            "RemotingName=org.wildbuzzard.WildBuzzard\n"
            "Version=153.1.0\n"
            "ID={648cc8ea-a8a6-59ec-b7e7-3ddc7e685961}\n\n"
            "[XRE]\n",
            encoding="utf-8",
        )
        values = {
            "BLOCKER-ASSET-SOURCE-NOTICE": b"blocker source\n",
            "COPYING": b"agpl\n",
            "LICENSE": b"combined license\n",
            "MOZILLA-MCP-LICENSE": b"mit\n",
            "NOTICE": b"upstream notice\n",
            "SOURCE-NOTICE": b"source\n",
        }
        sources = LEGAL.expected_payloads(source)
        for name, value in values.items():
            sources[name].write_bytes(value)
            (browser / "notices" / name).write_bytes(value)
        documentation_names = {
            "BLOCKER-ASSET-SOURCE-NOTICE": "BLOCKER-ASSET-SOURCE-NOTICE",
            "COPYING": "COPYING",
            "LICENSE": "LICENSE",
            "MOZILLA-MCP-LICENSE": "MOZILLA-MCP-LICENSE",
            "cli-NOTICE": "NOTICE",
            "SOURCE-NOTICE": "SOURCE-NOTICE",
        }
        for destination, source_name in documentation_names.items():
            (documentation / destination).write_bytes(values[source_name])
        actual_runner = HERE.parents[1] / "components" / "wildbuzzard-cli" / "runner"
        runner = source / "wildbuzzard/components/wildbuzzard-cli/runner"
        runner.mkdir()
        shutil.copy2(actual_runner / "Cargo.lock", runner / "Cargo.lock")
        shutil.copytree(actual_runner / "third_party", runner / "third_party")
        runner_payloads = LEGAL.runner_payloads(source)
        for destination_root in (
            browser / "notices/wildbuzzard-cli",
            documentation / "runner-third-party",
        ):
            for relative, source_path in runner_payloads.items():
                destination = destination_root / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source_path, destination)
        actual_source = HERE.parents[2]
        source_arti = source / "third_party/arti"
        source_arti.mkdir(parents=True)
        shutil.copy2(actual_source / "third_party/arti/Cargo.lock", source_arti)
        source_arti_legal = source / "wildbuzzard/third_party/arti-crates"
        shutil.copytree(
            actual_source / "wildbuzzard/third_party/arti-crates",
            source_arti_legal,
        )
        shutil.copy2(
            actual_source / "wildbuzzard/third_party/arti.toml",
            source / "wildbuzzard/third_party/arti.toml",
        )
        arti_payloads = LEGAL.arti_payloads(source)
        for destination_root in (
            browser / "notices/arti-crates",
            documentation / "arti-third-party",
        ):
            for relative, source_path in arti_payloads.items():
                destination = destination_root / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source_path, destination)
        actual_blocker = (
            HERE.parents[2] / "browser/components/blocker/assets/SOURCES.lock.json"
        )
        source_blocker = source / "browser/components/blocker/assets/SOURCES.lock.json"
        source_blocker.parent.mkdir(parents=True)
        shutil.copy2(actual_blocker, source_blocker)
        for destination in (
            browser / "notices/blocker/SOURCES.lock.json",
            documentation / "blocker/SOURCES.lock.json",
        ):
            destination.parent.mkdir(parents=True)
            shutil.copy2(source_blocker, destination)
        return source, browser, documentation

    def test_accepts_exact_archive_and_documentation_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            roots = self.make_payload(pathlib.Path(directory))
            LEGAL.verify_payload(*roots)

    def test_rejects_tampering_and_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            source, browser, documentation = self.make_payload(pathlib.Path(directory))
            (documentation / "COPYING").write_text("wrong", encoding="utf-8")
            with self.assertRaises(LEGAL.ValidationError):
                LEGAL.verify_payload(source, browser, documentation)
            (documentation / "COPYING").unlink()
            (documentation / "COPYING").symlink_to(source / "COPYING")
            with self.assertRaises(LEGAL.ValidationError):
                LEGAL.verify_payload(source, browser, documentation)

    def test_rejects_tampered_or_extra_runner_legal_files(self):
        with tempfile.TemporaryDirectory() as directory:
            source, browser, documentation = self.make_payload(pathlib.Path(directory))
            license_path = (
                documentation / "runner-third-party/licenses/MIT-dtolnay-serde.txt"
            )
            license_path.write_text("wrong\n", encoding="utf-8")
            with self.assertRaises(LEGAL.ValidationError):
                LEGAL.verify_payload(source, browser, documentation)
            shutil.copy2(
                source
                / "wildbuzzard/components/wildbuzzard-cli/runner/third_party/licenses/MIT-dtolnay-serde.txt",
                license_path,
            )
            (browser / "notices/wildbuzzard-cli/tests").mkdir()
            (browser / "notices/wildbuzzard-cli/tests/fixture.json").write_text(
                "{}\n", encoding="utf-8"
            )
            with self.assertRaises(LEGAL.ValidationError):
                LEGAL.verify_payload(source, browser, documentation)

    def test_rejects_tampered_or_extra_arti_legal_files(self):
        with tempfile.TemporaryDirectory() as directory:
            source, browser, documentation = self.make_payload(pathlib.Path(directory))
            license_path = next((documentation / "arti-third-party/licenses").iterdir())
            original = license_path.read_bytes()
            license_path.write_bytes(b"wrong\n")
            with self.assertRaises(LEGAL.ValidationError):
                LEGAL.verify_payload(source, browser, documentation)
            license_path.write_bytes(original)
            (browser / "notices/arti-crates/tests").mkdir()
            (browser / "notices/arti-crates/tests/fixture").write_text(
                "dev-only\n", encoding="utf-8"
            )
            with self.assertRaises(LEGAL.ValidationError):
                LEGAL.verify_payload(source, browser, documentation)

    def test_rejects_firefox_or_migrating_application_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            source, browser, documentation = self.make_payload(pathlib.Path(directory))
            application_ini = browser / "application.ini"
            application_ini.write_text(
                "[App]\n"
                "Vendor=Mozilla\n"
                "Name=Firefox\n"
                "RemotingName=firefox\n"
                "Profile=Firefox\n"
                "ID={ec8030f7-c20a-464f-9b0e-13a3a9e97384}\n\n"
                "[XRE]\nEnableProfileMigrator=1\n",
                encoding="utf-8",
            )
            with self.assertRaises(LEGAL.ValidationError):
                LEGAL.verify_payload(source, browser, documentation)

    def test_rejects_update_and_crash_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            source, browser, documentation = self.make_payload(pathlib.Path(directory))
            with (browser / "application.ini").open("a", encoding="utf-8") as output:
                output.write("\n[AppUpdate]\nURL=https://aus5.mozilla.org/update\n")
            with self.assertRaises(LEGAL.ValidationError):
                LEGAL.verify_payload(source, browser, documentation)


if __name__ == "__main__":
    unittest.main()
