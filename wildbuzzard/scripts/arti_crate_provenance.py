#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later

import argparse
import hashlib
import json
import lzma
import os
import re
import stat
import tarfile
import tempfile
from pathlib import Path, PurePosixPath

import tomllib

VERSION = "2.5.1"
VENDOR_ARCHIVE = f"wildbuzzard-arti-{VERSION}-cargo-vendor.tar.xz"
VENDOR_ARCHIVE_ROOT = f"wildbuzzard-arti-{VERSION}-cargo-vendor"
ARTI_ARCHIVE = f"wildbuzzard-arti-{VERSION}-source.tar.xz"
REGISTRY_SOURCE = "registry+https://github.com/rust-lang/crates.io-index"
SHA256_PATTERN = re.compile(r"[0-9a-f]{64}")
NAME_PATTERN = re.compile(r"[A-Za-z0-9_-]+")
VERSION_PATTERN = re.compile(r"[A-Za-z0-9.+_-]+")
LEGAL_PREFIXES = (
    "AGPL",
    "COPYING",
    "COPYRIGHT",
    "GPL",
    "LGPL",
    "LICENCE",
    "LICENSE",
    "NOTICE",
    "NOTICES",
    "UNLICENSE",
)
SOURCE_ROOT = Path(__file__).resolve().parents[2]
ARTI_ROOT = SOURCE_ROOT / "third_party" / "arti"
LEGAL_ROOT = SOURCE_ROOT / "wildbuzzard" / "third_party" / "arti-crates"
PIN_PATH = SOURCE_ROOT / "wildbuzzard" / "third_party" / "arti.toml"


class ValidationError(Exception):
    pass


def sha256_bytes(value):
    return hashlib.sha256(value).hexdigest()


def sha256_file(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def strict_object(pairs):
    value = {}
    for name, entry in pairs:
        if name in value:
            raise ValidationError(f"duplicate JSON field: {name}")
        value[name] = entry
    return value


def exact_keys(value, expected, context):
    if not isinstance(value, dict) or set(value) != set(expected):
        raise ValidationError(f"invalid fields for {context}")


def regular_file(path, context):
    try:
        info = path.lstat()
    except FileNotFoundError as error:
        raise ValidationError(f"missing {context}: {path}") from error
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ValidationError(f"unsafe {context}: {path}")


def regular_directory(path, context):
    try:
        info = path.lstat()
    except FileNotFoundError as error:
        raise ValidationError(f"missing {context}: {path}") from error
    if not stat.S_ISDIR(info.st_mode):
        raise ValidationError(f"unsafe {context}: {path}")


def require_string(value, context, pattern=None):
    if not isinstance(value, str) or not value:
        raise ValidationError(f"invalid {context}")
    if pattern is not None and pattern.fullmatch(value) is None:
        raise ValidationError(f"invalid {context}: {value}")
    return value


def optional_string(value, context):
    if value is not None and (not isinstance(value, str) or not value):
        raise ValidationError(f"invalid {context}")
    return value


def relative_path(value, context):
    require_string(value, context)
    path = PurePosixPath(value)
    if (
        "\\" in value
        or path.is_absolute()
        or ".." in path.parts
        or path.as_posix() != value
        or any(part in ("", ".") for part in path.parts)
    ):
        raise ValidationError(f"invalid {context}: {value}")
    return path


def load_pins(path):
    regular_file(path, "Arti pin metadata")
    try:
        pins = tomllib.loads(path.read_text(encoding="utf-8"))
    except (UnicodeDecodeError, tomllib.TOMLDecodeError) as error:
        raise ValidationError("invalid Arti pin metadata") from error
    for field in (
        "source_sha256",
        "cargo_lock_sha256",
        "cargo_vendor_sha256",
        "cargo_license_inventory_sha256",
    ):
        require_string(pins.get(field), f"Arti {field}", SHA256_PATTERN)
    return pins


def load_inventory(path, pins):
    regular_file(path, "Arti crate inventory")
    contents = path.read_bytes()
    try:
        value = json.loads(contents, object_pairs_hook=strict_object)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValidationError("invalid Arti crate inventory") from error
    if contents != (json.dumps(value, indent=2, sort_keys=True) + "\n").encode():
        raise ValidationError("Arti crate inventory is not canonical JSON")
    if sha256_bytes(contents) != pins["cargo_license_inventory_sha256"]:
        raise ValidationError("Arti crate inventory differs from the release pin")
    exact_keys(
        value,
        {"schema", "cargoLock", "sourceArtifacts", "packages"},
        "Arti crate inventory",
    )
    if value["schema"] != 1:
        raise ValidationError("unsupported Arti crate inventory schema")
    exact_keys(value["cargoLock"], {"path", "sha256"}, "Arti Cargo.lock")
    if (
        value["cargoLock"]["path"] != "Cargo.lock"
        or value["cargoLock"]["sha256"] != pins["cargo_lock_sha256"]
    ):
        raise ValidationError("Arti crate inventory has the wrong Cargo.lock")
    exact_keys(value["sourceArtifacts"], {"arti", "cargoVendor"}, "source artifacts")
    expected_artifacts = {
        "arti": (ARTI_ARCHIVE, pins["source_sha256"]),
        "cargoVendor": (VENDOR_ARCHIVE, pins["cargo_vendor_sha256"]),
    }
    for name, (filename, digest) in expected_artifacts.items():
        artifact = value["sourceArtifacts"][name]
        exact_keys(artifact, {"file", "sha256"}, f"{name} source artifact")
        if artifact != {"file": filename, "sha256": digest}:
            raise ValidationError(f"invalid {name} source artifact")
    if not isinstance(value["packages"], list) or not value["packages"]:
        raise ValidationError("Arti crate inventory is empty")
    return value


def lock_packages(path, expected_digest):
    regular_file(path, "Arti Cargo.lock")
    if sha256_file(path) != expected_digest:
        raise ValidationError("Arti Cargo.lock differs from the release pin")
    try:
        lock = tomllib.loads(path.read_text(encoding="utf-8"))
    except (UnicodeDecodeError, tomllib.TOMLDecodeError) as error:
        raise ValidationError("invalid Arti Cargo.lock") from error
    packages = []
    for package in lock.get("package", []):
        if not isinstance(package, dict):
            raise ValidationError("invalid package in Arti Cargo.lock")
        name = require_string(package.get("name"), "Cargo package name", NAME_PATTERN)
        version = require_string(
            package.get("version"), "Cargo package version", VERSION_PATTERN
        )
        source = package.get("source")
        checksum = package.get("checksum")
        if source is None:
            if checksum is not None:
                raise ValidationError(f"unexpected checksum for local crate {name}")
            source_kind = "arti"
        else:
            if source != REGISTRY_SOURCE or not isinstance(checksum, str):
                raise ValidationError(f"unsupported Cargo source for {name}")
            require_string(checksum, f"{name} checksum", SHA256_PATTERN)
            source_kind = "cargoVendor"
        packages.append({
            "cargoChecksum": checksum,
            "cargoSource": source,
            "name": name,
            "sourceArtifact": source_kind,
            "version": version,
        })
    identities = [(entry["name"], entry["version"]) for entry in packages]
    if len(identities) != len(set(identities)):
        raise ValidationError("Arti Cargo.lock packages must be unique")
    return sorted(packages, key=lambda entry: (entry["name"], entry["version"]))


def manifest_metadata(path, name, version):
    regular_file(path, f"{name} Cargo.toml")
    try:
        package = tomllib.loads(path.read_text(encoding="utf-8"))["package"]
    except (KeyError, UnicodeDecodeError, tomllib.TOMLDecodeError) as error:
        raise ValidationError(f"invalid Cargo.toml for {name}") from error
    if package.get("name") != name or package.get("version") != version:
        raise ValidationError(f"Cargo.toml identity mismatch for {name} {version}")
    license_expression = optional_string(package.get("license"), f"{name} license")
    license_file = optional_string(package.get("license-file"), f"{name} license-file")
    if bool(license_expression) == bool(license_file):
        raise ValidationError(
            f"{name} must declare exactly one of license or license-file"
        )
    repository = optional_string(package.get("repository"), f"{name} repository")
    homepage = optional_string(package.get("homepage"), f"{name} homepage")
    return {
        "homepage": homepage,
        "license": license_expression,
        "licenseFile": license_file,
        "repository": repository,
    }


def local_manifest_paths(source_root, identities):
    paths = {}
    for path in source_root.rglob("Cargo.toml"):
        relative = path.relative_to(source_root)
        if any(part in {".git", "target"} for part in relative.parts):
            continue
        regular_file(path, "local Cargo.toml")
        try:
            package = tomllib.loads(path.read_text(encoding="utf-8")).get("package")
        except (UnicodeDecodeError, tomllib.TOMLDecodeError) as error:
            raise ValidationError(f"invalid local Cargo.toml: {relative}") from error
        if not isinstance(package, dict):
            continue
        identity = (package.get("name"), package.get("version"))
        if identity not in identities:
            continue
        if identity in paths:
            raise ValidationError(f"duplicate local Cargo package: {identity}")
        paths[identity] = relative.as_posix()
    if set(paths) != identities:
        missing = sorted(identities - set(paths))
        raise ValidationError(f"local Cargo manifests are incomplete: {missing}")
    return paths


def is_legal_filename(name):
    upper = name.upper()
    return any(
        upper == prefix
        or upper.startswith(prefix + "-")
        or upper.startswith(prefix + ".")
        or upper.startswith(prefix + "_")
        for prefix in LEGAL_PREFIXES
    )


def safe_source_tree_files(root, context):
    regular_directory(root, context)
    files = []
    for path in root.rglob("*"):
        info = path.lstat()
        if stat.S_ISDIR(info.st_mode):
            continue
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise ValidationError(f"unsafe {context} entry: {path}")
        files.append(path)
    return sorted(files, key=lambda path: path.relative_to(root).as_posix())


def legal_files(root, relative_base):
    files = []
    for path in root.rglob("*"):
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode):
            if is_legal_filename(path.name):
                raise ValidationError(f"unsafe crate legal file: {path}")
            continue
        if stat.S_ISDIR(info.st_mode):
            continue
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise ValidationError(f"unsafe crate source entry: {path}")
        if is_legal_filename(path.name):
            files.append((relative_base / path.relative_to(root)).as_posix())
    return sorted(files)


def verify_vendor_package(directory, locked):
    regular_directory(directory, f"vendored crate {locked['name']}")
    checksum_path = directory / ".cargo-checksum.json"
    regular_file(checksum_path, f"{locked['name']} Cargo checksum metadata")
    try:
        checksum = json.loads(
            checksum_path.read_bytes(), object_pairs_hook=strict_object
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValidationError(
            f"invalid Cargo checksum metadata for {locked['name']}"
        ) from error
    exact_keys(checksum, {"files", "package"}, f"{locked['name']} checksum metadata")
    if checksum["package"] != locked["cargoChecksum"] or not isinstance(
        checksum["files"], dict
    ):
        raise ValidationError(f"package checksum mismatch for {locked['name']}")
    expected_files = {}
    for name, digest in checksum["files"].items():
        relative_path(name, f"{locked['name']} checksum path")
        require_string(digest, f"{locked['name']} file checksum", SHA256_PATTERN)
        expected_files[name] = digest
    actual = {}
    for path in safe_source_tree_files(directory, f"vendored crate {locked['name']}"):
        relative = path.relative_to(directory).as_posix()
        if relative != ".cargo-checksum.json":
            actual[relative] = sha256_file(path)
    if actual != expected_files:
        raise ValidationError(
            f"vendored file set or digest mismatch for {locked['name']}"
        )


def package_documents(source_root, vendor_root, locked_packages):
    local_identities = {
        (entry["name"], entry["version"])
        for entry in locked_packages
        if entry["sourceArtifact"] == "arti"
    }
    local_paths = local_manifest_paths(source_root, local_identities)
    if vendor_root is not None:
        regular_directory(vendor_root, "Cargo vendor directory")
        expected_vendor = {
            f"{entry['name']}-{entry['version']}"
            for entry in locked_packages
            if entry["sourceArtifact"] == "cargoVendor"
        }
        actual_vendor = {
            path.name
            for path in vendor_root.iterdir()
            if path.is_dir() and not path.is_symlink()
        }
        if actual_vendor != expected_vendor or any(
            not path.is_dir() or path.is_symlink() for path in vendor_root.iterdir()
        ):
            raise ValidationError(
                "Cargo vendor directory does not exactly match Cargo.lock"
            )
    documents = []
    for locked in locked_packages:
        identity = (locked["name"], locked["version"])
        if locked["sourceArtifact"] == "cargoVendor":
            if vendor_root is None:
                documents.append(None)
                continue
            directory = vendor_root / f"{locked['name']}-{locked['version']}"
            verify_vendor_package(directory, locked)
            manifest_path = directory / "Cargo.toml"
            source_directory = directory.name
            legal = legal_files(directory, PurePosixPath(directory.name))
        else:
            manifest_relative = local_paths[identity]
            manifest_path = source_root / manifest_relative
            source_directory = PurePosixPath(manifest_relative).parent.as_posix()
            directory = manifest_path.parent
            legal = legal_files(directory, PurePosixPath(source_directory))
        metadata = manifest_metadata(manifest_path, locked["name"], locked["version"])
        if metadata["licenseFile"]:
            declared = (
                PurePosixPath(source_directory) / metadata["licenseFile"]
            ).as_posix()
            relative_path(declared, f"{locked['name']} license-file")
            if declared not in legal:
                raise ValidationError(
                    f"declared license-file is missing for {locked['name']}"
                )
        if locked["sourceArtifact"] == "arti" and not legal:
            if metadata["license"] != "MIT OR Apache-2.0":
                raise ValidationError(
                    f"local license files are missing for {locked['name']}"
                )
            legal = ["LICENSE-APACHE", "LICENSE-MIT"]
        documents.append({
            **locked,
            **metadata,
            "licenseFiles": legal,
            "sourceDirectory": source_directory,
        })
    return documents


def checked_package(entry, context):
    exact_keys(
        entry,
        {
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
        },
        context,
    )
    name = require_string(entry["name"], f"{context} name", NAME_PATTERN)
    require_string(entry["version"], f"{name} version", VERSION_PATTERN)
    if entry["sourceArtifact"] not in {"arti", "cargoVendor"}:
        raise ValidationError(f"invalid source artifact for {name}")
    optional_string(entry["cargoSource"], f"{name} Cargo source")
    optional_string(entry["cargoChecksum"], f"{name} Cargo checksum")
    optional_string(entry["homepage"], f"{name} homepage")
    optional_string(entry["repository"], f"{name} repository")
    license_expression = optional_string(entry["license"], f"{name} license")
    license_file = optional_string(entry["licenseFile"], f"{name} license-file")
    if bool(license_expression) == bool(license_file):
        raise ValidationError(f"invalid license metadata for {name}")
    relative_path(entry["sourceDirectory"], f"{name} source directory")
    if not isinstance(entry["licenseFiles"], list):
        raise ValidationError(f"invalid license file list for {name}")
    return name


def validate_inventory(lock_path, inventory_path, license_root, pins_path):
    pins = load_pins(pins_path)
    inventory = load_inventory(inventory_path, pins)
    locked = lock_packages(lock_path, pins["cargo_lock_sha256"])
    expected = {(entry["name"], entry["version"]): entry for entry in locked}
    identities = []
    installed = {}
    for package in inventory["packages"]:
        name = checked_package(package, "Arti crate")
        identity = (name, package["version"])
        identities.append(identity)
        locked_package = expected.get(identity)
        if locked_package is None or any(
            package[field] != locked_package[field]
            for field in (
                "cargoChecksum",
                "cargoSource",
                "name",
                "sourceArtifact",
                "version",
            )
        ):
            raise ValidationError(f"inventory does not match Cargo.lock for {identity}")
        seen = set()
        for legal in package["licenseFiles"]:
            exact_keys(
                legal,
                {"installedPath", "sha256", "sourcePath"},
                f"{name} license file",
            )
            source_path = relative_path(legal["sourcePath"], f"{name} license path")
            installed_path = relative_path(
                legal["installedPath"], f"{name} installed license path"
            )
            if (
                len(installed_path.parts) != 2
                or installed_path.parts[0] != "licenses"
                or installed_path.suffix != ".txt"
            ):
                raise ValidationError(f"invalid installed license path for {name}")
            digest = require_string(
                legal["sha256"], f"{name} license digest", SHA256_PATTERN
            )
            if source_path.as_posix() in seen:
                raise ValidationError(f"duplicate license path for {name}")
            seen.add(source_path.as_posix())
            path = license_root.parent / installed_path
            regular_file(path, f"{name} installed license")
            if sha256_file(path) != digest:
                raise ValidationError(f"installed license digest mismatch for {name}")
            previous = installed.setdefault(installed_path.as_posix(), digest)
            if previous != digest:
                raise ValidationError("conflicting installed license digest")
        if [entry["sourcePath"] for entry in package["licenseFiles"]] != sorted(seen):
            raise ValidationError(f"license files are not sorted for {name}")
    if identities != sorted(set(identities)) or set(identities) != set(expected):
        raise ValidationError("Arti crate inventory does not exactly cover Cargo.lock")
    regular_directory(license_root, "Arti crate license directory")
    actual = {
        path.relative_to(license_root.parent).as_posix()
        for path in safe_source_tree_files(license_root, "Arti crate licenses")
    }
    if actual != set(installed):
        raise ValidationError("Arti crate license directory has missing or extra files")
    return inventory


def compare_source_metadata(
    source_root, vendor_root, inventory, lock_path, installed_license_root
):
    locked = lock_packages(lock_path, inventory["cargoLock"]["sha256"])
    discovered = package_documents(source_root, vendor_root, locked)
    for expected, actual in zip(inventory["packages"], discovered, strict=True):
        if actual is None:
            continue
        actual_legal = actual.pop("licenseFiles")
        expected_without_legal = dict(expected)
        expected_legal = expected_without_legal.pop("licenseFiles")
        if actual != expected_without_legal:
            raise ValidationError(
                f"source metadata differs for {expected['name']} {expected['version']}"
            )
        expected_paths = [entry["sourcePath"] for entry in expected_legal]
        if actual_legal != expected_paths:
            raise ValidationError(f"source license list differs for {expected['name']}")
        source_base = (
            vendor_root if expected["sourceArtifact"] == "cargoVendor" else source_root
        )
        for legal in expected_legal:
            source_path = source_base / legal["sourcePath"]
            regular_file(source_path, f"{expected['name']} source license")
            installed_path = installed_license_root.parent / legal["installedPath"]
            if (
                sha256_file(source_path) != legal["sha256"]
                or source_path.read_bytes() != installed_path.read_bytes()
            ):
                raise ValidationError(
                    f"source license bytes differ for {expected['name']}"
                )


def archive_entries(vendor_root):
    directories = [vendor_root]
    files = []
    for path in vendor_root.rglob("*"):
        info = path.lstat()
        if stat.S_ISDIR(info.st_mode):
            directories.append(path)
        elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
            files.append(path)
        else:
            raise ValidationError(f"unsafe Cargo vendor entry: {path}")
    def key(path):
        return path.relative_to(vendor_root).as_posix()

    return sorted(directories, key=key), sorted(files, key=key)


def write_source_archive(vendor_root, output):
    regular_directory(vendor_root, "Cargo vendor directory")
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists() or output.is_symlink():
        raise ValidationError(f"source archive output already exists: {output}")
    descriptor, temporary_name = tempfile.mkstemp(
        dir=output.parent, prefix=output.name + ".", suffix=".tmp"
    )
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        with lzma.open(
            temporary,
            "wb",
            format=lzma.FORMAT_XZ,
            check=lzma.CHECK_CRC64,
            preset=6,
        ) as compressed:
            with tarfile.open(
                fileobj=compressed, mode="w", format=tarfile.USTAR_FORMAT
            ) as archive:
                directories, files = archive_entries(vendor_root)
                for path in [*directories, *files]:
                    relative = (
                        ""
                        if path == vendor_root
                        else path.relative_to(vendor_root).as_posix()
                    )
                    name = VENDOR_ARCHIVE_ROOT + (f"/{relative}" if relative else "")
                    info = path.lstat()
                    entry = tarfile.TarInfo(name)
                    entry.uid = 0
                    entry.gid = 0
                    entry.uname = ""
                    entry.gname = ""
                    entry.mtime = 0
                    if stat.S_ISDIR(info.st_mode):
                        entry.type = tarfile.DIRTYPE
                        entry.mode = 0o755
                        archive.addfile(entry)
                    else:
                        entry.size = info.st_size
                        entry.mode = 0o755 if info.st_mode & 0o111 else 0o644
                        with path.open("rb") as source:
                            archive.addfile(entry, source)
        os.chmod(temporary, 0o644)
        temporary.replace(output)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def verify_source_archive(path, expected_digest, vendor_root=None):
    regular_file(path, "Arti Cargo vendor source archive")
    if path.name != VENDOR_ARCHIVE or sha256_file(path) != expected_digest:
        raise ValidationError("Arti Cargo vendor source archive digest mismatch")
    expected = None
    if vendor_root is not None:
        directories, files = archive_entries(vendor_root)
        expected = {
            VENDOR_ARCHIVE_ROOT
            + (
                f"/{source.relative_to(vendor_root).as_posix()}"
                if source != vendor_root
                else ""
            ): source
            for source in [*directories, *files]
        }
    seen = set()
    try:
        with tarfile.open(path, mode="r:xz") as archive:
            for member in archive:
                member_name = (
                    member.name[:-1]
                    if member.isdir() and member.name.endswith("/")
                    else member.name
                )
                relative_path(member_name, "Cargo vendor archive path")
                if (
                    not (
                        member_name == VENDOR_ARCHIVE_ROOT
                        or member_name.startswith(VENDOR_ARCHIVE_ROOT + "/")
                    )
                    or member_name in seen
                ):
                    raise ValidationError(
                        f"unexpected Cargo vendor archive member: {member.name}"
                    )
                if member.uid != 0 or member.gid != 0 or member.mtime != 0:
                    raise ValidationError("noncanonical Cargo vendor archive metadata")
                source = expected.get(member_name) if expected is not None else None
                if member.isdir():
                    if member.mode != 0o755:
                        raise ValidationError(
                            "noncanonical Cargo vendor directory mode"
                        )
                elif member.isfile():
                    if member.mode not in {0o644, 0o755}:
                        raise ValidationError("noncanonical Cargo vendor file mode")
                    stream = archive.extractfile(member)
                    if stream is None:
                        raise ValidationError("unreadable Cargo vendor archive member")
                    if source is not None and (
                        member.size != source.stat().st_size
                        or sha256_bytes(stream.read()) != sha256_file(source)
                    ):
                        raise ValidationError(
                            f"Cargo vendor archive differs at {member.name}"
                        )
                else:
                    raise ValidationError(
                        f"unsafe Cargo vendor archive member: {member.name}"
                    )
                if expected is not None and source is None:
                    raise ValidationError(
                        f"extra Cargo vendor archive member: {member.name}"
                    )
                seen.add(member_name)
    except (OSError, tarfile.TarError) as error:
        raise ValidationError("invalid Arti Cargo vendor source archive") from error
    if expected is not None and seen != set(expected):
        raise ValidationError("Arti Cargo vendor source archive is incomplete")


def generate_inventory(source_root, vendor_root, source_bundle, output_root, pins_path):
    pins = load_pins(pins_path)
    regular_file(source_bundle, "Arti Cargo vendor source archive")
    if source_bundle.name != VENDOR_ARCHIVE:
        raise ValidationError("Arti Cargo vendor source archive has the wrong name")
    vendor_digest = sha256_file(source_bundle)
    locked = lock_packages(source_root / "Cargo.lock", pins["cargo_lock_sha256"])
    documents = package_documents(source_root, vendor_root, locked)
    license_bytes = {}
    packages = []
    for package in documents:
        paths = package.pop("licenseFiles")
        source_base = (
            vendor_root if package["sourceArtifact"] == "cargoVendor" else source_root
        )
        legal = []
        for source_path in paths:
            contents = (source_base / source_path).read_bytes()
            digest = sha256_bytes(contents)
            license_bytes.setdefault(digest, contents)
            legal.append({
                "installedPath": f"licenses/{digest}.txt",
                "sha256": digest,
                "sourcePath": source_path,
            })
        package["licenseFiles"] = legal
        packages.append(package)
    inventory = {
        "schema": 1,
        "cargoLock": {"path": "Cargo.lock", "sha256": pins["cargo_lock_sha256"]},
        "sourceArtifacts": {
            "arti": {"file": ARTI_ARCHIVE, "sha256": pins["source_sha256"]},
            "cargoVendor": {"file": VENDOR_ARCHIVE, "sha256": vendor_digest},
        },
        "packages": packages,
    }
    if output_root.exists() or output_root.is_symlink():
        raise ValidationError(f"inventory output already exists: {output_root}")
    (output_root / "licenses").mkdir(parents=True)
    (output_root / "THIRD-PARTY.json").write_text(
        json.dumps(inventory, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    for digest, contents in sorted(license_bytes.items()):
        (output_root / "licenses" / f"{digest}.txt").write_bytes(contents)
    print(f"cargo_vendor_sha256={vendor_digest}")
    print(
        "cargo_license_inventory_sha256="
        + sha256_file(output_root / "THIRD-PARTY.json")
    )


def default_paths(arguments):
    source_root = (arguments.source_root or ARTI_ROOT).resolve()
    inventory = (arguments.inventory or LEGAL_ROOT / "THIRD-PARTY.json").resolve()
    license_root = (arguments.license_root or LEGAL_ROOT / "licenses").resolve()
    pins = (arguments.pins or PIN_PATH).resolve()
    return source_root, inventory, license_root, pins


def add_common_arguments(parser):
    parser.add_argument("--source-root", type=Path)
    parser.add_argument("--inventory", type=Path)
    parser.add_argument("--license-root", type=Path)
    parser.add_argument("--pins", type=Path)


def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    verify = commands.add_parser("verify")
    add_common_arguments(verify)
    verify.add_argument("--vendor-dir", type=Path)
    verify.add_argument("--source-bundle", type=Path)
    archive = commands.add_parser("source-archive")
    add_common_arguments(archive)
    archive.add_argument("--vendor-dir", required=True, type=Path)
    archive.add_argument("--output", required=True, type=Path)
    generate = commands.add_parser("generate-inventory")
    add_common_arguments(generate)
    generate.add_argument("--vendor-dir", required=True, type=Path)
    generate.add_argument("--source-bundle", required=True, type=Path)
    generate.add_argument("--output-root", required=True, type=Path)
    arguments = parser.parse_args()
    try:
        source_root, inventory_path, license_root, pins_path = default_paths(arguments)
        if arguments.command == "generate-inventory":
            generate_inventory(
                source_root,
                arguments.vendor_dir.resolve(),
                arguments.source_bundle.resolve(),
                arguments.output_root.resolve(),
                pins_path,
            )
            return
        inventory = validate_inventory(
            source_root / "Cargo.lock", inventory_path, license_root, pins_path
        )
        if arguments.vendor_dir:
            compare_source_metadata(
                source_root,
                arguments.vendor_dir.resolve(),
                inventory,
                source_root / "Cargo.lock",
                license_root,
            )
        if arguments.command == "source-archive":
            output = arguments.output.resolve()
            if output.name != VENDOR_ARCHIVE:
                raise ValidationError("Cargo vendor source archive has the wrong name")
            write_source_archive(arguments.vendor_dir.resolve(), output)
            verify_source_archive(
                output,
                inventory["sourceArtifacts"]["cargoVendor"]["sha256"],
                arguments.vendor_dir.resolve(),
            )
        elif arguments.source_bundle:
            verify_source_archive(
                arguments.source_bundle.resolve(),
                inventory["sourceArtifacts"]["cargoVendor"]["sha256"],
                arguments.vendor_dir.resolve() if arguments.vendor_dir else None,
            )
    except (OSError, ValidationError) as error:
        raise SystemExit(str(error)) from error


if __name__ == "__main__":
    main()
