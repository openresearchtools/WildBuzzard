# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import base64
import importlib.util
import pathlib
import unittest
from unittest import mock

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
        self.assertEqual(
            MODULE.paths()["runtime"], pathlib.Path("/usr/lib/buzzard-torrent/runtime")
        )

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

    def test_add_validates_download_path_for_every_source(self) -> None:
        sources = [
            {"magnet": "magnet:?xt=urn:btih:" + "a" * 40},
            {"torrentBase64": base64.b64encode(b"torrent").decode("ascii")},
        ]
        for source in sources:
            for invalid in (
                None,
                0,
                "a" * 4097,
                "bad\0path",
                "bad\r\npath",
                "bad\x85path",
            ):
                with self.subTest(source=next(iter(source)), invalid=invalid):
                    with self.assertRaisesRegex(ValueError, "downloadPath is invalid"):
                        MODULE.add({
                            **source,
                            "downloadPath": invalid,
                            "confirmed": True,
                        })

    def test_base64_add_includes_validated_savepath_in_multipart(self) -> None:
        payload = b"d4:infod4:name4:testee"
        calls = []

        def capture(target, method="GET", body=None, content_type=None):
            calls.append((target, method, body, content_type))
            return "Ok."

        with mock.patch.object(MODULE, "request_text", side_effect=capture):
            result = MODULE.add({
                "torrentBase64": base64.b64encode(payload).decode("ascii"),
                "downloadPath": "/tmp/Buzzard downloads",
                "confirmed": True,
            })

        self.assertEqual(result, {"added": True})
        self.assertEqual(len(calls), 1)
        target, method, body, content_type = calls[0]
        self.assertEqual((target, method), ("/api/v2/torrents/add", "POST"))
        self.assertRegex(
            content_type, r"^multipart/form-data; boundary=buzzard-[0-9a-f]{32}$"
        )
        self.assertIn(
            b'Content-Disposition: form-data; name="savepath"\r\n\r\n'
            b"/tmp/Buzzard downloads\r\n",
            body,
        )
        self.assertIn(
            b'Content-Disposition: form-data; name="torrents"; filename="torrent.torrent"'
            b"\r\nContent-Type: application/x-bittorrent\r\n\r\n" + payload,
            body,
        )

    def test_tracker_credentials_are_not_returned(self) -> None:
        self.assertEqual(
            MODULE.safe_tracker_url(
                "https://user:secret@example.com/announce?token=private#fragment"
            ),
            "https://example.com/announce",
        )


if __name__ == "__main__":
    unittest.main()
