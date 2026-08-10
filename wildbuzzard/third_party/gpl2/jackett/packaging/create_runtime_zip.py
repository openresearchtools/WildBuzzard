#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-only

import argparse
import os
import stat
import unicodedata
import zipfile
from pathlib import Path, PurePosixPath


def inventory(root):
    files = []
    seen_inodes = set()
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root).as_posix()
        parts = PurePosixPath(relative).parts
        if (
            not relative
            or unicodedata.normalize("NFC", relative) != relative
            or any(
                ord(character) < 32 or ord(character) == 127 for character in relative
            )
            or any(part in ("", ".", "..") for part in parts)
        ):
            raise ValueError(f"unsafe archive path: {relative}")
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode) or not (
            stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)
        ):
            raise ValueError(f"link or special archive entry: {relative}")
        if stat.S_ISREG(info.st_mode):
            inode = (info.st_dev, info.st_ino)
            if info.st_nlink != 1 or inode in seen_inodes:
                raise ValueError(f"hard-linked archive entry: {relative}")
            seen_inodes.add(inode)
            files.append((relative, path, bool(info.st_mode & 0o111)))
    return files


def create_zip(root, output, epoch):
    timestamp = tuple(__import__("time").gmtime(max(epoch, 315532800))[:6])
    files = inventory(root)
    names = [name for name, _, _ in files]
    if len(names) != len(set(names)):
        raise ValueError("duplicate archive path")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(output.name + ".tmp")
    with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_STORED) as archive:
        for name, path, executable in files:
            entry = zipfile.ZipInfo(name, timestamp)
            entry.create_system = 3
            entry.external_attr = (0o100755 if executable else 0o100644) << 16
            entry.compress_type = zipfile.ZIP_STORED
            entry.flag_bits = 0x800
            with path.open("rb") as source, archive.open(entry, "w") as target:
                for chunk in iter(lambda: source.read(1024 * 1024), b""):
                    target.write(chunk)
    os.replace(temporary, output)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--source-date-epoch", type=int, required=True)
    args = parser.parse_args()
    create_zip(args.runtime.resolve(), args.output.resolve(), args.source_date_epoch)


if __name__ == "__main__":
    main()
