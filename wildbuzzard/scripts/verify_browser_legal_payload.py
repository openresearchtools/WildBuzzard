#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later

import argparse
import configparser
import json
from pathlib import Path


class ValidationError(Exception):
    pass


EXPECTED_APP_IDENTITY = {
    "Vendor": "WildBuzzard",
    "Name": "WildBuzzard",
    "RemotingName": "org.wildbuzzard.WildBuzzard",
    "ID": "{648cc8ea-a8a6-59ec-b7e7-3ddc7e685961}",
}


def expected_payloads(source_root):
    return {
        "BLOCKER-ASSET-SOURCE-NOTICE": source_root
        / "wildbuzzard"
        / "BLOCKER-ASSET-SOURCE-NOTICE",
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


def tor_payloads(source_root):
    legal_root = source_root / "wildbuzzard" / "third_party" / "tor-notices"
    inventory_path = legal_root / "THIRD-PARTY.json"
    inventory = json.loads(inventory_path.read_text())
    payloads = {"THIRD-PARTY.json": inventory_path}
    for package in inventory["packages"]:
        for license_file in package["licenseFiles"]:
            relative = license_file["installedPath"]
            payloads[relative] = legal_root / relative
    return payloads


def verify_exact_tree(root, expected):
    if root.is_symlink() or not root.is_dir():
        raise ValidationError(f"required legal directory is missing or unsafe: {root}")
    actual = set()
    for path in root.rglob("*"):
        if path.is_symlink() or (not path.is_dir() and not path.is_file()):
            raise ValidationError(f"unsafe legal payload entry: {path}")
        if path.is_file():
            actual.add(path.relative_to(root).as_posix())
    if actual != set(expected):
        raise ValidationError(f"legal directory has missing or extra files: {root}")
    for relative, source in expected.items():
        verify_file(root / relative, source)


def verify_browser_identity(browser_root):
    application_ini = browser_root / "application.ini"
    if application_ini.is_symlink() or not application_ini.is_file():
        raise ValidationError(
            f"required application identity is missing or unsafe: {application_ini}"
        )
    parser = configparser.ConfigParser(interpolation=None, strict=True)
    try:
        with application_ini.open(encoding="utf-8") as source:
            parser.read_file(source)
    except (configparser.Error, OSError, UnicodeError) as error:
        raise ValidationError(
            f"invalid application identity: {application_ini}"
        ) from error
    if not parser.has_section("App"):
        raise ValidationError("application identity lacks the App section")
    for key, expected in EXPECTED_APP_IDENTITY.items():
        if parser.get("App", key, fallback=None) != expected:
            raise ValidationError(f"application identity has an invalid {key}")
    if parser.has_option("App", "Profile"):
        raise ValidationError("application identity must use XDG product directories")
    if parser.has_option("XRE", "EnableProfileMigrator"):
        raise ValidationError("application identity enables profile migration")
    for forbidden_section in ("AppUpdate", "Crash Reporter"):
        if parser.has_section(forbidden_section):
            raise ValidationError(
                f"application identity contains forbidden {forbidden_section} metadata"
            )


def verify_payload(source_root, browser_root, documentation_root=None):
    verify_browser_identity(browser_root)
    expected = expected_payloads(source_root)
    for name, source in expected.items():
        verify_file(browser_root / "notices" / name, source)
    tor = tor_payloads(source_root)
    verify_exact_tree(browser_root / "notices" / "tor-notices", tor)
    blocker = {
        "SOURCES.lock.json": source_root
        / "browser"
        / "components"
        / "blocker"
        / "assets"
        / "SOURCES.lock.json"
    }
    verify_exact_tree(browser_root / "notices" / "blocker", blocker)
    if documentation_root is not None:
        documentation_names = {
            "BLOCKER-ASSET-SOURCE-NOTICE": "BLOCKER-ASSET-SOURCE-NOTICE",
            "COPYING": "COPYING",
            "LICENSE": "LICENSE",
            "MOZILLA-MCP-LICENSE": "MOZILLA-MCP-LICENSE",
            "cli-NOTICE": "NOTICE",
            "SOURCE-NOTICE": "SOURCE-NOTICE",
        }
        for destination, source_name in documentation_names.items():
            verify_file(documentation_root / destination, expected[source_name])
        verify_exact_tree(documentation_root / "tor-third-party", tor)
        verify_exact_tree(documentation_root / "blocker", blocker)


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
