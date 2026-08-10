#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later

import argparse
import datetime
import hashlib
import io
import json
import os
import re
import stat
import sys
import tarfile
import zipfile
from pathlib import Path, PurePosixPath

import tomllib

VERSION = "2.5.1"
MANIFEST = "wildbuzzard-arti-runtime.json"
SOURCE = f"source/wildbuzzard-arti-{VERSION}-source.tar.xz"
SBOM = f"sbom/wildbuzzard-arti-{VERSION}.cdx.json"
LICENSES = ("licenses/LICENSE-APACHE", "licenses/LICENSE-MIT")
MAX_ARCHIVE_SIZE = 128 * 1024 * 1024
MAX_MEMBER_SIZE = 64 * 1024 * 1024
SHA256 = re.compile(r"^[a-f0-9]{64}$")
COMMIT = re.compile(r"^[a-f0-9]{40}$")


class ValidationError(ValueError):
    pass


def sha256_bytes(value):
    return hashlib.sha256(value).hexdigest()


def file_bytes(path, maximum=MAX_MEMBER_SIZE):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > maximum:
        raise ValidationError(f"unsafe Arti input: {path}")
    return path.read_bytes()


def safe_path(value):
    if not isinstance(value, str):
        return False
    path = PurePosixPath(value)
    return bool(
        value
        and not value.startswith("/")
        and "\\" not in value
        and all(part not in ("", ".", "..") for part in path.parts)
    )


def load_pins(path):
    try:
        pins = tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, tomllib.TOMLDecodeError) as error:
        raise ValidationError("invalid Arti pin metadata") from error
    required = {
        "name",
        "repository",
        "tag",
        "tag_object",
        "commit",
        "tree",
        "source_date_epoch",
        "subtree",
        "rust_version",
        "build_rustc",
        "build_cargo",
        "license",
        "source_sha256",
        "cargo_lock_sha256",
        "license_apache_sha256",
        "license_mit_sha256",
        "linux_x86_64_binary_sha256",
    }
    if (
        not isinstance(pins, dict)
        or set(pins) != required
        or pins["name"] != "Arti"
        or pins["repository"] != "https://gitlab.torproject.org/tpo/core/arti.git"
        or pins["tag"] != f"arti-v{VERSION}"
        or not COMMIT.fullmatch(str(pins["tag_object"]))
        or not COMMIT.fullmatch(str(pins["commit"]))
        or not COMMIT.fullmatch(str(pins["tree"]))
        or not isinstance(pins["source_date_epoch"], int)
        or pins["source_date_epoch"] < 315_532_800
        or pins["subtree"] != "third_party/arti"
        or pins["rust_version"] != "1.91"
        or not isinstance(pins["build_rustc"], str)
        or not pins["build_rustc"].startswith("rustc ")
        or not isinstance(pins["build_cargo"], str)
        or not pins["build_cargo"].startswith("cargo ")
        or pins["license"] != "MIT OR Apache-2.0"
        or any(
            not SHA256.fullmatch(str(pins[name]))
            for name in required
            if name.endswith("sha256")
        )
    ):
        raise ValidationError("invalid Arti pin metadata")
    return pins


def cargo_inventory(source_bytes, pins):
    name = f"arti-{VERSION}/Cargo.lock"
    try:
        with tarfile.open(fileobj=io.BytesIO(source_bytes), mode="r:xz") as archive:
            member = archive.getmember(name)
            if not member.isfile() or member.size > MAX_MEMBER_SIZE:
                raise ValidationError("invalid Cargo.lock in Arti source archive")
            stream = archive.extractfile(member)
            if stream is None:
                raise ValidationError("invalid Cargo.lock in Arti source archive")
            cargo_lock = stream.read(MAX_MEMBER_SIZE + 1)
        lock = tomllib.loads(cargo_lock.decode("utf-8"))
    except (
        KeyError,
        tarfile.TarError,
        UnicodeDecodeError,
        tomllib.TOMLDecodeError,
    ) as error:
        raise ValidationError("invalid Cargo.lock in Arti source archive") from error
    if (
        len(cargo_lock) > MAX_MEMBER_SIZE
        or sha256_bytes(cargo_lock) != pins["cargo_lock_sha256"]
        or not isinstance(lock, dict)
        or not isinstance(lock.get("package"), list)
    ):
        raise ValidationError("Cargo.lock differs from the release pin")
    components = []
    references = set()
    for package in lock["package"]:
        if not isinstance(package, dict):
            raise ValidationError("invalid package in Arti Cargo.lock")
        package_name = package.get("name")
        package_version = package.get("version")
        package_source = package.get("source")
        checksum = package.get("checksum")
        if (
            not isinstance(package_name, str)
            or not package_name
            or not isinstance(package_version, str)
            or not package_version
            or (package_source is not None and not isinstance(package_source, str))
            or (checksum is not None and not SHA256.fullmatch(str(checksum)))
        ):
            raise ValidationError("invalid package in Arti Cargo.lock")
        reference = f"pkg:cargo/{package_name}@{package_version}"
        if reference in references:
            raise ValidationError("duplicate package in Arti Cargo.lock")
        references.add(reference)
        component = {
            "type": "library",
            "bom-ref": reference,
            "name": package_name,
            "version": package_version,
            "purl": reference,
        }
        if checksum is not None:
            component["hashes"] = [{"alg": "SHA-256", "content": checksum}]
        if package_source is not None:
            component["properties"] = [
                {"name": "wildbuzzard:cargo-source", "value": package_source}
            ]
        components.append(component)
    return sorted(components, key=lambda component: component["bom-ref"])


def timestamp(pins):
    return datetime.datetime.fromtimestamp(
        pins["source_date_epoch"], datetime.timezone.utc
    )


def expected_sbom(pins, manifest, source_bytes):
    inventory = cargo_inventory(source_bytes, pins)
    properties = [
        {"name": "wildbuzzard:upstream-repository", "value": pins["repository"]},
        {"name": "wildbuzzard:upstream-tag", "value": pins["tag"]},
        {"name": "wildbuzzard:upstream-tag-object", "value": pins["tag_object"]},
        {"name": "wildbuzzard:upstream-commit", "value": pins["commit"]},
        {"name": "wildbuzzard:upstream-tree", "value": pins["tree"]},
        {"name": "wildbuzzard:cargo-lock-sha256", "value": pins["cargo_lock_sha256"]},
        {"name": "wildbuzzard:build-rustc", "value": pins["build_rustc"]},
        {"name": "wildbuzzard:build-cargo", "value": pins["build_cargo"]},
        {"name": "wildbuzzard:installed-path", "value": "runtime/tor/arti"},
        {"name": "wildbuzzard:cargo-package-count", "value": str(len(inventory))},
    ]
    return {
        "bomFormat": "CycloneDX",
        "specVersion": "1.6",
        "version": 1,
        "metadata": {
            "timestamp": timestamp(pins).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "component": {
                "type": "application",
                "bom-ref": f"wildbuzzard-arti-runtime-{VERSION}",
                "name": "Arti",
                "version": VERSION,
                "hashes": [{"alg": "SHA-256", "content": manifest["binary"]["sha256"]}],
                "licenses": [{"expression": pins["license"]}],
                "purl": f"pkg:cargo/arti@{VERSION}",
                "properties": properties,
            },
        },
        "components": [
            {
                "type": "file",
                "bom-ref": f"wildbuzzard-arti-source-{VERSION}",
                "name": f"wildbuzzard-arti-{VERSION}-source.tar.xz",
                "version": VERSION,
                "hashes": [{"alg": "SHA-256", "content": pins["source_sha256"]}],
                "licenses": [{"expression": pins["license"]}],
                "properties": [
                    {"name": "wildbuzzard:archive-path", "value": SOURCE},
                    {
                        "name": "wildbuzzard:corresponding-source-for",
                        "value": f"wildbuzzard-arti-runtime-{VERSION}",
                    },
                ],
            },
            *inventory,
        ],
    }


def manifest_document(pins, binary_bytes, config_bytes, source_bytes, members):
    if sha256_bytes(binary_bytes) != pins["linux_x86_64_binary_sha256"]:
        raise ValidationError("Arti binary differs from the release pin")
    if sha256_bytes(source_bytes) != pins["source_sha256"]:
        raise ValidationError("Arti corresponding source differs from the release pin")
    return {
        "schemaVersion": 1,
        "component": "arti",
        "semanticVersion": VERSION,
        "upstreamTag": pins["tag"],
        "upstreamTagObject": pins["tag_object"],
        "upstreamCommit": pins["commit"],
        "upstreamTree": pins["tree"],
        "upstreamCommitTimestamp": pins["source_date_epoch"],
        "minimumRustVersion": pins["rust_version"],
        "buildRustc": pins["build_rustc"],
        "buildCargo": pins["build_cargo"],
        "cargoLockSha256": pins["cargo_lock_sha256"],
        "platform": "linux",
        "architecture": "x86_64",
        "license": pins["license"],
        "binary": {
            "installedPath": "runtime/tor/arti",
            "sha256": sha256_bytes(binary_bytes),
            "size": len(binary_bytes),
            "executable": True,
        },
        "config": {
            "installedPath": "runtime/tor/arti.toml",
            "sha256": sha256_bytes(config_bytes),
            "size": len(config_bytes),
        },
        "correspondingSource": SOURCE,
        "sourceSha256": sha256_bytes(source_bytes),
        "sbom": SBOM,
        "licenseLocations": list(LICENSES),
        "files": [
            {
                "path": name,
                "size": len(value),
                "sha256": sha256_bytes(value),
                "executable": False,
            }
            for name, value in sorted(members.items())
        ],
    }


def provenance_bytes(pins, manifest_bytes, members):
    archive_buffer = io.BytesIO()
    zip_timestamp = timestamp(pins).timetuple()[:6]
    with zipfile.ZipFile(
        archive_buffer, "w", compression=zipfile.ZIP_STORED
    ) as archive:
        for name, value in [(MANIFEST, manifest_bytes), *sorted(members.items())]:
            entry = zipfile.ZipInfo(name, zip_timestamp)
            entry.create_system = 3
            entry.external_attr = (stat.S_IFREG | 0o644) << 16
            entry.compress_type = zipfile.ZIP_STORED
            entry.flag_bits = 0x800
            archive.writestr(entry, value)
    return archive_buffer.getvalue()


def create(binary, config, source, output, epoch):
    pins = load_pins(config)
    if epoch != pins["source_date_epoch"]:
        raise ValidationError("Arti source timestamp differs from the release pin")
    if not binary.lstat().st_mode & 0o111:
        raise ValidationError("Arti binary is not executable")
    source_root = config.parents[2]
    license_apache = file_bytes(source_root / "third_party/arti/LICENSE-APACHE")
    license_mit = file_bytes(source_root / "third_party/arti/LICENSE-MIT")
    if sha256_bytes(license_apache) != pins["license_apache_sha256"]:
        raise ValidationError("Arti Apache license differs from the release pin")
    if sha256_bytes(license_mit) != pins["license_mit_sha256"]:
        raise ValidationError("Arti MIT license differs from the release pin")
    binary_bytes = file_bytes(binary)
    config_bytes = file_bytes(config)
    source_bytes = file_bytes(source)
    members = {
        SOURCE: source_bytes,
        LICENSES[0]: license_apache,
        LICENSES[1]: license_mit,
    }
    preliminary = manifest_document(
        pins, binary_bytes, config_bytes, source_bytes, members
    )
    members[SBOM] = (
        json.dumps(
            expected_sbom(pins, preliminary, source_bytes),
            indent=2,
            sort_keys=True,
        )
        + "\n"
    ).encode()
    manifest = manifest_document(
        pins, binary_bytes, config_bytes, source_bytes, members
    )
    manifest_bytes = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode()
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(output.name + ".tmp")
    temporary.write_bytes(provenance_bytes(pins, manifest_bytes, members))
    os.replace(temporary, output)
    validate(binary, config, config, output)
    return manifest


def archive_member(archive, name):
    try:
        entry = archive.getinfo(name)
    except KeyError as error:
        raise ValidationError(f"Arti provenance member is missing: {name}") from error
    if entry.is_dir() or entry.file_size > MAX_MEMBER_SIZE:
        raise ValidationError(f"invalid Arti provenance member: {name}")
    return archive.read(entry)


def validate(binary, pin_config, installed_config, provenance):
    pins = load_pins(pin_config)
    if not binary.lstat().st_mode & 0o111:
        raise ValidationError("Arti binary is not executable")
    binary_bytes = file_bytes(binary)
    pin_config_bytes = file_bytes(pin_config)
    installed_config_bytes = file_bytes(installed_config)
    if installed_config_bytes != pin_config_bytes:
        raise ValidationError(
            "installed Arti pin metadata differs from the release pin"
        )
    if sha256_bytes(binary_bytes) != pins["linux_x86_64_binary_sha256"]:
        raise ValidationError("Arti binary differs from the release pin")
    archive_bytes = file_bytes(provenance, MAX_ARCHIVE_SIZE)
    try:
        with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
            entries = archive.infolist()
            names = [entry.filename for entry in entries]
            expected_names = {MANIFEST, SOURCE, SBOM, *LICENSES}
            if (
                len(names) != len(set(names))
                or set(names) != expected_names
                or any(
                    not safe_path(entry.filename)
                    or entry.is_dir()
                    or entry.flag_bits & 1
                    or entry.compress_type != zipfile.ZIP_STORED
                    or entry.create_system != 3
                    or stat.S_IFMT(entry.external_attr >> 16) != stat.S_IFREG
                    or (entry.external_attr >> 16) & 0o777 != 0o644
                    for entry in entries
                )
            ):
                raise ValidationError("invalid Arti provenance archive layout")
            manifest = json.loads(archive_member(archive, MANIFEST))
            members = {
                name: archive_member(archive, name)
                for name in expected_names
                if name != MANIFEST
            }
    except (
        OSError,
        UnicodeDecodeError,
        json.JSONDecodeError,
        zipfile.BadZipFile,
    ) as error:
        raise ValidationError("invalid Arti provenance archive") from error
    expected_manifest = manifest_document(
        pins,
        binary_bytes,
        pin_config_bytes,
        members[SOURCE],
        members,
    )
    if manifest != expected_manifest:
        raise ValidationError("Arti provenance manifest differs from the release pin")
    if sha256_bytes(members[SOURCE]) != pins["source_sha256"]:
        raise ValidationError("Arti corresponding source differs from the release pin")
    if sha256_bytes(members[LICENSES[0]]) != pins["license_apache_sha256"]:
        raise ValidationError("Arti Apache license differs from the release pin")
    if sha256_bytes(members[LICENSES[1]]) != pins["license_mit_sha256"]:
        raise ValidationError("Arti MIT license differs from the release pin")
    try:
        sbom = json.loads(members[SBOM])
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValidationError("invalid Arti SBOM") from error
    if sbom != expected_sbom(pins, manifest, members[SOURCE]):
        raise ValidationError("Arti SBOM differs from the release pin")
    expected_members = dict(members)
    expected_members[SBOM] = (
        json.dumps(
            expected_sbom(pins, expected_manifest, members[SOURCE]),
            indent=2,
            sort_keys=True,
        )
        + "\n"
    ).encode()
    expected_manifest_bytes = (
        json.dumps(expected_manifest, indent=2, sort_keys=True) + "\n"
    ).encode()
    if archive_bytes != provenance_bytes(
        pins, expected_manifest_bytes, expected_members
    ):
        raise ValidationError("Arti provenance archive encoding is not canonical")
    return manifest


def main():
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    create_parser = subparsers.add_parser("create")
    create_parser.add_argument("--binary", required=True, type=Path)
    create_parser.add_argument("--config", required=True, type=Path)
    create_parser.add_argument("--source", required=True, type=Path)
    create_parser.add_argument("--output", required=True, type=Path)
    create_parser.add_argument("--source-date-epoch", required=True, type=int)
    validate_parser = subparsers.add_parser("validate")
    validate_parser.add_argument("--binary", required=True, type=Path)
    validate_parser.add_argument("--pin-config", required=True, type=Path)
    validate_parser.add_argument("--installed-config", required=True, type=Path)
    validate_parser.add_argument("--provenance", required=True, type=Path)
    args = parser.parse_args()
    try:
        if args.command == "create":
            create(
                args.binary,
                args.config,
                args.source,
                args.output,
                args.source_date_epoch,
            )
        else:
            validate(
                args.binary,
                args.pin_config,
                args.installed_config,
                args.provenance,
            )
    except (OSError, ValidationError) as error:
        print(f"Arti provenance validation failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
