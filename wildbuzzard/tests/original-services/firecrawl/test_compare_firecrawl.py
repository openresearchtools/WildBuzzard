# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import importlib.util
import pathlib
import unittest

MODULE_PATH = pathlib.Path(__file__).with_name("compare_firecrawl.py")
SPEC = importlib.util.spec_from_file_location("compare_firecrawl", MODULE_PATH)
assert SPEC and SPEC.loader
COMPARATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(COMPARATOR)


class FirecrawlComparatorTest(unittest.TestCase):
    def test_reference_pin_distinguishes_tag_object_and_commit(self) -> None:
        self.assertEqual(COMPARATOR.FIRECRAWL_TAG, "v2.11.193")
        self.assertEqual(
            COMPARATOR.FIRECRAWL_TAG_OBJECT,
            "f13353ea529b12b4f17aef76d1a01e6d90784850",
        )
        self.assertEqual(
            COMPARATOR.FIRECRAWL_COMMIT,
            "448ef4bf815d8df798d1a676f0303285e54cabdb",
        )
        self.assertNotEqual(
            COMPARATOR.FIRECRAWL_TAG_OBJECT, COMPARATOR.FIRECRAWL_COMMIT
        )

    def test_semantic_html_parser(self) -> None:
        result = COMPARATOR.parse_html(
            """
            <html data-fixture-final-url="http://fixture:8080/final">
              <head><title> Fixture title </title><style>hidden words</style></head>
              <body><h1>First <em>heading</em></h1><script>hidden code</script>
              <p>Visible text</p><a href="../target?q=1#part">Target</a></body>
            </html>
            """,
            "http://fixture:8080/path/page",
        )
        self.assertEqual(result["title"], "Fixture title")
        self.assertEqual(result["headings"], [{"level": 1, "text": "First heading"}])
        self.assertEqual(result["links"], ["http://fixture:8080/target?q=1#part"])
        self.assertEqual(result["visibleText"], "First heading Visible text Target")
        self.assertEqual(result["finalUrl"], "http://fixture:8080/final")

    def test_multiset_token_recall(self) -> None:
        self.assertEqual(
            COMPARATOR.token_recall("Alpha alpha beta", "alpha beta"), 2 / 3
        )
        self.assertEqual(COMPARATOR.token_recall("café 東京", "CAFÉ 東京"), 1.0)
        self.assertEqual(COMPARATOR.token_recall("", "anything"), 1.0)

    def test_timeout_argument_is_finite_and_bounded(self) -> None:
        self.assertEqual(COMPARATOR.bounded_timeout("30"), 30.0)
        for value in ["0", "nan", "inf", "3601"]:
            with self.assertRaises(COMPARATOR.argparse.ArgumentTypeError):
                COMPARATOR.bounded_timeout(value)

    def test_fixture_url_normalization_is_narrow(self) -> None:
        self.assertEqual(
            COMPARATOR.normalize_fixture_url("http://fixture:8080/a?q=1#f"),
            "http://fixture.test/a?q=1#f",
        )
        self.assertEqual(
            COMPARATOR.normalize_fixture_url("http://other-fixture:8080/a"),
            "http://other-fixture.test/a",
        )
        self.assertEqual(
            COMPARATOR.normalize_fixture_url("https://example.test/a"),
            "https://example.test/a",
        )

    def test_fixture_url_normalization_distinguishes_loopback_origins(self) -> None:
        original = COMPARATOR.FIXTURE_PORT_ALIASES.copy()
        try:
            COMPARATOR.FIXTURE_PORT_ALIASES.clear()
            COMPARATOR.FIXTURE_PORT_ALIASES.update({
                45001: "fixture.test",
                45002: "other-fixture.test",
            })
            self.assertEqual(
                COMPARATOR.normalize_fixture_url(
                    "http://127.0.0.1:45001/redirect/cross-origin?"
                    "target=http%3A%2F%2F127.0.0.1%3A45002%2Fheaders"
                ),
                "http://fixture.test/redirect/cross-origin?"
                "target=http%3A%2F%2Fother-fixture.test%2Fheaders",
            )
        finally:
            COMPARATOR.FIXTURE_PORT_ALIASES.clear()
            COMPARATOR.FIXTURE_PORT_ALIASES.update(original)

    def test_redaction_orders_values_and_covers_bearer_tokens(self) -> None:
        redactor = COMPARATOR.Redactor()
        redactor.add("http://127.0.0.1:12345", "http://fixture.test")
        redactor.add("secret-token", "<redacted-token>")
        value = redactor.text(
            "http://127.0.0.1:12345/a Authorization: Bearer secret-token secret-token"
        )
        self.assertEqual(
            value,
            "http://fixture.test/a Authorization: Bearer <redacted> <redacted-token>",
        )

    def test_reference_threshold_and_exact_fields(self) -> None:
        scenario = {
            "name": "example",
            "path": "/page",
            "status": 200,
            "contentType": "text/html; charset=utf-8",
            "title": "Title",
            "headings": [{"level": 1, "text": "Heading"}],
            "links": ["http://fixture.test/target"],
            "visible": "one two three four five six seven eight nine ten twenty",
        }
        semantics = {
            "status": 200,
            "contentType": "text/html; charset=utf-8",
            "finalUrl": "http://fixture.test/page",
            "title": "Title",
            "headings": [{"level": 1, "text": "Heading"}],
            "links": ["http://fixture.test/target"],
            "visibleText": "one two three four five six seven eight nine ten twenty",
        }
        passed, failures = COMPARATOR.evaluate_reference(scenario, semantics)
        self.assertTrue(passed)
        self.assertEqual(failures, [])
        semantics["contentType"] = "text/html"
        passed, failures = COMPARATOR.evaluate_reference(scenario, semantics)
        self.assertFalse(passed)
        self.assertTrue(any("contentType" in failure for failure in failures))

    def test_cross_origin_security_difference_is_explicit(self) -> None:
        scenario = next(
            case
            for case in COMPARATOR.scenario_definitions(False)
            if case["name"] == "cross-origin-header"
        )
        shared = {
            "status": 200,
            "contentType": "text/html; charset=utf-8",
            "finalUrl": "http://other-fixture.test/headers",
            "title": "Header Fixture",
            "headings": [{"level": 1, "text": "Header concordance"}],
            "links": [],
        }
        reference = {
            **shared,
            "visibleText": "Header concordance custom=fixture-value authorization=absent",
        }
        candidate = {
            **shared,
            "visibleText": "Header concordance custom=absent authorization=absent",
        }
        self.assertEqual(COMPARATOR.evaluate_reference(scenario, reference), (True, []))
        self.assertEqual(
            COMPARATOR.compare_gecko(scenario, reference, candidate), (True, [])
        )

    def test_gecko_stress_requires_a_bounded_failure(self) -> None:
        scenario = {"geckoError": ["response", "serialized output"]}
        self.assertEqual(
            COMPARATOR.evaluate_gecko_stress(
                scenario, {"pageError": "resource-limit: response too large"}
            ),
            (True, []),
        )
        passed, failures = COMPARATOR.evaluate_gecko_stress(
            scenario, {"pageError": None}
        )
        self.assertFalse(passed)
        self.assertEqual(len(failures), 1)

    def test_non_html_body_hash_is_exact(self) -> None:
        reference = {
            "status": 200,
            "contentType": "text/plain; charset=utf-8",
            "finalUrl": "http://fixture.test/plain",
            "bodySha256": COMPARATOR.sha256_bytes(b"expected"),
        }
        candidate = {**reference, "bodySha256": COMPARATOR.sha256_bytes(b"changed")}
        passed, failures = COMPARATOR.compare_gecko({}, reference, candidate)
        self.assertFalse(passed)
        self.assertEqual(failures, ["bodySha256 differs"])

    def test_release_corpus_contains_required_core_cases(self) -> None:
        names = {case["name"] for case in COMPARATOR.scenario_definitions(True)}
        self.assertTrue(
            {
                "static-html",
                "javascript-dom",
                "delayed-selector",
                "redirect-chain",
                "status-204",
                "status-404",
                "json",
                "plain-text",
                "latin1-html",
                "csp",
                "iframe",
                "same-origin-header",
                "cross-origin-header",
                "state-write",
                "state-read-clean",
                "oversized-body",
                "oversized-dom",
                "gzip-bomb",
                "timeout",
            }.issubset(names)
        )


if __name__ == "__main__":
    unittest.main()
