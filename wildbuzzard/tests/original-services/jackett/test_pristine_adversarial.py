# SPDX-License-Identifier: AGPL-3.0-or-later

import importlib.util
import json
import os
import pathlib
import sys
import tempfile
import time
import unittest

from canonicalize import MAX_XML_BYTES, TorznabError, parse_torznab, parse_xml


SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    "pristine_adversarial",
    SCRIPT_DIR / "run-pristine-adversarial.py",
)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class PristineAdversarialTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.expected = json.loads(
            (SCRIPT_DIR / "fixtures/pristine-adversarial-expected.json").read_text(encoding="utf-8")
        )

    def test_snapshot_covers_error_and_transport_shapes(self):
        codes = {
            value.get("errorCode")
            for value in self.expected.values()
            if isinstance(value, dict)
        }
        statuses = {
            value.get("status")
            for value in self.expected.values()
            if isinstance(value, dict)
        }
        self.assertTrue({100, 201, 203, 900}.issubset(codes))
        self.assertTrue({200, 400, 429, 500}.issubset(statuses))
        self.assertEqual(
            self.expected["error-code-200-source-contract"]["unreachableFilterBranch"]["torznabCode"],
            200,
        )
        self.assertEqual(self.expected["hanging-provider-timeout"], {"outcome": "timeout"})
        self.assertEqual(self.expected["http-429-retry-after"]["retryAfter"], "7")

    def test_snapshot_covers_every_adult_category(self):
        categories = {
            category
            for item in self.expected["adult-category-matrix"]["items"]
            for category in item["categoryIds"]
            if category < 100000
        }
        self.assertEqual(categories, set(MODULE.ADULT_CATEGORIES))
        mixed = self.expected["mixed-safe-adult-category"]["items"][0]["categoryIds"]
        self.assertIn(2000, mixed)
        self.assertIn(6010, mixed)
        self.assertEqual(self.expected["adult-provider-generic-8000"]["items"][0]["categoryIds"][0], 8000)

    def test_xml_guards_reject_each_adversarial_shape(self):
        origin = "http://127.0.0.1:1"
        for scenario in ("malformed", "deep", "entity", "oversized"):
            with self.subTest(scenario=scenario):
                payload = MODULE.fixture_xml(origin, "main", scenario)
                with self.assertRaises(TorznabError):
                    parse_xml(payload)
        self.assertGreater(len(MODULE.fixture_xml(origin, "main", "oversized")), MAX_XML_BYTES)

    def test_absent_and_contradictory_peers_normalize_safely(self):
        absent = next(
            item
            for item in self.expected["peer-counts"]["items"]
            if item["title"] == "Peers absent"
        )
        self.assertIsNone(absent["seeders"])
        self.assertIsNone(absent["peers"])
        self.assertEqual(self.expected["contradictory-peer-client-guard"]["normalizedLeechers"], 0)

        payload = b'''<rss xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><item><title>x</title><guid>x</guid><torznab:attr name="category" value="2000"/><torznab:attr name="seeders" value="10"/><torznab:attr name="peers" value="3"/><torznab:attr name="infohash" value="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"/></item></channel></rss>'''
        result = parse_torznab(payload, "fixture", "Fixture")["results"][0]
        self.assertEqual(result["leechers"], 0)

    def test_transcript_redaction_removes_all_wire_secrets(self):
        redactions = [
            ("api-secret", "<api>"),
            ("pass-secret", "<pass>"),
            ("raw-secret", "<raw>"),
        ]
        payload = b"?apikey=api-secret&passkey=pass-secret&path=raw-secret&capability=api-secret"
        redacted = MODULE.redact_bytes(payload, redactions)
        for secret, _replacement in redactions:
            self.assertNotIn(secret.encode(), redacted)
        headers = MODULE.redacted_headers(
            {"Authorization": "Bearer api-secret", "Cookie": "pass-secret", "X-Test": "raw-secret"},
            redactions,
        )
        self.assertNotIn("api-secret", repr(headers))
        self.assertNotIn("pass-secret", repr(headers))
        self.assertNotIn("raw-secret", repr(headers))

    def test_process_group_cleanup_stops_children(self):
        with tempfile.TemporaryDirectory() as directory:
            child_path = pathlib.Path(directory) / "child.pid"
            parent, log = MODULE.start_process(
                [
                    sys.executable,
                    "-c",
                    (
                        "import pathlib, subprocess, sys, time; "
                        "child=subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)']); "
                        f"pathlib.Path({str(child_path)!r}).write_text(str(child.pid)); "
                        "time.sleep(60)"
                    ),
                ],
                pathlib.Path(directory),
                dict(os.environ),
                pathlib.Path(directory) / "process.log",
            )
            try:
                deadline = time.monotonic() + 5
                while not child_path.exists() and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertTrue(child_path.exists())
                child = int(child_path.read_text())
                MODULE.stop_process(parent)
                deadline = time.monotonic() + 5
                while pathlib.Path(f"/proc/{child}").exists() and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertFalse(pathlib.Path(f"/proc/{child}").exists())
            finally:
                MODULE.stop_process(parent)
                log.close()

    def test_rootless_wrapper_audits_kernel_key_quota(self):
        wrapper = (SCRIPT_DIR / "run-pristine-adversarial-rootless.sh").read_text(
            encoding="utf-8"
        )
        self.assertGreaterEqual(wrapper.count("/proc/key-users"), 2)
        self.assertIn('cmp -s -- "$oracle_key_check/before"', wrapper)


if __name__ == "__main__":
    unittest.main()
