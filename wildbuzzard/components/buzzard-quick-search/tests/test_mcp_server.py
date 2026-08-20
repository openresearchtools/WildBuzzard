# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import io
import json
import unittest
from unittest.mock import patch

from buzzard_quick_search import mcp_server
from buzzard_quick_search.service import QuickSearchOutput


class MCPServerTest(unittest.TestCase):
    def test_initialize_and_tool_listing(self):
        initialized = mcp_server.handle_request(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {"protocolVersion": "2025-06-18"},
            }
        )
        self.assertEqual(initialized["result"]["serverInfo"]["name"], "buzzard-quick-search")
        self.assertEqual(initialized["result"]["protocolVersion"], "2025-06-18")
        listed = mcp_server.handle_request(
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}
        )
        self.assertEqual([tool["name"] for tool in listed["result"]["tools"]], ["web_search"])
        self.assertEqual(
            set(listed["result"]["tools"][0]["inputSchema"]["properties"]),
            {"query", "url"},
        )

    def test_current_stateless_discovery(self):
        response = mcp_server.handle_request(
            {
                "jsonrpc": "2.0",
                "id": "discover",
                "method": "server/discover",
                "params": {
                    "_meta": {
                        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                        "io.modelcontextprotocol/clientCapabilities": {},
                    }
                },
            }
        )
        self.assertEqual(response["result"]["resultType"], "complete")
        self.assertEqual(response["result"]["supportedVersions"], ["2026-07-28"])
        self.assertIn("tools", response["result"]["capabilities"])

    @patch(
        "buzzard_quick_search.mcp_server.quick_search_output",
        return_value = QuickSearchOutput("model-ready"),
    )
    def test_tool_call_returns_text_and_provenance(self, mocked_search):
        response = mcp_server.handle_request(
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {"name": "web_search", "arguments": {"query": "q"}},
            }
        )
        mocked_search.assert_called_once_with("q", url = None)
        self.assertEqual(response["result"]["content"], [{"type": "text", "text": "model-ready"}])
        self.assertEqual(
            response["result"]["_meta"]["provenance"]["resultContract"],
            "unsloth-studio-web-search-v1",
        )
        self.assertEqual(response["result"]["structuredContent"]["content"], "model-ready")

    @patch(
        "buzzard_quick_search.mcp_server.quick_search_output",
        return_value = QuickSearchOutput("inline", "/tmp/private/full.md", 20_000),
    )
    def test_url_result_exposes_path_in_text_structured_content_and_metadata(self, mocked_search):
        response = mcp_server.handle_request(
            {
                "jsonrpc": "2.0",
                "id": 5,
                "method": "tools/call",
                "params": {"name": "web_search", "arguments": {"url": "https://example.com"}},
            }
        )
        mocked_search.assert_called_once_with("", url = "https://example.com")
        self.assertIn("BUZZARD_FULL_MARKDOWN_PATH=/tmp/private/full.md", response["result"]["content"][0]["text"])
        self.assertEqual(response["result"]["structuredContent"]["fullMarkdownPath"], "/tmp/private/full.md")
        self.assertEqual(response["result"]["_meta"]["fullMarkdownPath"], "/tmp/private/full.md")

    def test_stdio_uses_newline_delimited_json_rpc(self):
        request = json.dumps({"jsonrpc": "2.0", "id": 4, "method": "ping"}) + "\n"
        output = io.StringIO()
        mcp_server.serve(io.StringIO(request), output)
        self.assertEqual(
            json.loads(output.getvalue()),
            {"jsonrpc": "2.0", "id": 4, "result": {"resultType": "complete"}},
        )


if __name__ == "__main__":
    unittest.main()
