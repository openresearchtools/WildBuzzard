#!/usr/bin/env python3

import argparse
import hashlib
import json
import os
import re
import subprocess
from pathlib import Path, PurePosixPath


FORBIDDEN_COMPONENTS = {
    "__pycache__",
    "bench",
    "benches",
    "build",
    "cache",
    "cmake",
    "coverage",
    "examples",
    "fixtures",
    "logs",
    "node_modules",
    "obj",
    "target",
    "test",
    "testdata",
    "testing",
    "tests",
    "tmp",
}
FORBIDDEN_SUFFIXES = {
    ".a",
    ".c",
    ".cc",
    ".cmake",
    ".cpp",
    ".h",
    ".hpp",
    ".la",
    ".o",
    ".py",
    ".pyc",
    ".rs",
    ".tar",
    ".xz",
    ".bz2",
    ".zip",
}
MAX_RUNTIME_BYTES = 128 * 1024 * 1024
MAX_RUNTIME_FILES = 128


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_json(path):
    if not path.is_file() or path.is_symlink():
        raise SystemExit(f"missing regular provenance file: {path}")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise SystemExit(f"invalid provenance JSON: {path}") from error


def runtime_path(root, relative):
    if not isinstance(relative, str) or "\\" in relative:
        raise SystemExit("invalid runtime-relative provenance path")
    path = PurePosixPath(relative)
    if path.is_absolute() or ".." in path.parts or path.as_posix() != relative:
        raise SystemExit(f"unsafe runtime-relative provenance path: {relative}")
    return root.joinpath(*path.parts)


def validate_external_sources(sources):
    expected = {
        "core": r"wildbuzzard-qbittorrent-runtime-[0-9a-f]{12}-source\.tar\.xz",
        "boost": r"wildbuzzard-qbittorrent-boost-1\.88\.0-source\.tar\.bz2",
        "qt": r"wildbuzzard-qbittorrent-qtbase-6\.10\.2-source\.tar\.xz",
        "system": r"wildbuzzard-qbittorrent-ubuntu-24\.04-system-sources-[0-9a-f]{12}\.tar\.xz",
    }
    if set(sources) != set(expected):
        raise SystemExit("runtime source offer lacks exact source artifact classes")
    for name, pattern in expected.items():
        record = sources[name]
        if (
            not isinstance(record, dict)
            or not re.fullmatch(pattern, record.get("name", ""))
            or not re.fullmatch(r"[0-9a-f]{64}", record.get("sha256", ""))
            or not isinstance(record.get("size"), int)
            or record["size"] <= 0
        ):
            raise SystemExit(f"invalid {name} source artifact declaration")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime", required=True)
    arguments = parser.parse_args()
    root = Path(arguments.runtime).resolve()
    manifest_path = root / "wildbuzzard-qbittorrent-runtime.json"
    manifest = load_json(manifest_path)
    if manifest.get("schema") != 2 or manifest.get("component") != "wildbuzzard-qbittorrent-runtime":
        raise SystemExit("unsupported qBittorrent runtime manifest")

    files = {}
    inodes = set()
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise SystemExit(f"runtime symlink is forbidden: {path}")
        if not path.is_file() or path == manifest_path:
            continue
        relative = path.relative_to(root).as_posix()
        parts = {part.casefold() for part in PurePosixPath(relative).parts}
        suffix = PurePosixPath(relative.casefold()).suffix
        if parts & FORBIDDEN_COMPONENTS or suffix in FORBIDDEN_SUFFIXES:
            raise SystemExit(f"development or test payload is forbidden: {relative}")
        stat = path.stat()
        expected_mode = 0o755 if relative == "bin/qbittorrent-nox" else 0o644
        if stat.st_mode & 0o7777 != expected_mode:
            raise SystemExit(f"runtime file mode differs: {relative}")
        inode = (stat.st_dev, stat.st_ino)
        if stat.st_nlink != 1 or inode in inodes:
            raise SystemExit(f"runtime hard link is forbidden: {relative}")
        inodes.add(inode)
        files[relative] = {
            "path": relative,
            "size": stat.st_size,
            "sha256": digest(path),
            "executable": relative == "bin/qbittorrent-nox",
        }
    if len(files) > MAX_RUNTIME_FILES:
        raise SystemExit("qBittorrent runtime exceeds its file-count budget")
    if sum(entry["size"] for entry in files.values()) > MAX_RUNTIME_BYTES:
        raise SystemExit("qBittorrent runtime exceeds its installed-size budget")
    declared_files = manifest.get("files")
    if not isinstance(declared_files, list) or any(not isinstance(item, dict) for item in declared_files):
        raise SystemExit("runtime manifest has no exact file inventory")
    declared = {item.get("path"): item for item in declared_files}
    if len(declared) != len(declared_files) or declared != files:
        raise SystemExit("runtime file inventory or digest differs")
    payload = "".join(
        f"{entry['path']}\0{entry['size']}\0{entry['sha256']}\0{1 if entry['executable'] else 0}\n"
        for entry in declared_files
    ).encode()
    if hashlib.sha256(payload).hexdigest() != manifest.get("payloadSha256"):
        raise SystemExit("runtime payload digest differs")

    source_offer = load_json(root / "share/doc/buzzard-torrent/source-offer.json")
    external_sources = source_offer.get("correspondingSource", {}).get("externalArtifacts")
    validate_external_sources(external_sources)
    if set(source_offer.get("correspondingSource", {})) != {"externalArtifacts"}:
        raise SystemExit("corresponding source must remain outside the installed runtime")
    if external_sources != manifest.get("externalSourceArtifacts"):
        raise SystemExit("runtime manifest and source offer differ")

    inventory = load_json(root / "share/doc/buzzard-torrent/runtime-component-inventory.json")
    if inventory.get("schema") != 2 or inventory.get("platform") != "linux-x64":
        raise SystemExit("unsupported runtime component inventory")
    components = inventory.get("runtimeLibraries", []) + inventory.get("qt", {}).get("plugins", [])
    component_paths = {entry.get("path") for entry in components if isinstance(entry, dict)}
    actual_components = {
        relative
        for relative in files
        if relative.startswith("lib/") or relative.startswith("plugins/")
    }
    if len(component_paths) != len(components) or component_paths != actual_components:
        raise SystemExit("runtime component inventory is incomplete or duplicated")
    for entry in components:
        path = entry["path"]
        if entry.get("sha256") != files[path]["sha256"] or entry.get("size") != files[path]["size"]:
            raise SystemExit(f"runtime component digest differs: {path}")
        if entry.get("component") == "Qt":
            if entry.get("componentVersion") != "6.10.2":
                raise SystemExit(f"unexpected Qt component version: {path}")
        else:
            required = ("binaryPackage", "binaryVersion", "sourcePackage", "sourceVersion")
            if any(not entry.get(field) for field in required):
                raise SystemExit(f"runtime component lacks Debian source identity: {path}")
    system_packages = inventory.get("systemPackages")
    if not isinstance(system_packages, list):
        raise SystemExit("runtime inventory lacks system package provenance")
    expected_packages = {
        entry["binaryPackage"] for entry in components if entry.get("component") != "Qt"
    }
    if {entry.get("binaryPackage") for entry in system_packages} != expected_packages:
        raise SystemExit("system package inventory differs from runtime libraries")
    for package in system_packages:
        copyright_path = runtime_path(root, package.get("copyrightPath", ""))
        if (
            not copyright_path.is_file()
            or copyright_path.is_symlink()
            or digest(copyright_path) != package.get("copyrightSha256")
        ):
            raise SystemExit(f"system package copyright differs: {package.get('binaryPackage')}")
    if inventory.get("externalSourceArtifacts") != external_sources:
        raise SystemExit("component inventory and source offer differ")

    sbom = load_json(root / "share/doc/buzzard-torrent/sbom.spdx.json")
    if sbom.get("spdxVersion") != "SPDX-2.3" or sbom.get("dataLicense") != "CC0-1.0":
        raise SystemExit("invalid qBittorrent SPDX document")
    packages = sbom.get("packages")
    if not isinstance(packages, list) or not packages:
        raise SystemExit("qBittorrent SPDX document has no packages")
    for package in packages:
        for field in ("downloadLocation", "licenseConcluded", "licenseDeclared", "copyrightText"):
            if not package.get(field) or package[field] == "NOASSERTION":
                raise SystemExit(f"SPDX package has unresolved {field}: {package.get('name')}")
    license_ids = {
        entry.get("licenseId") for entry in sbom.get("hasExtractedLicensingInfos", [])
    }
    for package in system_packages:
        expected_id = "LicenseRef-Debian-Copyright-" + re.sub(
            r"[^A-Za-z0-9.+-]", "-", package["sourcePackage"]
        )
        if expected_id not in license_ids:
            raise SystemExit(f"SPDX lacks extracted system licensing: {package['sourcePackage']}")

    environment = os.environ.copy()
    environment["LD_LIBRARY_PATH"] = str(root / "lib")
    for relative in ["bin/qbittorrent-nox", *sorted(actual_components)]:
        result = subprocess.run(
            ["ldd", str(root / relative)],
            check=True,
            capture_output=True,
            text=True,
            env=environment,
        )
        if "not found" in result.stdout or "not found" in result.stderr:
            raise SystemExit(f"unresolved runtime library dependency: {relative}")


if __name__ == "__main__":
    main()
