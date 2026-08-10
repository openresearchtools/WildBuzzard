#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import struct
import sys
import unicodedata
import zipfile
from pathlib import Path

ADDRESSABLE_FILE_LIMIT = 64 * 1024 * 1024
ARCHIVE_LIMIT = 512 * 1024 * 1024
EXPANDED_LIMIT = 512 * 1024 * 1024
ENTRY_LIMIT = 20_000
EXPECTED_FILE_COUNT = 7_042
MANIFEST = "wildbuzzard-runtime.json"
MANIFEST_LIMIT = 2 * 1024 * 1024
RUNTIME_ARCHIVE_SHA256 = (
    "db683529031080cc1d35f5cfbe119b0d92f5985c4ecb996fc44e7c50838646f7"
)
SOURCE_ARCHIVE_SHA256 = (
    "c4d07e484d9e88a6deef78e02701bc6bdc100dbccb432d8492bbaa689e499f57"
)
SOURCE_ARCHIVE_SIZE = 697_380_812
RELEASE_INVENTORY_SHA256 = (
    "71ff13ca254db6a335be0ac9d3d4598663fa656435d76eff59cb65ca970c2f91"
)
RELEASE_INVENTORY_SIZE = 1_931
SERVICE_PATH = "libexec/searxng_service.py"
SERVICE_SHA256 = "4606ccd2c8d2123f42155f2567f1a71a2bf8a11fe225a153bad34cbb94d88cbe"
LAUNCHER_PATH = "bin/searxng-service"
LAUNCHER_SHA256 = "366af1e28c0fc029760f360896ce12d99ae22df58049fdc29584e3fc5f3a0fc7"
POLICY_PATH = "share/wildbuzzard/searxng/engine-policy.json"
POLICY_SHA256 = "098eb8820fa6744b174cbb5d4afb643bafc30d5859c79aa766ef787797894f82"

EXPECTED_MANIFEST = {
    "architecture": "x86_64",
    "buildToolSourcesLockSha256": "16c8eec18c59089a46f6b6d23940906057d66892d8e1c9dcc5f29c0d2db9a348",
    "buildToolsLockSha256": "d4a00f1257791193f703d09ead618ecc10dc11dffcf60c2d928594622a709ee2",
    "compiler": "Zig 0.15.2",
    "compilerTarget": "x86_64-linux-gnu.2.28",
    "component": "searxng",
    "correspondingSource": "wildbuzzard-searxng-2026.8.6+b023a28ba-source.tar.xz",
    "correspondingSourceSha256": "c4d07e484d9e88a6deef78e02701bc6bdc100dbccb432d8492bbaa689e499f57",
    "dependencyLockSha256": "3532d6386c8fae458945006efae16a07ed10d327f66ceccae7a34140f753cf8e",
    "granianCargoComponentsLockSha256": "8ad3c33d6967c2fcf0d2b71889b230df0df46a4a1b63a4f3af04b2d94b6e0c30",
    "granianCargoVendorLockSha256": "6fbd1c743108c9484ec7995d4ff90f2effa1796dc2c3568c7210a0c14c2f8550",
    "license": "AGPL-3.0-or-later",
    "nativeSourcesLockSha256": "3eb661da5692f7934d1b39a61b8e64e9c36112883ea2aa3051dfde13fbdfb34c",
    "platform": "linux",
    "protocolVersion": 1,
    "providerPolicySha256": POLICY_SHA256,
    "pythonSourceSha256": "143b1dddefaec3bd2e21e3b839b34a2b7fb9842272883c576420d605e9f30c63",
    "pythonVersion": "3.14.6",
    "runtimeVersion": "2026.8.6+b023a28ba",
    "rustToolchain": "Rust 1.96.0 (ac68faa20)",
    "schema": 1,
    "toolchainLockSha256": "bf9152e611653dd8ce4c5808a15fcc61ab19bc0fbdea80d461bba044f4e37d98",
    "upstreamCommit": "b023a28bab8839dba9eac96e9a51cc91bbd0a267",
    "upstreamSourceArchiveSha256": "f5ab68baa420f26ac0d6b3fed1a8e5754bbe1fd31357c41271449980d3df779e",
    "upstreamTree": "d2dc5354fe2281abd59f6734851bd586e6806631",
}
MANIFEST_FIELDS = frozenset((*EXPECTED_MANIFEST, "files"))
FILE_FIELDS = frozenset(("path", "sha256", "size"))
DIGEST = re.compile(r"[a-f0-9]{64}")


class ValidationError(Exception):
    pass


def regular_file_status(path: Path, label: str) -> os.stat_result:
    try:
        file_status = os.lstat(path)
    except OSError as error:
        raise ValidationError(f"cannot inspect {label}: {error}") from error
    if not stat.S_ISREG(file_status.st_mode) or stat.S_ISLNK(file_status.st_mode):
        raise ValidationError(f"{label} is not a regular file")
    return file_status


def file_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while block := stream.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def safe_archive_path(value: object) -> bool:
    if not isinstance(value, str):
        return False
    parts = value.split("/")
    return (
        bool(value)
        and len(value) <= 4096
        and unicodedata.normalize("NFC", value) == value
        and not value.startswith("/")
        and "\\" not in value
        and not any(ord(character) < 32 or ord(character) == 127 for character in value)
        and all(part not in ("", ".", "..") for part in parts)
    )


def is_digest(value: object) -> bool:
    return isinstance(value, str) and DIGEST.fullmatch(value) is not None


def strict_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValidationError(f"duplicate JSON field: {key}")
        result[key] = value
    return result


def invalid_constant(value: str) -> None:
    raise ValidationError(f"invalid JSON constant: {value}")


def central_directory(archive: Path, archive_size: int) -> dict[str, dict[str, int]]:
    tail_size = min(archive_size, 65_557)
    tail_offset = archive_size - tail_size
    with archive.open("rb") as stream:
        stream.seek(tail_offset)
        tail = stream.read(tail_size)
    end = tail.rfind(b"PK\x05\x06")
    if end < 0 or end + 22 > len(tail):
        raise ValidationError("ZIP end record is missing")
    (
        signature,
        disk,
        central_disk,
        disk_entries,
        entries,
        central_size,
        central_offset,
        comment_size,
    ) = struct.unpack_from("<4s4H2LH", tail, end)
    if (
        signature != b"PK\x05\x06"
        or end + 22 + comment_size != len(tail)
        or comment_size != 0
        or disk != 0
        or central_disk != 0
        or disk_entries != entries
        or entries in (0, 0xFFFF)
        or entries > ENTRY_LIMIT
        or central_size == 0xFFFFFFFF
        or central_offset == 0xFFFFFFFF
        or central_size > entries * (46 + 4096)
        or central_offset + central_size != tail_offset + end
    ):
        raise ValidationError("unsupported ZIP layout")
    with archive.open("rb") as stream:
        stream.seek(central_offset)
        payload = stream.read(central_size)
    if len(payload) != central_size:
        raise ValidationError("truncated ZIP central directory")

    result: dict[str, dict[str, int]] = {}
    expanded_size = 0
    offset = 0
    for _ in range(entries):
        if offset + 46 > len(payload):
            raise ValidationError("truncated ZIP entry")
        (
            signature,
            made_version,
            _extract_version,
            flags,
            method,
            _modified_time,
            _modified_date,
            crc,
            compressed_size,
            real_size,
            name_size,
            extra_size,
            entry_comment_size,
            entry_disk,
            _internal_attributes,
            external_attributes,
            local_offset,
        ) = struct.unpack_from("<4s6H3L5H2L", payload, offset)
        record_size = 46 + name_size + extra_size + entry_comment_size
        if (
            signature != b"PK\x01\x02"
            or made_version >> 8 != 3
            or flags != 0
            or method != zipfile.ZIP_STORED
            or compressed_size != real_size
            or compressed_size == 0xFFFFFFFF
            or entry_disk != 0
            or extra_size != 0
            or entry_comment_size != 0
            or local_offset == 0xFFFFFFFF
            or offset + record_size > len(payload)
        ):
            raise ValidationError("unsupported ZIP entry")
        name_bytes = payload[offset + 46 : offset + 46 + name_size]
        try:
            name = name_bytes.decode("utf-8")
        except UnicodeDecodeError as error:
            raise ValidationError("ZIP entry name is not UTF-8") from error
        mode = external_attributes >> 16
        if (
            not safe_archive_path(name)
            or name in result
            or stat.S_IFMT(mode) != stat.S_IFREG
            or stat.S_IMODE(mode) not in (0o644, 0o755)
        ):
            raise ValidationError(f"unsafe ZIP entry: {name}")
        expanded_size += real_size
        if real_size > ADDRESSABLE_FILE_LIMIT or expanded_size > EXPANDED_LIMIT:
            raise ValidationError("ZIP expansion limit exceeded")
        result[name] = {
            "crc": crc,
            "executable": int(bool(mode & 0o111)),
            "localOffset": local_offset,
            "mode": mode,
            "size": real_size,
        }
        offset += record_size
    if offset != len(payload):
        raise ValidationError("invalid ZIP central directory size")
    return result


def read_manifest(
    archive: zipfile.ZipFile, metadata: dict[str, dict[str, int]]
) -> dict[str, object]:
    entry = metadata.get(MANIFEST)
    if (
        entry is None
        or entry["size"] < 2
        or entry["size"] > MANIFEST_LIMIT
        or entry["executable"]
    ):
        raise ValidationError("invalid runtime manifest entry")
    with archive.open(MANIFEST, "r") as stream:
        payload = stream.read(MANIFEST_LIMIT + 1)
    if len(payload) != entry["size"]:
        raise ValidationError("invalid runtime manifest size")
    try:
        text = payload.decode("utf-8")
        value = json.loads(
            text,
            object_pairs_hook=strict_object,
            parse_constant=invalid_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValidationError("invalid runtime manifest JSON") from error
    canonical = (
        json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n"
    ).encode()
    if payload != canonical or not isinstance(value, dict):
        raise ValidationError("runtime manifest is not canonical JSON")
    return value


def validate_manifest(
    manifest: dict[str, object], metadata: dict[str, dict[str, int]]
) -> dict[str, dict[str, object]]:
    if set(manifest) != MANIFEST_FIELDS:
        raise ValidationError("runtime manifest has unexpected fields")
    for field, expected in EXPECTED_MANIFEST.items():
        if type(manifest[field]) is not type(expected) or manifest[field] != expected:
            raise ValidationError(f"runtime manifest field differs: {field}")
    files = manifest["files"]
    if not isinstance(files, list) or len(files) != EXPECTED_FILE_COUNT:
        raise ValidationError("invalid runtime file count")

    inventory: dict[str, dict[str, object]] = {}
    for entry in files:
        if not isinstance(entry, dict) or set(entry) != FILE_FIELDS:
            raise ValidationError("invalid runtime inventory entry")
        path = entry["path"]
        size = entry["size"]
        if (
            not safe_archive_path(path)
            or path == MANIFEST
            or path in inventory
            or not is_digest(entry["sha256"])
            or isinstance(size, bool)
            or not isinstance(size, int)
            or size < 0
            or size > ADDRESSABLE_FILE_LIMIT
            or metadata.get(path, {}).get("size") != size
        ):
            raise ValidationError("invalid runtime file inventory")
        inventory[path] = entry

    if (
        len(metadata) != len(inventory) + 1
        or set(metadata) != set(inventory) | {MANIFEST}
        or inventory.get(SERVICE_PATH, {}).get("sha256") != SERVICE_SHA256
        or inventory.get(LAUNCHER_PATH, {}).get("sha256") != LAUNCHER_SHA256
        or inventory.get(POLICY_PATH, {}).get("sha256") != POLICY_SHA256
        or not metadata.get(LAUNCHER_PATH, {}).get("executable")
        or not metadata.get("python/bin/python3", {}).get("executable")
        or not metadata.get("python/bin/python3.14", {}).get("executable")
    ):
        raise ValidationError("runtime inventory does not match the archive")
    return inventory


def validate_zip_entries(
    archive: zipfile.ZipFile, metadata: dict[str, dict[str, int]]
) -> dict[str, zipfile.ZipInfo]:
    infos = archive.infolist()
    if len(infos) != len(metadata):
        raise ValidationError("ZIP inventory count differs")
    result: dict[str, zipfile.ZipInfo] = {}
    for info in infos:
        central = metadata.get(info.filename)
        if (
            info.filename != info.orig_filename
            or central is None
            or info.filename in result
            or info.create_system != 3
            or info.flag_bits != 0
            or info.compress_type != zipfile.ZIP_STORED
            or info.file_size != central["size"]
            or info.compress_size != central["size"]
            or info.CRC != central["crc"]
            or info.header_offset != central["localOffset"]
            or info.external_attr >> 16 != central["mode"]
            or info.extra
            or info.comment
            or info.is_dir()
        ):
            raise ValidationError(f"ZIP reader rejected entry: {info.orig_filename}")
        result[info.filename] = info
    return result


def validate_archive(path: Path) -> tuple[str, int]:
    file_status = regular_file_status(path, "runtime archive")
    if file_status.st_size < 22 or file_status.st_size > ARCHIVE_LIMIT:
        raise ValidationError("runtime archive size is invalid")
    if file_digest(path) != RUNTIME_ARCHIVE_SHA256:
        raise ValidationError("runtime archive digest mismatch")
    metadata = central_directory(path, file_status.st_size)
    try:
        with zipfile.ZipFile(path, "r", allowZip64=False) as archive:
            infos = validate_zip_entries(archive, metadata)
            manifest = read_manifest(archive, metadata)
            inventory = validate_manifest(manifest, metadata)
            for name, expected in inventory.items():
                digest = hashlib.sha256()
                size = 0
                with archive.open(infos[name], "r") as stream:
                    while block := stream.read(1024 * 1024):
                        digest.update(block)
                        size += len(block)
                if size != expected["size"] or digest.hexdigest() != expected["sha256"]:
                    raise ValidationError(f"runtime payload digest differs: {name}")
    except zipfile.BadZipFile as error:
        raise ValidationError(f"invalid ZIP archive: {error}") from error
    return manifest["runtimeVersion"], len(inventory)


def validate_release_files(source: Path, inventory: Path) -> None:
    source_status = regular_file_status(source, "corresponding-source archive")
    if (
        source_status.st_size != SOURCE_ARCHIVE_SIZE
        or file_digest(source) != SOURCE_ARCHIVE_SHA256
    ):
        raise ValidationError("corresponding-source archive identity mismatch")
    inventory_status = regular_file_status(inventory, "release SBOM")
    if (
        inventory_status.st_size != RELEASE_INVENTORY_SIZE
        or file_digest(inventory) != RELEASE_INVENTORY_SHA256
    ):
        raise ValidationError("release SBOM identity mismatch")
    try:
        release_inventory = json.loads(
            inventory.read_text(encoding="utf-8"),
            object_pairs_hook=strict_object,
            parse_constant=invalid_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValidationError("invalid release SBOM") from error
    if not isinstance(release_inventory, dict):
        raise ValidationError("invalid release SBOM inventory")
    components = release_inventory.get("components")
    if (
        release_inventory.get("bomFormat") != "CycloneDX"
        or release_inventory.get("specVersion") != "1.6"
        or not isinstance(components, list)
        or len(components) != 2
    ):
        raise ValidationError("invalid release SBOM inventory")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Validate a host-built WildBuzzard SearXNG runtime archive."
    )
    parser.add_argument("archive", type=Path)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--inventory", required=True, type=Path)
    arguments = parser.parse_args()
    try:
        validate_release_files(arguments.source, arguments.inventory)
        version, file_count = validate_archive(arguments.archive)
    except (OSError, ValidationError, ValueError) as error:
        print(f"SearXNG runtime validation failed: {error}", file=sys.stderr)
        return 1
    print(f"Validated SearXNG runtime {version} ({file_count} files)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
