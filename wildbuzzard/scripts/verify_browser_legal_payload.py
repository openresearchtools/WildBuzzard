#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later

import argparse
from pathlib import Path


class ValidationError(Exception):
    pass


def expected_payloads(source_root):
    return {
        "COPYING": source_root / "COPYING",
        "LICENSE": source_root / "LICENSE",
        "MOZILLA-MCP-LICENSE": source_root
        / "wildbuzzard"
        / "components"
        / "wildbuzzard-cli"
        / "MOZILLA-MCP-LICENSE",
        "NOTICE": source_root
        / "wildbuzzard"
        / "components"
        / "wildbuzzard-cli"
        / "NOTICE",
        "SOURCE-NOTICE": source_root / "wildbuzzard" / "SOURCE-NOTICE",
    }


def verify_file(path, expected):
    if path.is_symlink() or not path.is_file():
        raise ValidationError(f"required legal file is missing or unsafe: {path}")
    if expected.is_symlink() or not expected.is_file():
        raise ValidationError(f"legal source file is missing or unsafe: {expected}")
    if path.read_bytes() != expected.read_bytes():
        raise ValidationError(f"legal file differs from its source: {path}")


def verify_payload(source_root, browser_root, documentation_root=None):
    expected = expected_payloads(source_root)
    for name, source in expected.items():
        verify_file(browser_root / "notices" / name, source)
    if documentation_root is not None:
        documentation_names = {
            "COPYING": "COPYING",
            "LICENSE": "LICENSE",
            "MOZILLA-MCP-LICENSE": "MOZILLA-MCP-LICENSE",
            "cli-NOTICE": "NOTICE",
            "SOURCE-NOTICE": "SOURCE-NOTICE",
        }
        for destination, source_name in documentation_names.items():
            verify_file(documentation_root / destination, expected[source_name])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-root", required=True, type=Path)
    parser.add_argument("--browser-root", required=True, type=Path)
    parser.add_argument("--documentation-root", type=Path)
    arguments = parser.parse_args()
    try:
        verify_payload(
            arguments.source_root.resolve(strict=True),
            arguments.browser_root.resolve(strict=True),
            arguments.documentation_root.resolve(strict=True)
            if arguments.documentation_root
            else None,
        )
    except ValidationError as error:
        raise SystemExit(str(error)) from error


if __name__ == "__main__":
    main()
