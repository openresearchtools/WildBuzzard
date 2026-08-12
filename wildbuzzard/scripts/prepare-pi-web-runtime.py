#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later

import argparse
import hashlib
import os
import stat
from pathlib import Path

NODE_PTY_METADATA = (
    "build/Makefile",
    "build/binding.Makefile",
    "build/config.gypi",
    "build/pty.target.mk",
    "node-addon-api/node_addon_api.Makefile",
    "node-addon-api/node_addon_api.target.mk",
    "node-addon-api/node_addon_api_except.target.mk",
    "node-addon-api/node_addon_api_maybe.target.mk",
)


def require_regular(path):
    try:
        info = path.lstat()
    except FileNotFoundError as error:
        raise ValueError(f"required regular file is missing: {path}") from error
    if not stat.S_ISREG(info.st_mode):
        raise ValueError(f"required path is not a regular file: {path}")


def file_sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def node_pty_binary(root):
    return root / "node_modules" / "node-pty" / "build" / "Release" / "pty.node"


def normalize_node_pty(root):
    node_pty = root / "node_modules" / "node-pty"
    binary = node_pty_binary(root)
    require_regular(binary)
    expected = file_sha256(binary)
    for relative in NODE_PTY_METADATA:
        path = node_pty / relative
        require_regular(path)
        path.unlink()
    (node_pty / "node-addon-api").rmdir()
    verify_node_pty(root, expected)
    return expected


def verify_node_pty(root, expected):
    if not isinstance(expected, str) or len(expected) != 64:
        raise ValueError("invalid node-pty SHA256")
    binary = node_pty_binary(root)
    require_regular(binary)
    if file_sha256(binary) != expected:
        raise ValueError(
            "Packaged Pi Web node-pty native runtime differs from the verified build"
        )


def path_leaks(runtime, roots):
    needles = []
    for root in roots:
        needle = os.fsencode(os.path.realpath(root))
        if not os.path.isabs(os.fsdecode(needle)):
            raise ValueError(f"path-leak root is not absolute: {root}")
        if needle not in needles:
            needles.append(needle)
    leaks = []
    overlap_size = max(map(len, needles), default=1) - 1
    for path in sorted(runtime.rglob("*")):
        if not stat.S_ISREG(path.lstat().st_mode):
            continue
        with path.open("rb") as source:
            overlap = b""
            while chunk := source.read(1024 * 1024):
                value = overlap + chunk
                if any(needle in value for needle in needles):
                    leaks.append(path.relative_to(runtime).as_posix())
                    break
                overlap = value[-overlap_size:] if overlap_size else b""
    return leaks


def reject_path_leaks(runtime, roots):
    leaks = path_leaks(runtime, roots)
    if leaks:
        raise ValueError(
            "Pi Web runtime contains absolute build-path leakage: " + ", ".join(leaks)
        )


def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    normalize = commands.add_parser("normalize-node-pty")
    normalize.add_argument("root", type=Path)
    verify = commands.add_parser("verify-node-pty")
    verify.add_argument("root", type=Path)
    verify.add_argument("sha256")
    paths = commands.add_parser("reject-path-leaks")
    paths.add_argument("runtime", type=Path)
    paths.add_argument("roots", nargs="+")
    arguments = parser.parse_args()
    if arguments.command == "normalize-node-pty":
        print(normalize_node_pty(arguments.root))
    elif arguments.command == "verify-node-pty":
        verify_node_pty(arguments.root, arguments.sha256)
    else:
        reject_path_leaks(arguments.runtime, arguments.roots)


if __name__ == "__main__":
    main()
