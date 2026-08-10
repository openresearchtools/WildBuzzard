# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import importlib.util
import json
import pathlib
import tempfile
import unittest

MODULE_PATH = pathlib.Path(__file__).with_name("compare_firecrawl.py")
SPEC = importlib.util.spec_from_file_location("compare_firecrawl", MODULE_PATH)
assert SPEC and SPEC.loader
COMPARATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(COMPARATOR)


class FirecrawlComparatorTest(unittest.TestCase):
    def test_podman_storage_is_ephemeral_and_isolated(self) -> None:
        previous = COMPARATOR.os.environ.get("CONTAINERS_STORAGE_CONF")
        previous_engine = COMPARATOR.os.environ.get("CONTAINERS_CONF")
        try:
            with (
                tempfile.TemporaryDirectory() as directory,
                tempfile.TemporaryDirectory() as runtime_directory,
            ):
                work = pathlib.Path(directory)
                runtime_base = pathlib.Path(runtime_directory)
                runtime_base.chmod(0o700)
                run_root = COMPARATOR.create_ephemeral_podman_run_root(runtime_base)
                identity = COMPARATOR.configure_isolated_podman_storage(
                    work, run_root
                )
                config_path = pathlib.Path(
                    COMPARATOR.os.environ["CONTAINERS_STORAGE_CONF"]
                )
                engine_config_path = pathlib.Path(
                    COMPARATOR.os.environ["CONTAINERS_CONF"]
                )
                config = config_path.read_text(encoding="utf-8")
                engine_config = engine_config_path.read_text(encoding="utf-8")
                crun_wrapper = work / "crun-wrapper"
                self.assertEqual(identity["driver"], "overlay")
                self.assertTrue(identity["isolated"])
                self.assertEqual(
                    identity["configSha256"], COMPARATOR.sha256_file(config_path)
                )
                self.assertIn(str(work / "podman-graph"), config)
                self.assertIn(str(run_root), config)
                self.assertNotIn(str(work / "podman-run"), config)
                self.assertTrue(identity["ephemeralUserRunRoot"])
                self.assertEqual(identity["runtime"], "oracle-crun")
                self.assertEqual(identity["runtimeFlags"], ["no-new-keyring"])
                self.assertEqual(
                    identity["engineConfigSha256"],
                    COMPARATOR.sha256_file(engine_config_path),
                )
                self.assertIn('[engine]\nruntime = "oracle-crun"', engine_config)
                self.assertIn(str(crun_wrapper), engine_config)
                self.assertEqual(
                    identity["runtimeWrapperSha256"],
                    COMPARATOR.sha256_file(crun_wrapper),
                )
                self.assertIn(
                    '("$argument" == create || "$argument" == run)',
                    crun_wrapper.read_text(encoding="utf-8"),
                )
                self.assertIn(
                    'arguments+=("--no-new-keyring")',
                    crun_wrapper.read_text(encoding="utf-8"),
                )
                self.assertEqual(run_root.stat().st_mode & 0o777, 0o700)
                self.assertEqual(config_path.stat().st_mode & 0o777, 0o600)
                self.assertEqual(engine_config_path.stat().st_mode & 0o777, 0o600)
                self.assertEqual(crun_wrapper.stat().st_mode & 0o777, 0o700)
                COMPARATOR.subprocess.run(
                    [
                        str(crun_wrapper),
                        "--root",
                        str(work / "crun-root"),
                        "create",
                        "--help",
                    ],
                    check=True,
                    stdout=COMPARATOR.subprocess.DEVNULL,
                )
                COMPARATOR.shutil.rmtree(run_root)
                self.assertFalse(run_root.exists())
        finally:
            if previous is None:
                COMPARATOR.os.environ.pop("CONTAINERS_STORAGE_CONF", None)
            else:
                COMPARATOR.os.environ["CONTAINERS_STORAGE_CONF"] = previous
            if previous_engine is None:
                COMPARATOR.os.environ.pop("CONTAINERS_CONF", None)
            else:
                COMPARATOR.os.environ["CONTAINERS_CONF"] = previous_engine

    def test_current_key_quota_is_bounded(self) -> None:
        quota = COMPARATOR.current_key_quota()
        self.assertLessEqual(quota["usage"], quota["keyQuota"])
        self.assertLessEqual(quota["instantiated"], quota["instantiatedQuota"])
        self.assertLessEqual(quota["byteUsage"], quota["byteQuota"])

    def test_published_port_cleanup_probe(self) -> None:
        listener = COMPARATOR.socket.socket(
            COMPARATOR.socket.AF_INET, COMPARATOR.socket.SOCK_STREAM
        )
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        port = listener.getsockname()[1]
        self.assertFalse(COMPARATOR.wait_ports_closed([port], 0.01)["passed"])
        listener.close()
        self.assertEqual(
            COMPARATOR.wait_ports_closed([port], 0.1),
            {"passed": True, "openPorts": []},
        )

    def test_base_images_pin_index_platform_and_config_digests(self) -> None:
        digest_pattern = COMPARATOR.re.compile(r"sha256:[0-9a-f]{64}")
        for image in COMPARATOR.BASE_IMAGES:
            digests = {
                image["indexDigest"],
                image["platformDigest"],
                image["configDigest"],
            }
            self.assertEqual(len(digests), 3)
            self.assertTrue(all(digest_pattern.fullmatch(value) for value in digests))
            descriptor = COMPARATOR.pinned_platform_descriptor(
                {
                    "manifests": [
                        {
                            "digest": image["platformDigest"],
                            "platform": {"os": "linux", "architecture": "amd64"},
                        }
                    ]
                },
                image,
            )
            self.assertEqual(descriptor["digest"], image["platformDigest"])
            identity = {
                "id": image["configDigest"],
                "digest": image["platformDigest"],
                "os": "linux",
                "architecture": "amd64",
            }
            COMPARATOR.validate_base_identity(image, identity)
            COMPARATOR.validate_base_identity(
                image,
                {
                    **identity,
                    "id": image["configDigest"].removeprefix("sha256:"),
                },
            )
            with self.assertRaisesRegex(RuntimeError, "config digest"):
                COMPARATOR.validate_base_identity(image, {**identity, "id": "wrong"})

    def test_digest_normalization_is_strict(self) -> None:
        digest = "a" * 64
        self.assertEqual(
            COMPARATOR.canonical_sha256_digest(digest), f"sha256:{digest}"
        )
        self.assertEqual(
            COMPARATOR.canonical_sha256_digest(f"sha256:{digest}"),
            f"sha256:{digest}",
        )
        for value in (None, "", "sha512:" + digest, "A" * 64):
            with self.assertRaises(RuntimeError):
                COMPARATOR.canonical_sha256_digest(value)

    def test_pristine_dockerfile_from_parser(self) -> None:
        self.assertEqual(
            COMPARATOR.dockerfile_from_references(
                "FROM node:22-slim AS base\n"
                "FROM --platform=linux/amd64 golang:1.24 AS build\n"
                "FROM base AS runtime\n"
            ),
            ["node:22-slim", "golang:1.24", "base"],
        )

    def test_reference_build_arguments_are_exact_and_immutable(self) -> None:
        root = pathlib.Path("/reference")
        api = COMPARATOR.reference_image_build_command(
            "api", "localhost/api:reference", root / "api.Dockerfile", root / "api"
        )
        playwright = COMPARATOR.reference_image_build_command(
            "playwright",
            "localhost/playwright:reference",
            root / "playwright.Dockerfile",
            root / "playwright",
        )
        self.assertEqual(
            [api[index + 1] for index, item in enumerate(api) if item == "--build-arg"],
            [f"GIT_SHA={COMPARATOR.FIRECRAWL_COMMIT}"],
        )
        self.assertEqual(
            [
                playwright[index + 1]
                for index, item in enumerate(playwright)
                if item == "--build-arg"
            ],
            ["PORT=3000"],
        )
        self.assertIn("--pull=never", api)
        self.assertIn("--pull=never", playwright)
        with self.assertRaisesRegex(RuntimeError, "Unknown Firecrawl"):
            COMPARATOR.reference_image_build_command(
                "candidate", "candidate", root / "Dockerfile", root
            )

    def test_playwright_build_port_matches_pinned_upstream_contract(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = pathlib.Path(directory)
            service = source / "apps" / "playwright-service-ts"
            service.mkdir(parents=True)
            (source / "docker-compose.yaml").write_text(
                "x-common-env: &common-env\n"
                "  PLAYWRIGHT_MICROSERVICE_URL: "
                "${PLAYWRIGHT_MICROSERVICE_URL:-http://playwright-service:3000/scrape}\n"
                "services:\n"
                "  playwright-service:\n"
                "    build: apps/playwright-service-ts\n"
                "    environment:\n"
                "      PORT: 3000\n",
                encoding="utf-8",
            )
            dockerfile = service / "Dockerfile"
            dockerfile.write_text(
                "FROM node:22-slim\nARG PORT\nENV PORT=${PORT}\n\n"
                "EXPOSE ${PORT}\n",
                encoding="utf-8",
            )
            (service / "package.json").write_text(
                json.dumps({
                    "scripts": {"start": "node dist/api.js"},
                    "packageManager": "pnpm@11.4.0",
                }),
                encoding="utf-8",
            )
            contract = COMPARATOR.verify_upstream_runtime_contract(source)
            self.assertEqual(contract["playwrightPort"], 3000)
            self.assertEqual(contract["playwrightBuildArguments"], ["PORT=3000"])
            self.assertEqual(
                contract["playwrightStartCommand"], ["node", "dist/api.js"]
            )
            self.assertEqual(
                contract["composeSha256"],
                COMPARATOR.sha256_file(source / "docker-compose.yaml"),
            )
            (source / "docker-compose.yaml").write_text(
                (source / "docker-compose.yaml")
                .read_text(encoding="utf-8")
                .replace("PORT: 3000", "PORT: 3001"),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(RuntimeError, "runtime contract changed"):
                COMPARATOR.verify_upstream_runtime_contract(source)

    def test_base_pull_orchestration_never_pulls_a_mutable_tag(self) -> None:
        class Recorder:
            def __init__(self) -> None:
                self.commands = []

            def run(self, _name, command):
                self.commands.append(command)
                if command[1:3] == ["manifest", "inspect"]:
                    image = next(
                        item
                        for item in COMPARATOR.BASE_IMAGES
                        if item["indexDigest"] in command[-1]
                    )
                    output = json.dumps({
                        "manifests": [
                            {
                                "digest": image["platformDigest"],
                                "platform": {
                                    "os": "linux",
                                    "architecture": "amd64",
                                },
                            }
                        ]
                    })
                elif command[1:3] == ["image", "inspect"]:
                    reference = command[-1]
                    image = next(
                        item
                        for item in COMPARATOR.BASE_IMAGES
                        if reference
                        in {
                            item["from"],
                            COMPARATOR.base_tag_reference(item),
                            COMPARATOR.base_platform_reference(item),
                        }
                    )
                    output = json.dumps([
                        {
                            "Id": image["configDigest"],
                            "Digest": image["platformDigest"],
                            "RepoDigests": [],
                            "Architecture": "amd64",
                            "Os": "linux",
                            "RootFS": {"Layers": []},
                        }
                    ])
                else:
                    output = ""
                return COMPARATOR.subprocess.CompletedProcess(command, 0, output)

        recorder = Recorder()
        identities = COMPARATOR.pull_bases(recorder)
        self.assertEqual(len(identities), 3)
        pulls = [command for command in recorder.commands if command[1] == "pull"]
        self.assertEqual(len(pulls), 3)
        self.assertTrue(all("@sha256:" in command[-1] for command in pulls))
        self.assertTrue(
            all(
                image["platformDigest"] in command[-1]
                for image, command in zip(COMPARATOR.BASE_IMAGES, pulls)
            )
        )

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

    def test_cancellation_prompt_bound_precedes_natural_completion(self) -> None:
        self.assertLess(
            COMPARATOR.CANCELLATION_PROMPT_BOUND_MS,
            COMPARATOR.CANCELLATION_FIXTURE_MS,
        )
        self.assertTrue(COMPARATOR.cancellation_prompt_passed(2999))
        self.assertFalse(COMPARATOR.cancellation_prompt_passed(3000))
        self.assertFalse(COMPARATOR.cancellation_prompt_passed(5000))
        self.assertFalse(COMPARATOR.cancellation_prompt_passed(None))

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
            COMPARATOR.normalize_fixture_url("http://fixture.test:8080/a"),
            "http://fixture.test/a",
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

    def test_status_204_reference_difference_is_exact(self) -> None:
        scenario = next(
            case
            for case in COMPARATOR.scenario_definitions(False)
            if case["name"] == "status-204"
        )
        reference = {
            "apiStatus": 500,
            "api": {"success": False, "code": "SCRAPE_ALL_ENGINES_FAILED"},
        }
        self.assertEqual(COMPARATOR.evaluate_reference(scenario, reference), (True, []))
        candidate = {
            "status": 204,
            "contentType": "",
            "finalUrl": "http://fixture.test/status/204",
            "bodySha256": COMPARATOR.sha256_bytes(b""),
        }
        self.assertEqual(COMPARATOR.compare_gecko(scenario, reference, candidate), (True, []))
        reference["apiStatus"] = 200
        self.assertFalse(COMPARATOR.evaluate_reference(scenario, reference)[0])

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
