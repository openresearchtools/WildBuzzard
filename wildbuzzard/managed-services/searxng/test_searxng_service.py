# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import copy
import http.client
import json
import pathlib
import threading
import unittest

import searxng_service

POLICY = {
    "schema": 1,
    "searxngCommit": "b023a28bab8839dba9eac96e9a51cc91bbd0a267",
    "safeSearch": 1,
    "engines": [
        {
            "name": "fixture engine",
            "module": "demo_offline",
            "requiresCredentials": False,
            "purpose": "deterministic local comparison fixture",
        }
    ],
}


class FakeService:
    def __init__(self) -> None:
        self.port = 0
        self.token = "test-capability"
        self.backend_socket = pathlib.Path("/not-used")

    def public_identity(self) -> dict[str, object]:
        return {"component": "searxng", "protocolVersion": 1}

    def backend_healthy(self) -> bool:
        return True

    def mark_healthy(self) -> None:
        return


class EnginePolicyTest(unittest.TestCase):
    def test_valid_policy_generates_private_settings(self) -> None:
        engines = searxng_service.validate_engine_policy(POLICY)
        settings = searxng_service.settings_text("secret", 49152, engines)
        self.assertIn('      - "fixture engine"', settings)
        self.assertIn('    engine: "demo_offline"', settings)
        self.assertIn("  safe_search: 1", settings)
        self.assertIn("  enable_metrics: false", settings)
        self.assertIn("  formats:\n    - html\n    - json", settings)
        self.assertIn("  base_url: http://127.0.0.1:49152/", settings)

    def test_credentials_are_rejected(self) -> None:
        policy = copy.deepcopy(POLICY)
        policy["engines"][0]["requiresCredentials"] = True
        with self.assertRaisesRegex(RuntimeError, "may not require credentials"):
            searxng_service.validate_engine_policy(policy)

    def test_unknown_fields_are_rejected(self) -> None:
        policy = copy.deepcopy(POLICY)
        policy["engines"][0]["apiKey"] = "secret"
        with self.assertRaisesRegex(RuntimeError, "invalid fields"):
            searxng_service.validate_engine_policy(policy)


class GatewayBoundaryTest(unittest.TestCase):
    def setUp(self) -> None:
        self.service = FakeService()
        self.gateway = searxng_service.Gateway(self.service)
        self.service.port = self.gateway.server_address[1]
        self.thread = threading.Thread(target=self.gateway.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.gateway.shutdown()
        self.gateway.server_close()
        self.thread.join(timeout=5)

    def request(
        self, path: str, *, authorization: bool = False, host: str | None = None
    ) -> tuple[int, dict[str, object]]:
        connection = http.client.HTTPConnection("127.0.0.1", self.service.port)
        headers = {"Host": host or f"127.0.0.1:{self.service.port}"}
        if authorization:
            headers["Authorization"] = f"Bearer {self.service.token}"
        connection.request("GET", path, headers=headers)
        response = connection.getresponse()
        body = json.loads(response.read())
        connection.close()
        return response.status, body

    def test_identity_requires_capability(self) -> None:
        status, body = self.request("/v1/identity")
        self.assertEqual(status, 401)
        self.assertEqual(body, {"error": "capability-required"})
        status, body = self.request("/v1/identity", authorization=True)
        self.assertEqual(status, 200)
        self.assertEqual(body["component"], "searxng")

    def test_metrics_is_not_exposed(self) -> None:
        status, body = self.request("/metrics", authorization=True)
        self.assertEqual(status, 404)
        self.assertEqual(body, {"error": "not-found"})

    def test_host_boundary_rejects_dns_rebinding(self) -> None:
        status, body = self.request(
            "/v1/identity", authorization=True, host="attacker.invalid"
        )
        self.assertEqual(status, 403)
        self.assertEqual(body, {"error": "forbidden"})


if __name__ == "__main__":
    unittest.main()
