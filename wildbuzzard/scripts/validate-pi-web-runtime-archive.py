#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later

import argparse
import base64
import binascii
import hashlib
import importlib.util
import io
import json
import re
import sys
import tarfile
import zipfile
from pathlib import Path, PurePosixPath

MANIFEST = "wildbuzzard-runtime.json"
MAX_JSON_SIZE = 2 * 1024 * 1024
MAX_INVENTORY_PACKAGES = 20_000
MAX_PACKAGE_FILES = 20_000
MAX_PACKAGE_SIZE = 256 * 1024 * 1024
SHA256 = re.compile(r"^[a-f0-9]{64}$")
COMMIT = re.compile(r"^[a-f0-9]{40}$")
SHA512_INTEGRITY = re.compile(r"^sha512-[A-Za-z0-9+/]+={0,2}$")
REQUIRED_PAYLOAD = {
    "bin/pi",
    "bin/pi-web",
    "bin/pi-web-server",
    "bin/pi-web-sessiond",
    "node/bin/node",
    "node_modules/@earendil-works/pi-agent-core/package.json",
    "node_modules/@earendil-works/pi-ai/package.json",
    "node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
    "node_modules/@earendil-works/pi-coding-agent/package.json",
    "node_modules/@jmfederico/pi-web/dist/cli.js",
    "node_modules/@jmfederico/pi-web/dist/server/index.js",
    "node_modules/@jmfederico/pi-web/dist/server/sessiond.js",
    "node_modules/@jmfederico/pi-web/package.json",
}


class ValidationError(ValueError):
    pass


def load_archive_verifier():
    path = Path(__file__).with_name("runtime-archive-manifest.py")
    spec = importlib.util.spec_from_file_location("runtime_archive_manifest", path)
    if spec is None or spec.loader is None:
        raise ValidationError("Pi Web runtime verifier is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_json(path: Path, label: str):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, TypeError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValidationError(f"invalid {label}") from error


def valid_integrity(value):
    if not isinstance(value, str) or not SHA512_INTEGRITY.fullmatch(value):
        return False
    try:
        return len(base64.b64decode(value.removeprefix("sha512-"), validate=True)) == 64
    except (binascii.Error, ValueError):
        return False


def safe_path(value):
    if not isinstance(value, str):
        return False
    path = PurePosixPath(value)
    return (
        value
        and not value.startswith("/")
        and "\\" not in value
        and all(part not in ("", ".", "..") for part in path.parts)
    )


def archive_entry(archive, path, maximum_size=None):
    try:
        entry = archive.getinfo(path)
    except KeyError as error:
        raise ValidationError(f"Pi Web runtime payload is absent: {path}") from error
    if entry.is_dir() or (maximum_size is not None and entry.file_size > maximum_size):
        raise ValidationError(f"invalid Pi Web runtime payload: {path}")
    return entry


def archive_bytes(archive, path, maximum_size=None):
    return archive.read(archive_entry(archive, path, maximum_size))


def archive_json(archive, path, label):
    try:
        return json.loads(archive_bytes(archive, path, MAX_JSON_SIZE))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValidationError(f"invalid {label}") from error


def validate_package_inventory(archive, value, prefix, pinned_versions=None):
    if not isinstance(value, list) or len(value) > MAX_INVENTORY_PACKAGES:
        raise ValidationError("invalid Pi Web runtime dependency inventory")
    found = set()
    paths = set()
    for package in value:
        if not isinstance(package, dict):
            raise ValidationError("invalid Pi Web runtime dependency")
        path = package.get("path")
        name = package.get("name")
        version = package.get("version")
        resolved = package.get("resolved")
        integrity = package.get("integrity")
        manifest_sha256 = package.get("manifestSha256")
        if (
            not safe_path(path)
            or not path.startswith(prefix)
            or path in paths
            or not isinstance(name, str)
            or not name
            or len(name) > 214
            or not isinstance(version, str)
            or not version
            or len(version) > 128
            or not SHA256.fullmatch(str(manifest_sha256 or ""))
        ):
            raise ValidationError("invalid Pi Web runtime dependency")
        paths.add(path)
        if (
            not isinstance(resolved, str)
            or not resolved.startswith("https://registry.npmjs.org/")
            or not valid_integrity(integrity)
        ):
            raise ValidationError("untrusted Pi Web runtime dependency")
        manifest_bytes = archive_bytes(archive, f"{path}/package.json", MAX_JSON_SIZE)
        if hashlib.sha256(manifest_bytes).hexdigest() != manifest_sha256:
            raise ValidationError("Pi Web runtime dependency manifest differs")
        try:
            manifest = json.loads(manifest_bytes)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValidationError(
                "invalid Pi Web runtime dependency manifest"
            ) from error
        if (
            not isinstance(manifest, dict)
            or manifest.get("name") != name
            or manifest.get("version") != version
        ):
            raise ValidationError("Pi Web runtime dependency identity differs")
        if pinned_versions is not None and pinned_versions.get(name) == version:
            found.add(name)
    if pinned_versions is not None and found != set(pinned_versions):
        raise ValidationError("Pi Web runtime omits a pinned Pi package")


def validate_inventory(archive, value, lock):
    if not isinstance(value, dict):
        raise ValidationError("invalid Pi Web runtime dependency inventory")
    if (
        value.get("schema") != 1
        or value.get("piWebCommit") != lock["piWeb"]["commit"]
        or value.get("packageLockSha256") != lock["piWeb"]["packageLockSha256"]
    ):
        raise ValidationError("Pi Web runtime dependency inventory differs from lock")
    pinned_versions = lock.get("piPackages")
    if not isinstance(pinned_versions, dict):
        raise ValidationError("invalid Pi package pins")
    validate_package_inventory(
        archive, value.get("packages"), "node_modules/", pinned_versions
    )
    validate_package_inventory(
        archive, value.get("webAccessPackages"), "seed/web-access/node_modules/"
    )
    cargo_packages = value.get("cargoPackages")
    if (
        not isinstance(value.get("webAccessPackageLockSha256"), str)
        or not SHA256.fullmatch(value["webAccessPackageLockSha256"])
        or not isinstance(value.get("cargoLockSha256"), str)
        or not SHA256.fullmatch(value["cargoLockSha256"])
        or not isinstance(cargo_packages, list)
        or len(cargo_packages) > MAX_INVENTORY_PACKAGES
        or any(not isinstance(package, dict) for package in cargo_packages)
    ):
        raise ValidationError("invalid Pi Web runtime dependency inventory")


def validate_payload_pins(archive, lock):
    payload = lock.get("runtimePayload")
    if not isinstance(payload, dict) or set(payload) != REQUIRED_PAYLOAD:
        raise ValidationError("invalid Pi Web runtime payload pins")
    for path, expected in payload.items():
        if (
            not safe_path(path)
            or not isinstance(expected, dict)
            or set(expected) != {"sha256", "executable"}
            or not SHA256.fullmatch(str(expected.get("sha256", "")))
            or not isinstance(expected.get("executable"), bool)
        ):
            raise ValidationError("invalid Pi Web runtime payload pins")
        entry = archive_entry(archive, path)
        if hashlib.sha256(archive.read(entry)).hexdigest() != expected["sha256"]:
            raise ValidationError(f"Pi Web runtime payload differs from pin: {path}")
        executable = bool((entry.external_attr >> 16) & 0o111)
        if executable != expected["executable"]:
            raise ValidationError(f"Pi Web runtime payload mode differs: {path}")


def validate_archive_pin(archive_file, lock):
    pin = lock.get("runtimeArchive")
    if (
        not isinstance(pin, dict)
        or set(pin) != {"bootstrapBlocked", "sourceCommit", "sha256"}
        or not isinstance(pin.get("bootstrapBlocked"), bool)
        or not COMMIT.fullmatch(str(pin.get("sourceCommit", "")))
        or not SHA256.fullmatch(str(pin.get("sha256", "")))
    ):
        raise ValidationError("invalid Pi Web runtime archive pin")
    if pin["bootstrapBlocked"]:
        if pin["sourceCommit"] != "0" * 40 or pin["sha256"] != "0" * 64:
            raise ValidationError("invalid Pi Web runtime bootstrap pin")
        return True
    if pin["sourceCommit"] == "0" * 40 or pin["sha256"] == "0" * 64:
        raise ValidationError("invalid Pi Web runtime archive pin")
    archive_file.seek(0)
    digest = hashlib.sha256()
    while chunk := archive_file.read(1024 * 1024):
        digest.update(chunk)
    if digest.hexdigest() != pin["sha256"]:
        raise ValidationError("Pi Web runtime archive digest differs from pin")
    return False


def validate_embedded_package(archive, lock):
    pi_web = lock["piWeb"]
    lock_path = "source/pi-web-package-lock.json"
    if (
        hashlib.sha256(archive_bytes(archive, lock_path)).hexdigest()
        != pi_web["packageLockSha256"]
    ):
        raise ValidationError("embedded Pi Web package lock differs from pin")
    package_path = f"source/pi-web-package-{pi_web['commit']}.tgz"
    package_bytes = archive_bytes(archive, package_path, MAX_PACKAGE_SIZE)
    if hashlib.sha256(package_bytes).hexdigest() != pi_web["packageArchiveSha256"]:
        raise ValidationError("embedded Pi Web package archive differs from pin")
    try:
        with tarfile.open(fileobj=io.BytesIO(package_bytes), mode="r:gz") as package:
            members = package.getmembers()
            if len(members) > MAX_PACKAGE_FILES:
                raise ValidationError("invalid embedded Pi Web package archive")
            expected_files = set()
            total_size = 0
            for member in members:
                if member.isdir():
                    continue
                if (
                    not member.isfile()
                    or not safe_path(member.name)
                    or not member.name.startswith("package/")
                    or member.size > MAX_PACKAGE_SIZE
                ):
                    raise ValidationError("invalid embedded Pi Web package archive")
                relative = member.name.removeprefix("package/")
                runtime_path = f"node_modules/@jmfederico/pi-web/{relative}"
                total_size += member.size
                if total_size > MAX_PACKAGE_SIZE or runtime_path in expected_files:
                    raise ValidationError("invalid embedded Pi Web package archive")
                source = package.extractfile(member)
                if source is None or source.read(MAX_PACKAGE_SIZE + 1) != archive_bytes(
                    archive, runtime_path, MAX_PACKAGE_SIZE
                ):
                    raise ValidationError(
                        "installed Pi Web package differs from archive"
                    )
                expected_files.add(runtime_path)
    except (OSError, tarfile.TarError) as error:
        raise ValidationError("invalid embedded Pi Web package archive") from error
    actual_files = {
        entry.filename
        for entry in archive.infolist()
        if not entry.is_dir()
        and entry.filename.startswith("node_modules/@jmfederico/pi-web/")
    }
    if actual_files != expected_files:
        raise ValidationError("installed Pi Web package inventory differs from archive")


def validate_opened_archive(archive_file, lock_path: Path):
    lock = load_json(lock_path, "Pi Web runtime lock")
    pi_web = lock.get("piWeb") if isinstance(lock, dict) else None
    node = lock.get("node") if isinstance(lock, dict) else None
    if (
        not isinstance(lock, dict)
        or lock.get("schema") != 1
        or lock.get("platform") != "linux-x64"
        or not isinstance(pi_web, dict)
        or not isinstance(node, dict)
    ):
        raise ValidationError("invalid Pi Web runtime lock")
    try:
        bootstrap_blocked = validate_archive_pin(archive_file, lock)
        archive_file.seek(0)
        load_archive_verifier().verify(archive_file)
        archive_file.seek(0)
        with zipfile.ZipFile(archive_file) as archive:
            manifest = archive_json(archive, MANIFEST, "Pi Web runtime manifest")
            expected = {
                "component": "pi-web",
                "dependencyLockSha256": pi_web["packageLockSha256"],
                "nodeArchiveSha256": node["sha256"],
                "nodeVersion": node["version"],
                "piWebCommit": pi_web["commit"],
                "piWebRepository": pi_web["repository"],
                "piWebTree": pi_web["tree"],
                "platform": lock["platform"],
                "version": pi_web["version"],
            }
            if not bootstrap_blocked:
                expected["wildbuzzardCommit"] = lock["runtimeArchive"]["sourceCommit"]
            for field, expected_value in expected.items():
                if manifest.get(field) != expected_value:
                    raise ValidationError(f"Pi Web runtime pin differs: {field}")
            inventory_path = manifest.get("runtimeDependencyInventory")
            if not safe_path(inventory_path):
                raise ValidationError("Pi Web runtime dependency inventory is absent")
            validate_inventory(
                archive,
                archive_json(
                    archive, inventory_path, "Pi Web runtime dependency inventory"
                ),
                lock,
            )
            validate_payload_pins(archive, lock)
            validate_embedded_package(archive, lock)
            if bootstrap_blocked:
                raise ValidationError("Pi Web runtime bootstrap pin blocks packaging")
            return manifest
    except ValidationError:
        raise
    except (
        AttributeError,
        KeyError,
        OSError,
        TypeError,
        UnicodeDecodeError,
        json.JSONDecodeError,
        zipfile.BadZipFile,
        ValueError,
    ) as error:
        raise ValidationError("invalid Pi Web runtime archive") from error


def validate(archive_path: Path, lock_path: Path):
    try:
        with open(archive_path, "rb") as archive_file:
            return validate_opened_archive(archive_file, lock_path)
    except ValidationError:
        raise
    except OSError as error:
        raise ValidationError("invalid Pi Web runtime archive") from error


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("archive", type=Path)
    parser.add_argument("--lock", required=True, type=Path)
    args = parser.parse_args()
    try:
        validate(args.archive, args.lock)
    except ValidationError as error:
        print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
