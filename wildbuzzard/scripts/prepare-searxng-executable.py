#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import stat
import zipfile
from pathlib import Path, PurePosixPath


RUNTIME_ARCHIVE_SHA256 = (
    "12120e882ca48b673e2901da6b76f3d9616063aed96b11b92cdc2dac5c9a426a"
)
RUNTIME_ARCHIVE_SIZE = 167122419
RUNTIME_VERSION = "2026.8.6+b023a28ba"
UPSTREAM_COMMIT = "b023a28bab8839dba9eac96e9a51cc91bbd0a267"
SOURCE_DATE_EPOCH = 1786030997
MAX_RUNTIME_BYTES = 2 * 1024 * 1024 * 1024


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def safe_relative(value: str) -> PurePosixPath:
    path = PurePosixPath(value)
    if (
        path.is_absolute()
        or not path.parts
        or any(part in ("", ".", "..") for part in path.parts)
    ):
        raise RuntimeError(f"unsafe runtime path: {value}")
    return path


def read_archive_manifest(archive: zipfile.ZipFile) -> dict[str, object]:
    try:
        value = json.loads(archive.read("wildbuzzard-runtime.json"))
    except (KeyError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError("invalid base runtime manifest") from error
    if not isinstance(value, dict):
        raise RuntimeError("invalid base runtime manifest")
    return value


def extract_runtime(archive_path: Path, runtime_root: Path) -> dict[str, object]:
    status = os.stat(archive_path, follow_symlinks=False)
    if (
        not stat.S_ISREG(status.st_mode)
        or status.st_size != RUNTIME_ARCHIVE_SIZE
        or sha256_file(archive_path) != RUNTIME_ARCHIVE_SHA256
    ):
        raise RuntimeError("base SearXNG runtime archive identity mismatch")
    runtime_root.mkdir(mode=0o755, parents=True)
    with zipfile.ZipFile(archive_path, "r", allowZip64=False) as archive:
        manifest = read_archive_manifest(archive)
        files = manifest.get("files")
        if (
            manifest.get("schema") != 1
            or manifest.get("component") != "searxng"
            or manifest.get("runtimeVersion") != RUNTIME_VERSION
            or manifest.get("upstreamCommit") != UPSTREAM_COMMIT
            or not isinstance(files, list)
            or len(files) != 7042
        ):
            raise RuntimeError("base SearXNG runtime manifest identity mismatch")
        expected: dict[str, tuple[int, str]] = {}
        for entry in files:
            if not isinstance(entry, dict) or set(entry) != {"path", "size", "sha256"}:
                raise RuntimeError("invalid base runtime inventory")
            relative = entry.get("path")
            size = entry.get("size")
            digest = entry.get("sha256")
            if (
                not isinstance(relative, str)
                or not isinstance(size, int)
                or isinstance(size, bool)
                or size < 0
                or not isinstance(digest, str)
                or len(digest) != 64
                or relative in expected
            ):
                raise RuntimeError("invalid base runtime file identity")
            safe_relative(relative)
            expected[relative] = (size, digest)
        infos = archive.infolist()
        if len(infos) != len(expected) + 1:
            raise RuntimeError("base runtime ZIP entry count mismatch")
        names: set[str] = set()
        for info in infos:
            relative = safe_relative(info.filename)
            mode = info.external_attr >> 16
            if (
                info.filename in names
                or info.create_system != 3
                or info.flag_bits != 0
                or info.compress_type != zipfile.ZIP_STORED
                or info.is_dir()
                or mode not in (0o100644, 0o100755)
                or info.extra
                or info.comment
            ):
                raise RuntimeError(
                    f"unsupported base runtime ZIP entry: {info.filename}"
                )
            names.add(info.filename)
            target = runtime_root.joinpath(*relative.parts)
            target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
            digest = hashlib.sha256()
            size = 0
            descriptor = os.open(
                target,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW,
                stat.S_IMODE(mode),
            )
            with os.fdopen(descriptor, "wb") as output, archive.open(
                info, "r"
            ) as source:
                while block := source.read(1024 * 1024):
                    output.write(block)
                    digest.update(block)
                    size += len(block)
            os.utime(
                target, (SOURCE_DATE_EPOCH, SOURCE_DATE_EPOCH), follow_symlinks=False
            )
            if info.filename == "wildbuzzard-runtime.json":
                continue
            if expected.get(info.filename) != (size, digest.hexdigest()):
                raise RuntimeError(f"base runtime payload mismatch: {info.filename}")
        if names != set(expected) | {"wildbuzzard-runtime.json"}:
            raise RuntimeError("base runtime ZIP inventory mismatch")
    return manifest


def copy_file(source: Path, target: Path, mode: int) -> None:
    target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    shutil.copyfile(source, target)
    target.chmod(mode)
    os.utime(target, (SOURCE_DATE_EPOCH, SOURCE_DATE_EPOCH), follow_symlinks=False)


def inventory(runtime_root: Path) -> tuple[list[dict[str, object]], int]:
    result: list[dict[str, object]] = []
    total = 0
    manifest_path = runtime_root / "wildbuzzard-executable.json"
    for path in sorted(runtime_root.rglob("*")):
        if path.is_symlink() or (not path.is_dir() and not path.is_file()):
            raise RuntimeError(f"unexpected executable payload type: {path}")
        if not path.is_file() or path == manifest_path:
            continue
        relative = path.relative_to(runtime_root).as_posix()
        size = path.stat().st_size
        total += size
        result.append({"path": relative, "size": size, "sha256": sha256_file(path)})
    if total >= MAX_RUNTIME_BYTES:
        raise RuntimeError("SearXNG executable unpacked payload exceeds 2 GiB")
    return result, total


def prepare(args: argparse.Namespace) -> dict[str, object]:
    if args.app_dir.exists():
        raise RuntimeError(f"AppDir already exists: {args.app_dir}")
    runtime_root = args.app_dir / "usr" / "lib" / "wildbuzzard-searxng"
    base_manifest = extract_runtime(args.runtime_archive, runtime_root)
    metadata = runtime_root / "share" / "wildbuzzard" / "searxng"
    (runtime_root / "bin" / "searxng-service").unlink()
    (runtime_root / "libexec" / "searxng_service.py").unlink()
    os.replace(
        runtime_root / "wildbuzzard-runtime.json",
        metadata / "base-runtime-manifest.json",
    )
    copy_file(args.catalog, metadata / "engine-catalog.json", 0o644)
    copy_file(
        args.launcher_root / "searxng_executable.py",
        runtime_root / "libexec" / "searxng_executable.py",
        0o644,
    )
    copy_file(args.launcher_root / "AppRun", args.app_dir / "AppRun", 0o755)
    copy_file(
        args.launcher_root / "wildbuzzard-searxng.desktop",
        args.app_dir / "wildbuzzard-searxng.desktop",
        0o644,
    )
    copy_file(
        args.launcher_root / "wildbuzzard-searxng.svg",
        args.app_dir / "wildbuzzard-searxng.svg",
        0o644,
    )
    catalog = json.loads(args.catalog.read_text(encoding="utf-8"))
    files, unpacked = inventory(runtime_root)
    manifest = {
        "schema": 1,
        "component": "wildbuzzard-searxng-executable",
        "runtimeVersion": RUNTIME_VERSION,
        "upstreamCommit": UPSTREAM_COMMIT,
        "upstreamTree": "d2dc5354fe2281abd59f6734851bd586e6806631",
        "upstreamSourceArchiveSha256": "f5ab68baa420f26ac0d6b3fed1a8e5754bbe1fd31357c41271449980d3df779e",
        "baseRuntimeArchiveSha256": RUNTIME_ARCHIVE_SHA256,
        "baseRuntimeArchiveBytes": RUNTIME_ARCHIVE_SIZE,
        "baseRuntimeManifestSha256": sha256_file(
            metadata / "base-runtime-manifest.json"
        ),
        "engineCatalogSha256": sha256_file(metadata / "engine-catalog.json"),
        "engineCounts": catalog["counts"],
        "sbomSha256": sha256_file(metadata / "sbom.cdx.json"),
        "dependencyLockSha256": base_manifest["dependencyLockSha256"],
        "nativeSourcesLockSha256": base_manifest["nativeSourcesLockSha256"],
        "toolchainLockSha256": base_manifest["toolchainLockSha256"],
        "appImageTool": {
            "version": "5735cc5",
            "sha256": args.appimagetool_sha256,
        },
        "appImageRuntime": {
            "version": "5735cc5",
            "sha256": args.appimage_runtime_sha256,
        },
        "squashfsCompression": "xz",
        "transport": {
            "kind": "unix-domain-socket",
            "directoryMode": "0700",
            "socketMode": "0600",
            "tcpListeners": 0,
        },
        "unpackedBytes": unpacked,
        "files": files,
    }
    (runtime_root / "wildbuzzard-executable.json").write_text(
        json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    os.utime(
        runtime_root / "wildbuzzard-executable.json",
        (SOURCE_DATE_EPOCH, SOURCE_DATE_EPOCH),
        follow_symlinks=False,
    )
    for path in sorted(args.app_dir.rglob("*"), reverse=True):
        if path.is_dir():
            os.utime(
                path, (SOURCE_DATE_EPOCH, SOURCE_DATE_EPOCH), follow_symlinks=False
            )
    os.utime(
        args.app_dir, (SOURCE_DATE_EPOCH, SOURCE_DATE_EPOCH), follow_symlinks=False
    )
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime-archive", required=True, type=Path)
    parser.add_argument("--catalog", required=True, type=Path)
    parser.add_argument("--launcher-root", required=True, type=Path)
    parser.add_argument("--app-dir", required=True, type=Path)
    parser.add_argument("--appimagetool-sha256", required=True)
    parser.add_argument("--appimage-runtime-sha256", required=True)
    args = parser.parse_args()
    manifest = prepare(args)
    print(
        json.dumps(
            {
                "files": len(manifest["files"]),
                "unpackedBytes": manifest["unpackedBytes"],
                "engineCounts": manifest["engineCounts"],
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
