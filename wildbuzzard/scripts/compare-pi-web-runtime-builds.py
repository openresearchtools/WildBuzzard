#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later

import argparse
import hashlib
import json
import sys
import tarfile
import zipfile
from pathlib import Path


def digest(data):
    return hashlib.sha256(data).hexdigest()


def load_record(path):
    value = json.loads(path.read_text(encoding="utf-8"))
    if (
        not isinstance(value, dict)
        or value.get("schema") != 1
        or set(value)
        != {
            "schema",
            "environment",
            "inputs",
            "runtimeArchive",
            "sourceArchive",
        }
    ):
        raise ValueError("invalid Pi Web build record")
    return value


def zip_inventory(path):
    result = []
    with zipfile.ZipFile(path) as archive:
        for entry in archive.infolist():
            result.append({
                "name": entry.filename,
                "dateTime": entry.date_time,
                "compression": entry.compress_type,
                "attributes": entry.external_attr,
                "createSystem": entry.create_system,
                "size": entry.file_size,
                "sha256": digest(archive.read(entry)),
            })
    return result


def tar_inventory(path):
    result = []
    with tarfile.open(path, "r:*") as archive:
        for entry in archive.getmembers():
            item = {
                "name": entry.name,
                "mode": entry.mode,
                "uid": entry.uid,
                "gid": entry.gid,
                "mtime": entry.mtime,
                "type": entry.type.decode("ascii"),
                "size": entry.size,
            }
            if entry.isfile():
                stream = archive.extractfile(entry)
                if stream is None:
                    raise ValueError(f"missing source member: {entry.name}")
                item["sha256"] = digest(stream.read())
            result.append(item)
    return result


def archive_path(record_path, record, key):
    value = record[key]
    if (
        not isinstance(value, dict)
        or set(value) != {"path", "sha256"}
        or Path(value["path"]).is_absolute()
        or ".." in Path(value["path"]).parts
        or not isinstance(value["sha256"], str)
    ):
        raise ValueError(f"invalid {key} build record")
    return record_path.parent / value["path"]


def compare(left_path, right_path):
    left = load_record(left_path)
    right = load_record(right_path)
    if left != right:
        raise ValueError("Pi Web build records differ")
    for key, inventory in (
        ("runtimeArchive", zip_inventory),
        ("sourceArchive", tar_inventory),
    ):
        left_archive = archive_path(left_path, left, key)
        right_archive = archive_path(right_path, right, key)
        left_bytes = left_archive.read_bytes()
        right_bytes = right_archive.read_bytes()
        if digest(left_bytes) != left[key]["sha256"]:
            raise ValueError(f"left {key} digest differs from its build record")
        if digest(right_bytes) != right[key]["sha256"]:
            raise ValueError(f"right {key} digest differs from its build record")
        if left_bytes != right_bytes:
            raise ValueError(f"Pi Web {key} bytes differ")
        if inventory(left_archive) != inventory(right_archive):
            raise ValueError(f"Pi Web {key} member metadata differs")
    with zipfile.ZipFile(archive_path(left_path, left, "runtimeArchive")) as archive:
        manifest = json.loads(archive.read("wildbuzzard-runtime.json"))
        build_inputs = manifest.get("buildInputs")
        if not isinstance(build_inputs, str) or build_inputs not in manifest.get(
            "files", {}
        ):
            raise ValueError("Pi Web runtime does not identify its build inputs")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("left", type=Path)
    parser.add_argument("right", type=Path)
    args = parser.parse_args()
    try:
        compare(args.left, args.right)
    except (
        OSError,
        ValueError,
        KeyError,
        json.JSONDecodeError,
        tarfile.TarError,
        zipfile.BadZipFile,
    ) as error:
        print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
