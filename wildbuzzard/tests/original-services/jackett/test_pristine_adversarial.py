# SPDX-License-Identifier: AGPL-3.0-or-later

import copy
import hashlib
import importlib.util
import json
import os
import pathlib
import sys
import tempfile
import time
import unittest
from unittest import mock

from canonicalize import MAX_XML_BYTES, TorznabError, parse_torznab, parse_xml
from expected_mini import (
    SCENARIOS,
    TRANSPORT_SCENARIOS,
    XML_LIMIT_SCENARIOS,
    expected_for,
    expected_transport_result,
    provider_error,
    validate_all,
    validate_transport_results,
    validate_xml_limit_results,
)

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
            (SCRIPT_DIR / "fixtures/pristine-adversarial-expected.json").read_text(
                encoding="utf-8"
            )
        )

    def write_source_manifest(self, directory, entries):
        manifest = pathlib.Path(directory) / "SOURCE-MANIFEST.sha256"
        manifest.write_text(
            "".join(f"{digest}  {path}\n" for path, digest in entries),
            encoding="utf-8",
        )
        return manifest, MODULE.sha256_file(manifest)

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
            self.expected["error-code-200-source-contract"]["unreachableFilterBranch"][
                "torznabCode"
            ],
            200,
        )
        self.assertEqual(
            self.expected["hanging-provider-timeout"], {"outcome": "timeout"}
        )
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
        self.assertEqual(
            self.expected["adult-provider-generic-8000"]["items"][0]["categoryIds"][0],
            8000,
        )

    def test_xml_guards_reject_each_adversarial_shape(self):
        origin = "http://127.0.0.1:1"
        for scenario in ("malformed", "deep", "entity", "oversized"):
            with self.subTest(scenario=scenario):
                payload = MODULE.fixture_xml(origin, "main", scenario)
                with self.assertRaises(TorznabError):
                    parse_xml(payload)
        self.assertGreater(
            len(MODULE.fixture_xml(origin, "main", "oversized")), MAX_XML_BYTES
        )

    def test_mislabeled_xml_fixtures_cross_each_mini_limit(self):
        origin = "http://127.0.0.1:1"
        fixtures = {
            "mislabeled-attribute-xml": MODULE.fixture_xml(
                origin, "main", "limit-attribute"
            ),
            "mislabeled-deep-xml": MODULE.fixture_xml(origin, "main", "limit-deep"),
            "mislabeled-entity-xml": MODULE.fixture_xml(origin, "main", "limit-entity"),
            "mislabeled-node-xml": MODULE.fixture_xml(origin, "main", "limit-node"),
            "mislabeled-result-xml": MODULE.fixture_xml(origin, "main", "limit-result"),
            "mislabeled-text-xml": MODULE.fixture_xml(origin, "main", "limit-text"),
            "mislabeled-declared-latin1-node-xml": MODULE.fixture_xml(
                origin, "main", "limit-declared-latin1-node"
            ),
            "mislabeled-utf16be-node-xml": MODULE.fixture_xml(
                origin, "main", "limit-utf16be-node"
            ),
            "mislabeled-utf16le-node-xml": MODULE.fixture_xml(
                origin, "main", "limit-utf16le-node"
            ),
            "mislabeled-utf16be-signature-node-xml": MODULE.fixture_xml(
                origin, "main", "limit-utf16be-signature-node"
            ),
            "mislabeled-utf16le-signature-node-xml": MODULE.fixture_xml(
                origin, "main", "limit-utf16le-signature-node"
            ),
            "mislabeled-utf32be-node-xml": MODULE.fixture_xml(
                origin, "main", "limit-utf32be-node"
            ),
            "mislabeled-utf32le-node-xml": MODULE.fixture_xml(
                origin, "main", "limit-utf32le-node"
            ),
            "mislabeled-utf32be-signature-node-xml": MODULE.fixture_xml(
                origin, "main", "limit-utf32be-signature-node"
            ),
            "mislabeled-utf32le-signature-node-xml": MODULE.fixture_xml(
                origin, "main", "limit-utf32le-signature-node"
            ),
        }
        self.assertEqual(set(fixtures), XML_LIMIT_SCENARIOS)
        self.assertGreater(
            fixtures["mislabeled-attribute-xml"].count(b'value="x"'),
            MODULE.MINI_MAX_XML_ATTRIBUTES,
        )
        self.assertGreater(
            fixtures["mislabeled-deep-xml"].count(b"<node>"),
            MODULE.MINI_MAX_XML_DEPTH,
        )
        self.assertIn(b"<!ENTITY", fixtures["mislabeled-entity-xml"])
        self.assertGreater(
            fixtures["mislabeled-node-xml"].count(b"<node/>"),
            MODULE.MINI_MAX_XML_NODES,
        )
        self.assertGreater(
            fixtures["mislabeled-result-xml"].count(b"<item/>"),
            MODULE.MINI_MAX_XML_RESULTS,
        )
        self.assertGreater(
            fixtures["mislabeled-text-xml"].count(b"X"),
            MODULE.MINI_MAX_XML_TEXT_CHARACTERS,
        )
        latin1 = fixtures["mislabeled-declared-latin1-node-xml"].decode("iso-8859-1")
        self.assertIn('encoding="ISO-8859-1"', latin1)
        self.assertGreater(latin1.count("<node/>"), MODULE.MINI_MAX_XML_NODES)
        unicode_fixtures = {
            "mislabeled-utf16be-node-xml": (b"\xfe\xff", "utf-16be"),
            "mislabeled-utf16le-node-xml": (b"\xff\xfe", "utf-16le"),
            "mislabeled-utf32be-node-xml": (b"\x00\x00\xfe\xff", "utf-32be"),
            "mislabeled-utf32le-node-xml": (b"\xff\xfe\x00\x00", "utf-32le"),
        }
        for name, (preamble, codec) in unicode_fixtures.items():
            with self.subTest(name=name):
                self.assertTrue(fixtures[name].startswith(preamble))
                document = fixtures[name][len(preamble) :].decode(codec)
                self.assertGreater(document.count("<node/>"), MODULE.MINI_MAX_XML_NODES)
        signature_fixtures = {
            "mislabeled-utf16be-signature-node-xml": "utf-16be",
            "mislabeled-utf16le-signature-node-xml": "utf-16le",
            "mislabeled-utf32be-signature-node-xml": "utf-32be",
            "mislabeled-utf32le-signature-node-xml": "utf-32le",
        }
        for name, codec in signature_fixtures.items():
            with self.subTest(name=name):
                document = fixtures[name].decode(codec)
                self.assertTrue(document.startswith("<?xml"))
                self.assertGreater(document.count("<node/>"), MODULE.MINI_MAX_XML_NODES)
        self.assertTrue(
            all(len(payload) < MAX_XML_BYTES for payload in fixtures.values())
        )

    def test_mislabeled_xml_has_exact_reviewed_mini_semantics(self):
        observed = {name: provider_error() for name in XML_LIMIT_SCENARIOS}
        validate_xml_limit_results(observed)
        changed = copy.deepcopy(observed)
        changed["mislabeled-result-xml"]["items"] = [{"title": "escaped"}]
        with self.assertRaisesRegex(AssertionError, "XML-limit semantics"):
            validate_xml_limit_results(changed)

    def test_shipping_transport_bounds_mislabeled_xml(self):
        patch = (
            SCRIPT_DIR.parent.parent.parent
            / "third_party/gpl2/jackett/patches/0001-add-jackett-mini-read-only-service.patch"
        ).read_text(encoding="utf-8")
        required = (
            "AutomaticDecompression = DecompressionMethods.None",
            'ReadBoundedAsync(input, "compressed"',
            'ReadBoundedAsync(decoded, "decompressed"',
            "DtdProcessing = DtdProcessing.Prohibit",
            "MaxCharactersFromEntities = 0",
            "MaximumNodes = 50_000",
            "MaximumDepth = 64",
            "MaximumAttributes = 32_768",
            "MaximumAttributeCharacters = 1024 * 1024",
            "MaximumTextCharacters = 1024 * 1024",
            "MaximumNodeCharacters = 64 * 1024",
            "MaximumResults = 2_000",
            'mediaType?.Contains("html"',
            'mediaType?.Contains("json"',
            "return declaration || name.Length > 0",
            "AssertActionThrows<XmlException>",
            '"deflate" => new ZLibStream',
            "DecodeForXmlSniff",
            "new UTF32Encoding(bigEndian: true",
            "new UnicodeEncoding(bigEndian: false",
            "unsupported EBCDIC encoding",
            'AssertCodec("br"',
            'AssertCodec("deflate"',
            'AssertCodec("gzip"',
            "BoundedXmlValidator.Validate(bytes)",
            "BoundedXmlValidator.Validate(response.ContentBytes)",
        )
        for token in required:
            with self.subTest(token=token):
                self.assertIn(token, patch)

    def test_each_xml_limit_scenario_maps_to_the_expected_fixture_query(self):
        expected = {
            "mislabeled-attribute-xml": "limit-attribute",
            "mislabeled-deep-xml": "limit-deep",
            "mislabeled-entity-xml": "limit-entity",
            "mislabeled-node-xml": "limit-node",
            "mislabeled-result-xml": "limit-result",
            "mislabeled-text-xml": "limit-text",
            "mislabeled-declared-latin1-node-xml": "limit-declared-latin1-node",
            "mislabeled-utf16be-node-xml": "limit-utf16be-node",
            "mislabeled-utf16le-node-xml": "limit-utf16le-node",
            "mislabeled-utf16be-signature-node-xml": "limit-utf16be-signature-node",
            "mislabeled-utf16le-signature-node-xml": "limit-utf16le-signature-node",
            "mislabeled-utf32be-node-xml": "limit-utf32be-node",
            "mislabeled-utf32le-node-xml": "limit-utf32le-node",
            "mislabeled-utf32be-signature-node-xml": "limit-utf32be-signature-node",
            "mislabeled-utf32le-signature-node-xml": "limit-utf32le-signature-node",
        }
        for name, query in expected.items():
            with self.subTest(name=name):
                _method, _path, body, _headers, _timeout = MODULE.mini_case(
                    name, "A" * 43
                )
                self.assertEqual(json.loads(body)["query"], query)
                self.assertEqual(
                    MODULE.fixture_content_type(query),
                    "text/plain; charset=utf-8",
                )

    def test_compressed_transport_fixtures_cover_codecs_and_both_byte_limits(self):
        origin = "http://127.0.0.1:1"
        fixtures = {}
        for name, query in MODULE.TRANSPORT_QUERIES.items():
            payload = MODULE.fixture_xml(origin, "main", query)
            wire, headers = MODULE.fixture_transport_response(query, payload)
            fixtures[name] = (payload, wire, headers)
            self.assertEqual(headers["Content-Type"], "text/plain; charset=utf-8")
        self.assertEqual(set(fixtures), TRANSPORT_SCENARIOS)
        gzip_payload, gzip_wire, gzip_headers = fixtures["transport-valid-gzip"]
        self.assertEqual(gzip_headers["Content-Encoding"], "gzip")
        self.assertEqual(MODULE.gzip.decompress(gzip_wire), gzip_payload)
        deflate_payload, deflate_wire, deflate_headers = fixtures[
            "transport-valid-deflate"
        ]
        self.assertEqual(deflate_headers["Content-Encoding"], "deflate")
        self.assertEqual(MODULE.zlib.decompress(deflate_wire), deflate_payload)
        self.assertTrue(deflate_wire.startswith(b"\x78"))
        brotli_payload, brotli_wire, brotli_headers = fixtures["transport-valid-br"]
        self.assertEqual(brotli_headers["Content-Encoding"], "br")
        self.assertEqual(brotli_payload, MODULE.BROTLI_XML)
        self.assertEqual(
            hashlib.sha256(brotli_wire).hexdigest(),
            "afb5b892f099f71567a0ebf4216de984199198e5e6851d0db813042555ee8d43",
        )
        self.assertEqual(
            fixtures["transport-layered-encoding"][2]["Content-Encoding"],
            "gzip, br",
        )
        self.assertIn(
            MODULE.RAW_URL_SECRET.encode(),
            fixtures["transport-malformed-gzip"][1],
        )
        self.assertGreater(
            len(fixtures["transport-compressed-overflow"][1]), MAX_XML_BYTES
        )
        bomb_payload, bomb_wire, bomb_headers = fixtures[
            "transport-decompressed-overflow"
        ]
        self.assertEqual(bomb_headers["Content-Encoding"], "gzip")
        self.assertLess(len(bomb_wire), 16 * 1024)
        self.assertGreater(len(MODULE.gzip.decompress(bomb_wire)), MAX_XML_BYTES)
        self.assertEqual(MODULE.gzip.decompress(bomb_wire), bomb_payload)
        self.assertIn(MODULE.RAW_URL_SECRET.encode(), bomb_payload)

    def test_compressed_transport_has_exact_reviewed_mini_semantics(self):
        observed = {
            name: expected_transport_result(name) for name in TRANSPORT_SCENARIOS
        }
        validate_transport_results(observed)
        failures = TRANSPORT_SCENARIOS - {
            "transport-valid-br",
            "transport-valid-deflate",
            "transport-valid-gzip",
        }
        for name in failures:
            self.assertEqual(observed[name]["items"], [])
        changed = copy.deepcopy(observed)
        changed["transport-malformed-gzip"]["items"] = [{"raw": "leaked"}]
        with self.assertRaisesRegex(AssertionError, "compressed-transport semantics"):
            validate_transport_results(changed)

    def test_absent_and_contradictory_peers_normalize_safely(self):
        absent = next(
            item
            for item in self.expected["peer-counts"]["items"]
            if item["title"] == "Peers absent"
        )
        self.assertIsNone(absent["seeders"])
        self.assertIsNone(absent["peers"])
        self.assertEqual(
            self.expected["contradictory-peer-client-guard"]["normalizedLeechers"], 0
        )

        payload = b"""<rss xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><item><title>x</title><guid>x</guid><torznab:attr name="category" value="2000"/><torznab:attr name="seeders" value="10"/><torznab:attr name="peers" value="3"/><torznab:attr name="infohash" value="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"/></item></channel></rss>"""
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
            {
                "Authorization": "Bearer api-secret",
                "Cookie": "pass-secret",
                "X-Test": "raw-secret",
            },
            redactions,
        )
        self.assertNotIn("api-secret", repr(headers))
        self.assertNotIn("pass-secret", repr(headers))
        self.assertNotIn("raw-secret", repr(headers))

    def test_every_pristine_scenario_has_an_executable_mini_mapping(self):
        ordinary = set(self.expected) - MODULE.SPECIAL_MINI_SCENARIOS
        self.assertTrue(ordinary)
        for scenario in sorted(ordinary):
            with self.subTest(scenario=scenario):
                method, path, body, headers, timeout = MODULE.mini_case(
                    scenario, "A" * 43
                )
                self.assertIn(method, {"GET", "POST"})
                self.assertTrue(path.startswith("/v1/"))
                self.assertGreater(timeout, 0)
                if body is not None:
                    json.loads(body)
                    self.assertEqual(headers["Content-Type"], "application/json")

    def test_every_scenario_has_an_exact_reviewed_mini_transform(self):
        self.assertEqual(set(self.expected), SCENARIOS)
        mini = {
            name: expected_for(name, value, self.expected)
            for name, value in self.expected.items()
        }
        validate_all(self.expected, mini)
        changed = copy.deepcopy(mini)
        changed["redirect-once"]["items"][0]["title"] = "unreviewed"
        with self.assertRaisesRegex(AssertionError, "unexplained Mini"):
            validate_all(self.expected, changed)

    def test_mini_runtime_validation_covers_the_complete_inventory(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = pathlib.Path(directory) / "runtime"
            runtime.mkdir()
            executable = runtime / "jackett-mini"
            catalog = runtime / "catalog.json"
            executable.write_bytes(b"pinned-mini")
            executable.chmod(0o755)
            catalog.write_bytes(b"{}\n")
            entry = {
                "path": "jackett-mini",
                "sha256": MODULE.sha256_file(executable),
                "size": executable.stat().st_size,
                "executable": True,
            }
            catalog_entry = {
                "path": "catalog.json",
                "sha256": MODULE.sha256_file(catalog),
                "size": catalog.stat().st_size,
                "executable": False,
            }
            files = [catalog_entry, entry]
            manifest = {
                "component": "jackett-mini",
                "protocolVersion": 1,
                "upstreamVersion": "v0.24.2360",
                "upstreamCommit": MODULE.COMMIT,
                "sourceSha256": MODULE.SOURCE_SHA256,
                "platform": "linux",
                "architecture": "x86_64",
                "libc": "glibc",
                "testFixture": False,
                "enabledProviderCount": 60,
                "catalogFileSha256": catalog_entry["sha256"],
                "providerPolicySha256": "b" * 64,
                "runtimeSha256": hashlib.sha256(
                    json.dumps(files, sort_keys=True, separators=(",", ":")).encode()
                ).hexdigest(),
                "files": files,
            }
            manifest_path = runtime / "jackett-mini-runtime.json"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            MODULE.validate_mini_runtime(runtime, manifest_path)
            (runtime / "unmanifested").write_bytes(b"unexpected")
            with self.assertRaisesRegex(RuntimeError, "unmanifested"):
                MODULE.validate_mini_runtime(runtime, manifest_path)

    def test_fixture_runtime_must_bind_the_production_inventory(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = pathlib.Path(directory)
            executable = runtime / "jackett-mini"
            catalog = runtime / "catalog.json"
            executable.write_bytes(b"fixture-mini")
            executable.chmod(0o755)
            catalog.write_bytes(b"{}\n")
            files = [
                {
                    "path": "catalog.json",
                    "sha256": MODULE.sha256_file(catalog),
                    "size": catalog.stat().st_size,
                    "executable": False,
                },
                {
                    "path": "jackett-mini",
                    "sha256": MODULE.sha256_file(executable),
                    "size": executable.stat().st_size,
                    "executable": True,
                },
            ]
            production_digest = "a" * 64
            manifest = {
                "component": "jackett-mini",
                "protocolVersion": 1,
                "upstreamVersion": "v0.24.2360",
                "upstreamCommit": MODULE.COMMIT,
                "sourceSha256": MODULE.SOURCE_SHA256,
                "platform": "linux",
                "architecture": "x86_64",
                "libc": "glibc",
                "testFixture": True,
                "enabledProviderCount": 2,
                "catalogFileSha256": files[0]["sha256"],
                "providerPolicySha256": "b" * 64,
                "productionRuntimeSha256": production_digest,
                "runtimeSha256": hashlib.sha256(
                    json.dumps(files, sort_keys=True, separators=(",", ":")).encode()
                ).hexdigest(),
                "files": files,
            }
            manifest_path = runtime / "jackett-mini-runtime.json"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            MODULE.validate_mini_runtime(
                runtime,
                manifest_path,
                test_fixture=True,
                production_runtime_sha256=production_digest,
            )
            with self.assertRaisesRegex(RuntimeError, "fixture"):
                MODULE.validate_mini_runtime(
                    runtime,
                    manifest_path,
                    test_fixture=True,
                    production_runtime_sha256="b" * 64,
                )

    def test_pristine_source_manifest_validates_listed_files_and_allows_outputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory) / "source"
            nested = root / "nested"
            nested.mkdir(parents=True)
            first = root / "first.txt"
            second = nested / "second.txt"
            first.write_bytes(b"first")
            second.write_bytes(b"second")
            (root / "unlisted-build-output").write_bytes(b"allowed")
            entries = [
                ("first.txt", MODULE.sha256_file(first)),
                ("nested/second.txt", MODULE.sha256_file(second)),
            ]
            manifest, manifest_sha256 = self.write_source_manifest(directory, entries)

            evidence = MODULE.validate_pristine_source(root, manifest, manifest_sha256)

            self.assertEqual(evidence["manifestSha256"], manifest_sha256)
            self.assertEqual(evidence["entryCount"], 2)

    def test_pristine_source_manifest_rejects_manifest_digest_mismatch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory) / "source"
            root.mkdir()
            manifest, _digest = self.write_source_manifest(
                directory, [("missing", "0" * 64)]
            )
            with self.assertRaisesRegex(RuntimeError, "manifest digest"):
                MODULE.validate_pristine_source(root, manifest)

    def test_pristine_source_manifest_rejects_unsafe_and_duplicate_paths(self):
        unsafe_paths = [
            "/absolute",
            "../escape",
            "nested/../escape",
            "./relative",
            "nested//file",
            "nested\\file",
        ]
        for unsafe_path in unsafe_paths:
            with self.subTest(
                path=unsafe_path
            ), tempfile.TemporaryDirectory() as directory:
                manifest, digest = self.write_source_manifest(
                    directory, [(unsafe_path, "0" * 64)]
                )
                with self.assertRaisesRegex(RuntimeError, "unsafe"):
                    MODULE.parse_source_manifest(manifest, digest)

        with tempfile.TemporaryDirectory() as directory:
            manifest, digest = self.write_source_manifest(
                directory,
                [("duplicate", "0" * 64), ("duplicate", "1" * 64)],
            )
            with self.assertRaisesRegex(RuntimeError, "duplicate"):
                MODULE.parse_source_manifest(manifest, digest)

    def test_pristine_source_manifest_rejects_missing_symlink_and_nonregular(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory) / "source"
            root.mkdir()
            regular = root / "regular"
            regular.write_bytes(b"content")
            expected = MODULE.sha256_file(regular)
            (root / "link").symlink_to(regular)
            (root / "directory").mkdir()
            outside = pathlib.Path(directory) / "outside"
            outside.mkdir()
            (outside / "nested").write_bytes(b"outside")
            (root / "linked-parent").symlink_to(outside, target_is_directory=True)
            for path in ("missing", "link", "directory", "linked-parent/nested"):
                with self.subTest(path=path):
                    manifest, manifest_sha256 = self.write_source_manifest(
                        directory, [(path, expected)]
                    )
                    with self.assertRaisesRegex(
                        RuntimeError, "missing or unsafe|not a regular file"
                    ):
                        MODULE.validate_pristine_source(root, manifest, manifest_sha256)

    def test_pristine_source_manifest_rejects_content_mismatch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory) / "source"
            root.mkdir()
            (root / "changed").write_bytes(b"changed")
            manifest, manifest_sha256 = self.write_source_manifest(
                directory, [("changed", hashlib.sha256(b"original").hexdigest())]
            )
            with self.assertRaisesRegex(RuntimeError, "content digest mismatch"):
                MODULE.validate_pristine_source(root, manifest, manifest_sha256)

    def test_mini_normalization_removes_opaque_ids_and_timing(self):
        response = {
            "outcome": "response",
            "status": 200,
            "headers": [("Content-Type", "application/json")],
            "body": json.dumps({
                "searchId": "S" * 32,
                "partial": False,
                "providers": [{"id": "showrss", "state": "ok", "elapsedMs": 812}],
                "results": [
                    {
                        "resultId": "R" * 32,
                        "providerId": "showrss",
                        "name": "Fixture",
                        "categoryIds": [2000],
                        "seeders": 4,
                        "leechers": 2,
                        "acquisition": "magnet",
                    }
                ],
            }).encode(),
            "elapsedMs": 900,
        }
        normalized = MODULE.canonical_mini_response(response)
        self.assertNotIn("searchId", normalized)
        self.assertNotIn("resultId", repr(normalized))
        self.assertNotIn("elapsedMs", repr(normalized))
        self.assertEqual(normalized["providers"], [{"id": "main", "state": "ok"}])

    def test_mini_result_store_contract_uses_corresponding_source_patch(self):
        with tempfile.TemporaryDirectory() as directory:
            patch = (
                pathlib.Path(directory)
                / "source/jackett/patches/0001-add-jackett-mini-read-only-service.patch"
            )
            patch.parent.mkdir(parents=True)
            patch.write_text(
                "diff --git a/src/Jackett.Mini/ResultStore.cs b/src/Jackett.Mini/ResultStore.cs\n"
                "+            _results.Add(id, new StoredResult(searchId, indexer, release, DateTimeOffset.UtcNow.AddMinutes(10)));\n"
                "+    private void Prune()\n",
                encoding="utf-8",
            )
            contract = MODULE.mini_result_store_contract(pathlib.Path(directory))
            self.assertEqual(contract["expiryMinutes"], 10)
            self.assertEqual(
                contract["sourcePath"],
                "source/jackett/patches/0001-add-jackett-mini-read-only-service.patch",
            )

    def test_mini_peer_contract_uses_corresponding_source_patch(self):
        with tempfile.TemporaryDirectory() as directory:
            patch = (
                pathlib.Path(directory)
                / "source/jackett/patches/0001-add-jackett-mini-read-only-service.patch"
            )
            patch.parent.mkdir(parents=True)
            patch.write_text(
                "+                long? leechers = release.Peers.HasValue && release.Seeders.HasValue\n"
                "+                    ? Math.Max(0, release.Peers.Value - release.Seeders.Value)\n"
                "+                    : null;\n",
                encoding="utf-8",
            )
            contract = MODULE.mini_peer_contract(pathlib.Path(directory))
            self.assertTrue(contract["totalPeersMinusSeeders"])
            self.assertEqual(contract["lowerBound"], 0)
            self.assertIsNone(contract["unavailableValue"])

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
                while (
                    pathlib.Path(f"/proc/{child}").exists()
                    and time.monotonic() < deadline
                ):
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
        self.assertIn('cmp -s -- "$comparison_key_check/before"', wrapper)
        self.assertIn("kernel-key-quota.json", wrapper)
        self.assertNotIn("unshare ", wrapper)
        self.assertNotIn("network create", wrapper)
        self.assertIn("run-pristine-adversarial.py", wrapper)
        self.assertIn("--fixture-address 127.0.0.1", wrapper)
        self.assertIn("container exists", wrapper)
        self.assertIn('rm -f "$container_name"', wrapper)
        self.assertIn(MODULE.PRISTINE_OCI_IMAGE, wrapper)

    def test_only_pristine_release_command_uses_oci(self):
        command = MODULE.pristine_container_command(
            ["/usr/bin/podman"],
            "wildbuzzard-jackett-pristine-test",
            "a" * 32,
            MODULE.PRISTINE_OCI_IMAGE,
            pathlib.Path("/host/pristine-runtime"),
            pathlib.Path("/host/pristine-source"),
            pathlib.Path("/host/overlays"),
            pathlib.Path("/host/pristine-data"),
            19001,
        )
        rendered = " ".join(map(str, command))
        self.assertIn("--network host", rendered)
        self.assertIn("--read-only", command)
        self.assertIn("--cap-drop=all", command)
        self.assertIn("/host/pristine-runtime:/inputs/pristine-runtime:ro", command)
        self.assertIn("/host/pristine-source:/inputs/pristine-source:ro", command)
        self.assertIn("/host/overlays:/inputs/overlays:ro", command)
        self.assertIn("/host/pristine-data:/data:rw", command)
        self.assertIn("/inputs/pristine-runtime/jackett", command)
        self.assertNotIn("mini", rendered.lower())

    def test_mini_process_identity_is_direct_host(self):
        with tempfile.TemporaryDirectory() as directory:
            process, log = MODULE.start_process(
                [sys.executable, "-c", "import time; time.sleep(60)"],
                pathlib.Path(directory),
                dict(os.environ),
                pathlib.Path(directory) / "mini.log",
            )
            try:
                identity = MODULE.direct_host_process_identity(
                    process,
                    MODULE.sha256_file(pathlib.Path(sys.executable)),
                    MODULE.host_execution_identity(),
                )
                self.assertEqual(identity["executionBoundary"], "direct-host-process")
                self.assertEqual(identity["pid"], process.pid)
            finally:
                MODULE.stop_process(process)
                log.close()

    def test_unreviewed_oracle_image_is_rejected_before_podman(self):
        with self.assertRaisesRegex(RuntimeError, "reviewed Microsoft pin"):
            MODULE.prepare_pristine_oci(
                ["podman"], "example.invalid/oracle@sha256:" + "a" * 64
            )

    def test_pristine_container_inspection_enforces_mount_boundary(self):
        runtime = pathlib.Path("/host/pristine-runtime")
        source = pathlib.Path("/host/pristine-source")
        overlays = pathlib.Path("/host/overlays")
        data = pathlib.Path("/host/pristine-data")
        document = {
            "Config": {
                "Entrypoint": ["/inputs/pristine-runtime/jackett"],
                "Labels": {MODULE.PRISTINE_OCI_RUN_LABEL: "a" * 32},
                "User": f"{os.geteuid()}:{os.getegid()}",
            },
            "HostConfig": {
                "Annotations": {
                    "io.podman.annotations.pids-limit": "512",
                    "io.podman.annotations.userns": "keep-id",
                },
                "CapAdd": [],
                "CapDrop": [
                    "CAP_CHOWN",
                    "CAP_DAC_OVERRIDE",
                    "CAP_FOWNER",
                    "CAP_FSETID",
                    "CAP_KILL",
                    "CAP_NET_BIND_SERVICE",
                    "CAP_SETFCAP",
                    "CAP_SETGID",
                    "CAP_SETPCAP",
                    "CAP_SETUID",
                    "CAP_SYS_CHROOT",
                ],
                "NetworkMode": "host",
                "PidsLimit": 512,
                "Privileged": False,
                "ReadonlyRootfs": True,
                "SecurityOpt": ["no-new-privileges", "label=disable"],
                "Tmpfs": {"/tmp": "rw,noexec,nosuid,nodev,size=1g"},
            },
            "Id": "c" * 64,
            "Image": "sha256:" + "d" * 64,
            "ImageName": MODULE.PRISTINE_OCI_IMAGE,
            "Mounts": [
                {"Destination": destination, "RW": writable, "Source": str(path)}
                for destination, writable, path in (
                    ("/inputs/pristine-runtime", False, runtime),
                    ("/inputs/pristine-source", False, source),
                    ("/inputs/overlays", False, overlays),
                    ("/data", True, data),
                )
            ],
            "State": {"Pid": 1234, "Running": True},
        }
        process_identity = {
            "executableSha256": MODULE.PRISTINE_EXECUTABLE_SHA256,
            "namespaces": {
                "mnt": "mnt:[2]",
                "net": "net:[1]",
                "pid": "pid:[2]",
                "user": "user:[2]",
            },
        }
        host_identity = {
            "namespaces": {
                "mnt": "mnt:[1]",
                "net": "net:[1]",
                "pid": "pid:[1]",
                "user": "user:[1]",
            }
        }

        with (
            mock.patch.object(MODULE, "command_json", return_value=[document]),
            mock.patch.object(
                MODULE, "process_identity_from_pid", return_value=process_identity
            ),
        ):
            evidence = MODULE.inspect_pristine_container(
                ["podman"],
                "wildbuzzard-jackett-pristine-test",
                "a" * 32,
                MODULE.PRISTINE_OCI_IMAGE,
                runtime,
                source,
                overlays,
                data,
                host_identity,
            )
            self.assertEqual(
                evidence["process"]["executionBoundary"], "rootless-oci-process"
            )

            document["Mounts"][0]["RW"] = True
            with self.assertRaisesRegex(RuntimeError, "mount boundary"):
                MODULE.inspect_pristine_container(
                    ["podman"],
                    "wildbuzzard-jackett-pristine-test",
                    "a" * 32,
                    MODULE.PRISTINE_OCI_IMAGE,
                    runtime,
                    source,
                    overlays,
                    data,
                    host_identity,
                )


if __name__ == "__main__":
    unittest.main()
