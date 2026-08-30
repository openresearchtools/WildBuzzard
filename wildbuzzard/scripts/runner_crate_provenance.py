#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later

import argparse
import hashlib
import io
import json
import lzma
import os
import re
import tarfile
import tempfile
import urllib.request
from pathlib import Path, PurePosixPath

import tomllib


SHA256_PATTERN = re.compile(r"[0-9a-f]{64}")
NAME_PATTERN = re.compile(r"[A-Za-z0-9_-]+")
VERSION_PATTERN = re.compile(r"[A-Za-z0-9.+_-]+")
SOURCE_BUNDLE_ROOT = "wildbuzzard-runner-crates-source"
RUNNER_ROOT = (
    Path(__file__).resolve().parents[1] / "components" / "wildbuzzard-cli" / "runner"
)


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
    if path.is_symlink() or not path.is_file():
        raise ValidationError(f"missing or unsafe {context}: {path}")


def require_string(value, context, pattern=None):
    if not isinstance(value, str) or not value:
        raise ValidationError(f"invalid {context}")
    if pattern is not None and pattern.fullmatch(value) is None:
        raise ValidationError(f"invalid {context}: {value}")
    return value


def relative_file(value, context, *, parent=None):
    require_string(value, context)
    if "\\" in value:
        raise ValidationError(f"invalid {context}: {value}")
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts or path.as_posix() != value:
        raise ValidationError(f"invalid {context}: {value}")
    if parent is not None and (len(path.parts) != 2 or path.parts[0] != parent):
        raise ValidationError(f"invalid {context}: {value}")
    return path


def load_inventory(path):
    regular_file(path, "third-party inventory")
    try:
        contents = path.read_bytes()
        value = json.loads(contents, object_pairs_hook=strict_object)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise ValidationError(f"invalid third-party inventory: {path}") from error
    canonical = json.dumps(value, indent=2, sort_keys=True).encode() + b"\n"
    if contents != canonical:
        raise ValidationError("third-party inventory is not canonical JSON")
    exact_keys(value, {"schema", "cargoLock", "sourceBundle", "packages"}, "inventory")
    if value["schema"] != 1:
        raise ValidationError("unsupported third-party inventory schema")
    exact_keys(value["cargoLock"], {"path", "sha256"}, "Cargo lock")
    if value["cargoLock"]["path"] != "Cargo.lock":
        raise ValidationError("inventory must cover runner/Cargo.lock")
    require_string(value["cargoLock"]["sha256"], "Cargo.lock digest", SHA256_PATTERN)
    exact_keys(value["sourceBundle"], {"file", "sha256"}, "source bundle")
    if value["sourceBundle"]["file"] != "wildbuzzard-runner-crates-source.tar.xz":
        raise ValidationError("invalid corresponding-source bundle name")
    require_string(
        value["sourceBundle"]["sha256"], "source bundle digest", SHA256_PATTERN
    )
    if not isinstance(value["packages"], list) or not value["packages"]:
        raise ValidationError("third-party package inventory is empty")
    return value


def lock_packages(lock_path, expected_digest):
    regular_file(lock_path, "Cargo.lock")
    if sha256_file(lock_path) != expected_digest:
        raise ValidationError("Cargo.lock differs from the third-party inventory")
    try:
        lock = tomllib.loads(lock_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, tomllib.TOMLDecodeError) as error:
        raise ValidationError(f"invalid Cargo.lock: {lock_path}") from error
    if not isinstance(lock.get("package"), list):
        raise ValidationError("Cargo.lock package list is missing")
    packages = []
    local_packages = []
    for package in lock.get("package", []):
        if not isinstance(package, dict):
            raise ValidationError("invalid Cargo.lock package")
        if "source" not in package:
            if set(package) not in (
                {"name", "version"},
                {"name", "version", "dependencies"},
            ):
                raise ValidationError("invalid local Cargo.lock package fields")
            local_packages.append((package.get("name"), package.get("version")))
            continue
        if set(package) not in (
            {"name", "version", "source", "checksum"},
            {"name", "version", "source", "checksum", "dependencies"},
        ):
            raise ValidationError("invalid third-party Cargo.lock package fields")
        require_string(package["name"], "Cargo.lock package name", NAME_PATTERN)
        require_string(
            package["version"], "Cargo.lock package version", VERSION_PATTERN
        )
        require_string(package["source"], "Cargo.lock package source")
        require_string(
            package["checksum"], "Cargo.lock package checksum", SHA256_PATTERN
        )
        packages.append({
            "checksum": package["checksum"],
            "name": package["name"],
            "source": package["source"],
            "version": package["version"],
        })
    if local_packages != [("wildbuzzard-native-client", "0.1.0")]:
        raise ValidationError("unexpected local package set in Cargo.lock")
    return sorted(packages, key=lambda package: (package["name"], package["version"]))


def validate_inventory(lock_path, inventory_path, license_root):
    inventory = load_inventory(inventory_path)
    locked = lock_packages(lock_path, inventory["cargoLock"]["sha256"])
    packages = inventory["packages"]
    identities = []
    installed_files = {}
    for package in packages:
        exact_keys(
            package,
            {
                "license",
                "licenseFiles",
                "name",
                "repository",
                "source",
                "sourceArchive",
                "vcs",
                "version",
            },
            "third-party package",
        )
        name = require_string(package["name"], "package name", NAME_PATTERN)
        version = require_string(package["version"], "package version", VERSION_PATTERN)
        identity = (name, version)
        identities.append(identity)
        require_string(package["license"], f"{name} license")
        repository = require_string(package["repository"], f"{name} repository")
        if not repository.startswith("https://"):
            raise ValidationError(f"invalid repository for {name}")
        source = require_string(package["source"], f"{name} Cargo source")
        if source != "registry+https://github.com/rust-lang/crates.io-index":
            raise ValidationError(f"unsupported Cargo source for {name}")
        exact_keys(
            package["sourceArchive"], {"sha256", "url"}, f"{name} source archive"
        )
        source_digest = require_string(
            package["sourceArchive"]["sha256"], f"{name} source digest", SHA256_PATTERN
        )
        expected_url = f"https://static.crates.io/crates/{name}/{name}-{version}.crate"
        if package["sourceArchive"]["url"] != expected_url:
            raise ValidationError(f"invalid source archive URL for {name}")
        exact_keys(package["vcs"], {"commit", "path"}, f"{name} VCS provenance")
        require_string(
            package["vcs"]["commit"], f"{name} VCS commit", re.compile(r"[0-9a-f]{40}")
        )
        vcs_path = package["vcs"]["path"]
        if (
            not isinstance(vcs_path, str)
            or "\\" in vcs_path
            or PurePosixPath(vcs_path).is_absolute()
            or ".." in PurePosixPath(vcs_path).parts
            or PurePosixPath(vcs_path).as_posix() != (vcs_path or ".")
        ):
            raise ValidationError(f"invalid VCS path for {name}")
        matching = [
            entry for entry in locked if (entry["name"], entry["version"]) == identity
        ]
        if (
            len(matching) != 1
            or matching[0]["source"] != source
            or matching[0]["checksum"] != source_digest
        ):
            raise ValidationError(
                f"inventory does not match Cargo.lock for {name} {version}"
            )
        license_files = package["licenseFiles"]
        if not isinstance(license_files, list) or not license_files:
            raise ValidationError(f"missing license files for {name}")
        source_paths = set()
        for license_file in license_files:
            exact_keys(
                license_file,
                {"installedPath", "sha256", "sourcePath"},
                f"{name} license file",
            )
            source_path = relative_file(
                license_file["sourcePath"], f"{name} source license path"
            )
            if len(source_path.parts) != 1 or source_path.as_posix() in source_paths:
                raise ValidationError(f"invalid or duplicate source license for {name}")
            source_paths.add(source_path.as_posix())
            installed = relative_file(
                license_file["installedPath"],
                f"{name} installed license path",
                parent="licenses",
            )
            digest = require_string(
                license_file["sha256"], f"{name} license digest", SHA256_PATTERN
            )
            installed_path = license_root.parent / installed
            regular_file(installed_path, f"{name} license")
            if sha256_file(installed_path) != digest:
                raise ValidationError(
                    f"license digest mismatch for {name}: {installed}"
                )
            previous = installed_files.setdefault(installed.as_posix(), digest)
            if previous != digest:
                raise ValidationError(
                    f"conflicting installed license digest: {installed}"
                )
        if [entry["sourcePath"] for entry in license_files] != sorted(source_paths):
            raise ValidationError(f"license file list is not sorted for {name}")
    if identities != sorted(set(identities)):
        raise ValidationError("third-party inventory must be unique and sorted")
    if identities != [(entry["name"], entry["version"]) for entry in locked]:
        raise ValidationError("third-party inventory does not exactly cover Cargo.lock")
    actual_files = set()
    if license_root.is_symlink() or not license_root.is_dir():
        raise ValidationError(f"missing or unsafe license directory: {license_root}")
    for path in license_root.rglob("*"):
        if path.is_symlink() or (not path.is_dir() and not path.is_file()):
            raise ValidationError(f"unsafe third-party license entry: {path}")
        if path.is_file():
            actual_files.add(path.relative_to(license_root.parent).as_posix())
    if actual_files != set(installed_files):
        raise ValidationError(
            "third-party license directory has missing or extra files"
        )
    return inventory


def safe_tar_name(name, context):
    if "\\" in name:
        raise ValidationError(f"unsafe {context} path: {name}")
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or path.as_posix() != name:
        raise ValidationError(f"unsafe {context} path: {name}")
    return path


def crate_metadata(data, package, license_root):
    if sha256_bytes(data) != package["sourceArchive"]["sha256"]:
        raise ValidationError(f"source archive digest mismatch for {package['name']}")
    prefix = f"{package['name']}-{package['version']}"
    files = {}
    try:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
            for member in archive:
                name = safe_tar_name(member.name, "crate archive")
                if not name.parts or name.parts[0] != prefix:
                    raise ValidationError(
                        f"invalid crate archive root for {package['name']}"
                    )
                if member.isdir():
                    continue
                if not member.isfile() or member.name in files:
                    raise ValidationError(f"unsafe crate archive member: {member.name}")
                extracted = archive.extractfile(member)
                if extracted is None:
                    raise ValidationError(
                        f"unreadable crate archive member: {member.name}"
                    )
                files[member.name] = extracted.read()
    except (OSError, tarfile.TarError) as error:
        raise ValidationError(
            f"invalid source archive for {package['name']}"
        ) from error
    cargo_path = f"{prefix}/Cargo.toml"
    vcs_path = f"{prefix}/.cargo_vcs_info.json"
    if cargo_path not in files or vcs_path not in files:
        raise ValidationError(f"source metadata is missing for {package['name']}")
    try:
        cargo_package = tomllib.loads(files[cargo_path].decode())["package"]
        vcs = json.loads(files[vcs_path], object_pairs_hook=strict_object)
    except (
        KeyError,
        UnicodeDecodeError,
        json.JSONDecodeError,
        tomllib.TOMLDecodeError,
    ) as error:
        raise ValidationError(
            f"invalid source metadata for {package['name']}"
        ) from error
    if (
        cargo_package.get("name") != package["name"]
        or cargo_package.get("version") != package["version"]
        or cargo_package.get("license") != package["license"]
        or cargo_package.get("repository") != package["repository"]
    ):
        raise ValidationError(f"source metadata mismatch for {package['name']}")
    exact_keys(vcs, {"git", "path_in_vcs"}, f"{package['name']} crate VCS metadata")
    exact_keys(vcs["git"], {"sha1"}, f"{package['name']} crate Git metadata")
    if (
        vcs["git"]["sha1"] != package["vcs"]["commit"]
        or vcs["path_in_vcs"] != package["vcs"]["path"]
    ):
        raise ValidationError(f"VCS provenance mismatch for {package['name']}")
    declared = {entry["sourcePath"] for entry in package["licenseFiles"]}
    found = {
        PurePosixPath(name).name
        for name in files
        if PurePosixPath(name).parent.as_posix() == prefix
        and (
            PurePosixPath(name).name.startswith("LICENSE")
            or PurePosixPath(name).name in {"COPYING", "UNLICENSE"}
        )
    }
    if found != declared:
        raise ValidationError(f"source license list mismatch for {package['name']}")
    for entry in package["licenseFiles"]:
        source = files[f"{prefix}/{entry['sourcePath']}"]
        installed = (license_root.parent / entry["installedPath"]).read_bytes()
        if source != installed or sha256_bytes(source) != entry["sha256"]:
            raise ValidationError(
                f"source license bytes mismatch for {package['name']}"
            )


def fetch_crate(package, cache_dir):
    cache_dir.mkdir(parents=True, exist_ok=True)
    if cache_dir.is_symlink() or not cache_dir.is_dir():
        raise ValidationError(f"unsafe crate cache: {cache_dir}")
    destination = cache_dir / f"{package['name']}-{package['version']}.crate"
    if destination.exists() or destination.is_symlink():
        regular_file(destination, f"cached source for {package['name']}")
        if sha256_file(destination) != package["sourceArchive"]["sha256"]:
            raise ValidationError(
                f"cached source digest mismatch for {package['name']}"
            )
        return destination
    request = urllib.request.Request(
        package["sourceArchive"]["url"],
        headers={"User-Agent": "WildBuzzard-release-builder/1"},
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            data = response.read()
    except OSError as error:
        raise ValidationError(
            f"could not download source for {package['name']}"
        ) from error
    if sha256_bytes(data) != package["sourceArchive"]["sha256"]:
        raise ValidationError(
            f"downloaded source digest mismatch for {package['name']}"
        )
    temporary = destination.with_suffix(destination.suffix + ".download")
    if temporary.exists() or temporary.is_symlink():
        raise ValidationError(f"temporary source path already exists: {temporary}")
    temporary.write_bytes(data)
    os.chmod(temporary, 0o644)
    temporary.replace(destination)
    return destination


def write_source_bundle(output, packages, crate_paths):
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists() or output.is_symlink():
        raise ValidationError(f"source bundle output already exists: {output}")
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
            preset=9,
        ) as compressed:
            with tarfile.open(
                fileobj=compressed, mode="w", format=tarfile.USTAR_FORMAT
            ) as archive:
                for package, crate_path in zip(packages, crate_paths, strict=True):
                    data = crate_path.read_bytes()
                    member = tarfile.TarInfo(
                        f"{SOURCE_BUNDLE_ROOT}/{package['name']}-{package['version']}.crate"
                    )
                    member.size = len(data)
                    member.mode = 0o644
                    member.mtime = 0
                    member.uid = 0
                    member.gid = 0
                    member.uname = ""
                    member.gname = ""
                    archive.addfile(member, io.BytesIO(data))
        os.chmod(temporary, 0o644)
        temporary.replace(output)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def verify_source_bundle(path, inventory, license_root):
    regular_file(path, "corresponding-source bundle")
    if path.name != inventory["sourceBundle"]["file"]:
        raise ValidationError("corresponding-source bundle has the wrong name")
    if sha256_file(path) != inventory["sourceBundle"]["sha256"]:
        raise ValidationError("corresponding-source bundle digest mismatch")
    expected = {
        f"{SOURCE_BUNDLE_ROOT}/{package['name']}-{package['version']}.crate": package
        for package in inventory["packages"]
    }
    seen = set()
    try:
        with tarfile.open(path, mode="r:xz") as archive:
            for member in archive:
                name = safe_tar_name(member.name, "source bundle")
                if (
                    member.name not in expected
                    or not member.isfile()
                    or member.name in seen
                ):
                    raise ValidationError(f"unexpected source bundle member: {name}")
                extracted = archive.extractfile(member)
                if extracted is None:
                    raise ValidationError(f"unreadable source bundle member: {name}")
                crate_metadata(extracted.read(), expected[member.name], license_root)
                seen.add(member.name)
    except (OSError, tarfile.TarError) as error:
        raise ValidationError(f"invalid corresponding-source bundle: {path}") from error
    if seen != set(expected):
        raise ValidationError("corresponding-source bundle is incomplete")


def default_paths(arguments):
    def absolute(path):
        return path if path.is_absolute() else Path.cwd() / path

    lock = absolute(arguments.lock or RUNNER_ROOT / "Cargo.lock")
    inventory = absolute(
        arguments.inventory or RUNNER_ROOT / "third_party" / "THIRD-PARTY.json"
    )
    license_root = absolute(
        arguments.license_root or RUNNER_ROOT / "third_party" / "licenses"
    )
    return lock, inventory, license_root


def add_common_arguments(parser):
    parser.add_argument("--lock", type=Path)
    parser.add_argument("--inventory", type=Path)
    parser.add_argument("--license-root", type=Path)


def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    verify = commands.add_parser("verify")
    add_common_arguments(verify)
    verify.add_argument("--source-bundle", type=Path)
    source = commands.add_parser("source-archive")
    add_common_arguments(source)
    source.add_argument("--cache-dir", required=True, type=Path)
    source.add_argument("--output", required=True, type=Path)
    arguments = parser.parse_args()
    try:
        lock, inventory_path, license_root = default_paths(arguments)
        inventory = validate_inventory(lock, inventory_path, license_root)
        if arguments.command == "verify":
            if arguments.source_bundle:
                verify_source_bundle(
                    arguments.source_bundle.absolute(), inventory, license_root
                )
            return
        cache_dir = arguments.cache_dir.absolute()
        crate_paths = []
        for package in inventory["packages"]:
            crate_path = fetch_crate(package, cache_dir)
            crate_metadata(crate_path.read_bytes(), package, license_root)
            crate_paths.append(crate_path)
        output = arguments.output.absolute()
        if output.name != inventory["sourceBundle"]["file"]:
            raise ValidationError("corresponding-source bundle has the wrong name")
        write_source_bundle(output, inventory["packages"], crate_paths)
        verify_source_bundle(output, inventory, license_root)
    except (OSError, ValidationError) as error:
        raise SystemExit(str(error)) from error


if __name__ == "__main__":
    main()
