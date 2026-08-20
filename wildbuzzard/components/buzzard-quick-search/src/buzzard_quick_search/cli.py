# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import argparse
import json
import sys

from .service import PROVENANCE, QuickSearchOutput, quick_search_output


def _positive_int(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return parsed


def _result_count(value: str) -> int:
    parsed = _positive_int(value)
    if parsed > 20:
        raise argparse.ArgumentTypeError("must be at most 20")
    return parsed


def _timeout(value: str) -> int:
    parsed = _positive_int(value)
    if parsed > 300:
        raise argparse.ArgumentTypeError("must be at most 300")
    return parsed


def _emit(output: QuickSearchOutput, as_json: bool) -> None:
    if as_json:
        print(json.dumps(output.as_dict(), ensure_ascii = False))
    else:
        print(output.as_text())


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog = "buzzard-quick-search",
        description = "Standalone Unsloth-compatible quick web search and page extraction.",
    )
    subparsers = parser.add_subparsers(dest = "command", required = True)

    search = subparsers.add_parser("search", help = "search and return model-ready snippets")
    search.add_argument("query")
    search.add_argument("--max-results", type = _result_count, default = 5)
    search.add_argument("--timeout", type = _timeout, default = 300)
    search.add_argument("--allow-domain", action = "append", default = [])
    search.add_argument("--block-domain", action = "append", default = [])
    search.add_argument("--json", action = "store_true")

    fetch = subparsers.add_parser(
        "fetch",
        help = "fetch one URL as inline Markdown plus a complete file path",
    )
    fetch.add_argument("url")
    fetch.add_argument("--timeout", type = _timeout, default = 300)
    fetch.add_argument("--allow-domain", action = "append", default = [])
    fetch.add_argument("--block-domain", action = "append", default = [])
    fetch.add_argument("--json", action = "store_true")

    subparsers.add_parser("mcp", help = "serve the web_search tool over MCP stdio")
    subparsers.add_parser("version", help = "print package and protocol versions")
    subparsers.add_parser("provenance", help = "print machine-readable upstream provenance")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.command == "mcp":
        from .mcp_server import serve

        serve()
        return 0
    if args.command == "provenance":
        print(json.dumps(PROVENANCE, indent = 2, sort_keys = True))
        return 0
    if args.command == "version":
        from .mcp_server import PROTOCOL_VERSION

        print(json.dumps({**PROVENANCE, "protocolVersion": PROTOCOL_VERSION}, sort_keys = True))
        return 0
    if args.command == "fetch":
        output = quick_search_output(
            url = args.url,
            timeout = args.timeout,
            allowed_domains = args.allow_domain,
            blocked_domains = args.block_domain,
        )
        _emit(output, args.json)
        return 0
    output = quick_search_output(
        args.query,
        max_results = args.max_results,
        timeout = args.timeout,
        allowed_domains = args.allow_domain,
        blocked_domains = args.block_domain,
    )
    _emit(output, args.json)
    return 0


if __name__ == "__main__":
    sys.exit(main())
