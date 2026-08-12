#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import shutil
import stat
import subprocess
import tempfile
from typing import BinaryIO


EXPECTED_LOCK_FIELDS = {
    "schema",
    "artifact",
    "artifactBytes",
    "artifactSha256",
    "mode",
    "runtimeVersion",
    "upstreamCommit",
    "engineCatalogSha256",
    "engineCounts",
    "baseRuntimeArchiveSha256",
    "appImageToolSha256",
    "appImageRuntimeSha256",
}
EXPECTED_COUNTS = {
    "totalEntries": 343,
    "totalModules": 222,
    "eligibleEntries": 332,
    "eligibleModules": 211,
    "credentialRequiredEntries": 11,
    "credentialRequiredModules": 11,
    "eligibleUpstreamInactiveEntries": 56,
}
DEFAULT_LOCK = (
    pathlib.Path(__file__).resolve().parents[1]
    / "third_party/agpl/searxng/executable-artifact.lock.json"
)


def strict_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON field: {key}")
        result[key] = value
    return result


def read_lock(path: pathlib.Path = DEFAULT_LOCK) -> dict[str, object]:
    value = json.loads(
        path.read_text(encoding="utf-8"),
        object_pairs_hook=strict_object,
        parse_constant=lambda item: (_ for _ in ()).throw(ValueError(item)),
    )
    if (
        not isinstance(value, dict)
        or set(value) != EXPECTED_LOCK_FIELDS
        or value.get("schema") != 1
        or value.get("mode") != "0755"
        or value.get("runtimeVersion") != "2026.8.6+b023a28ba"
        or value.get("upstreamCommit") != "b023a28bab8839dba9eac96e9a51cc91bbd0a267"
        or value.get("engineCatalogSha256")
        != "7d054c87f25e2925f71c1a12fdff6973ffc735e2cfff71df744d2d3b14d786f1"
        or value.get("engineCounts") != EXPECTED_COUNTS
        or not isinstance(value.get("artifact"), str)
        or not isinstance(value.get("artifactBytes"), int)
        or isinstance(value.get("artifactBytes"), bool)
        or not isinstance(value.get("artifactSha256"), str)
    ):
        raise RuntimeError("invalid SearXNG executable lock")
    return value


def open_source(path: pathlib.Path, lock: dict[str, object]) -> BinaryIO:
    status = os.lstat(path)
    if (
        not stat.S_ISREG(status.st_mode)
        or stat.S_IMODE(status.st_mode) != 0o755
        or path.name != lock["artifact"]
    ):
        raise RuntimeError("invalid SearXNG executable type, mode, or name")
    descriptor = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    stream = os.fdopen(descriptor, "rb")
    opened = os.fstat(descriptor)
    if (
        not stat.S_ISREG(opened.st_mode)
        or stat.S_IMODE(opened.st_mode) != 0o755
        or opened.st_dev != status.st_dev
        or opened.st_ino != status.st_ino
        or opened.st_size != lock["artifactBytes"]
    ):
        stream.close()
        raise RuntimeError("SearXNG executable changed while opening")
    return stream


def copy_and_hash(source: BinaryIO, target: BinaryIO) -> str:
    digest = hashlib.sha256()
    while block := source.read(1024 * 1024):
        digest.update(block)
        target.write(block)
    return digest.hexdigest()


def validate_catalog(artifact: pathlib.Path, temporary_root: pathlib.Path) -> None:
    environment = {
        "APPIMAGE_EXTRACT_AND_RUN": "1",
        "HOME": str(temporary_root),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "PATH": "/usr/bin:/bin",
        "TMPDIR": str(temporary_root),
        "TZ": "UTC",
    }
    result = subprocess.run(
        [str(artifact), "catalog"],
        check=False,
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=90,
    )
    if (
        result.returncode != 0
        or result.stderr
        or result.stdout != '{"eligibleEntries": 332, "eligibleModules": 211}\n'
    ):
        raise RuntimeError("embedded SearXNG executable identity check failed")
    residue = list(temporary_root.glob("appimage_extracted_*"))
    if residue:
        raise RuntimeError(f"SearXNG executable left extraction residue: {residue}")


def snapshot(
    source_path: pathlib.Path,
    target_path: pathlib.Path,
    lock: dict[str, object],
) -> None:
    with open_source(source_path, lock) as source, target_path.open("xb") as target:
        digest = copy_and_hash(source, target)
        target.flush()
        os.fsync(target.fileno())
    target_path.chmod(0o755)
    if digest != lock["artifactSha256"]:
        raise RuntimeError("SearXNG executable digest mismatch")


def validate_executable(
    source: pathlib.Path | str,
    lock_path: pathlib.Path | str = DEFAULT_LOCK,
) -> dict[str, object]:
    source_path = pathlib.Path(source).absolute()
    lock = read_lock(pathlib.Path(lock_path))
    with tempfile.TemporaryDirectory(prefix="wildbuzzard-searxng-validator-") as root:
        temporary_root = pathlib.Path(root)
        artifact = temporary_root / str(lock["artifact"])
        snapshot(source_path, artifact, lock)
        validate_catalog(artifact, temporary_root)
    return lock


def validate_and_copy(
    source: pathlib.Path | str,
    destination: pathlib.Path | str,
    lock_path: pathlib.Path | str = DEFAULT_LOCK,
) -> dict[str, object]:
    source_path = pathlib.Path(source).absolute()
    destination_path = pathlib.Path(destination).absolute()
    lock = read_lock(pathlib.Path(lock_path))
    if destination_path.name != lock["artifact"]:
        raise RuntimeError("invalid packaged SearXNG executable name")
    destination_path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_value = tempfile.mkstemp(
        prefix=f".{destination_path.name}.", dir=destination_path.parent
    )
    os.close(descriptor)
    temporary_path = pathlib.Path(temporary_value)
    temporary_path.unlink()
    try:
        snapshot(source_path, temporary_path, lock)
        with tempfile.TemporaryDirectory(
            prefix="wildbuzzard-searxng-validator-"
        ) as root:
            validate_catalog(temporary_path, pathlib.Path(root))
        os.replace(temporary_path, destination_path)
        directory = os.open(destination_path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary_path.unlink(missing_ok=True)
    return lock


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("executable", type=pathlib.Path)
    parser.add_argument("--lock", type=pathlib.Path, default=DEFAULT_LOCK)
    parser.add_argument("--copy-to", type=pathlib.Path)
    args = parser.parse_args()
    if args.copy_to is None:
        lock = validate_executable(args.executable, args.lock)
    else:
        lock = validate_and_copy(args.executable, args.copy_to, args.lock)
    print(
        json.dumps(
            {
                "artifact": lock["artifact"],
                "artifactBytes": lock["artifactBytes"],
                "artifactSha256": lock["artifactSha256"],
                "engineCatalogSha256": lock["engineCatalogSha256"],
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
