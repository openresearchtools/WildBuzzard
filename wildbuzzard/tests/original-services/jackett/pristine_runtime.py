#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later

import hashlib
import json
import re
import stat

COMMIT = "0cd8622b735922a909a128d8d6943bb8565a640f"
SOURCE_SHA256 = "3816fea39546b5fa440d3e33b856e73500ee6129e91b14d839fc0f04c7f9bd3e"
SOURCE_MANIFEST_SHA256 = (
    "7ce151e9e59943d4411bc2347cbfb6a7a5fb29c636ca2692b521f1f2dc086187"
)
RELEASE_VERSION = "v0.24.2360"
RELEASE_URL = (
    "https://github.com/Jackett/Jackett/releases/download/v0.24.2360/"
    "Jackett.Binaries.LinuxAMDx64.tar.gz"
)
RELEASE_SHA256 = "f3cd7eafa5a478f8c21208d0ab65980e9c935c2861767d1c448a38126305f116"
RELEASE_SIZE = 50_877_536
RELEASE_EXECUTABLE_SHA256 = (
    "b436e2c80c90df9f94c6537edb797790eedabf38094800f2d60e66d4f3879904"
)
RELEASE_LOCK_SHA256 = (
    "bb7947e245b44029bc76708458a81ed7ef5def09515ebc42597565b322af0101"
)


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def runtime_inventory(root):
    entries = []
    seen_inodes = set()
    for path in sorted(root.rglob("*")):
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode) or not (
            stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)
        ):
            raise RuntimeError(f"pristine runtime has a link or special file: {path}")
        if not stat.S_ISREG(info.st_mode):
            continue
        inode = (info.st_dev, info.st_ino)
        if info.st_nlink != 1 or inode in seen_inodes:
            raise RuntimeError(f"pristine runtime has a hard link: {path}")
        seen_inodes.add(inode)
        entries.append({
            "executable": bool(info.st_mode & 0o111),
            "path": path.relative_to(root).as_posix(),
            "sha256": sha256_file(path),
            "size": info.st_size,
        })
    return entries


def inventory_digest(entries):
    value = json.dumps(entries, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(value).hexdigest()


def write_build_record(runtime, destination, release_archive, release_lock):
    lock = json.loads(release_lock.read_text(encoding="utf-8"))
    if (
        lock.get("schemaVersion") != 1
        or lock.get("version") != RELEASE_VERSION
        or lock.get("commit") != COMMIT
        or lock.get("platform") != "linux/amd64"
        or lock.get("url") != RELEASE_URL
        or lock.get("sha256") != RELEASE_SHA256
        or lock.get("size") != RELEASE_SIZE
        or release_archive.stat().st_size != RELEASE_SIZE
        or sha256_file(release_archive) != RELEASE_SHA256
    ):
        raise RuntimeError("pristine Jackett release identity mismatch")
    files = runtime_inventory(runtime)
    executable = runtime / "jackett"
    if sha256_file(executable) != RELEASE_EXECUTABLE_SHA256:
        raise RuntimeError("pristine Jackett executable identity mismatch")
    record = {
        "schemaVersion": 1,
        "component": "pristine-jackett-release-runtime",
        "sourceCommit": COMMIT,
        "sourceArchiveSha256": SOURCE_SHA256,
        "sourceManifestSha256": SOURCE_MANIFEST_SHA256,
        "releaseVersion": RELEASE_VERSION,
        "releaseUrl": RELEASE_URL,
        "releaseArchiveSha256": RELEASE_SHA256,
        "releaseArchiveSize": RELEASE_SIZE,
        "releaseExecutableSha256": RELEASE_EXECUTABLE_SHA256,
        "releaseLockSha256": RELEASE_LOCK_SHA256,
        "platform": "linux/amd64",
        "preparationMode": "verified-official-release-extraction",
        "runtimeInventorySha256": inventory_digest(files),
        "files": files,
    }
    destination.write_text(
        json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    return record


def verify_runtime(runtime, record_path, pin_path):
    record = json.loads(record_path.read_text(encoding="utf-8"))
    pin = json.loads(pin_path.read_text(encoding="utf-8"))
    expected_digest = pin.get("runtimeInventorySha256")
    expected_archive_digest = pin.get("releaseArchiveSha256")
    expected_executable_digest = pin.get("releaseExecutableSha256")
    if (
        pin.get("schemaVersion") != 1
        or pin.get("source") != "official-v0.24.2360-linux-x64-release"
        or not isinstance(expected_digest, str)
        or not re.fullmatch(r"[0-9a-f]{64}", expected_digest)
        or expected_archive_digest != RELEASE_SHA256
        or expected_executable_digest != RELEASE_EXECUTABLE_SHA256
    ):
        raise RuntimeError(
            "the pristine release runtime pins have not been recorded"
        )
    if (
        record.get("schemaVersion") != 1
        or record.get("component") != "pristine-jackett-release-runtime"
        or record.get("sourceCommit") != COMMIT
        or record.get("sourceArchiveSha256") != SOURCE_SHA256
        or record.get("sourceManifestSha256") != SOURCE_MANIFEST_SHA256
        or record.get("releaseVersion") != RELEASE_VERSION
        or record.get("releaseUrl") != RELEASE_URL
        or record.get("releaseArchiveSha256") != expected_archive_digest
        or record.get("releaseArchiveSize") != RELEASE_SIZE
        or record.get("releaseExecutableSha256") != expected_executable_digest
        or record.get("releaseLockSha256") != RELEASE_LOCK_SHA256
        or record.get("platform") != "linux/amd64"
        or record.get("preparationMode")
        != "verified-official-release-extraction"
        or record.get("runtimeInventorySha256") != expected_digest
    ):
        raise RuntimeError("the pristine runtime build record is not pinned")
    executable = runtime / "jackett"
    if not executable.is_file() or sha256_file(executable) != expected_executable_digest:
        raise RuntimeError("the pristine Jackett executable differs from its pin")
    files = runtime_inventory(runtime)
    if files != record.get("files") or inventory_digest(files) != expected_digest:
        raise RuntimeError("the pristine runtime inventory differs from its pin")
    return record
