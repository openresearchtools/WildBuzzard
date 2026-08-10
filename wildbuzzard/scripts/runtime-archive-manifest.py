#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later

import argparse
import hashlib
import json
import stat
import sys
import zipfile
from pathlib import Path, PurePosixPath

MANIFEST = "wildbuzzard-runtime.json"


def safe_path(value):
    path = PurePosixPath(value)
    return (
        value
        and not value.startswith("/")
        and "\\" not in value
        and all(part not in ("", ".", "..") for part in path.parts)
    )


def digest(data):
    return hashlib.sha256(data).hexdigest()


def build(root, metadata_path):
    metadata = json.loads(metadata_path.read_text())
    files = {}
    executables = []
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root).as_posix()
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode) or not (
            stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)
        ):
            raise ValueError(f"unsupported runtime entry: {relative}")
        if stat.S_ISREG(info.st_mode) and info.st_nlink != 1:
            raise ValueError(f"hardlinked runtime entry: {relative}")
        if not stat.S_ISREG(info.st_mode) or relative == MANIFEST:
            continue
        files[relative] = digest(path.read_bytes())
        if info.st_mode & 0o111:
            executables.append(relative)
    metadata.update({
        "schema": 4,
        "files": files,
        "executableAllowlist": executables,
    })
    (root / MANIFEST).write_text(json.dumps(metadata, indent=2, sort_keys=True) + "\n")


def validate_entries(entries):
    names = [entry.filename for entry in entries]
    if len(names) != len(set(names)):
        raise ValueError("duplicate archive path")
    for entry in entries:
        name = entry.filename.removesuffix("/")
        if not safe_path(name):
            raise ValueError(f"unsafe archive path: {entry.filename}")
        mode = entry.external_attr >> 16
        kind = stat.S_IFMT(mode)
        expected_kind = stat.S_IFDIR if entry.is_dir() else stat.S_IFREG
        if kind not in (0, expected_kind):
            raise ValueError(f"unsupported archive entry: {entry.filename}")


def structure(archive_path):
    with zipfile.ZipFile(archive_path) as archive:
        validate_entries(archive.infolist())


def verify(archive_path):
    with zipfile.ZipFile(archive_path) as archive:
        entries = archive.infolist()
        validate_entries(entries)
        manifest = json.loads(archive.read(MANIFEST))
        if manifest.get("schema") != 4:
            raise ValueError("invalid runtime manifest schema")
        files = manifest.get("files")
        executables = manifest.get("executableAllowlist")
        if not isinstance(files, dict) or not isinstance(executables, list):
            raise ValueError("invalid runtime manifest inventory")
        if (
            len(executables) != len(set(executables))
            or any(not safe_path(path) for path in files)
            or any(
                not isinstance(value, str)
                or len(value) != 64
                or any(character not in "0123456789abcdef" for character in value)
                for value in files.values()
            )
        ):
            raise ValueError("invalid runtime manifest inventory")
        source = manifest.get("correspondingSource")
        licenses = manifest.get("licenseLocations")
        if (
            source not in files
            or files[source] != manifest.get("sourceSha256")
            or not isinstance(licenses, list)
            or any(path not in files for path in licenses)
        ):
            raise ValueError("invalid runtime source metadata")
        expected = set(files) | {MANIFEST}
        actual = {entry.filename for entry in entries if not entry.is_dir()}
        if actual != expected:
            raise ValueError("runtime file inventory mismatch")
        if set(executables) - set(files):
            raise ValueError("invalid executable allowlist")
        for entry in entries:
            if entry.is_dir() or entry.filename == MANIFEST:
                continue
            if digest(archive.read(entry)) != files.get(entry.filename):
                raise ValueError(f"runtime digest mismatch: {entry.filename}")
            executable = bool((entry.external_attr >> 16) & 0o111)
            if executable != (entry.filename in executables):
                raise ValueError(f"runtime executable mismatch: {entry.filename}")


def main():
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    build_parser = subparsers.add_parser("build")
    build_parser.add_argument("root", type=Path)
    build_parser.add_argument("metadata", type=Path)
    verify_parser = subparsers.add_parser("verify")
    verify_parser.add_argument("archive", type=Path)
    structure_parser = subparsers.add_parser("structure")
    structure_parser.add_argument("archive", type=Path)
    args = parser.parse_args()
    try:
        if args.command == "build":
            build(args.root, args.metadata)
        elif args.command == "verify":
            verify(args.archive)
        else:
            structure(args.archive)
    except (
        OSError,
        ValueError,
        KeyError,
        json.JSONDecodeError,
        zipfile.BadZipFile,
    ) as error:
        print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
