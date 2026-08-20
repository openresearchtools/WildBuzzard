# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import json
import os
from pathlib import Path
import stat
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from buzzard_quick_search._upstream import search_runtime
from buzzard_quick_search.service import PROVENANCE, quick_search, quick_search_output


FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "search-results.json").read_text(encoding = "utf-8")
)


class FakeDDGS:
    timeout = None
    query = None
    max_results = None

    def __init__(self, *, timeout):
        type(self).timeout = timeout

    def text(self, query, *, max_results):
        type(self).query = query
        type(self).max_results = max_results
        return FIXTURE["input"][:max_results]


class QuickSearchTest(unittest.TestCase):
    def test_formats_results_with_upstream_text_contract(self):
        with patch.dict(sys.modules, {"ddgs": SimpleNamespace(DDGS = FakeDDGS)}):
            output = quick_search("test query", timeout = 17)
        self.assertEqual(output, FIXTURE["expected"])
        self.assertEqual(FakeDDGS.timeout, 17)
        self.assertEqual(FakeDDGS.query, "test query")
        self.assertEqual(FakeDDGS.max_results, 5)

    def test_policy_overfetches_and_filters_before_formatting(self):
        class PolicyDDGS(FakeDDGS):
            def text(self, query, *, max_results):
                type(self).query = query
                type(self).max_results = max_results
                return [
                    {"title": "Blocked", "href": "https://example.org/no", "body": "No"},
                    {"title": "Allowed", "href": "https://example.com/yes", "body": "Yes"},
                ]

        with patch.dict(sys.modules, {"ddgs": SimpleNamespace(DDGS = PolicyDDGS)}):
            output = quick_search("q", allowed_domains = ["example.com"])
        self.assertEqual(PolicyDDGS.query, "q (site:example.com)")
        self.assertEqual(PolicyDDGS.max_results, 20)
        self.assertNotIn("example.org", output)
        self.assertIn("https://example.com/yes", output)

    def test_page_truncation_marker_matches_upstream(self):
        text = "x" * 16_001
        output = search_runtime._truncate_page_text(text, 16_000)
        self.assertEqual(output, "x" * 16_000 + "\n\n... (truncated, 16001 chars total)")

    def test_fetch_preserves_upstream_prefix_and_publishes_private_full_markdown(self):
        markdown = "# Useful title\n\n" + "x" * 16_001
        with tempfile.TemporaryDirectory() as runtime:
            os.chmod(runtime, 0o700)
            with patch.dict(os.environ, {"XDG_RUNTIME_DIR": runtime}), patch(
                "buzzard_quick_search.service._fetch_complete_page_text",
                return_value = markdown,
            ):
                output = quick_search_output(url = "https://example.com/page")
            path = Path(output.full_markdown_path)
            self.assertEqual(path.read_text(encoding = "utf-8"), markdown)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700)
            expected_inline = search_runtime._truncate_page_text(markdown, 16_000)
            self.assertTrue(output.as_text().startswith(expected_inline))
            self.assertIn(f"BUZZARD_FULL_MARKDOWN_PATH={path}", output.as_text())
            self.assertEqual(output.as_dict()["fullMarkdownPath"], str(path))
            self.assertTrue(output.as_dict()["truncated"])

    def test_query_output_remains_exactly_upstream_text(self):
        with patch.dict(sys.modules, {"ddgs": SimpleNamespace(DDGS = FakeDDGS)}):
            output = quick_search_output("test query", timeout = 17)
        self.assertEqual(output.as_text(), FIXTURE["expected"])
        self.assertNotIn("fullMarkdownPath", output.as_dict())

    def test_relative_runtime_directory_is_rejected(self):
        from buzzard_quick_search.artifacts import document_directory

        with patch.dict(os.environ, {"XDG_RUNTIME_DIR": "relative-runtime"}):
            with self.assertRaisesRegex(RuntimeError, "XDG_RUNTIME_DIR is unsafe"):
                document_directory()

    def test_github_repository_inspection_uses_the_shared_artifact_contract(self):
        document = SimpleNamespace(
            title = "owner/repository",
            markdown = "# Repository inspection\n\ncomplete tree and selected files",
        )
        with tempfile.TemporaryDirectory() as runtime:
            os.chmod(runtime, 0o700)
            with patch.dict(os.environ, {"XDG_RUNTIME_DIR": runtime}), patch(
                "buzzard_quick_search.service.fetch_github_repository",
                return_value = document,
            ) as github_fetch, patch(
                "buzzard_quick_search.service._fetch_complete_page_text"
            ) as generic_fetch:
                output = quick_search_output(url = "https://github.com/owner/repository")
            path = Path(output.full_markdown_path)
            self.assertEqual(path.read_text(encoding = "utf-8"), document.markdown)
        github_fetch.assert_called_once()
        generic_fetch.assert_not_called()
        self.assertIn("Repository inspection", output.content)

    def test_empty_query_and_empty_results_match_upstream(self):
        self.assertEqual(quick_search(""), "No query provided.")

        class EmptyDDGS(FakeDDGS):
            def text(self, query, *, max_results):
                return []

        with patch.dict(sys.modules, {"ddgs": SimpleNamespace(DDGS = EmptyDDGS)}):
            self.assertEqual(quick_search("nothing"), "No results found.")

    def test_provenance_is_exact_and_machine_readable(self):
        self.assertEqual(
            PROVENANCE["upstream"]["commit"],
            "bfcaea46574d63ec470ce9c7d7221471a38ea7e4",
        )
        self.assertEqual(PROVENANCE["searchProvider"]["version"], "9.14.4")


if __name__ == "__main__":
    unittest.main()
