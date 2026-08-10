#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later

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
    "commit",
    "platform",
    "schemaVersion",
    "sha256",
    "size",
    "url",
    "version",
}
MAX_ENTRIES = 2_000
MAX_EXPANDED_BYTES = 512 * 1024 * 1024


def sha256_file(path):
    digest = hashlib.sha256()
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
        or value.get("version") != "v0.24.2360"
        or value.get("commit") != "0cd8622b735922a909a128d8d6943bb8565a640f"
        or value.get("platform") != "linux/amd64"
        or not isinstance(value.get("archive"), str)
        or pathlib.PurePosixPath(value["archive"]).name != value["archive"]
        or not isinstance(value.get("size"), int)
        or isinstance(value["size"], bool)
        or value["size"] <= 0
        or value["size"] > 128 * 1024 * 1024
        or not isinstance(value.get("sha256"), str)
        or len(value["sha256"]) != 64
        or any(character not in "0123456789abcdef" for character in value["sha256"])
        or not isinstance(value.get("url"), str)
        or not value["url"].startswith(
            "https://github.com/Jackett/Jackett/releases/download/"
        )
    ):
        raise ValueError("invalid pristine Jackett release lock")
    return value


def verify_archive(path, lock):
    info = path.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_size != lock["size"]:
        raise ValueError("pristine Jackett release size mismatch")
    if sha256_file(path) != lock["sha256"]:
        raise ValueError("pristine Jackett release digest mismatch")


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
                    raise ValueError("pristine Jackett release download size mismatch")
            output.flush()
            os.fsync(output.fileno())
        verify_archive(temporary, lock)
        os.chmod(temporary, 0o600)
        os.replace(temporary, archive)
    finally:
        temporary.unlink(missing_ok=True)
    return archive


def member_path(name):
    if not name or name.startswith("/") or "\\" in name or "\0" in name:
        raise ValueError("unsafe pristine Jackett release path")
    parts = pathlib.PurePosixPath(name).parts
    if (
        len(parts) < 2
        or parts[0] != "Jackett"
        or any(part in ("", ".", "..") for part in parts)
    ):
        raise ValueError("unsafe pristine Jackett release path")
    return pathlib.PurePosixPath(*parts[1:])


def extract_archive(archive, destination):
    if destination.exists() and any(destination.iterdir()):
        raise ValueError("pristine Jackett output directory is not empty")
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    staging = pathlib.Path(
        tempfile.mkdtemp(prefix=f".{destination.name}.", dir=destination.parent)
    )
    try:
        with tarfile.open(archive, "r:gz") as source:
            members = source.getmembers()
            if not members or len(members) > MAX_ENTRIES:
                raise ValueError("invalid pristine Jackett release entry count")
            paths = {}
            expanded = 0
            for member in members:
                if member.name == "Jackett" and member.isdir():
                    continue
                relative = member_path(member.name)
                if relative in paths or not (member.isdir() or member.isfile()):
                    raise ValueError("unsupported pristine Jackett release entry")
                if member.mode & 0o7000:
                    raise ValueError("unsafe pristine Jackett release permissions")
                expanded += member.size
                if expanded > MAX_EXPANDED_BYTES:
                    raise ValueError("pristine Jackett release exceeds its limit")
                paths[relative] = member
            for relative, member in paths.items():
                target = staging.joinpath(*relative.parts)
                if member.isdir():
                    target.mkdir(mode=0o755, parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
                stream = source.extractfile(member)
                if stream is None:
                    raise ValueError("unreadable pristine Jackett release entry")
                descriptor = os.open(
                    target,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC,
                    0o755 if member.mode & 0o111 else 0o644,
                )
                with os.fdopen(descriptor, "wb") as output, stream:
                    shutil.copyfileobj(stream, output, 1024 * 1024)
                if target.stat().st_size != member.size:
                    raise ValueError("pristine Jackett release entry size mismatch")
        if (
            not (staging / "jackett").is_file()
            or not os.access(staging / "jackett", os.X_OK)
            or not (staging / "Content/index.html").is_file()
            or len(list((staging / "Definitions").glob("*.yml"))) != 549
            or len([path for path in staging.rglob("*") if path.is_file()]) != 962
        ):
            raise ValueError("pristine Jackett release layout mismatch")
        if destination.exists():
            destination.rmdir()
        staging.rename(destination)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def prepare(lock_path, cache, destination):
    lock = load_lock(lock_path)
    archive = cached_archive(cache, lock)
    extract_archive(archive, destination)
    return archive


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--lock", required=True, type=pathlib.Path)
    parser.add_argument("--cache", required=True, type=pathlib.Path)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    args = parser.parse_args()
    print(prepare(args.lock, args.cache, args.output))


if __name__ == "__main__":
    main()
