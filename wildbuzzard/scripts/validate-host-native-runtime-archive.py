#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later

import argparse
import datetime
import hashlib
import io
import json
import re
import stat
import sys
import tarfile
import unicodedata
import zipfile
from pathlib import Path, PurePosixPath

import tomllib

MAX_ARCHIVE_SIZE = 1024 * 1024 * 1024
MAX_FILE_SIZE = 512 * 1024 * 1024
MAX_EXPANDED_SIZE = 4 * 1024 * 1024 * 1024
MAX_ENTRIES = 200_000
MAX_JSON_SIZE = 16 * 1024 * 1024
SHA256 = re.compile(r"^[a-f0-9]{64}$")

TORRENT_PINS = {
    "architecture",
    "component",
    "correspondingSource",
    "dependencyLockSha256",
    "licenseLocations",
    "nodeArchiveSha256",
    "nodeVersion",
    "packageLockSha256",
    "payloadSha256",
    "platform",
    "protocolVersion",
    "sbom",
    "schema",
    "sourceSha256",
    "utpBuiltFromSource",
    "version",
    "webTorrentImportCommit",
    "webTorrentVersion",
    "wildbuzzardCommit",
}
TORRENT_REQUIRED = {
    "WEBTORRENT-LICENSE",
    "WILDBUZZARD-LICENSE",
    "app/package-lock.json",
    "app/package.json",
    "app/service.mjs",
    "bin/wildbuzzard-torrent",
    "node/LICENSE",
    "node/bin/node",
    "share/wildbuzzard/torrent/sbom.cdx.json",
}
JACKETT_PINS = {
    "architecture",
    "catalogFileSha256",
    "component",
    "correspondingSource",
    "dashboardIncluded",
    "dependencyLockSha256",
    "enabledProviderCount",
    "executableName",
    "libc",
    "license",
    "licenseLocations",
    "platform",
    "protocolVersion",
    "providerPolicySha256",
    "runtimeSha256",
    "sbom",
    "schemaVersion",
    "sdkToolchain",
    "semanticVersion",
    "sourceSha256",
    "testFixture",
    "updaterIncluded",
    "upstreamCommit",
    "upstreamVersion",
}
JACKETT_REQUIRED = {
    "catalog.json",
    "jackett-mini",
    "jackett-mini.spdx.json",
    "licenses/dotnet/LICENSE.txt",
    "licenses/dotnet/ThirdPartyNotices.txt",
    "licenses/jackett/LICENSE",
    "licenses/jackett/THIRD_PARTY_NOTICES.md",
    "source/jackett/UPSTREAM.toml",
    "source/jackett/build-jackett-mini.sh",
    "source/jackett/packaging/dotnet-sdk-linux-x64.json",
    "source/jackett/packaging/nuget-licenses.json",
    "source/jackett/patches/series",
    "source/jackett/provider-policy/catalog.json",
    "source/jackett/upstream/SOURCE-MANIFEST.sha256",
    "source/jackett/upstream/jackett-v0.24.2360.tar.gz",
}


class ValidationError(ValueError):
    pass


def sha256_bytes(value):
    return hashlib.sha256(value).hexdigest()


def safe_path(value):
    if not isinstance(value, str):
        return False
    path = PurePosixPath(value)
    return bool(
        value
        and len(value) <= 4096
        and unicodedata.normalize("NFC", value) == value
        and not value.startswith("/")
        and "\\" not in value
        and all(part not in ("", ".", "..") and len(part) <= 255 for part in path.parts)
        and not any(ord(character) < 32 or ord(character) == 127 for character in value)
    )


def read_json_bytes(value, description):
    try:
        document = json.loads(value)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValidationError(f"invalid {description}") from error
    if not isinstance(document, dict):
        raise ValidationError(f"invalid {description}")
    return document


def validate_digest(value):
    return isinstance(value, str) and SHA256.fullmatch(value)


def load_lock(path, kind):
    try:
        lock = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValidationError("invalid host-native runtime lock") from error
    expected_component = (
        "wildbuzzard-torrent-runtime" if kind == "torrent" else "jackett-mini"
    )
    pins = TORRENT_PINS if kind == "torrent" else JACKETT_PINS
    required = TORRENT_REQUIRED if kind == "torrent" else JACKETT_REQUIRED
    if (
        not isinstance(lock, dict)
        or set(lock)
        != {
            "archive",
            "component",
            "manifest",
            "manifestPins",
            "requiredFiles",
            "schemaVersion",
            "sourceDateEpoch",
        }
        or lock["schemaVersion"] != 1
        or lock["component"] != expected_component
        or not isinstance(lock["sourceDateEpoch"], int)
        or lock["sourceDateEpoch"] < 315_532_800
        or not isinstance(lock["archive"], dict)
        or set(lock["archive"]) != {"sha256", "size"}
        or not validate_digest(lock["archive"].get("sha256"))
        or not isinstance(lock["archive"].get("size"), int)
        or not 0 < lock["archive"]["size"] <= MAX_ARCHIVE_SIZE
        or not isinstance(lock["manifest"], dict)
        or set(lock["manifest"]) != {"path", "sha256"}
        or not safe_path(lock["manifest"].get("path"))
        or not validate_digest(lock["manifest"].get("sha256"))
        or not isinstance(lock["manifestPins"], dict)
        or set(lock["manifestPins"]) != pins
        or not isinstance(lock["requiredFiles"], dict)
        or not required.issubset(lock["requiredFiles"])
    ):
        raise ValidationError("invalid host-native runtime lock")
    source = lock["manifestPins"].get("correspondingSource")
    sbom = lock["manifestPins"].get("sbom")
    licenses = lock["manifestPins"].get("licenseLocations")
    if (
        not safe_path(source)
        or not safe_path(sbom)
        or (kind == "torrent" and source not in lock["requiredFiles"])
        or (
            kind != "torrent"
            and not any(name.startswith(source + "/") for name in lock["requiredFiles"])
        )
        or sbom not in lock["requiredFiles"]
        or not isinstance(licenses, list)
        or not licenses
        or len(licenses) != len(set(licenses))
        or any(
            not safe_path(name) or name not in lock["requiredFiles"]
            for name in licenses
        )
    ):
        raise ValidationError("invalid host-native runtime lock")
    for name, entry in lock["requiredFiles"].items():
        if (
            not safe_path(name)
            or not isinstance(entry, dict)
            or set(entry) != {"executable", "sha256", "size"}
            or not isinstance(entry["executable"], bool)
            or not validate_digest(entry["sha256"])
            or not isinstance(entry["size"], int)
            or not 0 <= entry["size"] <= MAX_FILE_SIZE
        ):
            raise ValidationError("invalid host-native runtime lock")
    return lock


def stream_sha256(stream):
    digest = hashlib.sha256()
    size = 0
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        size += len(chunk)
        if size > MAX_FILE_SIZE:
            raise ValidationError("host-native runtime member is too large")
        digest.update(chunk)
    return digest.hexdigest(), size


def archive_sha256(source):
    source.seek(0, 2)
    size = source.tell()
    if size <= 0 or size > MAX_ARCHIVE_SIZE:
        raise ValidationError("host-native runtime archive exceeds its size limit")
    source.seek(0)
    digest = hashlib.sha256()
    for chunk in iter(lambda: source.read(1024 * 1024), b""):
        digest.update(chunk)
    source.seek(0)
    return digest.hexdigest(), size


def zip_timestamp(epoch):
    return datetime.datetime.fromtimestamp(epoch, datetime.timezone.utc).timetuple()[:6]


def validate_manifest_files(manifest, infos, manifest_name, kind):
    files = manifest.get("files")
    if not isinstance(files, list) or not files or len(files) > MAX_ENTRIES:
        raise ValidationError("invalid host-native runtime file inventory")
    inventory = {}
    previous = ""
    total = 0
    for entry in files:
        if (
            not isinstance(entry, dict)
            or set(entry) != {"executable", "path", "sha256", "size"}
            or not safe_path(entry.get("path"))
            or entry["path"] <= previous
            or entry["path"] in inventory
            or not validate_digest(entry.get("sha256"))
            or not isinstance(entry.get("size"), int)
            or not 0 <= entry["size"] <= MAX_FILE_SIZE
            or not isinstance(entry.get("executable"), bool)
        ):
            raise ValidationError("invalid host-native runtime file inventory")
        inventory[entry["path"]] = entry
        previous = entry["path"]
        total += entry["size"]
        if total > MAX_EXPANDED_SIZE:
            raise ValidationError("host-native runtime expands beyond its size limit")
    if set(infos) != {*inventory, manifest_name}:
        raise ValidationError("host-native runtime ZIP and manifest inventories differ")
    for name, info in infos.items():
        expected_executable = inventory.get(name, {}).get("executable", False)
        mode = info.external_attr >> 16
        if (
            info.is_dir()
            or info.create_system != 3
            or stat.S_IFMT(mode) != stat.S_IFREG
            or mode & 0o777 != (0o755 if expected_executable else 0o644)
            or info.file_size > MAX_FILE_SIZE
            or (name != manifest_name and info.file_size != inventory[name]["size"])
        ):
            raise ValidationError("unsafe host-native runtime ZIP mode or size")
    if kind == "torrent":
        payload = "".join(
            f"{entry['path']}\0{entry['size']}\0{entry['sha256']}\0{1 if entry['executable'] else 0}\n"
            for entry in files
        ).encode()
        expected = manifest["payloadSha256"]
    else:
        payload = json.dumps(files, sort_keys=True, separators=(",", ":")).encode()
        expected = manifest["runtimeSha256"]
    if sha256_bytes(payload) != expected:
        raise ValidationError(
            "host-native runtime inventory digest differs from its pin"
        )
    return inventory


def zip_member_bytes(archive, name, maximum=MAX_JSON_SIZE):
    info = archive.getinfo(name)
    if info.file_size > maximum:
        raise ValidationError(f"host-native runtime member is too large: {name}")
    with archive.open(info) as stream:
        value = stream.read(maximum + 1)
    if len(value) > maximum:
        raise ValidationError(f"host-native runtime member is too large: {name}")
    return value


def validate_torrent_source(archive, manifest):
    source = zip_member_bytes(archive, manifest["correspondingSource"], MAX_FILE_SIZE)
    prefix = f"wildbuzzard-torrent-runtime-{manifest['wildbuzzardCommit']}/"
    required = {
        "third_party/webtorrent/package.json",
        "wildbuzzard/torrent-runtime/package-lock.json",
        "wildbuzzard/torrent-runtime/service.mjs",
        "wildbuzzard/upstreams.toml",
    }
    values = {}
    try:
        with tarfile.open(fileobj=io.BytesIO(source), mode="r:xz") as source_tar:
            members = source_tar.getmembers()
            if len(members) > MAX_ENTRIES:
                raise ValidationError("torrent source archive has too many entries")
            for member in members:
                if (
                    not (
                        member.name == prefix.removesuffix("/")
                        or member.name.startswith(prefix)
                    )
                    or not safe_path(member.name)
                    or not (member.isfile() or member.isdir())
                    or member.size > MAX_FILE_SIZE
                ):
                    raise ValidationError("unsafe torrent source archive entry")
            for relative in required:
                member = source_tar.getmember(prefix + relative)
                stream = source_tar.extractfile(member)
                if stream is None:
                    raise ValidationError("torrent source archive is incomplete")
                values[relative] = stream.read(MAX_JSON_SIZE + 1)
    except (KeyError, tarfile.TarError) as error:
        raise ValidationError("invalid torrent corresponding-source archive") from error
    if values["wildbuzzard/torrent-runtime/package-lock.json"] != zip_member_bytes(
        archive, "app/package-lock.json"
    ) or values["wildbuzzard/torrent-runtime/service.mjs"] != zip_member_bytes(
        archive, "app/service.mjs"
    ):
        raise ValidationError("torrent source and runtime payload differ")
    try:
        upstreams = tomllib.loads(values["wildbuzzard/upstreams.toml"].decode("utf-8"))
        webtorrent_package = json.loads(values["third_party/webtorrent/package.json"])
        package_lock = json.loads(
            values["wildbuzzard/torrent-runtime/package-lock.json"]
        )
    except (UnicodeDecodeError, tomllib.TOMLDecodeError, json.JSONDecodeError) as error:
        raise ValidationError("invalid torrent source metadata") from error
    webtorrent = upstreams.get("webtorrent", {})
    if (
        webtorrent.get("commit") != manifest["webTorrentImportCommit"]
        or webtorrent.get("version") != manifest["webTorrentVersion"]
        or webtorrent_package.get("version") != manifest["webTorrentVersion"]
        or package_lock.get("lockfileVersion") != 3
        or not isinstance(package_lock.get("packages"), dict)
        or sha256_bytes(values["wildbuzzard/torrent-runtime/package-lock.json"])
        != manifest["packageLockSha256"]
    ):
        raise ValidationError(
            "torrent source revision or dependencies differ from the pin"
        )


def validate_torrent_sbom(archive, manifest):
    sbom = read_json_bytes(
        zip_member_bytes(archive, manifest["sbom"]), "torrent runtime SBOM"
    )
    application = sbom.get("metadata", {}).get("component", {})
    properties = {
        entry.get("name"): entry.get("value")
        for entry in application.get("properties", [])
        if isinstance(entry, dict)
    }
    components = sbom.get("components")
    purls = {
        entry.get("purl"): entry
        for entry in components or []
        if isinstance(entry, dict) and isinstance(entry.get("purl"), str)
    }
    node = purls.get(f"pkg:generic/node@{manifest['nodeVersion']}", {})
    if (
        sbom.get("bomFormat") != "CycloneDX"
        or sbom.get("specVersion") != "1.6"
        or application.get("name") != manifest["component"]
        or application.get("version") != manifest["version"]
        or properties.get("wildbuzzard:commit") != manifest["wildbuzzardCommit"]
        or properties.get("wildbuzzard:package-lock-sha256")
        != manifest["packageLockSha256"]
        or properties.get("wildbuzzard:webtorrent-commit")
        != manifest["webTorrentImportCommit"]
        or not isinstance(components, list)
        or len(components) < 2
        or len(purls) != len(components)
        or purls.get(f"pkg:npm/webtorrent@{manifest['webTorrentVersion']}") is None
        or node.get("hashes")
        != [{"alg": "SHA-256", "content": manifest["nodeArchiveSha256"]}]
    ):
        raise ValidationError("torrent runtime SBOM differs from the release pin")


def validate_jackett_source(archive, manifest):
    upstream_bytes = zip_member_bytes(archive, "source/jackett/UPSTREAM.toml")
    sdk_bytes = zip_member_bytes(
        archive, "source/jackett/packaging/dotnet-sdk-linux-x64.json"
    )
    catalog_bytes = zip_member_bytes(
        archive, "source/jackett/provider-policy/catalog.json"
    )
    source_bytes = zip_member_bytes(
        archive,
        "source/jackett/upstream/jackett-v0.24.2360.tar.gz",
        MAX_FILE_SIZE,
    )
    try:
        upstream = tomllib.loads(upstream_bytes.decode("utf-8"))
        sdk = json.loads(sdk_bytes)
        catalog = json.loads(catalog_bytes)
        with tarfile.open(fileobj=io.BytesIO(source_bytes), mode="r:gz") as source_tar:
            source_members = source_tar.getmembers()
            prefix = f"Jackett-{manifest['upstreamCommit']}/"
            if len(source_members) > MAX_ENTRIES or any(
                not (
                    member.name == prefix.removesuffix("/")
                    or member.name.startswith(prefix)
                )
                or not safe_path(member.name)
                or not (member.isfile() or member.isdir())
                or member.size > MAX_FILE_SIZE
                for member in source_members
            ):
                raise ValidationError("unsafe Jackett source archive entry")
    except (
        UnicodeDecodeError,
        tomllib.TOMLDecodeError,
        json.JSONDecodeError,
        tarfile.TarError,
    ) as error:
        raise ValidationError("invalid Jackett corresponding source") from error
    expected_sdk = dict(manifest["sdkToolchain"])
    sdk_digest = expected_sdk.pop("lockSha256", None)
    if (
        upstream.get("commit") != manifest["upstreamCommit"]
        or upstream.get("version") != manifest["upstreamVersion"]
        or upstream.get("source_sha256") != manifest["sourceSha256"]
        or sha256_bytes(source_bytes) != manifest["sourceSha256"]
        or sha256_bytes(sdk_bytes) != sdk_digest
        or sdk != expected_sdk
        or catalog.get("policySha256") != manifest["providerPolicySha256"]
        or len(catalog.get("enabledIndexerIds", [])) != manifest["enabledProviderCount"]
        or sha256_bytes(catalog_bytes) != manifest["catalogFileSha256"]
        or catalog_bytes != zip_member_bytes(archive, "catalog.json")
    ):
        raise ValidationError(
            "Jackett source revision or dependencies differ from the pin"
        )


def validate_jackett_sbom(archive, manifest, inventory):
    sbom = read_json_bytes(
        zip_member_bytes(archive, manifest["sbom"]), "Jackett runtime SBOM"
    )
    license_inventory = read_json_bytes(
        zip_member_bytes(archive, "source/jackett/packaging/nuget-licenses.json"),
        "Jackett NuGet license inventory",
    )
    expected_packages = {
        (entry.get("name"), entry.get("version")): entry.get("license")
        for entry in license_inventory.get("packages", [])
        if isinstance(entry, dict)
    }
    packages = sbom.get("packages")
    dependencies = {}
    main = None
    for package in packages or []:
        if not isinstance(package, dict):
            continue
        if package.get("SPDXID") == "SPDXRef-Package-jackett-mini":
            main = package
        else:
            dependencies[(package.get("name"), package.get("versionInfo"))] = package
    sbom_files = {}
    for entry in sbom.get("files", []):
        checksums = entry.get("checksums", []) if isinstance(entry, dict) else []
        if len(checksums) == 1 and checksums[0].get("algorithm") == "SHA256":
            sbom_files[entry.get("fileName", "").removeprefix("./")] = checksums[0].get(
                "checksumValue"
            )
    expected_files = {
        name: entry["sha256"]
        for name, entry in inventory.items()
        if name != manifest["sbom"]
    }
    if (
        sbom.get("spdxVersion") != "SPDX-2.3"
        or sbom.get("SPDXID") != "SPDXRef-DOCUMENT"
        or sbom.get("name") != "jackett-mini-runtime"
        or not isinstance(packages, list)
        or main is None
        or main.get("versionInfo") != manifest["semanticVersion"]
        or main.get("licenseDeclared") != manifest["license"]
        or set(dependencies) != set(expected_packages)
        or any(
            dependencies[key].get("licenseDeclared") != license_name
            for key, license_name in expected_packages.items()
        )
        or sbom_files != expected_files
    ):
        raise ValidationError("Jackett runtime SBOM or dependency inventory differs")


def validate_opened_archive(source, lock_path, kind):
    lock = load_lock(Path(lock_path), kind)
    digest, size = archive_sha256(source)
    if digest != lock["archive"]["sha256"] or size != lock["archive"]["size"]:
        raise ValidationError(f"{kind} runtime archive differs from the release pin")
    try:
        with zipfile.ZipFile(source) as archive:
            infos_list = archive.infolist()
            infos = {info.filename: info for info in infos_list}
            allowed_compression = (
                {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}
                if kind == "torrent"
                else {zipfile.ZIP_STORED}
            )
            if (
                archive.comment
                or not infos_list
                or len(infos_list) > MAX_ENTRIES
                or len(infos) != len(infos_list)
                or any(
                    not safe_path(info.filename)
                    or info.flag_bits & 1
                    or info.compress_type not in allowed_compression
                    or info.is_dir()
                    or info.create_system != 3
                    or stat.S_IFMT(info.external_attr >> 16) != stat.S_IFREG
                    or info.extra
                    or info.comment
                    or info.date_time != zip_timestamp(lock["sourceDateEpoch"])
                    for info in infos_list
                )
            ):
                raise ValidationError(f"unsafe {kind} runtime ZIP layout")
            manifest_name = lock["manifest"]["path"]
            manifest_bytes = zip_member_bytes(archive, manifest_name)
            if sha256_bytes(manifest_bytes) != lock["manifest"]["sha256"]:
                raise ValidationError(f"{kind} runtime manifest differs from the pin")
            manifest = read_json_bytes(manifest_bytes, f"{kind} runtime manifest")
            pins = lock["manifestPins"]
            if set(manifest) != {*pins, "files"} or any(
                manifest.get(name) != value for name, value in pins.items()
            ):
                raise ValidationError(f"{kind} runtime manifest differs from the pin")
            inventory = validate_manifest_files(manifest, infos, manifest_name, kind)
            if any(
                name not in inventory
                or {
                    "executable": inventory[name]["executable"],
                    "sha256": inventory[name]["sha256"],
                    "size": inventory[name]["size"],
                }
                != value
                for name, value in lock["requiredFiles"].items()
            ):
                raise ValidationError(
                    f"{kind} runtime required file differs from the pin"
                )
            for name, entry in inventory.items():
                with archive.open(name) as stream:
                    member_digest, member_size = stream_sha256(stream)
                if member_digest != entry["sha256"] or member_size != entry["size"]:
                    raise ValidationError(f"{kind} runtime payload differs: {name}")
            if kind == "torrent":
                validate_torrent_source(archive, manifest)
                validate_torrent_sbom(archive, manifest)
            else:
                validate_jackett_source(archive, manifest)
                validate_jackett_sbom(archive, manifest, inventory)
    except (KeyError, OSError, zipfile.BadZipFile) as error:
        raise ValidationError(f"invalid {kind} runtime archive") from error
    source.seek(0)
    return manifest


def validate_path(archive_path, lock_path, kind):
    info = archive_path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ValidationError(f"unsafe {kind} runtime archive input")
    with archive_path.open("rb") as source:
        return validate_opened_archive(source, lock_path, kind)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("archive", type=Path)
    parser.add_argument("--kind", choices=("torrent", "jackett-mini"), required=True)
    parser.add_argument("--lock", type=Path, required=True)
    args = parser.parse_args()
    kind = "torrent" if args.kind == "torrent" else "jackett"
    try:
        validate_path(args.archive, args.lock, kind)
    except (OSError, ValidationError) as error:
        print(f"{args.kind} runtime validation failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
