# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import importlib.util
import pathlib
import unittest


MODULE_PATH = pathlib.Path(__file__).parents[1] / "src" / "buzzard_torrent.py"
SPEC = importlib.util.spec_from_file_location("buzzard_torrent", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class TorrentContractTest(unittest.TestCase):
    def test_hash_boundary(self) -> None:
        self.assertEqual(MODULE.require_hash("a" * 40), "a" * 40)
        with self.assertRaises(ValueError):
            MODULE.require_hash("not-a-hash")

    def test_runtime_is_owned_by_package(self) -> None:
        self.assertEqual(MODULE.paths()["runtime"], pathlib.Path("/usr/lib/buzzard-torrent/runtime"))

    def test_list_validation_rejects_passthrough_arguments(self) -> None:
        self.assertEqual(MODULE.validate_list({})["limit"], 50)
        with self.assertRaises(ValueError):
            MODULE.validate_list({"arbitraryQbittorrentParameter": "value"})
        with self.assertRaises(ValueError):
            MODULE.validate_list({"limit": 101})

    def test_destructive_operations_require_confirmation(self) -> None:
        with self.assertRaisesRegex(ValueError, "explicit user confirmation"):
            MODULE.add({"magnet": "magnet:?xt=urn:btih:" + "a" * 40})
        with self.assertRaisesRegex(ValueError, "explicit user confirmation"):
            MODULE.control({"ids": ["a" * 40], "action": "delete"})

    def test_tracker_credentials_are_not_returned(self) -> None:
        self.assertEqual(
            MODULE.safe_tracker_url("https://user:secret@example.com/announce?token=private#fragment"),
            "https://example.com/announce",
        )


if __name__ == "__main__":
    unittest.main()
