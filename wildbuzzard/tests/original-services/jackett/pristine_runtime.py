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
SDK_IMAGE = (
    "mcr.microsoft.com/dotnet/sdk@"
    "sha256:6e6542a43b6bf3c5ecfa80dd33c79c9fd09d58f95f4ebacd14fa056275b25164"
)
SOURCE_DATE_EPOCH = 1786253932
BUILD_COMMAND = [
    "dotnet",
    "publish",
    "src/Jackett.Server/Jackett.Server.csproj",
    "--configuration",
    "Release",
    "--framework",
    "net9.0",
    "--runtime",
    "linux-x64",
    "--self-contained",
    "true",
    "--output",
    "/output",
    "-p:Version=0.24.2360",
    "-p:ContinuousIntegrationBuild=true",
    "-p:DebugSymbols=false",
    "-p:DebugType=None",
    "-p:Deterministic=true",
    "-p:PublishReadyToRun=false",
    "-p:PublishSingleFile=false",
    "-p:PublishTrimmed=false",
]


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


def write_build_record(runtime, destination, image_inspect):
    inspected = json.loads(image_inspect.read_text(encoding="utf-8"))
    if not isinstance(inspected, list) or len(inspected) != 1:
        raise RuntimeError("SDK image inspection must contain exactly one image")
    image = inspected[0]
    digest = image.get("Digest") or image.get("digest")
    architecture = image.get("Architecture") or image.get("architecture")
    operating_system = image.get("Os") or image.get("os")
    image_id = image.get("Id") or image.get("id")
    if not isinstance(digest, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
        raise RuntimeError("SDK platform digest is unavailable")
    if (operating_system, architecture) != ("linux", "amd64"):
        raise RuntimeError("SDK image platform is not linux/amd64")
    if not isinstance(image_id, str) or not re.fullmatch(
        r"sha256:[0-9a-f]{64}", image_id
    ):
        raise RuntimeError("SDK image ID is unavailable")
    files = runtime_inventory(runtime)
    record = {
        "schemaVersion": 1,
        "component": "pristine-jackett-test-runtime",
        "sourceCommit": COMMIT,
        "sourceArchiveSha256": SOURCE_SHA256,
        "sourceManifestSha256": SOURCE_MANIFEST_SHA256,
        "sdkImage": SDK_IMAGE,
        "sdkPlatform": "linux/amd64",
        "sdkPlatformDigest": digest,
        "sdkImageId": image_id,
        "sourceDateEpoch": SOURCE_DATE_EPOCH,
        "buildCommand": BUILD_COMMAND,
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
    expected_platform_digest = pin.get("sdkPlatformDigest")
    expected_image_id = pin.get("sdkImageId")
    if (
        pin.get("schemaVersion") != 1
        or not isinstance(expected_digest, str)
        or not re.fullmatch(r"[0-9a-f]{64}", expected_digest)
        or not isinstance(expected_platform_digest, str)
        or not re.fullmatch(r"sha256:[0-9a-f]{64}", expected_platform_digest)
        or not isinstance(expected_image_id, str)
        or not re.fullmatch(r"sha256:[0-9a-f]{64}", expected_image_id)
    ):
        raise RuntimeError(
            "the reproducible pristine runtime and SDK platform pins have not been recorded"
        )
    if (
        record.get("schemaVersion") != 1
        or record.get("component") != "pristine-jackett-test-runtime"
        or record.get("sourceCommit") != COMMIT
        or record.get("sourceArchiveSha256") != SOURCE_SHA256
        or record.get("sourceManifestSha256") != SOURCE_MANIFEST_SHA256
        or record.get("sdkImage") != SDK_IMAGE
        or record.get("sdkPlatform") != "linux/amd64"
        or record.get("sourceDateEpoch") != SOURCE_DATE_EPOCH
        or record.get("buildCommand") != BUILD_COMMAND
        or record.get("sdkPlatformDigest") != expected_platform_digest
        or record.get("sdkImageId") != expected_image_id
        or record.get("runtimeInventorySha256") != expected_digest
    ):
        raise RuntimeError("the pristine runtime build record is not pinned")
    files = runtime_inventory(runtime)
    if files != record.get("files") or inventory_digest(files) != expected_digest:
        raise RuntimeError("the pristine runtime inventory differs from its pin")
    return record
