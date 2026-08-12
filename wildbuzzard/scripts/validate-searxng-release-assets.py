#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import re
import stat
import tempfile
from typing import BinaryIO


SHA256 = re.compile(r"^[0-9a-f]{64}$")
DEFAULT_LOCK = (
    pathlib.Path(__file__).resolve().parents[1]
    / "third_party/agpl/searxng/release-assets.lock.json"
)


def read_lock(path: pathlib.Path = DEFAULT_LOCK) -> dict[str, object]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or set(value) != {"schema", "source", "sbom"}:
        raise RuntimeError("invalid SearXNG release asset lock")
    if value["schema"] != 1:
        raise RuntimeError("invalid SearXNG release asset lock schema")
    for label in ("source", "sbom"):
        asset = value[label]
        if (
            not isinstance(asset, dict)
            or set(asset)
            != {
                "artifact",
                "artifactBytes",
                "artifactSha256",
                "mode",
            }
            or not isinstance(asset["artifact"], str)
            or pathlib.PurePath(asset["artifact"]).name != asset["artifact"]
            or not isinstance(asset["artifactBytes"], int)
            or isinstance(asset["artifactBytes"], bool)
            or asset["artifactBytes"] <= 0
            or not isinstance(asset["artifactSha256"], str)
            or not SHA256.fullmatch(asset["artifactSha256"])
            or asset["mode"] != "0644"
        ):
            raise RuntimeError(f"invalid SearXNG {label} asset lock")
    return value


def open_asset(path: pathlib.Path, asset: dict[str, object]) -> BinaryIO:
    status = os.lstat(path)
    if (
        not stat.S_ISREG(status.st_mode)
        or stat.S_IMODE(status.st_mode) != 0o644
        or status.st_nlink != 1
        or path.name != asset["artifact"]
    ):
        raise RuntimeError("invalid SearXNG release asset type, mode, or name")
    descriptor = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    stream = os.fdopen(descriptor, "rb")
    opened = os.fstat(descriptor)
    if (
        not stat.S_ISREG(opened.st_mode)
        or stat.S_IMODE(opened.st_mode) != 0o644
        or opened.st_nlink != 1
        or opened.st_dev != status.st_dev
        or opened.st_ino != status.st_ino
        or opened.st_size != asset["artifactBytes"]
    ):
        stream.close()
        raise RuntimeError("SearXNG release asset changed while opening")
    return stream


def copy_and_hash(source: BinaryIO, target: BinaryIO | None = None) -> str:
    digest = hashlib.sha256()
    while block := source.read(1024 * 1024):
        digest.update(block)
        if target is not None:
            target.write(block)
    return digest.hexdigest()


def validate_asset(path: pathlib.Path, asset: dict[str, object]) -> None:
    with open_asset(path, asset) as source:
        digest = copy_and_hash(source)
    if digest != asset["artifactSha256"]:
        raise RuntimeError("SearXNG release asset digest mismatch")


def validate_assets(
    source: pathlib.Path | str,
    sbom: pathlib.Path | str,
    lock_path: pathlib.Path | str = DEFAULT_LOCK,
) -> dict[str, object]:
    lock = read_lock(pathlib.Path(lock_path))
    validate_asset(pathlib.Path(source).absolute(), lock["source"])
    validate_asset(pathlib.Path(sbom).absolute(), lock["sbom"])
    return lock


def snapshot_asset(
    source_path: pathlib.Path,
    temporary_path: pathlib.Path,
    asset: dict[str, object],
) -> None:
    with open_asset(source_path, asset) as source, temporary_path.open("xb") as target:
        digest = copy_and_hash(source, target)
        target.flush()
        os.fsync(target.fileno())
    temporary_path.chmod(0o644)
    if digest != asset["artifactSha256"]:
        raise RuntimeError("SearXNG release asset digest mismatch")


def validate_and_stage(
    source: pathlib.Path | str,
    sbom: pathlib.Path | str,
    output_dir: pathlib.Path | str,
    lock_path: pathlib.Path | str = DEFAULT_LOCK,
) -> dict[str, object]:
    lock = read_lock(pathlib.Path(lock_path))
    output = pathlib.Path(output_dir).absolute()
    output.mkdir(parents=True, exist_ok=True)
    temporary_paths: list[pathlib.Path] = []
    destinations: list[tuple[pathlib.Path, pathlib.Path, dict[str, object]]] = []
    try:
        for label, source_value in (("source", source), ("sbom", sbom)):
            asset = lock[label]
            destination = output / str(asset["artifact"])
            descriptor, temporary_value = tempfile.mkstemp(
                prefix=f".{destination.name}.", dir=output
            )
            os.close(descriptor)
            temporary = pathlib.Path(temporary_value)
            temporary.unlink()
            temporary_paths.append(temporary)
            snapshot_asset(pathlib.Path(source_value).absolute(), temporary, asset)
            destinations.append((temporary, destination, asset))
        for temporary, destination, asset in destinations:
            os.replace(temporary, destination)
            checksum = output / f"{destination.name}.sha256"
            checksum.write_text(
                f"{asset['artifactSha256']}  {destination.name}\n", encoding="utf-8"
            )
        directory = os.open(output, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        for temporary in temporary_paths:
            temporary.unlink(missing_ok=True)
    return lock


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=pathlib.Path)
    parser.add_argument("--sbom", required=True, type=pathlib.Path)
    parser.add_argument("--lock", default=DEFAULT_LOCK, type=pathlib.Path)
    parser.add_argument("--output-dir", type=pathlib.Path)
    args = parser.parse_args()
    if args.output_dir is None:
        lock = validate_assets(args.source, args.sbom, args.lock)
    else:
        lock = validate_and_stage(args.source, args.sbom, args.output_dir, args.lock)
    print(
        json.dumps(
            {
                label: {
                    "artifact": lock[label]["artifact"],
                    "artifactBytes": lock[label]["artifactBytes"],
                    "artifactSha256": lock[label]["artifactSha256"],
                }
                for label in ("source", "sbom")
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
