#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import json
import sys
from typing import Any

import buzzard_search


TOOLS = [
    {
        "name": "web_search",
        "description": (
            "Pass query for SearXNG snippets, then pass url to read one selected "
            "page as Markdown with a fullMarkdownPath artifact."
        ),
        "inputSchema": {
            "type": "object",
            "additionalProperties": False,
            "oneOf": [{"required": ["query"]}, {"required": ["url"]}],
            "properties": {
                "query": {"type": "string", "minLength": 1, "maxLength": 512},
                "url": {"type": "string", "minLength": 1, "maxLength": 8192},
                "timeout": {"type": "integer", "minimum": 1, "maximum": 60},
                "engines": {
                    "type": "array",
                    "items": {"type": "string"},
                    "maxItems": 332,
                    "uniqueItems": True,
                },
                "language": {"type": "string", "minLength": 1, "maxLength": 35},
                "page": {"type": "integer", "minimum": 1, "maximum": 10},
                "timeRange": {"enum": ["day", "week", "month", "year"]},
                "safeSearch": {"const": 1},
                "maxResults": {"type": "integer", "minimum": 1, "maximum": 20},
                "sortOrder": {"enum": ["relevance", "newest", "oldest"]},
            },
        },
        "annotations": {"readOnlyHint": True, "openWorldHint": True},
    },
]


def response(identifier: Any, result: Any = None, error: Any = None) -> None:
    value: dict[str, Any] = {"jsonrpc": "2.0", "id": identifier}
    if error is not None:
        value["error"] = error
    else:
        value["result"] = result
    print(json.dumps(value, separators=(",", ":")), flush=True)


def dispatch(message: dict[str, Any]) -> None:
    method = message.get("method")
    identifier = message.get("id")
    if method == "initialize":
        response(
            identifier,
            {
                "protocolVersion": "2025-11-25",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "buzzard-search", "version": buzzard_search.VERSION},
            },
        )
    elif method == "ping":
        response(identifier, {})
    elif method == "tools/list":
        response(identifier, {"tools": TOOLS})
    elif method == "tools/call":
        params = message.get("params") or {}
        try:
            result = buzzard_search.invoke(params.get("name"), params.get("arguments") or {})
            response(
                identifier,
                {
                    "content": [
                        {
                            "type": "text",
                            "text": json.dumps(result, separators=(",", ":")),
                        }
                    ],
                    "structuredContent": result,
                },
            )
        except Exception as error:
            response(
                identifier,
                {
                    "content": [{"type": "text", "text": str(error)}],
                    "isError": True,
                },
            )
    elif identifier is not None:
        response(identifier, error={"code": -32601, "message": "Method not found"})


def main() -> int:
    for line in sys.stdin:
        try:
            message = json.loads(line)
            if isinstance(message, dict):
                dispatch(message)
        except Exception as error:
            print(f"buzzard-search-mcp: {error}", file=sys.stderr, flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
