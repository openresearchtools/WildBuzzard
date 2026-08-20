#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later

import hashlib
import json
import shutil
import subprocess
import tempfile
import tomllib
import unittest
from pathlib import Path


COMPONENT = Path(__file__).resolve().parents[1]
REPOSITORY = COMPONENT.parents[2]
VENDOR = REPOSITORY / "wildbuzzard/third_party/mit/pi"
UPSTREAM = VENDOR / "upstream"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class BuzzardAgentPackageTests(unittest.TestCase):
    def test_pristine_source_matches_provenance(self):
        metadata = tomllib.loads((VENDOR / "UPSTREAM.toml").read_text(encoding="utf-8"))
        self.assertEqual(metadata["version"], "0.84.1")
        self.assertEqual(metadata["commit"], "53fa77ccd8a279eb87e92294ef3687b03ff80112")
        self.assertEqual(metadata["git_tree"], "70a1ca9fe2bd7dfdcf00d53a60b02be4978e40e9")
        self.assertEqual(metadata["license"], "MIT")
        self.assertEqual(sha256(UPSTREAM / "LICENSE"), metadata["license_sha256"])
        self.assertEqual(sha256(VENDOR / "SOURCE-MANIFEST.sha256"), metadata["source_manifest_sha256"])

        entries = (VENDOR / "SOURCE-MANIFEST.sha256").read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(entries), metadata["source_files"])
        for entry in entries:
            expected, relative = entry.split("  ./", 1)
            self.assertEqual(sha256(UPSTREAM / relative), expected, relative)

    def test_upstream_packages_select_0841(self):
        packages = {}
        for relative in (
            "packages/agent/package.json",
            "packages/ai/package.json",
            "packages/coding-agent/package.json",
        ):
            package = json.loads((UPSTREAM / relative).read_text(encoding="utf-8"))
            packages[package["name"]] = package["version"]
        self.assertEqual(
            packages,
            {
                "@earendil-works/pi-agent-core": "0.84.1",
                "@earendil-works/pi-ai": "0.84.1",
                "@earendil-works/pi-coding-agent": "0.84.1",
            },
        )
        extension = json.loads((REPOSITORY / "agent/extensions/web-access/package.json").read_text(encoding="utf-8"))
        self.assertEqual(extension["dependencies"]["@earendil-works/pi-ai"], "0.83.0")

    def test_debranding_is_outside_pristine_source(self):
        with tempfile.TemporaryDirectory(prefix="buzzard-agent-test-") as directory:
            work = Path(directory) / "source"
            shutil.copytree(UPSTREAM, work)
            subprocess.run(["python3", COMPONENT / "scripts/debrand.py", work], check=True)

            package = json.loads((work / "packages/coding-agent/package.json").read_text(encoding="utf-8"))
            self.assertEqual(package["name"], "@earendil-works/pi-coding-agent")
            self.assertEqual(package["piConfig"], {"configDir": ".pi"})
            self.assertEqual(package["bin"], {"pi": "dist/cli.js"})

            source_root = work / "packages/coding-agent/src"
            combined = "\n".join(path.read_text(encoding="utf-8") for path in source_root.rglob("*.ts"))
            for forbidden in (
                'Start without extensions using "pi',
                "operating inside pi",
                "Pi can explain",
                "Pi works best",
                "restart pi",
                "pi exiting",
                "outside pi",
                "within Pi",
                "Location of pi executable",
                "Update pi",
                "${APP_NAME} update pi",
            ):
                self.assertNotIn(forbidden, combined)

        upstream_package = json.loads((UPSTREAM / "packages/coding-agent/package.json").read_text(encoding="utf-8"))
        self.assertEqual(upstream_package["name"], "@earendil-works/pi-coding-agent")
        self.assertEqual(upstream_package["bin"], {"pi": "dist/cli.js"})

    def test_debian_package_composes_independent_modules(self):
        control = (COMPONENT / "debian/control").read_text(encoding="utf-8")
        binary_control = (COMPONENT / "debian/binary-control").read_text(encoding="utf-8")
        for package in (
            "buzzard-search",
            "buzzard-torrent-search",
            "buzzard-torrent",
            "buzzard-quick-search",
        ):
            self.assertIn(package, control)
            self.assertIn(package, binary_control)
        self.assertNotIn("buzzard-agent-web", control)
        self.assertNotIn("buzzard-agent-web", binary_control)
        self.assertNotIn("node_modules/@jmfederico/pi-web", (COMPONENT / "scripts/build-runtime.sh").read_text(encoding="utf-8"))

    def test_launcher_and_runtime_identity(self):
        launcher = (COMPONENT / "bin/buzzard-agent").read_text(encoding="utf-8")
        self.assertIn("/usr/lib/buzzard-agent/app/node_modules/@earendil-works/pi-coding-agent/dist/cli.js", launcher)
        self.assertIn("extensions/buzzard-capabilities/index.ts", launcher)
        self.assertIn("--no-extensions", launcher)
        self.assertIn("PI_SKIP_VERSION_CHECK=1", launcher)
        self.assertIn("PI_TELEMETRY=0", launcher)
        build = (COMPONENT / "build-deb.sh").read_text(encoding="utf-8")
        self.assertIn("agent/integrations/buzzard-capabilities", build)
        runtime = json.loads((COMPONENT / "runtime-package.json").read_text(encoding="utf-8"))
        self.assertEqual(runtime["name"], "buzzard-agent-runtime")
        self.assertEqual(runtime["piConfig"]["name"], "buzzard-agent")
        self.assertEqual(runtime["buzzardAgentUpstream"]["commit"], "53fa77ccd8a279eb87e92294ef3687b03ff80112")


if __name__ == "__main__":
    unittest.main()
