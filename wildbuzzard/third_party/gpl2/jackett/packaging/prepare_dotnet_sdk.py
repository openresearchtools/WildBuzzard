#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-only

import argparse
import hashlib
import json
import os
import pathlib
import shutil
import stat
import tarfile
import tempfile
import urllib.request

LOCK_FIELDS = {
    "archive",
    "architecture",
    "releaseMetadata",
    "rid",
    "schemaVersion",
    "sha512",
    "size",
    "url",
    "version",
}
MAX_ENTRIES = 20_000
MAX_EXPANDED_BYTES = 2 * 1024 * 1024 * 1024


def sha512_file(path):
    digest = hashlib.sha512()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def load_lock(path):
    value = json.loads(path.read_text(encoding="utf-8"))
    if (
        not isinstance(value, dict)
        or set(value) != LOCK_FIELDS
        or value.get("schemaVersion") != 1
        or value.get("rid") != "linux-x64"
        or value.get("architecture") != "x86_64"
        or not isinstance(value.get("version"), str)
        or not value["version"]
        or not isinstance(value.get("archive"), str)
        or pathlib.PurePosixPath(value["archive"]).name != value["archive"]
        or not isinstance(value.get("size"), int)
        or isinstance(value["size"], bool)
        or value["size"] <= 0
        or value["size"] > 512 * 1024 * 1024
        or not isinstance(value.get("sha512"), str)
        or len(value["sha512"]) != 128
        or any(character not in "0123456789abcdef" for character in value["sha512"])
        or not isinstance(value.get("url"), str)
        or not value["url"].startswith("https://builds.dotnet.microsoft.com/")
        or not isinstance(value.get("releaseMetadata"), str)
        or not value["releaseMetadata"].startswith(
            "https://dotnetcli.blob.core.windows.net/"
        )
    ):
        raise ValueError("invalid .NET SDK lock")
    return value


def verify_archive(path, lock):
    info = path.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_size != lock["size"]:
        raise ValueError(".NET SDK archive size mismatch")
    if sha512_file(path) != lock["sha512"]:
        raise ValueError(".NET SDK archive digest mismatch")


def cached_archive(cache, lock):
    cache.mkdir(mode=0o700, parents=True, exist_ok=True)
    archive = cache / lock["archive"]
    if archive.exists():
        verify_archive(archive, lock)
        return archive
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{lock['archive']}.", dir=cache
    )
    temporary = pathlib.Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as output:
            with urllib.request.urlopen(lock["url"], timeout=60) as response:
                remaining = lock["size"]
                while remaining:
                    block = response.read(min(1024 * 1024, remaining))
                    if not block:
                        break
                    output.write(block)
                    remaining -= len(block)
                if remaining or response.read(1):
                    raise ValueError(".NET SDK download size mismatch")
            output.flush()
            os.fsync(output.fileno())
        verify_archive(temporary, lock)
        os.chmod(temporary, 0o600)
        os.replace(temporary, archive)
    finally:
        temporary.unlink(missing_ok=True)
    return archive


def member_path(name, directory=False):
    while name.startswith("./"):
        name = name[2:]
    if name in ("", ".") and directory:
        return None
    if not name or name.startswith("/") or "\\" in name or "\0" in name:
        raise ValueError("unsafe .NET SDK archive path")
    parts = pathlib.PurePosixPath(name).parts
    if not parts or any(part in ("", ".", "..") for part in parts):
        raise ValueError("unsafe .NET SDK archive path")
    return pathlib.PurePosixPath(*parts)


def extract_archive(archive, destination, lock):
    if destination.exists() and any(destination.iterdir()):
        raise ValueError(".NET SDK output directory is not empty")
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    staging = pathlib.Path(
        tempfile.mkdtemp(prefix=f".{destination.name}.", dir=destination.parent)
    )
    try:
        with tarfile.open(archive, "r:gz") as source:
            members = source.getmembers()
            if not members or len(members) > MAX_ENTRIES:
                raise ValueError("invalid .NET SDK archive entry count")
            paths = {}
            expanded = 0
            for member in members:
                relative = member_path(member.name, member.isdir())
                if relative is None:
                    continue
                if relative in paths or not (member.isdir() or member.isfile()):
                    raise ValueError("unsupported .NET SDK archive entry")
                if member.mode & 0o7000:
                    raise ValueError("unsafe .NET SDK archive permissions")
                expanded += member.size
                if expanded > MAX_EXPANDED_BYTES:
                    raise ValueError(".NET SDK archive exceeds its expanded limit")
                paths[relative] = member
            for relative, member in paths.items():
                target = staging.joinpath(*relative.parts)
                if member.isdir():
                    target.mkdir(mode=0o755, parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
                stream = source.extractfile(member)
                if stream is None:
                    raise ValueError("unreadable .NET SDK archive entry")
                descriptor = os.open(
                    target,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC,
                    0o755 if member.mode & 0o111 else 0o644,
                )
                with os.fdopen(descriptor, "wb") as output, stream:
                    shutil.copyfileobj(stream, output, 1024 * 1024)
                if target.stat().st_size != member.size:
                    raise ValueError(".NET SDK archive entry size mismatch")
        required = [staging / "dotnet", staging / "LICENSE.txt", staging / "ThirdPartyNotices.txt"]
        if not all(path.is_file() and not path.is_symlink() for path in required):
            raise ValueError(".NET SDK archive layout mismatch")
        if not os.access(staging / "dotnet", os.X_OK):
            raise ValueError(".NET SDK launcher is not executable")
        marker = staging / "wildbuzzard-dotnet-toolchain.json"
        marker.write_text(
            json.dumps(lock, sort_keys=True, separators=(",", ":")) + "\n",
            encoding="utf-8",
        )
        marker.chmod(0o644)
        if destination.exists():
            destination.rmdir()
        staging.rename(destination)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def prepare(lock_path, cache, destination):
    lock = load_lock(lock_path)
    archive = cached_archive(cache, lock)
    extract_archive(archive, destination, lock)
    return archive


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--lock", required=True, type=pathlib.Path)
    parser.add_argument("--cache", required=True, type=pathlib.Path)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    args = parser.parse_args()
    archive = prepare(args.lock, args.cache, args.output)
    print(archive)


if __name__ == "__main__":
    main()
