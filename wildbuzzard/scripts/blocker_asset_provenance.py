#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later

import argparse
import hashlib
import io
import json
import os
import shutil
import subprocess
import tarfile
import tempfile
import urllib.error
import urllib.request
from pathlib import Path, PurePosixPath

ARCHIVE_ROOT = "wildbuzzard-blocker-assets-source"
SOURCE_KEYS = ("braveAdblockResources", "uBlockOrigin")
SHA256_LENGTH = 64


class ValidationError(Exception):
    pass


def digest_bytes(value):
    return hashlib.sha256(value).hexdigest()


def digest_file(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def repository_paths(repository):
    blocker = repository / "browser" / "components" / "blocker"
    return {
        "lock": blocker / "assets" / "SOURCES.lock.json",
        "notice": repository / "wildbuzzard" / "BLOCKER-ASSET-SOURCE-NOTICE",
        "generator": blocker / "scripts" / "update-bundled-assets.js",
        "verifier": blocker / "scripts" / "verify-bundled-resource-source.js",
        "outputs": blocker / "assets" / "resources",
    }


def require_dict(value, label):
    if not isinstance(value, dict):
        raise ValidationError(f"{label} must be an object")
    return value


def require_string(value, label, *, length=None):
    if not isinstance(value, str) or not value:
        raise ValidationError(f"{label} must be a non-empty string")
    if length is not None and (
        len(value) != length or any(char not in "0123456789abcdef" for char in value)
    ):
        raise ValidationError(f"{label} must be a lowercase hexadecimal digest")
    return value


def load_lock(path):
    try:
        lock = require_dict(json.loads(path.read_text(encoding="utf-8")), "lock")
    except (OSError, json.JSONDecodeError) as error:
        raise ValidationError(f"could not read blocker source lock: {path}") from error
    if lock.get("schemaVersion") != 1:
        raise ValidationError("unsupported blocker source lock schema")
    require_string(lock.get("nodeVersion"), "nodeVersion")
    artifact = require_string(lock.get("artifact"), "artifact")
    if artifact != "wildbuzzard-blocker-assets-source.tar.xz":
        raise ValidationError("unexpected blocker source artifact name")
    sources = require_dict(lock.get("sources"), "sources")
    if set(sources) != set(SOURCE_KEYS):
        raise ValidationError("blocker source lock has missing or extra sources")
    for key in SOURCE_KEYS:
        source = require_dict(sources[key], f"sources.{key}")
        for field in (
            "name",
            "repository",
            "archive",
            "archiveUrl",
            "license",
            "licensePath",
        ):
            require_string(source.get(field), f"sources.{key}.{field}")
        for field in ("commit", "tree"):
            require_string(source.get(field), f"sources.{key}.{field}", length=40)
        for field in ("archiveSha256", "licenseSha256"):
            require_string(source.get(field), f"sources.{key}.{field}", length=64)
        for field in ("archiveSize", "sourceDateEpoch"):
            if not isinstance(source.get(field), int) or source[field] <= 0:
                raise ValidationError(f"sources.{key}.{field} must be positive")
        if PurePosixPath(source["archive"]).name != source["archive"]:
            raise ValidationError(f"sources.{key}.archive must be a basename")
    brave = sources["braveAdblockResources"]
    require_string(brave.get("resourcesPath"), "Brave resourcesPath")
    require_string(brave.get("resourcesSha256"), "Brave resourcesSha256", length=64)
    require_string(sources["uBlockOrigin"].get("tag"), "uBlock Origin tag")

    outputs = require_dict(lock.get("outputs"), "outputs")
    expected_outputs = {
        "resources/resources.json",
        "resources/ubo-scriptlets.json",
    }
    if set(outputs) != expected_outputs:
        raise ValidationError("blocker source lock has missing or extra outputs")
    for relative, raw_record in outputs.items():
        record = require_dict(raw_record, f"outputs.{relative}")
        require_string(record.get("sha256"), f"outputs.{relative}.sha256", length=64)
        if not isinstance(record.get("size"), int) or record["size"] <= 0:
            raise ValidationError(f"outputs.{relative}.size must be positive")
    return lock


def verify_file_record(path, record, label):
    if path.is_symlink() or not path.is_file():
        raise ValidationError(f"missing or unsafe {label}: {path}")
    size = path.stat().st_size
    digest = digest_file(path)
    if size != record["size"] or digest != record["sha256"]:
        raise ValidationError(
            f"{label} differs from lock: {path} ({size} bytes, {digest})"
        )


def safe_archive_members(archive, label):
    members = archive.getmembers()
    if not members:
        raise ValidationError(f"empty archive: {label}")
    seen = set()
    top_levels = set()
    for member in members:
        if "\\" in member.name:
            raise ValidationError(f"unsafe archive member in {label}: {member.name}")
        relative = PurePosixPath(member.name)
        if relative.is_absolute() or ".." in relative.parts or not relative.parts:
            raise ValidationError(f"unsafe archive member in {label}: {member.name}")
        canonical = relative.as_posix()
        if canonical in seen:
            raise ValidationError(f"duplicate archive member in {label}: {canonical}")
        seen.add(canonical)
        top_levels.add(relative.parts[0])
        if not (member.isdir() or member.isfile()):
            raise ValidationError(f"unsupported archive member in {label}: {canonical}")
    if len(top_levels) != 1:
        raise ValidationError(f"source archive has multiple roots: {label}")
    return members, next(iter(top_levels))


def inspect_source_archive(path, source):
    verify_file_record(
        path,
        {"size": source["archiveSize"], "sha256": source["archiveSha256"]},
        source["name"],
    )
    try:
        with tarfile.open(path, "r:gz") as archive:
            members, root = safe_archive_members(archive, source["name"])
            names = {member.name: member for member in members}
            required = {
                "license": f"{root}/{source['licensePath']}",
            }
            if "resourcesPath" in source:
                required["resources"] = f"{root}/{source['resourcesPath']}"
            values = {}
            for name, member_name in required.items():
                member = names.get(member_name)
                if member is None or not member.isfile():
                    raise ValidationError(
                        f"{source['name']} archive lacks {member_name}"
                    )
                stream = archive.extractfile(member)
                if stream is None:
                    raise ValidationError(f"could not read {member_name}")
                values[name] = stream.read()
    except (OSError, tarfile.TarError) as error:
        raise ValidationError(f"invalid source archive: {path}") from error
    if digest_bytes(values["license"]) != source["licenseSha256"]:
        raise ValidationError(f"{source['name']} license differs from lock")
    if (
        "resources" in values
        and digest_bytes(values["resources"]) != source["resourcesSha256"]
    ):
        raise ValidationError("Brave resources differ from lock")
    return root, values


def download_source(source, cache_dir):
    cache_dir.mkdir(parents=True, exist_ok=True)
    destination = cache_dir / source["archive"]
    if destination.exists():
        try:
            inspect_source_archive(destination, source)
            return destination
        except ValidationError:
            destination.unlink()
    temporary = destination.with_name(f".{destination.name}.{os.getpid()}.tmp")
    request = urllib.request.Request(
        source["archiveUrl"], headers={"User-Agent": "WildBuzzard release builder"}
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response, temporary.open(
            "wb"
        ) as output:
            shutil.copyfileobj(response, output)
        os.replace(temporary, destination)
    except (OSError, urllib.error.URLError) as error:
        temporary.unlink(missing_ok=True)
        raise ValidationError(f"could not download {source['archiveUrl']}") from error
    inspect_source_archive(destination, source)
    return destination


def extract_source(path, destination, source):
    with tarfile.open(path, "r:gz") as archive:
        members, root = safe_archive_members(archive, source["name"])
        archive.extractall(destination, members=members, filter="data")
    return destination / root


def run_reproduction_check(node, paths, lock, source_roots):
    version = subprocess.run(
        [str(node), "--version"], check=True, capture_output=True, text=True
    ).stdout.strip()
    if version != lock["nodeVersion"]:
        raise ValidationError(
            f"blocker source reproduction requires Node {lock['nodeVersion']}, found {version}"
        )
    brave = lock["sources"]["braveAdblockResources"]
    process = subprocess.run(
        [
            str(node),
            str(paths["verifier"]),
            str(source_roots["uBlockOrigin"]),
            str(source_roots["braveAdblockResources"] / brave["resourcesPath"]),
            str(paths["outputs"]),
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    if process.returncode:
        message = process.stderr.strip() or process.stdout.strip()
        raise ValidationError(
            "blocker outputs are not reproducible from locked sources: "
            + (message or f"Node exited {process.returncode}")
        )


def json_bytes(value):
    return (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()


def add_tar_directory(archive, name, epoch):
    info = tarfile.TarInfo(name)
    info.type = tarfile.DIRTYPE
    info.mode = 0o755
    info.mtime = epoch
    info.uid = info.gid = 0
    info.uname = info.gname = "root"
    archive.addfile(info)


def add_tar_file(archive, name, value, epoch):
    info = tarfile.TarInfo(name)
    info.size = len(value)
    info.mode = 0o644
    info.mtime = epoch
    info.uid = info.gid = 0
    info.uname = info.gname = "root"
    archive.addfile(info, io.BytesIO(value))


def create_source_bundle(repository, cache_dir, output, node):
    paths = repository_paths(repository)
    lock = load_lock(paths["lock"])
    if output.name != lock["artifact"]:
        raise ValidationError(f"output must be named {lock['artifact']}")
    for relative, record in lock["outputs"].items():
        verify_file_record(
            paths["outputs"] / PurePosixPath(relative).name, record, relative
        )

    archives = {}
    source_roots = {}
    license_values = {}
    with tempfile.TemporaryDirectory(prefix="wildbuzzard-blocker-source-") as temp:
        extraction_root = Path(temp)
        for key in SOURCE_KEYS:
            source = lock["sources"][key]
            archive_path = download_source(source, cache_dir)
            archives[key] = archive_path
            source_roots[key] = extract_source(
                archive_path, extraction_root / key, source
            )
            license_path = source_roots[key] / source["licensePath"]
            license_values[key] = license_path.read_bytes()
            if digest_bytes(license_values[key]) != source["licenseSha256"]:
                raise ValidationError(
                    f"{source['name']} extracted license differs from lock"
                )
        run_reproduction_check(node, paths, lock, source_roots)

    payload = {
        "SOURCES.lock.json": paths["lock"].read_bytes(),
        "BLOCKER-ASSET-SOURCE-NOTICE": paths["notice"].read_bytes(),
        "generator/update-bundled-assets.js": paths["generator"].read_bytes(),
        "generator/verify-bundled-resource-source.js": paths["verifier"].read_bytes(),
        "generated/resources.json": (paths["outputs"] / "resources.json").read_bytes(),
        "generated/ubo-scriptlets.json": (
            paths["outputs"] / "ubo-scriptlets.json"
        ).read_bytes(),
    }
    for key in SOURCE_KEYS:
        source = lock["sources"][key]
        payload[f"sources/{source['archive']}"] = archives[key].read_bytes()
        payload[f"licenses/{key}-{PurePosixPath(source['licensePath']).name}"] = (
            license_values[key]
        )
    epoch = max(source["sourceDateEpoch"] for source in lock["sources"].values())
    manifest = {
        "schemaVersion": 1,
        "sourceDateEpoch": epoch,
        "lockSha256": digest_bytes(payload["SOURCES.lock.json"]),
        "files": {
            name: {"sha256": digest_bytes(value), "size": len(value)}
            for name, value in sorted(payload.items())
        },
    }
    payload["SOURCE-MANIFEST.json"] = json_bytes(manifest)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f".{output.name}.{os.getpid()}.tmp")
    directories = {ARCHIVE_ROOT}
    for name in payload:
        parent = PurePosixPath(ARCHIVE_ROOT, name).parent
        while parent.as_posix() != ".":
            directories.add(parent.as_posix())
            parent = parent.parent
    with tarfile.open(temporary, "w:xz", preset=9) as archive:
        for directory in sorted(directories):
            add_tar_directory(archive, directory, epoch)
        for name, value in sorted(payload.items()):
            add_tar_file(archive, f"{ARCHIVE_ROOT}/{name}", value, epoch)
    os.replace(temporary, output)
    verify_source_bundle(output, repository)


def read_bundle(path):
    values = {}
    try:
        with tarfile.open(path, "r:xz") as archive:
            members, root = safe_archive_members(archive, path.name)
            if root != ARCHIVE_ROOT:
                raise ValidationError(f"unexpected blocker source archive root: {root}")
            for member in members:
                if not member.isfile():
                    continue
                relative = PurePosixPath(member.name).relative_to(root).as_posix()
                stream = archive.extractfile(member)
                if stream is None:
                    raise ValidationError(
                        f"could not read blocker source member: {relative}"
                    )
                values[relative] = stream.read()
    except (OSError, tarfile.TarError) as error:
        raise ValidationError(f"invalid blocker source bundle: {path}") from error
    return values


def verify_source_bundle(path, repository):
    paths = repository_paths(repository)
    lock = load_lock(paths["lock"])
    if path.name != lock["artifact"]:
        raise ValidationError(f"source bundle must be named {lock['artifact']}")
    values = read_bundle(path)
    try:
        manifest = require_dict(
            json.loads(values["SOURCE-MANIFEST.json"]), "SOURCE-MANIFEST.json"
        )
    except (KeyError, json.JSONDecodeError) as error:
        raise ValidationError(
            "source bundle lacks a valid SOURCE-MANIFEST.json"
        ) from error
    files = require_dict(manifest.get("files"), "SOURCE-MANIFEST.json files")
    if set(values) != set(files) | {"SOURCE-MANIFEST.json"}:
        raise ValidationError("source bundle members differ from its manifest")
    for name, raw_record in files.items():
        record = require_dict(raw_record, f"manifest record {name}")
        value = values[name]
        if len(value) != record.get("size") or digest_bytes(value) != record.get(
            "sha256"
        ):
            raise ValidationError(f"source bundle member differs from manifest: {name}")
    expected = {
        "SOURCES.lock.json": paths["lock"],
        "BLOCKER-ASSET-SOURCE-NOTICE": paths["notice"],
        "generator/update-bundled-assets.js": paths["generator"],
        "generator/verify-bundled-resource-source.js": paths["verifier"],
        "generated/resources.json": paths["outputs"] / "resources.json",
        "generated/ubo-scriptlets.json": paths["outputs"] / "ubo-scriptlets.json",
    }
    for name, source_path in expected.items():
        if values.get(name) != source_path.read_bytes():
            raise ValidationError(
                f"source bundle member differs from release source: {name}"
            )
    if manifest.get("lockSha256") != digest_bytes(values["SOURCES.lock.json"]):
        raise ValidationError("source bundle lock digest is invalid")
    if manifest.get("sourceDateEpoch") != max(
        source["sourceDateEpoch"] for source in lock["sources"].values()
    ):
        raise ValidationError("source bundle epoch is invalid")
    for key in SOURCE_KEYS:
        source = lock["sources"][key]
        archive_name = f"sources/{source['archive']}"
        archive_value = values.get(archive_name)
        if archive_value is None:
            raise ValidationError(f"source bundle lacks {archive_name}")
        with tempfile.TemporaryDirectory(prefix="wildbuzzard-blocker-verify-") as temp:
            archive_path = Path(temp) / source["archive"]
            archive_path.write_bytes(archive_value)
            _, extracted = inspect_source_archive(archive_path, source)
        license_name = f"licenses/{key}-{PurePosixPath(source['licensePath']).name}"
        if values.get(license_name) != extracted["license"]:
            raise ValidationError(
                f"source bundle license differs from source: {license_name}"
            )


def main():
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    build = subparsers.add_parser("build")
    build.add_argument("--repository", required=True, type=Path)
    build.add_argument("--cache-dir", required=True, type=Path)
    build.add_argument("--output", required=True, type=Path)
    build.add_argument("--node", default="node", type=Path)
    verify = subparsers.add_parser("verify")
    verify.add_argument("--repository", required=True, type=Path)
    verify.add_argument("--source-bundle", required=True, type=Path)
    arguments = parser.parse_args()
    try:
        repository = arguments.repository.resolve(strict=True)
        if arguments.command == "build":
            create_source_bundle(
                repository,
                arguments.cache_dir.resolve(),
                arguments.output.resolve(),
                arguments.node,
            )
        else:
            verify_source_bundle(
                arguments.source_bundle.resolve(strict=True), repository
            )
    except (OSError, subprocess.SubprocessError, ValidationError) as error:
        raise SystemExit(str(error)) from error


if __name__ == "__main__":
    main()
