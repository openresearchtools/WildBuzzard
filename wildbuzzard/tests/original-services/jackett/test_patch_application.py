# SPDX-License-Identifier: AGPL-3.0-or-later

import hashlib
import pathlib
import subprocess
import tarfile
import tempfile
import unittest


class PatchApplicationTest(unittest.TestCase):
    def test_patch_applies_without_fuzz_to_pinned_source(self):
        repository = pathlib.Path(__file__).resolve().parents[4]
        package = repository / "wildbuzzard/third_party/gpl2/jackett"
        archive = package / "upstream/jackett-v0.24.2360.tar.gz"
        self.assertEqual(
            hashlib.sha256(archive.read_bytes()).hexdigest(),
            "3816fea39546b5fa440d3e33b856e73500ee6129e91b14d839fc0f04c7f9bd3e",
        )
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            with tarfile.open(archive, "r:gz") as source:
                source.extractall(root, filter="data")
            checkout = root / "Jackett-0cd8622b735922a909a128d8d6943bb8565a640f"
            patch = package / "patches/0001-add-jackett-mini-read-only-service.patch"
            with patch.open("rb") as patch_input:
                subprocess.run(
                    ["patch", "--batch", "--fuzz=0", "-d", checkout, "-p1"],
                    stdin=patch_input,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    check=True,
                )
            cardigann = checkout / "src/Jackett.Common/Indexers/Definitions/CardigannIndexer.cs"
            self.assertIn(
                "BoundedXmlValidator.Validate(response.ContentBytes);",
                cardigann.read_text(encoding="utf-8"),
            )
            network_policy = checkout / "src/Jackett.Mini/PublicNetworkPolicy.cs"
            policy_text = network_policy.read_text(encoding="utf-8")
            self.assertIn("__WILDBUZZARD_FIXTURE_ORIGIN__", policy_text)
            self.assertTrue(policy_text.endswith("\n}\n"))
            self.assertFalse(any(checkout.rglob("*.rej")))


if __name__ == "__main__":
    unittest.main()
