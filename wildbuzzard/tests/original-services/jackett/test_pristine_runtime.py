# SPDX-License-Identifier: AGPL-3.0-or-later

import json
import pathlib
import tempfile
import unittest
from unittest import mock

import pristine_runtime


class PristineRuntimeTest(unittest.TestCase):
    def create_record(self, root, files, executable_digest):
        digest = pristine_runtime.inventory_digest(files)
        record = {
            "schemaVersion": 1,
            "component": "pristine-jackett-release-runtime",
            "sourceCommit": pristine_runtime.COMMIT,
            "sourceArchiveSha256": pristine_runtime.SOURCE_SHA256,
            "sourceManifestSha256": pristine_runtime.SOURCE_MANIFEST_SHA256,
            "releaseVersion": pristine_runtime.RELEASE_VERSION,
            "releaseUrl": pristine_runtime.RELEASE_URL,
            "releaseArchiveSha256": pristine_runtime.RELEASE_SHA256,
            "releaseArchiveSize": pristine_runtime.RELEASE_SIZE,
            "releaseExecutableSha256": executable_digest,
            "releaseLockSha256": pristine_runtime.RELEASE_LOCK_SHA256,
            "platform": "linux/amd64",
            "preparationMode": "verified-official-release-extraction",
            "runtimeInventorySha256": digest,
            "files": files,
        }
        record_path = root / "record.json"
        pin_path = root / "pin.json"
        record_path.write_text(json.dumps(record), encoding="utf-8")
        pin_path.write_text(
            json.dumps({
                "releaseArchiveSha256": pristine_runtime.RELEASE_SHA256,
                "releaseExecutableSha256": executable_digest,
                "runtimeInventorySha256": digest,
                "schemaVersion": 1,
                "source": "official-v0.24.2360-linux-x64-release",
            }),
            encoding="utf-8",
        )
        return record_path, pin_path

    def create_runtime(self, root):
        runtime = root / "runtime"
        runtime.mkdir()
        executable = runtime / "jackett"
        executable.write_bytes(b"apphost")
        executable.chmod(0o755)
        (runtime / "Jackett.dll").write_bytes(b"managed")
        return runtime, pristine_runtime.sha256_file(executable)

    def test_complete_inventory_is_required(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            runtime, executable_digest = self.create_runtime(root)
            files = pristine_runtime.runtime_inventory(runtime)
            record, pin = self.create_record(root, files, executable_digest)

            with mock.patch.object(
                pristine_runtime, "RELEASE_EXECUTABLE_SHA256", executable_digest
            ):
                pristine_runtime.verify_runtime(runtime, record, pin)
                (runtime / "Jackett.dll").write_bytes(b"tampered")
                with self.assertRaisesRegex(RuntimeError, "differs"):
                    pristine_runtime.verify_runtime(runtime, record, pin)

    def test_executable_identity_is_required_independently(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            runtime, _ = self.create_runtime(root)
            files = pristine_runtime.runtime_inventory(runtime)
            record, pin = self.create_record(
                root, files, pristine_runtime.RELEASE_EXECUTABLE_SHA256
            )

            with self.assertRaisesRegex(RuntimeError, "executable differs"):
                pristine_runtime.verify_runtime(runtime, record, pin)

    def test_missing_pin_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            runtime, executable_digest = self.create_runtime(root)
            files = pristine_runtime.runtime_inventory(runtime)
            record, pin = self.create_record(root, files, executable_digest)
            pin.write_text('{"runtimeInventorySha256":null}\n', encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "have not been recorded"):
                pristine_runtime.verify_runtime(runtime, record, pin)

    def test_links_and_hardlinks_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = pathlib.Path(directory) / "runtime"
            runtime.mkdir()
            target = runtime / "target"
            target.write_bytes(b"value")
            (runtime / "link").symlink_to(target)
            with self.assertRaisesRegex(RuntimeError, "link or special"):
                pristine_runtime.runtime_inventory(runtime)


if __name__ == "__main__":
    unittest.main()
