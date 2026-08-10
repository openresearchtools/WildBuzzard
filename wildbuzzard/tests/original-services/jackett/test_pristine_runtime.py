# SPDX-License-Identifier: AGPL-3.0-or-later

import json
import pathlib
import tempfile
import unittest

from pristine_runtime import (
    BUILD_COMMAND,
    SOURCE_DATE_EPOCH,
    inventory_digest,
    runtime_inventory,
    verify_runtime,
)


class PristineRuntimeTest(unittest.TestCase):
    def create_record(self, root, files):
        digest = inventory_digest(files)
        record = {
            "schemaVersion": 1,
            "component": "pristine-jackett-test-runtime",
            "sourceCommit": "0cd8622b735922a909a128d8d6943bb8565a640f",
            "sourceArchiveSha256": "3816fea39546b5fa440d3e33b856e73500ee6129e91b14d839fc0f04c7f9bd3e",
            "sourceManifestSha256": "7ce151e9e59943d4411bc2347cbfb6a7a5fb29c636ca2692b521f1f2dc086187",
            "sdkImage": "mcr.microsoft.com/dotnet/sdk@sha256:6e6542a43b6bf3c5ecfa80dd33c79c9fd09d58f95f4ebacd14fa056275b25164",
            "sdkPlatform": "linux/amd64",
            "sdkPlatformDigest": "sha256:" + "a" * 64,
            "sdkImageId": "sha256:" + "b" * 64,
            "sourceDateEpoch": SOURCE_DATE_EPOCH,
            "buildCommand": BUILD_COMMAND,
            "runtimeInventorySha256": digest,
            "files": files,
        }
        record_path = root / "record.json"
        pin_path = root / "pin.json"
        record_path.write_text(json.dumps(record))
        pin_path.write_text(
            json.dumps({
                "runtimeInventorySha256": digest,
                "schemaVersion": 1,
                "sdkImageId": record["sdkImageId"],
                "sdkPlatformDigest": record["sdkPlatformDigest"],
            })
        )
        return record_path, pin_path

    def test_complete_inventory_is_required(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            runtime = root / "runtime"
            runtime.mkdir()
            executable = runtime / "jackett"
            library = runtime / "Jackett.dll"
            executable.write_bytes(b"apphost")
            executable.chmod(0o755)
            library.write_bytes(b"managed")
            files = runtime_inventory(runtime)
            record, pin = self.create_record(root, files)

            verify_runtime(runtime, record, pin)
            library.write_bytes(b"tampered")
            with self.assertRaisesRegex(RuntimeError, "differs"):
                verify_runtime(runtime, record, pin)

    def test_missing_pin_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            runtime = root / "runtime"
            runtime.mkdir()
            (runtime / "jackett").write_bytes(b"apphost")
            files = runtime_inventory(runtime)
            record, pin = self.create_record(root, files)
            pin.write_text('{"runtimeInventorySha256":null}\n')
            with self.assertRaisesRegex(RuntimeError, "have not been recorded"):
                verify_runtime(runtime, record, pin)

    def test_links_and_hardlinks_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            runtime = root / "runtime"
            runtime.mkdir()
            target = runtime / "target"
            target.write_bytes(b"value")
            (runtime / "link").symlink_to(target)
            with self.assertRaisesRegex(RuntimeError, "link or special"):
                runtime_inventory(runtime)


if __name__ == "__main__":
    unittest.main()
