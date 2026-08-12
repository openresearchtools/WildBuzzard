# SPDX-License-Identifier: AGPL-3.0-or-later

import base64
import gzip
import hashlib
import importlib.util
import io
import json
import stat
import subprocess
import sys
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
VALIDATE = load_script("validate-pi-web-runtime-archive.py", "pi_web_runtime_validate")
COMPARE = load_script("compare-pi-web-runtime-builds.py", "pi_web_compare")
ARCHIVE = load_script("runtime-archive-manifest.py", "pi_web_archive")
COPY = load_script("../copy_pi_web_runtime.py", "pi_web_copy")
PREPARE = load_script("prepare-pi-web-runtime.py", "pi_web_prepare")


def sha256(value):
    return hashlib.sha256(value).hexdigest()


class PiWebRuntimePackagingTest(unittest.TestCase):
    def pi_web_package_files(self):
        return {
            "package.json": json.dumps(
                {"name": "@jmfederico/pi-web", "version": "1.202608.0"},
                sort_keys=True,
            ).encode(),
            "dist/cli.js": b"pi web cli\n",
            "dist/server/index.js": b"pi web server\n",
            "dist/server/sessiond.js": b"pi web sessiond\n",
        }

    def package_archive(self):
        compressed = io.BytesIO()
        with gzip.GzipFile(fileobj=compressed, mode="wb", mtime=0) as zipped:
            with tarfile.open(fileobj=zipped, mode="w") as archive:
                for name, value in self.pi_web_package_files().items():
                    info = tarfile.TarInfo(f"package/{name}")
                    info.size = len(value)
                    info.mode = 0o644
                    info.mtime = 0
                    archive.addfile(info, io.BytesIO(value))
        return compressed.getvalue()

    def core_payload(self):
        files = {
            "bin/pi": b"#!/bin/sh\npi\n",
            "bin/pi-web": b"#!/bin/sh\npi-web\n",
            "bin/pi-web-server": b"#!/bin/sh\npi-web-server\n",
            "bin/pi-web-sessiond": b"#!/bin/sh\npi-web-sessiond\n",
            "node/bin/node": b"\x7fELFnode",
            "node_modules/@earendil-works/pi-agent-core/package.json": json.dumps(
                {"name": "@earendil-works/pi-agent-core", "version": "0.84.1"},
                sort_keys=True,
            ).encode(),
            "node_modules/@earendil-works/pi-ai/package.json": json.dumps(
                {"name": "@earendil-works/pi-ai", "version": "0.84.1"},
                sort_keys=True,
            ).encode(),
            "node_modules/@earendil-works/pi-coding-agent/package.json": json.dumps(
                {
                    "name": "@earendil-works/pi-coding-agent",
                    "version": "0.84.1",
                },
                sort_keys=True,
            ).encode(),
            "node_modules/@earendil-works/pi-coding-agent/dist/cli.js": b"pi cli\n",
        }
        files.update({
            f"node_modules/@jmfederico/pi-web/{name}": value
            for name, value in self.pi_web_package_files().items()
        })
        return files

    def base_lock(self):
        package_files = self.pi_web_package_files()
        payload = self.core_payload()
        executable = {
            "bin/pi",
            "bin/pi-web",
            "bin/pi-web-server",
            "bin/pi-web-sessiond",
            "node/bin/node",
        }
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
                "packageJsonSha256": sha256(package_files["package.json"]),
                "packageLockSha256": sha256(b'{"lockfileVersion":3}\n'),
                "packageArchiveSha256": sha256(self.package_archive()),
                "licenseSha256": "e" * 64,
            },
            "piPackages": {
                "@earendil-works/pi-agent-core": "0.84.1",
                "@earendil-works/pi-ai": "0.84.1",
                "@earendil-works/pi-coding-agent": "0.84.1",
            },
            "node": {
                "version": "22.23.2",
                "archive": "node-v22.23.2-linux-x64.tar.xz",
                "url": "https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-x64.tar.xz",
                "sha256": "f" * 64,
            },
            "runtimeArchive": {
                "bootstrapBlocked": False,
                "sourceCommit": "8" * 40,
                "sha256": "0" * 64,
            },
            "runtimePayload": {
                path: {
                    "sha256": sha256(value),
                    "executable": path in executable,
                }
                for path, value in payload.items()
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

    def create_pinned_runtime(
        self,
        directory,
        *,
        manifest_overrides=None,
        inventory_overrides=None,
        file_overrides=None,
    ):
        lock = self.base_lock()
        payload = self.core_payload()
        inventory = {
            "schema": 1,
            "piWebCommit": lock["piWeb"]["commit"],
            "packageLockSha256": lock["piWeb"]["packageLockSha256"],
            "packages": [
                {
                    "path": f"node_modules/{name}",
                    "name": name,
                    "version": version,
                    "resolved": f"https://registry.npmjs.org/{name}/-/package.tgz",
                    "integrity": "sha512-" + base64.b64encode(b"x" * 64).decode(),
                    "manifestSha256": sha256(
                        payload[f"node_modules/{name}/package.json"]
                    ),
                }
                for name, version in lock["piPackages"].items()
            ],
            "webAccessPackageLockSha256": "2" * 64,
            "webAccessPackages": [],
            "cargoLockSha256": "3" * 64,
            "cargoPackages": [],
        }
        inventory.update(inventory_overrides or {})
        inventory_bytes = json.dumps(inventory).encode()
        files = {
            "source/corresponding.tar.xz": b"source",
            "source/build-inputs.json": b"{}",
            "source/runtime-dependencies.json": inventory_bytes,
            "source/sbom.cdx.json": b"{}",
            "source/sbom.spdx.json": b"{}",
            "source/pi-web-package-lock.json": b'{"lockfileVersion":3}\n',
            f"source/pi-web-package-{lock['piWeb']['commit']}.tgz": self.package_archive(),
            **payload,
        }
        for name, value in (file_overrides or {}).items():
            if value is None:
                files.pop(name, None)
            else:
                files[name] = value
        executables = [
            path
            for path, pin in lock["runtimePayload"].items()
            if pin["executable"] and path in files
        ]
        manifest = {
            "schema": 4,
            "component": "pi-web",
            "version": lock["piWeb"]["version"],
            "piWebCommit": lock["piWeb"]["commit"],
            "piWebTree": lock["piWeb"]["tree"],
            "piWebRepository": lock["piWeb"]["repository"],
            "wildbuzzardCommit": lock["runtimeArchive"]["sourceCommit"],
            "dependencyLockSha256": lock["piWeb"]["packageLockSha256"],
            "nodeVersion": lock["node"]["version"],
            "nodeArchiveSha256": lock["node"]["sha256"],
            "platform": lock["platform"],
            "correspondingSource": "source/corresponding.tar.xz",
            "sourceSha256": sha256(files["source/corresponding.tar.xz"]),
            "buildInputs": "source/build-inputs.json",
            "runtimeDependencyInventory": "source/runtime-dependencies.json",
            "sbom": "source/sbom.cdx.json",
            "spdxSbom": "source/sbom.spdx.json",
            "licenseLocations": [],
            "executableAllowlist": executables,
            "files": {name: sha256(value) for name, value in files.items()},
        }
        manifest.update(manifest_overrides or {})
        archive = directory / "runtime.zip"
        with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_STORED) as output:
            for name, value in files.items():
                entry = zipfile.ZipInfo(name)
                entry.create_system = 3
                entry.external_attr = (
                    stat.S_IFREG | (0o755 if name in executables else 0o644)
                ) << 16
                output.writestr(entry, value)
            output.writestr("wildbuzzard-runtime.json", json.dumps(manifest))
        lock["runtimeArchive"]["sha256"] = sha256(archive.read_bytes())
        lock_path = directory / "lock.json"
        lock_path.write_text(json.dumps(lock), encoding="utf-8")
        return archive, lock_path

    def test_runtime_archive_matches_browser_pin(self):
        with tempfile.TemporaryDirectory() as temporary:
            archive, lock = self.create_pinned_runtime(Path(temporary))
            VALIDATE.validate(archive, lock)

    def test_runtime_archive_accepts_bounded_large_manifest(self):
        with tempfile.TemporaryDirectory() as temporary:
            archive, lock = self.create_pinned_runtime(
                Path(temporary),
                manifest_overrides={"buildPadding": "x" * (3 * 1024 * 1024)},
            )
            VALIDATE.validate(archive, lock)

    def test_bootstrap_archive_pin_always_blocks_packaging(self):
        with tempfile.TemporaryDirectory() as temporary:
            archive, lock_path = self.create_pinned_runtime(Path(temporary))
            lock = json.loads(lock_path.read_text(encoding="utf-8"))
            lock["runtimeArchive"] = {
                "bootstrapBlocked": True,
                "sourceCommit": "0" * 40,
                "sha256": "0" * 64,
            }
            lock_path.write_text(json.dumps(lock), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "bootstrap pin blocks"):
                VALIDATE.validate(archive, lock_path)

    def test_runtime_archive_rejects_whole_archive_digest_drift(self):
        with tempfile.TemporaryDirectory() as temporary:
            archive, lock = self.create_pinned_runtime(Path(temporary))
            with open(archive, "ab") as output:
                output.write(b"unexpected payload")
            with self.assertRaisesRegex(ValueError, "archive digest differs"):
                VALIDATE.validate(archive, lock)

    def test_runtime_archive_rejects_pin_drift(self):
        fields = {
            "piWebCommit": "4" * 40,
            "piWebTree": "5" * 40,
            "piWebRepository": "https://example.invalid/pi-web.git",
            "dependencyLockSha256": "6" * 64,
            "nodeVersion": "0.0.0",
            "nodeArchiveSha256": "7" * 64,
        }
        for field, value in fields.items():
            with self.subTest(field=field), tempfile.TemporaryDirectory() as temporary:
                archive, lock = self.create_pinned_runtime(
                    Path(temporary), manifest_overrides={field: value}
                )
                with self.assertRaisesRegex(ValueError, field):
                    VALIDATE.validate(archive, lock)

    def test_runtime_archive_rejects_unverified_dependencies(self):
        invalid = [
            ("resolved", None),
            ("integrity", None),
            ("integrity", "sha512-c2hvcnQ="),
            ("integrity", "sha512-not+base64!"),
        ]
        for field, value in invalid:
            with self.subTest(
                field=field, value=value
            ), tempfile.TemporaryDirectory() as temporary:
                archive, _lock = self.create_pinned_runtime(Path(temporary))
                with zipfile.ZipFile(archive) as source:
                    inventory = json.loads(
                        source.read("source/runtime-dependencies.json")
                    )
                inventory["packages"][0][field] = value
                archive, lock = self.create_pinned_runtime(
                    Path(temporary),
                    inventory_overrides={"packages": inventory["packages"]},
                )
                with self.assertRaisesRegex(ValueError, "untrusted"):
                    VALIDATE.validate(archive, lock)

    def test_runtime_archive_rejects_unverified_web_access_dependency(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            manifest_path = "seed/web-access/node_modules/web/package.json"
            manifest = json.dumps({"name": "web", "version": "1.0.0"}).encode()
            package = {
                "path": "seed/web-access/node_modules/web",
                "name": "web",
                "version": "1.0.0",
                "resolved": None,
                "integrity": None,
                "manifestSha256": sha256(manifest),
            }
            archive, lock = self.create_pinned_runtime(
                directory,
                inventory_overrides={"webAccessPackages": [package]},
                file_overrides={manifest_path: manifest},
            )
            with self.assertRaisesRegex(ValueError, "untrusted"):
                VALIDATE.validate(archive, lock)

    def test_runtime_archive_rejects_malformed_inventory_types(self):
        for field, value in (("packages", {}), ("webAccessPackages", {})):
            with self.subTest(field=field), tempfile.TemporaryDirectory() as temporary:
                archive, lock = self.create_pinned_runtime(
                    Path(temporary), inventory_overrides={field: value}
                )
                with self.assertRaises(ValueError):
                    VALIDATE.validate(archive, lock)

    def test_runtime_archive_rejects_absent_or_changed_payload(self):
        path = "node/bin/node"
        for value in (None, b"different node"):
            with self.subTest(value=value), tempfile.TemporaryDirectory() as temporary:
                archive, lock = self.create_pinned_runtime(
                    Path(temporary), file_overrides={path: value}
                )
                with self.assertRaises(ValueError):
                    VALIDATE.validate(archive, lock)

    def test_runtime_archive_rejects_wrong_embedded_lock_and_package(self):
        lock_path = "source/pi-web-package-lock.json"
        package_path = f"source/pi-web-package-{'a' * 40}.tgz"
        for path, value in ((lock_path, b"wrong"), (package_path, b"wrong")):
            with self.subTest(path=path), tempfile.TemporaryDirectory() as temporary:
                archive, lock = self.create_pinned_runtime(
                    Path(temporary), file_overrides={path: value}
                )
                with self.assertRaises(ValueError):
                    VALIDATE.validate(archive, lock)

    def test_copy_uses_the_validated_open_archive_after_replacement(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            archive, lock = self.create_pinned_runtime(directory)
            expected = archive.read_bytes()
            replacement = directory / "replacement.zip"
            replacement.write_bytes(b"not a runtime")

            class ReplacingValidator:
                @staticmethod
                def validate_opened_archive(source, lock_path):
                    result = VALIDATE.validate_opened_archive(source, lock_path)
                    replacement.replace(archive)
                    return result

            original_validator = COPY.validator
            COPY.validator = lambda: ReplacingValidator
            try:
                output = io.BytesIO()
                COPY.main(output, archive, lock)
            finally:
                COPY.validator = original_validator
            self.assertEqual(output.getvalue(), expected)
            self.assertEqual(archive.read_bytes(), b"not a runtime")

    def test_copy_uses_an_immutable_snapshot_after_in_place_rewrite(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            archive, lock = self.create_pinned_runtime(directory)
            expected = archive.read_bytes()

            class RewritingValidator:
                @staticmethod
                def validate_opened_archive(source, lock_path):
                    result = VALIDATE.validate_opened_archive(source, lock_path)
                    archive.write_bytes(b"rewritten after validation")
                    return result

            original_validator = COPY.validator
            COPY.validator = lambda: RewritingValidator
            try:
                output = io.BytesIO()
                COPY.main(output, archive, lock)
            finally:
                COPY.validator = original_validator
            self.assertEqual(output.getvalue(), expected)
            self.assertEqual(archive.read_bytes(), b"rewritten after validation")

    def test_runtime_validator_command_checks_real_archive(self):
        with tempfile.TemporaryDirectory() as temporary:
            archive, lock = self.create_pinned_runtime(Path(temporary))
            result = subprocess.run(
                [
                    sys.executable,
                    SCRIPTS / "validate-pi-web-runtime-archive.py",
                    archive,
                    "--lock",
                    lock,
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_configure_enforces_runtime_archive_pin(self):
        configure = (SCRIPTS.parent / "moz.configure").read_text(encoding="utf-8")
        mozbuild = (SCRIPTS.parent / "moz.build").read_text(encoding="utf-8")
        build = (SCRIPTS / "build-pi-web-runtime.sh").read_text(encoding="utf-8")
        self.assertIn("validate-pi-web-runtime-archive.py", configure)
        self.assertIn("pi-web-runtime-lock.json", configure)
        self.assertIn("check_cmd_output(", configure)
        self.assertIn('pi_web_runtime.script = "copy_pi_web_runtime.py"', mozbuild)
        self.assertIn('"pi-web-runtime-lock.json"', mozbuild)
        self.assertIn('"scripts/validate-pi-web-runtime-archive.py"', mozbuild)
        self.assertIn("wildbuzzard/scripts/validate-pi-web-runtime-archive.py", build)
        self.assertIn(
            "validate_opened_archive",
            (SCRIPTS.parent / "copy_pi_web_runtime.py").read_text(),
        )

    def test_runtime_and_source_archives_are_byte_reproducible_in_distinct_roots(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            roots = [directory / "first-root", directory / "other" / "second-root"]
            outputs = []
            for index, root in enumerate(roots):
                (root / "bin").mkdir(parents=True)
                tool = root / "bin" / "tool"
                tool.write_bytes(b"payload")
                tool.chmod(0o755)
                (root / "data").write_bytes(b"data")
                tool.touch(1_700_000_000 + index)
                runtime = directory / f"runtime-{index}.zip"
                source = directory / f"source-{index}.tar.xz"
                ARCHIVE.archive(root, runtime, 1_700_000_000)
                subprocess.run(
                    [
                        "tar",
                        "--sort=name",
                        "--mtime=@1700000000",
                        "--owner=0",
                        "--group=0",
                        "--numeric-owner",
                        "-cJf",
                        source,
                        "-C",
                        root,
                        ".",
                    ],
                    check=True,
                )
                outputs.append((runtime, source))
            first, second = outputs
            self.assertEqual(first[0].read_bytes(), second[0].read_bytes())
            self.assertEqual(first[1].read_bytes(), second[1].read_bytes())
            with zipfile.ZipFile(first[0]) as value:
                self.assertEqual(value.namelist(), ["bin/tool", "data"])
                self.assertEqual(
                    value.getinfo("bin/tool").external_attr >> 16, stat.S_IFREG | 0o755
                )

    def node_pty_tree(self, root, embedded_root):
        node_pty = root / "node_modules" / "node-pty"
        binary = node_pty / "build" / "Release" / "pty.node"
        binary.parent.mkdir(parents=True)
        binary.write_bytes(b"\x7fELFnode-pty-native-runtime")
        for relative in PREPARE.NODE_PTY_METADATA:
            path = node_pty / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(f"generated from {embedded_root}\n", encoding="utf-8")
        return binary

    def test_node_pty_normalization_is_reproducible_and_preserves_native_addon(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            roots = [directory / "first", directory / "different" / "second"]
            archives = []
            for index, root in enumerate(roots):
                binary = self.node_pty_tree(root, root)
                expected = sha256(binary.read_bytes())
                self.assertEqual(PREPARE.normalize_node_pty(root), expected)
                PREPARE.verify_node_pty(root, expected)
                self.assertEqual(binary.read_bytes(), b"\x7fELFnode-pty-native-runtime")
                self.assertFalse((binary.parents[2] / "node-addon-api").exists())
                archive = directory / f"node-pty-{index}.zip"
                ARCHIVE.archive(root, archive, 1_700_000_000)
                archives.append(archive)
            self.assertEqual(archives[0].read_bytes(), archives[1].read_bytes())

    def test_runtime_path_scan_detects_each_absolute_root_across_chunks(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            runtime = directory / "runtime"
            runtime.mkdir()
            first = directory / "first-build-root"
            second = directory / "different" / "second-build-root"
            first.mkdir()
            second.mkdir(parents=True)
            (runtime / "first.bin").write_bytes(b"x" * (1024 * 1024 - 2) + bytes(first))
            (runtime / "second.txt").write_text(str(second), encoding="utf-8")
            self.assertEqual(
                PREPARE.path_leaks(runtime, [first, second]),
                ["first.bin", "second.txt"],
            )
            with self.assertRaisesRegex(ValueError, "first.bin, second.txt"):
                PREPARE.reject_path_leaks(runtime, [first, second])
            (runtime / "first.bin").write_bytes(b"normalized")
            (runtime / "second.txt").write_bytes(b"normalized")
            PREPARE.reject_path_leaks(runtime, [first, second])

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
        self.assertIn("npm_config_globalconfig=${run_root}/npmrc-global", source)
        self.assertIn("npm_config_userconfig=${run_root}/npmrc-user", source)
        self.assertNotIn('=${run_root}/npmrc"', source)
        for path in (
            "build/Makefile",
            "build/config.gypi",
            "build/pty.target.mk",
            "node-addon-api/node_addon_api.target.mk",
            "node-addon-api/node_addon_api_except.target.mk",
            "node-addon-api/node_addon_api_maybe.target.mk",
        ):
            self.assertIn(path, PREPARE.NODE_PTY_METADATA)
        self.assertIn("${node_pty_sha256}", source)
        self.assertIn(
            "Packaged Pi Web node-pty native runtime differs from the verified build",
            (SCRIPTS / "prepare-pi-web-runtime.py").read_text(encoding="utf-8"),
        )
        self.assertIn("--remap-path-prefix=${cargo_home}=cargo-home", source)
        self.assertIn("reject-path-leaks", source)
        self.assertIn('"${build_root}" "${source_repo}" "${fork_repo}"', source)
        self.assertLess(
            source.index("normalize-node-pty"),
            source.index(
                "assemble-pi-web-runtime.mjs", source.index("normalize-node-pty")
            ),
        )
        self.assertIn("sbom.cdx.json", source)
        self.assertIn("sbom.spdx.json", source)
        self.assertIn("test-pi-web-runtime-lifecycle.mjs", source)
        self.assertIn("verify-pi-web-installed-tree.mjs", source)
        self.assertIn('--runtime "${runtime_dir}"', source)
        self.assertIn(
            'ln -s -- "${pi_web_checkout}/node_modules" "${browser_tools_modules}"',
            source,
        )
        self.assertIn('unlink -- "${browser_tools_modules}"', source)
        self.assertIn("remote/wildbuzzard/TorrentAgentTools.sys.mjs", source)
        self.assertIn("'export PI_TELEMETRY=0'", source)
        self.assertIn("'export PI_SKIP_VERSION_CHECK=1'", source)
        committed_inputs = source[
            source.index("for path in ") : source.index(
                "; do", source.index("for path in ")
            )
        ]
        corresponding_source = source[
            source.index('git -C "${source_checkout}" archive') : source.index(
                "|\n  tar -xf", source.index('git -C "${source_checkout}" archive')
            )
        ]
        sparse_checkout = source[
            source.index(
                'git -C "${source_checkout}" sparse-checkout set'
            ) : source.index(
                'git -C "${source_checkout}" checkout',
                source.index('git -C "${source_checkout}" sparse-checkout set'),
            )
        ]
        build_controls = [
            "assemble-pi-web-runtime.mjs",
            "build-pi-web-runtime.sh",
            "compare-pi-web-runtime-builds.py",
            "prepare-pi-web-runtime.py",
            "runtime-archive-manifest.py",
            "test-pi-web-runtime-lifecycle.mjs",
            "validate-pi-web-runtime-archive.py",
            "verify-pi-web-installed-tree.mjs",
            "verify-pi-web-runtime-inputs.py",
        ]
        for path in build_controls:
            self.assertIn(path, committed_inputs)
            self.assertIn(path, corresponding_source)
            self.assertIn(path, sparse_checkout)

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
            json.dumps({
                "lockfileVersion": 3,
                "packages": {
                    "": {"name": "fixture", "version": "1.0.0"},
                    "node_modules/package": {"version": locked},
                },
            }),
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
