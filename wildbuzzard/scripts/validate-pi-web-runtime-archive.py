#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later

import argparse
import base64
import binascii
import importlib.util
import json
import re
import sys
import zipfile
from pathlib import Path

MANIFEST = "wildbuzzard-runtime.json"
MAX_MANIFEST_SIZE = 2 * 1024 * 1024
SHA256 = re.compile(r"^[a-f0-9]{64}$")
SHA512_INTEGRITY = re.compile(r"^sha512-[A-Za-z0-9+/]+={0,2}$")


class ValidationError(ValueError):
    pass


def load_archive_verifier():
    path = Path(__file__).with_name("runtime-archive-manifest.py")
    spec = importlib.util.spec_from_file_location("runtime_archive_manifest", path)
    if spec is None or spec.loader is None:
        raise ValidationError("Pi Web runtime verifier is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_json(path: Path, label: str):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValidationError(f"invalid {label}") from error


def valid_integrity(value):
    if not isinstance(value, str) or not SHA512_INTEGRITY.fullmatch(value):
        return False
    try:
        return len(base64.b64decode(value.removeprefix("sha512-"), validate=True)) == 64
    except (binascii.Error, ValueError):
        return False


def validate_inventory(value, lock):
    if (
        not isinstance(value, dict)
        or value.get("schema") != 1
        or value.get("piWebCommit") != lock["piWeb"]["commit"]
        or value.get("packageLockSha256") != lock["piWeb"]["packageLockSha256"]
        or not isinstance(value.get("packages"), list)
    ):
        raise ValidationError("Pi Web runtime dependency inventory differs from lock")
    pinned_versions = lock.get("piPackages")
    if not isinstance(pinned_versions, dict):
        raise ValidationError("invalid Pi package pins")
    found = set()
    for package in value["packages"]:
        if not isinstance(package, dict):
            raise ValidationError("invalid Pi Web runtime dependency")
        name = package.get("name")
        version = package.get("version")
        resolved = package.get("resolved")
        integrity = package.get("integrity")
        if (
            not isinstance(name, str)
            or not name
            or not isinstance(version, str)
            or not version
            or not SHA256.fullmatch(str(package.get("manifestSha256", "")))
        ):
            raise ValidationError("invalid Pi Web runtime dependency")
        if resolved is not None and (
            not isinstance(resolved, str)
            or not resolved.startswith("https://registry.npmjs.org/")
            or not valid_integrity(integrity)
        ):
            raise ValidationError("untrusted Pi Web runtime dependency")
        if pinned_versions.get(name) == version:
            found.add(name)
    if found != set(pinned_versions):
        raise ValidationError("Pi Web runtime omits a pinned Pi package")


def validate(archive_path: Path, lock_path: Path):
    lock = load_json(lock_path, "Pi Web runtime lock")
    pi_web = lock.get("piWeb")
    node = lock.get("node")
    if (
        lock.get("schema") != 1
        or lock.get("platform") != "linux-x64"
        or not isinstance(pi_web, dict)
        or not isinstance(node, dict)
    ):
        raise ValidationError("invalid Pi Web runtime lock")
    try:
        load_archive_verifier().verify(archive_path)
        with zipfile.ZipFile(archive_path) as archive:
            entries = [
                entry for entry in archive.infolist() if entry.filename == MANIFEST
            ]
            if (
                len(entries) != 1
                or entries[0].is_dir()
                or entries[0].file_size < 2
                or entries[0].file_size > MAX_MANIFEST_SIZE
            ):
                raise ValidationError("invalid Pi Web runtime manifest entry")
            manifest = json.loads(archive.read(entries[0]))
            expected = {
                "component": "pi-web",
                "dependencyLockSha256": pi_web["packageLockSha256"],
                "nodeArchiveSha256": node["sha256"],
                "nodeVersion": node["version"],
                "piWebCommit": pi_web["commit"],
                "piWebRepository": pi_web["repository"],
                "piWebTree": pi_web["tree"],
                "platform": lock["platform"],
                "version": pi_web["version"],
            }
            for field, expected_value in expected.items():
                if manifest.get(field) != expected_value:
                    raise ValidationError(f"Pi Web runtime pin differs: {field}")
            inventory_path = manifest.get("runtimeDependencyInventory")
            if not isinstance(inventory_path, str):
                raise ValidationError("Pi Web runtime dependency inventory is absent")
            validate_inventory(json.loads(archive.read(inventory_path)), lock)
            return manifest
    except ValidationError:
        raise
    except (
        KeyError,
        OSError,
        UnicodeDecodeError,
        json.JSONDecodeError,
        zipfile.BadZipFile,
        ValueError,
    ) as error:
        raise ValidationError("invalid Pi Web runtime archive") from error


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("archive", type=Path)
    parser.add_argument("--lock", required=True, type=Path)
    args = parser.parse_args()
    try:
        validate(args.archive, args.lock)
    except ValidationError as error:
        print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
