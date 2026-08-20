# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import hashlib
from pathlib import Path
import unittest


class UpstreamIntegrityTest(unittest.TestCase):
    @staticmethod
    def _paths() -> tuple[Path, Path]:
        repo = Path(__file__).resolve().parents[4]
        component = repo / "wildbuzzard" / "third_party" / "agpl" / "unsloth-quick-search"
        port = repo / "wildbuzzard" / "components" / "buzzard-quick-search"
        return component, port

    def test_pristine_subset_matches_manifest(self):
        component, _port = self._paths()
        for line in (component / "SOURCE-MANIFEST.sha256").read_text().splitlines():
            digest, relative = line.split("  ", 1)
            actual = hashlib.sha256((component / relative).read_bytes()).hexdigest()
            self.assertEqual(actual, digest, relative)

    def test_ported_runtime_is_exact_upstream_range_except_import_path(self):
        component, port = self._paths()
        upstream = (
            component / "upstream" / "studio" / "backend" / "core" / "inference" / "tools.py"
        ).read_text()
        upstream_range = upstream[
            upstream.index("_MAX_PAGE_CHARS =") : upstream.index(
                "\n\ndef _check_signal_escape_patterns"
            )
        ].rstrip()
        ported = (
            port / "src" / "buzzard_quick_search" / "_upstream" / "search_runtime.py"
        ).read_text()
        ported_range = ported[ported.index("_MAX_PAGE_CHARS =") :].rstrip().replace(
            "from ._rag.parsers import parse_pdf_bytes",
            "from ..rag.parsers import parse_pdf_bytes",
        )
        self.assertEqual(ported_range, upstream_range)

    def test_supporting_source_files_are_byte_identical(self):
        component, port = self._paths()
        pairs = {
            "studio/backend/core/inference/_html_to_md.py": "_upstream/_html_to_md.py",
            "studio/backend/core/inference/web_access_policy.py": "_upstream/web_access_policy.py",
            "studio/backend/core/rag/config.py": "_upstream/_rag/config.py",
            "studio/backend/core/rag/parsers.py": "_upstream/_rag/parsers.py",
        }
        for upstream_relative, port_relative in pairs.items():
            upstream = component / "upstream" / upstream_relative
            downstream = port / "src" / "buzzard_quick_search" / port_relative
            self.assertEqual(downstream.read_bytes(), upstream.read_bytes(), port_relative)


if __name__ == "__main__":
    unittest.main()
