# SPDX-License-Identifier: AGPL-3.0-or-later

import hashlib
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


COMPONENT = Path(__file__).resolve().parents[1]
UPSTREAM = COMPONENT.parents[1] / "third_party" / "mit" / "pi-web" / "upstream"


class ComponentTests(unittest.TestCase):
    def test_upstream_pin_and_license(self):
        lock = json.loads((COMPONENT / "runtime-lock.json").read_text(encoding="utf-8"))
        self.assertEqual(lock["piWeb"]["commit"], "1d86c2269cc70e09a2af739f73767d9bbf80d9c0")
        for name, key in (("package.json", "packageJsonSha256"), ("package-lock.json", "packageLockSha256"), ("LICENSE", "licenseSha256")):
            actual = hashlib.sha256((UPSTREAM / name).read_bytes()).hexdigest()
            self.assertEqual(actual, lock["piWeb"][key])

    def test_downstream_copy_is_debranded_and_keeps_internal_identity(self):
        before = hashlib.sha256((UPSTREAM / "package.json").read_bytes()).hexdigest()
        with tempfile.TemporaryDirectory() as directory:
            copy = Path(directory) / "source"
            shutil.copytree(UPSTREAM, copy)
            subprocess.run([
                "python3",
                str(COMPONENT / "scripts" / "prepare-source.py"),
                str(copy),
                str(COMPONENT / "runtime-lock.json"),
            ], check=True)
            package = json.loads((copy / "package.json").read_text(encoding="utf-8"))
            self.assertEqual(package["name"], "@jmfederico/pi-web")
            for name, version in json.loads((COMPONENT / "runtime-lock.json").read_text())["piPackages"].items():
                self.assertEqual(package["dependencies"][name], version)
                self.assertNotIn(name, package["devDependencies"])
            self.assertIn("Buzzard Agent Web", (copy / "src/config.ts").read_text(encoding="utf-8"))
            self.assertIn("buzzard-agent-web plugins safe-start", (copy / "src/shared/pluginRecoveryCommands.ts").read_text(encoding="utf-8"))
            self.assertIn("Buzzard Agent Web mark", (copy / "src/client/public/favicon.svg").read_text(encoding="utf-8"))
            self.assertIn('const PI_WEB_PACKAGE_NAME = "buzzard-agent-web";', (copy / "src/server/piWebStatus.ts").read_text(encoding="utf-8"))
        self.assertEqual(hashlib.sha256((UPSTREAM / "package.json").read_bytes()).hexdigest(), before)

    def test_package_boundary_and_browser_contract(self):
        control = (COMPONENT / "libexec" / "control.mjs").read_text(encoding="utf-8")
        package_control = (COMPONENT / "packaging" / "control").read_text(encoding="utf-8")
        lock = (COMPONENT / "runtime-lock.json").read_text(encoding="utf-8")
        for field in ("running", "ready", "url", "port", "configPath", "dataDir", "offline"):
            self.assertIn(field, control)
        dependency_line = package_control.split("Depends:", 1)[1].splitlines()[0]
        self.assertIn("buzzard-agent", dependency_line)
        self.assertNotIn("buzzard-agent-web", dependency_line)
        self.assertNotIn("Suggests: buzzard-agent", package_control)
        self.assertIn("SOURCE_DATE_EPOCH=1786372559", (COMPONENT / "scripts" / "build-deb.sh").read_text(encoding="utf-8"))
        self.assertNotIn("runtimeArchive", lock)
        self.assertNotIn("browserRuntime", lock)

    def test_shell_syntax(self):
        for path in (
            COMPONENT / "bin" / "buzzard-agent-web",
            COMPONENT / "scripts" / "prepare-node.sh",
            COMPONENT / "scripts" / "build-deb.sh",
            COMPONENT / "tests" / "smoke-installed.sh",
            COMPONENT / "tests" / "fake-systemctl.sh",
        ):
            subprocess.run(["sh", "-n", str(path)], check=True)


if __name__ == "__main__":
    unittest.main()
