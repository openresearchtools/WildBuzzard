# SPDX-License-Identifier: AGPL-3.0-or-later

import importlib.util
import pathlib
import unittest
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    "live_all_source_comparison", HERE / "run-live-all-source-comparison.py"
)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class LiveAllSourceComparisonTest(unittest.TestCase):
    def test_redaction_preserves_structure_with_json_metacharacters(self):
        secret = 'cookie="quoted"\\path'
        value = {
            "headers": [("Cookie", f"Jackett={secret}")],
            "nested": [secret, 7, None],
        }
        redacted = MODULE.redact(value, [(secret, "<redacted>")])
        self.assertEqual(
            redacted,
            {
                "headers": [["Cookie", "Jackett=<redacted>"]],
                "nested": ["<redacted>", 7, None],
            },
        )

    def test_redaction_handles_encoded_values_without_touching_low_entropy_text(self):
        secret = "long/secret+value?token=123456789"
        value = {
            "path": "/request?value=" + MODULE.urllib.parse.quote(secret, safe=""),
            "ordinary": "HTTP/1.1 and 2015 are evidence",
        }
        self.assertEqual(
            MODULE.redact(value, [(secret, "<redacted>")]),
            {
                "path": "/request?value=<redacted>",
                "ordinary": "HTTP/1.1 and 2015 are evidence",
            },
        )
        with self.assertRaisesRegex(ValueError, "low-entropy"):
            MODULE.redact(value, [("1", "<redacted>")])

    def test_redacted_torznab_body_remains_structurally_parseable(self):
        secret = "0123456789abcdef0123456789abcdef"
        body = (
            '<rss><channel><item><title>fixture</title><guid>one</guid>'
            f'<link>https://example.invalid/?apikey={secret}</link>'
            '<torznab:attr xmlns:torznab="http://torznab.com/schemas/2015/feed" '
            'name="category" value="6010"/></item></channel></rss>'
        )
        redacted = MODULE.redact(
            {"response": {"body": body}},
            [(secret, "REDACTED_API_KEY")],
        )
        parsed = MODULE.CANONICAL.parse_torznab(
            redacted["response"]["body"].encode(), "fixture", "Fixture"
        )
        self.assertEqual(parsed["results"][0]["categoryIds"], [6010])

    def test_transport_and_site_failures_are_comparable_but_diagnostic(self):
        configuration = (
            {"response": {"status": 200}},
            {"response": {"status": 204}},
        )
        pristine = {
            "response": {
                "status": 400,
                "body": '<error code="900" description="DNS failed"/>',
            }
        }
        mini = {
            "response": {
                "status": 200,
                "body": '{"partial":true,"providers":[{"id":"fixture","state":"timeout"}],"results":[]}',
            }
        }
        pristine_normalized, pristine_signal = MODULE.normalize_pristine(
            pristine, "fixture", "Fixture", configuration
        )
        mini_normalized, mini_signal = MODULE.normalize_mini(mini, "fixture")
        self.assertEqual(pristine_normalized, mini_normalized)
        self.assertEqual(pristine_signal["torznabCode"], 900)
        self.assertEqual(mini_signal["providerState"], "timeout")
        self.assertEqual(
            MODULE.compare_outcome(
                pristine_normalized,
                mini_normalized,
                pristine_signal,
                mini_signal,
            ),
            "equivalent-environmental-failure",
        )

    def test_result_and_volatile_field_mismatches_are_exposed(self):
        base = {
            "partial": False,
            "providers": [{"id": "fixture", "state": "ok"}],
            "results": [
                {
                    "providerId": "fixture",
                    "name": "result",
                    "publishedAt": "2026-08-12T12:00:00Z",
                    "categoryIds": [6010],
                }
            ],
        }
        signal = {"class": "success"}
        volatile = MODULE.json.loads(MODULE.json.dumps(base))
        volatile["results"][0]["publishedAt"] = "2026-08-12T12:00:01Z"
        changed = MODULE.json.loads(MODULE.json.dumps(base))
        changed["results"][0]["categoryIds"] = [2000]
        self.assertEqual(
            MODULE.compare_outcome(base, volatile, signal, signal),
            "volatile-published-at-mismatch",
        )
        self.assertEqual(
            MODULE.compare_outcome(base, changed, signal, signal),
            "result-mismatch",
        )

    def test_equal_contract_failures_are_not_environmental_failures(self):
        failure = MODULE.contract_failure("fixture")
        signal = {"class": "contract"}
        self.assertEqual(
            MODULE.compare_outcome(failure, failure, signal, signal),
            "equivalent-contract-failure",
        )

    def test_mini_results_use_the_canonical_semantic_order(self):
        exchange = {
            "response": {
                "status": 200,
                "body": MODULE.json.dumps(
                    {
                        "partial": False,
                        "providers": [{"id": "fixture", "state": "ok"}],
                        "results": [
                            {
                                "providerId": "fixture",
                                "providerName": "Fixture",
                                "name": "Zulu",
                                "seeders": 1,
                                "leechers": 0,
                                "sizeBytes": 1,
                                "publishedAt": None,
                                "categoryIds": [6010],
                                "access": "public",
                                "acquisition": "magnet",
                            },
                            {
                                "providerId": "fixture",
                                "providerName": "Fixture",
                                "name": "Alpha",
                                "seeders": 3,
                                "leechers": 0,
                                "sizeBytes": 2,
                                "publishedAt": None,
                                "categoryIds": [2000],
                                "access": "public",
                                "acquisition": "magnet",
                            },
                        ],
                    }
                ),
            }
        }
        normalized, signal = MODULE.normalize_mini(exchange, "fixture")
        self.assertEqual(signal["class"], "success")
        self.assertEqual(
            [result["name"] for result in normalized["results"]],
            ["Alpha", "Zulu"],
        )
        self.assertEqual(normalized["results"][1]["categoryIds"], [6010])

    def test_configuration_allows_the_official_indexer_workflow_to_finish(self):
        fetched = {"response": {"status": 200, "body": "[]"}}
        configured = {"response": {"status": 204, "body": ""}}
        with mock.patch.object(MODULE, "request", side_effect=[fetched, configured]) as request:
            self.assertEqual(
                MODULE.configure_source(1234, "fixture", {"Cookie": "dashboard"}),
                (fetched, configured),
            )
        self.assertEqual(
            request.call_args_list[1].kwargs["timeout"],
            MODULE.CONFIGURATION_TIMEOUT_SECONDS,
        )


if __name__ == "__main__":
    unittest.main()
