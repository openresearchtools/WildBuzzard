#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later

import argparse
import hashlib
import json
import re
import zipfile
from pathlib import Path, PurePosixPath

EXPECTED_IDS = {
    "torrent-search@extensions.wildbuzzard",
    "web-search@extensions.wildbuzzard",
}
SHA256 = re.compile(r"[0-9a-f]{64}")
VERSION = re.compile(r"[0-9]+(?:\.[0-9]+){1,3}")


class ValidationError(Exception):
    pass


def exact_keys(value, keys):
    return isinstance(value, dict) and set(value) == set(keys)


def load_pins(path):
    if path.is_symlink() or not path.is_file():
        raise ValidationError(f"pin file is not a regular file: {path}")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValidationError(f"invalid pin file: {path}") from error
    if (
        not exact_keys(value, {"extensions", "hashAlgorithm", "schema"})
        or value["schema"] != 1
        or value["hashAlgorithm"] != "sha256"
        or not isinstance(value["extensions"], list)
    ):
        raise ValidationError("invalid XPI pin policy")
    pins = {}
    for entry in value["extensions"]:
        if (
            not exact_keys(entry, {"extensionId", "sha256", "version"})
            or not isinstance(entry["extensionId"], str)
            or not isinstance(entry["sha256"], str)
            or not isinstance(entry["version"], str)
            or not SHA256.fullmatch(entry["sha256"])
            or not VERSION.fullmatch(entry["version"])
            or entry["extensionId"] in pins
        ):
            raise ValidationError("invalid or duplicate XPI pin")
        pins[entry["extensionId"]] = entry
    if set(pins) != EXPECTED_IDS:
        raise ValidationError("XPI pins must contain exactly the two extensions")
    return pins


def file_digest(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def load_xpi(path):
    if path.is_symlink() or not path.is_file():
        raise ValidationError(f"XPI is not a regular file: {path}")
    try:
        with zipfile.ZipFile(path) as archive:
            names = archive.namelist()
            if len(names) != len(set(names)) or "manifest.json" not in names:
                raise ValidationError(f"invalid XPI members: {path.name}")
            for name in names:
                parts = PurePosixPath(name).parts
                if (
                    not name
                    or name.startswith(("/", "\\"))
                    or "\\" in name
                    or any(part in {"", ".", ".."} for part in parts)
                ):
                    raise ValidationError(f"unsafe XPI member: {name}")
            manifest = json.loads(archive.read("manifest.json"))
    except (json.JSONDecodeError, KeyError, OSError, zipfile.BadZipFile) as error:
        raise ValidationError(f"invalid XPI: {path.name}") from error
    try:
        extension_id = manifest["browser_specific_settings"]["gecko"]["id"]
        version = manifest["version"]
    except (KeyError, TypeError) as error:
        raise ValidationError(f"XPI lacks a fixed identity: {path.name}") from error
    return extension_id, version, file_digest(path)


def verify(pins_path, xpi_paths):
    pins = load_pins(pins_path)
    actual = {}
    for path in xpi_paths:
        extension_id, version, digest = load_xpi(path)
        if extension_id in actual:
            raise ValidationError(f"duplicate XPI identity: {extension_id}")
        actual[extension_id] = {"sha256": digest, "version": version}
    if set(actual) != set(pins):
        raise ValidationError(
            "XPI artifacts must contain exactly the pinned identities"
        )
    for extension_id, pin in pins.items():
        if actual[extension_id] != {
            "sha256": pin["sha256"],
            "version": pin["version"],
        }:
            raise ValidationError(f"XPI does not match its browser pin: {extension_id}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pins", required=True, type=Path)
    parser.add_argument("--xpi", action="append", required=True, type=Path)
    arguments = parser.parse_args()
    try:
        verify(arguments.pins, arguments.xpi)
    except ValidationError as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
