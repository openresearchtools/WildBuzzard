# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import importlib.util
import io
import json
import os
import pathlib
import stat
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch


MODULE_PATH = pathlib.Path(__file__).parents[1] / "src" / "buzzard_search.py"
sys.path.insert(0, str(MODULE_PATH.parent))
SPEC = importlib.util.spec_from_file_location("buzzard_search", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class SearchContractTest(unittest.TestCase):
    def test_time_filter_and_sort_are_independent(self) -> None:
        value = MODULE.validate_search(
            {"query": "linux", "timeRange": "month", "sortOrder": "newest"}
        )
        self.assertEqual(value["timeRange"], "month")
        self.assertEqual(value["sortOrder"], "newest")

    def test_missing_dates_sort_last_in_both_directions(self) -> None:
        values = [
            {"url": "missing"},
            {"url": "later", "publishedDate": "2026-08-18T00:00:00Z"},
            {"url": "earlier", "publishedDate": "2026-08-17T00:00:00Z"},
        ]
        for order, expected in (
            ("newest", ["later", "earlier", "missing"]),
            ("oldest", ["earlier", "later", "missing"]),
        ):
            dated = [(index, item, MODULE.date_value(item)) for index, item in enumerate(values)]
            dated.sort(
                key=lambda entry: (
                    entry[2] is None,
                    -(entry[2].timestamp()) if entry[2] and order == "newest" else entry[2].timestamp() if entry[2] else 0,
                    entry[0],
                )
            )
            self.assertEqual([entry[1]["url"] for entry in dated], expected)

    def test_page_artifact_is_private_absolute_and_exactly_truncated(self) -> None:
        markdown = "x" * 16_001
        with tempfile.TemporaryDirectory() as runtime:
            os.chmod(runtime, 0o700)
            with patch.dict(os.environ, {"XDG_RUNTIME_DIR": runtime}), patch.object(
                MODULE, "fetch_readable_page", return_value=(markdown, "A useful page title")
            ):
                result = MODULE.fetch({"url": "https://example.com/read"})
            path = pathlib.Path(result["fullMarkdownPath"])
            self.assertTrue(path.is_absolute())
            self.assertEqual(path.read_text(encoding="utf-8"), markdown)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700)
            self.assertEqual(
                result["content"],
                "x" * 16_000 + "\n\n... (truncated, 16001 chars total)",
            )

    def test_filename_is_bounded_readable_and_contains_no_url_secret(self) -> None:
        title = MODULE.title_without_url_secrets(
            "Report secret-value", "https://example.com/?token=secret-value"
        )
        with tempfile.TemporaryDirectory() as runtime:
            os.chmod(runtime, 0o700)
            with patch.dict(os.environ, {"XDG_RUNTIME_DIR": runtime}):
                path = MODULE.write_markdown_document(title * 100, "full")
            self.assertLessEqual(len(path.name.encode()), os.pathconf(path.parent, "PC_NAME_MAX"))
            self.assertIn("Report-redacted", path.name)
            self.assertNotIn("secret", path.name)

    def test_relative_runtime_directory_is_rejected(self) -> None:
        with patch.dict(os.environ, {"XDG_RUNTIME_DIR": "relative-runtime"}):
            with self.assertRaisesRegex(RuntimeError, "XDG_RUNTIME_DIR is unsafe"):
                MODULE.document_directory()

    def test_plain_and_json_fetch_outputs_have_stable_path_contract(self) -> None:
        result = {
            "schema": 1,
            "implementation": "buzzard-search",
            "kind": "page",
            "content": "inline",
            "fullMarkdownPath": "/tmp/private/page.md",
        }
        output = io.StringIO()
        with redirect_stdout(output):
            MODULE.emit_web_result(result, False)
        self.assertEqual(
            output.getvalue(),
            "inline\n\nBUZZARD_FULL_MARKDOWN_PATH=/tmp/private/page.md\n",
        )
        output = io.StringIO()
        with redirect_stdout(output):
            MODULE.emit_web_result(result, True)
        self.assertEqual(json.loads(output.getvalue())["fullMarkdownPath"], "/tmp/private/page.md")

    def test_youtube_url_uses_transcript_fetcher_through_same_capability(self) -> None:
        transcript = {
            "content": "transcript",
            "path": "/tmp/private/transcript.md",
            "content_length": 10,
            "truncated": False,
            "video_id": "dQw4w9WgXcQ",
            "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "language": {"name": "English", "code": "en", "generated": False},
            "segment_count": 1,
        }
        with tempfile.TemporaryDirectory() as runtime:
            os.chmod(runtime, 0o700)
            with patch.dict(os.environ, {"XDG_RUNTIME_DIR": runtime}), patch(
                "buzzard_youtube_transcript.fetch_youtube_transcript",
                return_value=transcript,
            ) as mocked_fetch:
                result = MODULE.fetch(
                    {"url": "https://youtu.be/dQw4w9WgXcQ?si=tracking"}
                )
        self.assertEqual(result["kind"], "youtube_transcript")
        self.assertEqual(result["fullMarkdownPath"], transcript["path"])
        self.assertEqual(mocked_fetch.call_args.args[0], "https://youtu.be/dQw4w9WgXcQ?si=tracking")


if __name__ == "__main__":
    unittest.main()
