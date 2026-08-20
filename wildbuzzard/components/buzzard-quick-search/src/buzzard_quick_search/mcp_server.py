# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import json
import sys
from typing import Any, TextIO

from .service import PROVENANCE, quick_search_output

SERVER_NAME = "buzzard-quick-search"
SERVER_VERSION = "0.1.0"
PROTOCOL_VERSION = "2026-07-28"
LEGACY_PROTOCOL_VERSIONS = (
    "2024-11-05",
    "2025-03-26",
    "2025-06-18",
    "2025-11-25",
)
SERVER_INFO = {"name": SERVER_NAME, "version": SERVER_VERSION}
INSTRUCTIONS = (
    "Call web_search with query for Unsloth-compatible snippets, then call it with url "
    "to read a selected page as truncated Markdown."
)

WEB_SEARCH_TOOL = {
    "name": "web_search",
    "description": (
        "Search the web and fetch page content. Returns snippets for all results. "
        "Use the url parameter to fetch full page text from a specific URL."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "maxLength": 512,
                "description": "The search query",
            },
            "url": {
                "type": "string",
                "maxLength": 8192,
                "description": (
                    "A URL to fetch full page content from (instead of searching). "
                    "Use this to read a page found in search results."
                ),
            },
        },
        "required": [],
        "additionalProperties": False,
    },
    "annotations": {"readOnlyHint": True, "openWorldHint": True},
    "_meta": {"provenance": PROVENANCE},
}


def _error(request_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


def handle_request(message: dict[str, Any]) -> dict[str, Any] | None:
    method = message.get("method")
    request_id = message.get("id")
    if request_id is None:
        return None
    if message.get("jsonrpc") != "2.0" or not isinstance(method, str):
        return _error(request_id, -32600, "Invalid Request")
    if method == "server/discover":
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "resultType": "complete",
                "supportedVersions": [PROTOCOL_VERSION],
                "capabilities": {"tools": {"listChanged": False}},
                "instructions": INSTRUCTIONS,
                "ttlMs": 3_600_000,
                "cacheScope": "public",
                "_meta": {"io.modelcontextprotocol/serverInfo": SERVER_INFO},
            },
        }
    if method == "initialize":
        params = message.get("params") or {}
        requested = params.get("protocolVersion") if isinstance(params, dict) else None
        negotiated = requested if requested in LEGACY_PROTOCOL_VERSIONS else "2025-11-25"
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "protocolVersion": negotiated,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": SERVER_INFO,
                "instructions": INSTRUCTIONS,
            },
        }
    if method == "ping":
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {"resultType": "complete"},
        }
    if method == "tools/list":
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "resultType": "complete",
                "tools": [WEB_SEARCH_TOOL],
                "ttlMs": 3_600_000,
                "cacheScope": "public",
                "_meta": {"io.modelcontextprotocol/serverInfo": SERVER_INFO},
            },
        }
    if method != "tools/call":
        return _error(request_id, -32601, "Method not found")

    params = message.get("params")
    if not isinstance(params, dict) or params.get("name") != "web_search":
        return _error(request_id, -32602, "Unknown tool")
    arguments = params.get("arguments") or {}
    if not isinstance(arguments, dict) or set(arguments) - {"query", "url"}:
        return _error(request_id, -32602, "Invalid web_search arguments")
    query = arguments.get("query", "")
    url = arguments.get("url")
    if not isinstance(query, str) or (url is not None and not isinstance(url, str)):
        return _error(request_id, -32602, "query and url must be strings")
    output = quick_search_output(query, url = url)
    metadata = {
        "io.modelcontextprotocol/serverInfo": SERVER_INFO,
        "provenance": PROVENANCE,
    }
    if output.full_markdown_path is not None:
        metadata["fullMarkdownPath"] = output.full_markdown_path
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "result": {
            "resultType": "complete",
            "content": [{"type": "text", "text": output.as_text()}],
            "structuredContent": output.as_dict(),
            "isError": False,
            "_meta": metadata,
        },
    }


def serve(stdin: TextIO | None = None, stdout: TextIO | None = None) -> None:
    input_stream = stdin or sys.stdin
    output_stream = stdout or sys.stdout
    for line in input_stream:
        if not line.strip():
            continue
        try:
            message = json.loads(line)
            if not isinstance(message, dict):
                raise ValueError("request must be an object")
            response = handle_request(message)
        except (json.JSONDecodeError, ValueError) as exc:
            response = _error(None, -32700, str(exc))
        except Exception as exc:
            response = _error(message.get("id") if isinstance(message, dict) else None, -32603, str(exc))
        if response is not None:
            output_stream.write(json.dumps(response, ensure_ascii = False, separators = (",", ":")) + "\n")
            output_stream.flush()


def main() -> int:
    serve()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
