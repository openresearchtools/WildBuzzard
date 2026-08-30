#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later

import importlib.util
import pathlib
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    "verify_browser_legal_payload",
    HERE.parents[1] / "scripts" / "verify_browser_legal_payload.py",
)
LEGAL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LEGAL)


class LegalPayloadTests(unittest.TestCase):
    def make_payload(self, root):
        source = root / "source"
        browser = root / "browser"
        documentation = root / "documentation"
        (source / "wildbuzzard/components/wildbuzzard-cli").mkdir(parents=True)
        (source / "wildbuzzard").mkdir(exist_ok=True)
        (browser / "notices").mkdir(parents=True)
        documentation.mkdir()
        values = {
            "COPYING": b"agpl\n",
            "LICENSE": b"combined license\n",
            "MOZILLA-MCP-LICENSE": b"mit\n",
            "NOTICE": b"upstream notice\n",
            "SOURCE-NOTICE": b"source\n",
        }
        sources = LEGAL.expected_payloads(source)
        for name, value in values.items():
            sources[name].write_bytes(value)
            (browser / "notices" / name).write_bytes(value)
        documentation_names = {
            "COPYING": "COPYING",
            "LICENSE": "LICENSE",
            "MOZILLA-MCP-LICENSE": "MOZILLA-MCP-LICENSE",
            "cli-NOTICE": "NOTICE",
            "SOURCE-NOTICE": "SOURCE-NOTICE",
        }
        for destination, source_name in documentation_names.items():
            (documentation / destination).write_bytes(values[source_name])
        return source, browser, documentation

    def test_accepts_exact_archive_and_documentation_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            roots = self.make_payload(pathlib.Path(directory))
            LEGAL.verify_payload(*roots)

    def test_rejects_tampering_and_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            source, browser, documentation = self.make_payload(pathlib.Path(directory))
            (documentation / "COPYING").write_text("wrong", encoding="utf-8")
            with self.assertRaises(LEGAL.ValidationError):
                LEGAL.verify_payload(source, browser, documentation)
            (documentation / "COPYING").unlink()
            (documentation / "COPYING").symlink_to(source / "COPYING")
            with self.assertRaises(LEGAL.ValidationError):
                LEGAL.verify_payload(source, browser, documentation)


if __name__ == "__main__":
    unittest.main()
