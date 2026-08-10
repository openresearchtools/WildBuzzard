# SPDX-License-Identifier: AGPL-3.0-or-later

import hashlib
import importlib.util
import io
import json
import stat
import subprocess
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path

SCRIPTS = Path(__file__).parents[1]


def load_script(name, module_name):
    spec = importlib.util.spec_from_file_location(module_name, SCRIPTS / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


VERIFY = load_script("verify-pi-web-runtime-inputs.py", "pi_web_verify")
COMPARE = load_script("compare-pi-web-runtime-builds.py", "pi_web_compare")
ARCHIVE = load_script("runtime-archive-manifest.py", "pi_web_archive")


def sha256(value):
    return hashlib.sha256(value).hexdigest()


class PiWebRuntimePackagingTest(unittest.TestCase):
    def base_lock(self):
        return {
            "schema": 1,
            "platform": "linux-x64",
            "piWeb": {
                "commit": "a" * 40,
                "tree": "b" * 40,
                "repository": "https://github.com/openresearchtools/pi-web.git",
                "name": "@jmfederico/pi-web",
                "version": "1.202608.0",
                "packageManager": "npm@10.9.8",
                "packageJsonSha256": "c" * 64,
                "packageLockSha256": "d" * 64,
                "licenseSha256": "e" * 64,
            },
            "piPackages": {
                "@earendil-works/pi-agent-core": "0.83.0",
                "@earendil-works/pi-ai": "0.83.0",
                "@earendil-works/pi-coding-agent": "0.83.0",
            },
            "node": {
                "version": "22.23.2",
                "archive": "node-v22.23.2-linux-x64.tar.xz",
                "url": "https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-x64.tar.xz",
                "sha256": "f" * 64,
            },
        }

    def test_lock_rejects_missing_pin_and_checksum_drift(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "lock.json"
            lock = self.base_lock()
            path.write_text(json.dumps(lock), encoding="utf-8")
            VERIFY.load_lock(path)
            del lock["node"]["sha256"]
            path.write_text(json.dumps(lock), encoding="utf-8")
            with self.assertRaises(ValueError):
                VERIFY.load_lock(path)
            lock = self.base_lock()
            lock["piWeb"]["packageLockSha256"] = "not-a-checksum"
            path.write_text(json.dumps(lock), encoding="utf-8")
            with self.assertRaises(ValueError):
                VERIFY.load_lock(path)

    def test_fork_rejects_head_drift(self):
        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary)
            subprocess.run(["git", "init", "-q", repo], check=True)
            subprocess.run(
                ["git", "-C", repo, "config", "user.email", "test@example.invalid"],
                check=True,
            )
            subprocess.run(
                ["git", "-C", repo, "config", "user.name", "Test"], check=True
            )
            (repo / "file").write_text("first\n", encoding="utf-8")
            subprocess.run(["git", "-C", repo, "add", "file"], check=True)
            subprocess.run(["git", "-C", repo, "commit", "-qm", "first"], check=True)
            pinned = subprocess.check_output(
                ["git", "-C", repo, "rev-parse", "HEAD"], text=True
            ).strip()
            (repo / "file").write_text("second\n", encoding="utf-8")
            subprocess.run(["git", "-C", repo, "commit", "-qam", "second"], check=True)
            lock = self.base_lock()
            lock["piWeb"]["commit"] = pinned
            with self.assertRaisesRegex(ValueError, "pinned commit"):
                VERIFY.verify_fork(lock, repo)

    def test_fork_rejects_untracked_input_impurity(self):
        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary)
            subprocess.run(["git", "init", "-q", repo], check=True)
            (repo / "untracked").write_text("unexpected\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "must be clean"):
                VERIFY.verify_fork(self.base_lock(), repo)

    def test_runtime_zip_is_byte_reproducible(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "root"
            root.mkdir()
            (root / "bin").mkdir()
            tool = root / "bin" / "tool"
            tool.write_bytes(b"payload")
            tool.chmod(0o755)
            (root / "data").write_bytes(b"data")
            first = Path(temporary) / "first.zip"
            second = Path(temporary) / "second.zip"
            ARCHIVE.archive(root, first, 1_700_000_000)
            tool.touch()
            ARCHIVE.archive(root, second, 1_700_000_000)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            with zipfile.ZipFile(first) as value:
                self.assertEqual(value.namelist(), ["bin/tool", "data"])
                self.assertEqual(
                    value.getinfo("bin/tool").external_attr >> 16, stat.S_IFREG | 0o755
                )

    def build_record(self, directory):
        runtime = directory / "runtime.zip"
        build_inputs = b"{}\n"
        manifest = {
            "buildInputs": "source/build-inputs.json",
            "files": {"source/build-inputs.json": sha256(build_inputs)},
        }
        with zipfile.ZipFile(runtime, "w") as archive:
            archive.writestr("source/build-inputs.json", build_inputs)
            archive.writestr("wildbuzzard-runtime.json", json.dumps(manifest))
        source = directory / "source.tar"
        with tarfile.open(source, "w") as archive:
            info = tarfile.TarInfo("source/file")
            info.size = 4
            info.mode = 0o644
            info.mtime = 1_700_000_000
            archive.addfile(info, io.BytesIO(b"data"))
        record = {
            "schema": 1,
            "environment": {"node": "22.23.2"},
            "inputs": {"pin": "exact"},
            "runtimeArchive": {
                "path": runtime.name,
                "sha256": sha256(runtime.read_bytes()),
            },
            "sourceArchive": {
                "path": source.name,
                "sha256": sha256(source.read_bytes()),
            },
        }
        path = directory / "build-record.json"
        path.write_text(json.dumps(record), encoding="utf-8")
        return path

    def test_comparator_checks_archives_and_build_metadata(self):
        with tempfile.TemporaryDirectory() as temporary:
            left_dir = Path(temporary) / "left"
            right_dir = Path(temporary) / "right"
            left_dir.mkdir()
            right_dir.mkdir()
            left = self.build_record(left_dir)
            right = self.build_record(right_dir)
            COMPARE.compare(left, right)
            value = json.loads(right.read_text(encoding="utf-8"))
            value["environment"]["node"] = "changed"
            right.write_text(json.dumps(value), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "records differ"):
                COMPARE.compare(left, right)

    def test_builder_has_locked_fail_closed_dependency_policy(self):
        source = (SCRIPTS / "build-pi-web-runtime.sh").read_text(encoding="utf-8")
        self.assertNotIn("npm install", source)
        self.assertIn('"${bundled_node}" "${bundled_npm}" ci', source)
        self.assertIn("Node.js archive checksum verification failed", source)
        self.assertIn('"${git_runtime_sha256}" != "${git_runtime_expected}"', source)
        self.assertIn(
            '"${ytdlp_runtime_sha256}" != "${ytdlp_runtime_expected}"', source
        )
        self.assertIn("Build input is not committed", source)
        self.assertIn('cargo_target="${run_root}/cargo-target"', source)
        self.assertNotIn("cargo/browser-runner-${source_commit}", source)
        self.assertIn(
            "Bundled npm does not match the Pi Web package-manager pin", source
        )
        self.assertIn("npm_config_offline=true", source)
        self.assertIn(
            'npm_config_globalconfig=${run_root}/npmrc-global', source
        )
        self.assertIn('npm_config_userconfig=${run_root}/npmrc-user', source)
        self.assertNotIn('=${run_root}/npmrc"', source)
        self.assertIn("sbom.cdx.json", source)
        self.assertIn("sbom.spdx.json", source)
        self.assertIn("test-pi-web-runtime-lifecycle.mjs", source)
        self.assertIn("verify-pi-web-installed-tree.mjs", source)
        self.assertIn('--runtime "${runtime_dir}"', source)
        self.assertIn("'export PI_TELEMETRY=0'", source)
        self.assertIn("'export PI_SKIP_VERSION_CHECK=1'", source)

    def run_installed_tree_verifier(self, root):
        return subprocess.run(
            ["node", SCRIPTS / "verify-pi-web-installed-tree.mjs", root],
            capture_output=True,
            text=True,
            check=False,
        )

    def installed_tree(self, root, locked="1.0.0", installed="1.0.0"):
        package = root / "node_modules" / "package"
        package.mkdir(parents=True)
        (root / "node_modules" / ".cache").mkdir()
        (package / "package.json").write_text(
            json.dumps({"name": "package", "version": installed}),
            encoding="utf-8",
        )
        (root / "package-lock.json").write_text(
            json.dumps(
                {
                    "lockfileVersion": 3,
                    "packages": {
                        "": {"name": "fixture", "version": "1.0.0"},
                        "node_modules/package": {"version": locked},
                    },
                }
            ),
            encoding="utf-8",
        )
        return package

    def test_installed_tree_matches_lock(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.installed_tree(root)
            result = self.run_installed_tree_verifier(root)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_installed_tree_rejects_shrinkwrap_version_drift(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.installed_tree(root, locked="2.0.0", installed="1.0.0")
            result = self.run_installed_tree_verifier(root)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("identity differs", result.stderr)

    def test_installed_tree_rejects_unlocked_and_missing_packages(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            package = self.installed_tree(root)
            extra = root / "node_modules" / "extra"
            extra.mkdir()
            (extra / "package.json").write_text(
                json.dumps({"name": "extra", "version": "1.0.0"}),
                encoding="utf-8",
            )
            result = self.run_installed_tree_verifier(root)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("absent from package-lock", result.stderr)
            extra.joinpath("package.json").unlink()
            extra.rmdir()
            package.joinpath("package.json").unlink()
            package.rmdir()
            result = self.run_installed_tree_verifier(root)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("not installed", result.stderr)


if __name__ == "__main__":
    unittest.main()
