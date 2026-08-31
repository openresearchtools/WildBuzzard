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
import zipfile
from pathlib import Path, PurePosixPath

import tomllib

VERSION = "2.5.1"
MANIFEST = "wildbuzzard-arti-runtime.json"
ARTI_SOURCE = f"wildbuzzard-arti-{VERSION}-source.tar.xz"
CARGO_VENDOR_SOURCE = f"wildbuzzard-arti-{VERSION}-cargo-vendor.tar.xz"
SBOM = f"sbom/wildbuzzard-arti-{VERSION}.cdx.json"
LICENSES = ("licenses/LICENSE-APACHE", "licenses/LICENSE-MIT")
INVENTORY_INSTALL_PATH = "notices/arti-crates/THIRD-PARTY.json"
MAX_ARCHIVE_SIZE = 16 * 1024 * 1024
MAX_BINARY_SIZE = 64 * 1024 * 1024
MAX_MEMBER_SIZE = 8 * 1024 * 1024
SHA256 = re.compile(r"^[a-f0-9]{64}$")
COMMIT = re.compile(r"^[a-f0-9]{40}$")


class ValidationError(ValueError):
    pass


def sha256_bytes(value):
    return hashlib.sha256(value).hexdigest()


def sha256_file(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def file_bytes(path, maximum=MAX_MEMBER_SIZE):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > maximum:
        raise ValidationError(f"unsafe Arti input: {path}")
    return path.read_bytes()


def source_artifact(path, expected_name, expected_digest):
    info = path.lstat()
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_nlink != 1
        or path.name != expected_name
        or sha256_file(path) != expected_digest
    ):
        raise ValidationError(
            f"Arti source artifact differs from its release pin: {path}"
        )


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
        "cargo_vendor_sha256",
        "cargo_license_inventory_sha256",
        "license_apache_sha256",
        "license_mit_sha256",
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


def cargo_inventory(path, pins):
    contents = file_bytes(path)
    if sha256_bytes(contents) != pins["cargo_license_inventory_sha256"]:
        raise ValidationError("Arti crate inventory differs from the release pin")
    try:
        inventory = json.loads(contents)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValidationError("invalid Arti crate inventory") from error
    if contents != (json.dumps(inventory, indent=2, sort_keys=True) + "\n").encode():
        raise ValidationError("Arti crate inventory is not canonical JSON")
    if (
        not isinstance(inventory, dict)
        or set(inventory) != {"schema", "cargoLock", "sourceArtifacts", "packages"}
        or inventory["schema"] != 1
        or inventory["cargoLock"]
        != {"path": "Cargo.lock", "sha256": pins["cargo_lock_sha256"]}
        or inventory["sourceArtifacts"]
        != {
            "arti": {"file": ARTI_SOURCE, "sha256": pins["source_sha256"]},
            "cargoVendor": {
                "file": CARGO_VENDOR_SOURCE,
                "sha256": pins["cargo_vendor_sha256"],
            },
        }
        or not isinstance(inventory["packages"], list)
        or not inventory["packages"]
    ):
        raise ValidationError("invalid Arti crate inventory")
    components = []
    references = set()
    package_fields = {
        "cargoChecksum",
        "cargoSource",
        "homepage",
        "license",
        "licenseFile",
        "licenseFiles",
        "name",
        "repository",
        "sourceArtifact",
        "sourceDirectory",
        "version",
    }
    for package in inventory["packages"]:
        if not isinstance(package, dict) or set(package) != package_fields:
            raise ValidationError("invalid package in Arti crate inventory")
        name = package["name"]
        version = package["version"]
        if not isinstance(name, str) or not isinstance(version, str):
            raise ValidationError("invalid package in Arti crate inventory")
        reference = f"pkg:cargo/{name}@{version}"
        if reference in references:
            raise ValidationError("duplicate package in Arti crate inventory")
        references.add(reference)
        source_name = inventory["sourceArtifacts"][package["sourceArtifact"]]["file"]
        component = {
            "type": "library",
            "bom-ref": reference,
            "name": name,
            "version": version,
            "purl": reference,
            "properties": [
                {
                    "name": "wildbuzzard:corresponding-source-artifact",
                    "value": source_name,
                },
                {
                    "name": "wildbuzzard:source-directory",
                    "value": package["sourceDirectory"],
                },
            ],
        }
        if package["license"] is not None:
            component["licenses"] = [{"expression": package["license"]}]
        else:
            component["licenses"] = [{"license": {"name": package["licenseFile"]}}]
        if package["cargoChecksum"] is not None:
            component["hashes"] = [
                {"alg": "SHA-256", "content": package["cargoChecksum"]}
            ]
        if package["cargoSource"] is not None:
            component["properties"].append({
                "name": "wildbuzzard:cargo-source",
                "value": package["cargoSource"],
            })
        components.append(component)
    return inventory, sorted(components, key=lambda component: component["bom-ref"])


def timestamp(pins):
    return datetime.datetime.fromtimestamp(
        pins["source_date_epoch"], datetime.timezone.utc
    )


def external_sources(pins):
    return [
        {
            "name": ARTI_SOURCE,
            "sha256": pins["source_sha256"],
            "scope": "Arti workspace and local Cargo packages",
        },
        {
            "name": CARGO_VENDOR_SOURCE,
            "sha256": pins["cargo_vendor_sha256"],
            "scope": "Cargo registry packages locked by Arti Cargo.lock",
        },
    ]


def expected_sbom(pins, manifest, inventory_path):
    _, components = cargo_inventory(inventory_path, pins)
    properties = [
        {"name": "wildbuzzard:upstream-repository", "value": pins["repository"]},
        {"name": "wildbuzzard:upstream-tag", "value": pins["tag"]},
        {"name": "wildbuzzard:upstream-tag-object", "value": pins["tag_object"]},
        {"name": "wildbuzzard:upstream-commit", "value": pins["commit"]},
        {"name": "wildbuzzard:upstream-tree", "value": pins["tree"]},
        {"name": "wildbuzzard:cargo-lock-sha256", "value": pins["cargo_lock_sha256"]},
        {
            "name": "wildbuzzard:cargo-license-inventory-sha256",
            "value": pins["cargo_license_inventory_sha256"],
        },
        {"name": "wildbuzzard:build-rustc", "value": pins["build_rustc"]},
        {"name": "wildbuzzard:build-cargo", "value": pins["build_cargo"]},
        {"name": "wildbuzzard:installed-path", "value": "runtime/tor/arti"},
        {"name": "wildbuzzard:cargo-package-count", "value": str(len(components))},
    ]
    source_components = [
        {
            "type": "file",
            "bom-ref": f"wildbuzzard-arti-source-{index}",
            "name": source["name"],
            "version": VERSION,
            "hashes": [{"alg": "SHA-256", "content": source["sha256"]}],
            "properties": [
                {
                    "name": "wildbuzzard:corresponding-source-for",
                    "value": f"wildbuzzard-arti-runtime-{VERSION}",
                },
                {"name": "wildbuzzard:source-scope", "value": source["scope"]},
            ],
        }
        for index, source in enumerate(external_sources(pins), 1)
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
        "components": [*source_components, *components],
    }


def manifest_document(pins, binary_bytes, config_bytes, inventory_path, members):
    inventory, _ = cargo_inventory(inventory_path, pins)
    return {
        "schemaVersion": 2,
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
        "cargoLicenseInventory": {
            "installedPath": INVENTORY_INSTALL_PATH,
            "sha256": pins["cargo_license_inventory_sha256"],
            "packageCount": len(inventory["packages"]),
        },
        "externalSourceArtifacts": external_sources(pins),
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


def create(
    binary,
    config,
    source,
    cargo_vendor,
    inventory,
    output,
    epoch,
    source_root=None,
):
    pins = load_pins(config)
    if epoch != pins["source_date_epoch"]:
        raise ValidationError("Arti source timestamp differs from the release pin")
    if not binary.lstat().st_mode & 0o111:
        raise ValidationError("Arti binary is not executable")
    source_artifact(source, ARTI_SOURCE, pins["source_sha256"])
    source_artifact(cargo_vendor, CARGO_VENDOR_SOURCE, pins["cargo_vendor_sha256"])
    source_root = source_root or config.parents[2]
    license_apache = file_bytes(source_root / "third_party/arti/LICENSE-APACHE")
    license_mit = file_bytes(source_root / "third_party/arti/LICENSE-MIT")
    if sha256_bytes(license_apache) != pins["license_apache_sha256"]:
        raise ValidationError("Arti Apache license differs from the release pin")
    if sha256_bytes(license_mit) != pins["license_mit_sha256"]:
        raise ValidationError("Arti MIT license differs from the release pin")
    binary_bytes = file_bytes(binary, MAX_BINARY_SIZE)
    config_bytes = file_bytes(config)
    members = {LICENSES[0]: license_apache, LICENSES[1]: license_mit}
    preliminary = manifest_document(
        pins, binary_bytes, config_bytes, inventory, members
    )
    members[SBOM] = (
        json.dumps(
            expected_sbom(pins, preliminary, inventory), indent=2, sort_keys=True
        )
        + "\n"
    ).encode()
    manifest = manifest_document(pins, binary_bytes, config_bytes, inventory, members)
    manifest_bytes = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode()
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(output.name + ".tmp")
    temporary.write_bytes(provenance_bytes(pins, manifest_bytes, members))
    os.replace(temporary, output)
    validate(binary, config, config, inventory, output)
    return manifest


def archive_member(archive, name):
    try:
        entry = archive.getinfo(name)
    except KeyError as error:
        raise ValidationError(f"Arti provenance member is missing: {name}") from error
    if entry.is_dir() or entry.file_size > MAX_MEMBER_SIZE:
        raise ValidationError(f"invalid Arti provenance member: {name}")
    return archive.read(entry)


def validate(binary, pin_config, installed_config, inventory, provenance):
    pins = load_pins(pin_config)
    if not binary.lstat().st_mode & 0o111:
        raise ValidationError("Arti binary is not executable")
    binary_bytes = file_bytes(binary, MAX_BINARY_SIZE)
    pin_config_bytes = file_bytes(pin_config)
    installed_config_bytes = file_bytes(installed_config)
    if installed_config_bytes != pin_config_bytes:
        raise ValidationError(
            "installed Arti pin metadata differs from the release pin"
        )
    cargo_inventory(inventory, pins)
    archive_bytes = file_bytes(provenance, MAX_ARCHIVE_SIZE)
    try:
        with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
            entries = archive.infolist()
            names = [entry.filename for entry in entries]
            expected_names = {MANIFEST, SBOM, *LICENSES}
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
    if manifest.get("binary", {}).get("sha256") != sha256_bytes(binary_bytes):
        raise ValidationError("Arti binary differs from its provenance")
    expected_manifest = manifest_document(
        pins, binary_bytes, pin_config_bytes, inventory, members
    )
    if manifest != expected_manifest:
        raise ValidationError("Arti provenance manifest differs from the release pin")
    if sha256_bytes(members[LICENSES[0]]) != pins["license_apache_sha256"]:
        raise ValidationError("Arti Apache license differs from the release pin")
    if sha256_bytes(members[LICENSES[1]]) != pins["license_mit_sha256"]:
        raise ValidationError("Arti MIT license differs from the release pin")
    try:
        sbom = json.loads(members[SBOM])
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValidationError("invalid Arti SBOM") from error
    if sbom != expected_sbom(pins, manifest, inventory):
        raise ValidationError("Arti SBOM differs from the release pin")
    expected_members = dict(members)
    expected_members[SBOM] = (
        json.dumps(
            expected_sbom(pins, expected_manifest, inventory), indent=2, sort_keys=True
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
    create_parser.add_argument("--cargo-vendor", required=True, type=Path)
    create_parser.add_argument("--inventory", required=True, type=Path)
    create_parser.add_argument("--output", required=True, type=Path)
    create_parser.add_argument("--source-date-epoch", required=True, type=int)
    create_parser.add_argument("--source-root", type=Path)
    validate_parser = subparsers.add_parser("validate")
    validate_parser.add_argument("--binary", required=True, type=Path)
    validate_parser.add_argument("--pin-config", required=True, type=Path)
    validate_parser.add_argument("--installed-config", required=True, type=Path)
    validate_parser.add_argument("--inventory", required=True, type=Path)
    validate_parser.add_argument("--provenance", required=True, type=Path)
    args = parser.parse_args()
    try:
        if args.command == "create":
            create(
                args.binary,
                args.config,
                args.source,
                args.cargo_vendor,
                args.inventory,
                args.output,
                args.source_date_epoch,
                args.source_root,
            )
        else:
            validate(
                args.binary,
                args.pin_config,
                args.installed_config,
                args.inventory,
                args.provenance,
            )
    except (OSError, ValidationError) as error:
        print(f"Arti provenance validation failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
