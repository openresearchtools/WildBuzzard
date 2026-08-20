#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import json
import sys
from typing import Any

import buzzard_torrent


OBJECT = {"type": "object", "additionalProperties": False}
TORRENT_ID = {"type": "string", "pattern": "^[0-9a-fA-F]{40}$"}
IDS = {"type": "array", "minItems": 1, "maxItems": 100, "uniqueItems": True, "items": TORRENT_ID}
TOOLS = [
    {"name": "torrent_status", "description": "Read qBittorrent service, transfer and torrent status.", "inputSchema": OBJECT, "annotations": {"readOnlyHint": True}},
    {
        "name": "torrent_list",
        "description": "List torrents with qBittorrent filters, ordering and pagination.",
        "inputSchema": {**OBJECT, "properties": {
            "filter": {"enum": ["all", "downloading", "seeding", "completed", "stopped", "running", "active", "inactive", "stalled", "stalled_uploading", "stalled_downloading", "errored"]},
            "category": {"type": "string", "maxLength": 256},
            "tag": {"type": "string", "maxLength": 256},
            "sort": {"enum": ["name", "size", "progress", "dlspeed", "upspeed", "priority", "num_seeds", "num_leechs", "eta", "ratio", "added_on", "completion_on"]},
            "reverse": {"type": "boolean"},
            "limit": {"type": "integer", "minimum": 1, "maximum": 100},
            "offset": {"type": "integer", "minimum": 0, "maximum": 100000},
        }},
        "annotations": {"readOnlyHint": True},
    },
    {
        "name": "torrent_details",
        "description": "Read a paginated overview, file, tracker or peer section for one torrent.",
        "inputSchema": {**OBJECT, "required": ["id"], "properties": {
            "id": TORRENT_ID,
            "section": {"enum": ["overview", "files", "trackers", "peers"]},
            "offset": {"type": "integer", "minimum": 0, "maximum": 100000},
            "limit": {"type": "integer", "minimum": 1, "maximum": 500},
        }},
        "annotations": {"readOnlyHint": True},
    },
    {"name": "torrent_files", "description": "Read files for one torrent.", "inputSchema": {**OBJECT, "required": ["id"], "properties": {"id": TORRENT_ID, "offset": {"type": "integer", "minimum": 0, "maximum": 100000}, "limit": {"type": "integer", "minimum": 1, "maximum": 500}}}, "annotations": {"readOnlyHint": True}},
    {"name": "torrent_trackers", "description": "Read trackers for one torrent.", "inputSchema": {**OBJECT, "required": ["id"], "properties": {"id": TORRENT_ID, "offset": {"type": "integer", "minimum": 0, "maximum": 100000}, "limit": {"type": "integer", "minimum": 1, "maximum": 500}}}, "annotations": {"readOnlyHint": True}},
    {"name": "torrent_peers", "description": "Read peers for one torrent.", "inputSchema": {**OBJECT, "required": ["id"], "properties": {"id": TORRENT_ID, "offset": {"type": "integer", "minimum": 0, "maximum": 100000}, "limit": {"type": "integer", "minimum": 1, "maximum": 500}}}, "annotations": {"readOnlyHint": True}},
    {
        "name": "torrent_add",
        "description": "Add one explicitly confirmed magnet or base64 torrent payload to qBittorrent.",
        "inputSchema": {**OBJECT, "required": ["confirmed"], "properties": {
            "magnet": {"type": "string", "maxLength": 32768},
            "torrentBase64": {"type": "string", "maxLength": 16777216},
            "downloadPath": {"type": "string", "maxLength": 4096},
            "confirmed": {"const": True},
        }, "oneOf": [{"required": ["magnet"]}, {"required": ["torrentBase64"]}]},
        "annotations": {"destructiveHint": False, "idempotentHint": False},
    },
    {
        "name": "torrent_action",
        "description": "Start, stop, reannounce or recheck one torrent.",
        "inputSchema": {**OBJECT, "required": ["id", "action"], "properties": {"id": TORRENT_ID, "action": {"enum": ["start", "resume", "stop", "pause", "reannounce", "recheck"]}}},
        "annotations": {"idempotentHint": True},
    },
    {
        "name": "torrent_control",
        "description": "Apply a validated advanced qBittorrent operation to one or more torrent IDs. Delete requires confirmed=true.",
        "inputSchema": {**OBJECT, "required": ["ids", "action"], "properties": {
            "ids": IDS,
            "action": {"enum": ["start", "stop", "forceStart", "autoStart", "reannounce", "recheck", "delete", "filePriority", "limits", "rename", "sequential", "firstLastPiece"]},
            "confirmed": {"type": "boolean"},
            "deleteData": {"type": "boolean"},
            "fileIds": {"type": "array", "minItems": 1, "maxItems": 10000, "uniqueItems": True, "items": {"type": "integer", "minimum": 0}},
            "priority": {"enum": [0, 1, 6, 7]},
            "downloadLimit": {"type": "integer", "minimum": 0, "maximum": 2147483647},
            "uploadLimit": {"type": "integer", "minimum": 0, "maximum": 2147483647},
            "name": {"type": "string", "maxLength": 512},
            "enabled": {"type": "boolean"},
        }},
        "annotations": {"destructiveHint": True, "idempotentHint": True},
    },
]


def send(identifier: Any, result: Any = None, error: Any = None) -> None:
    message = {"jsonrpc": "2.0", "id": identifier}
    message["error" if error else "result"] = error if error else result
    print(json.dumps(message, separators=(",", ":")), flush=True)


def main() -> int:
    for line in sys.stdin:
        try:
            message = json.loads(line)
            method = message.get("method")
            if method == "initialize":
                send(message.get("id"), {"protocolVersion": "2025-11-25", "capabilities": {"tools": {}}, "serverInfo": {"name": "buzzard-torrent", "version": buzzard_torrent.VERSION}})
            elif method == "ping":
                send(message.get("id"), {})
            elif method == "tools/list":
                send(message.get("id"), {"tools": TOOLS})
            elif method == "tools/call":
                try:
                    result = buzzard_torrent.invoke(message.get("params", {}).get("name"), message.get("params", {}).get("arguments", {}))
                    send(message.get("id"), {"content": [{"type": "text", "text": json.dumps(result, separators=(",", ":"))}], "structuredContent": result})
                except Exception as error:
                    send(message.get("id"), {"content": [{"type": "text", "text": str(error)}], "isError": True})
            elif message.get("id") is not None:
                send(message.get("id"), error={"code": -32601, "message": "Method not found"})
        except Exception as error:
            print(f"buzzard-torrent-mcp: {error}", file=sys.stderr, flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
