#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later

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
    ".cjs",
    ".cmake",
    ".cpp",
    ".h",
    ".hpp",
    ".js",
    ".la",
    ".mjs",
    ".o",
    ".py",
    ".pyc",
    ".rs",
    ".tar",
    ".ts",
    ".xz",
    ".bz2",
    ".zip",
}
FORBIDDEN_RUNTIME_NAMES = {"corepack", "node", "nodejs", "npm", "npx"}
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


def validate_external_sources(sources, commit):
    expected = {
        "core": rf"wildbuzzard-qbittorrent-runtime-{commit[:12]}-source\.tar\.xz",
        "boost": r"wildbuzzard-qbittorrent-boost-1\.88\.0-source\.tar\.bz2",
        "qt": r"wildbuzzard-qbittorrent-qtbase-6\.10\.2-source\.tar\.xz",
        "system": rf"wildbuzzard-qbittorrent-ubuntu-24\.04-system-sources-{commit[:12]}\.tar\.xz",
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


def validate_external_source_files(sources, artifacts):
    input_root = Path(artifacts)
    if not input_root.is_dir() or input_root.is_symlink():
        raise SystemExit(f"invalid qBittorrent artifact directory: {input_root}")
    root = input_root.resolve()
    for source_class, record in sources.items():
        path = root / record["name"]
        if (
            not path.is_file()
            or path.is_symlink()
            or path.stat().st_size != record["size"]
            or digest(path) != record["sha256"]
        ):
            raise SystemExit(f"{source_class} corresponding-source artifact differs")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime", required=True)
    parser.add_argument("--artifacts")
    arguments = parser.parse_args()
    root = Path(arguments.runtime).resolve()
    manifest_path = root / "wildbuzzard-qbittorrent-runtime.json"
    manifest = load_json(manifest_path)
    commit = manifest.get("wildbuzzardCommit", "")
    expected_manifest = {
        "schema": 2,
        "component": "wildbuzzard-qbittorrent-runtime",
        "version": "5.2.3",
        "protocolVersion": 1,
        "qbittorrentCommit": "0b63c3d17373f6132ea211c9dcd4241284ccdfaf",
        "libtorrentCommit": "aab2a10e2f60d9eac78e885a696736d043527794",
        "boostVersion": "1.88.0",
        "boostArchiveSha256": "46d9d2c06637b219270877c9e16155cbd015b6dc84349af064c088e9b5b12f7b",
        "qtVersion": "6.10.2",
        "qtSourceArchiveSha256": "aeb78d29291a2b5fd53cb55950f8f5065b4978c25fb1d77f627d695ab9adf21e",
        "platform": "linux-x64",
        "architecture": "x86_64",
    }
    if (
        not re.fullmatch(r"[0-9a-f]{40}", commit)
        or any(manifest.get(name) != value for name, value in expected_manifest.items())
    ):
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
        name = PurePosixPath(relative).name.casefold()
        if (
            parts & FORBIDDEN_COMPONENTS
            or name in FORBIDDEN_RUNTIME_NAMES
            or re.fullmatch(r"python(?:3(?:\.\d+)?)?", name)
            or suffix in FORBIDDEN_SUFFIXES
        ):
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

    binary = (root / "bin/qbittorrent-nox").read_bytes()
    for marker in (
        b"SearchPluginManager",
        b"nova2.py",
        b"nova2dl.py",
        b"api/v2/search",
        b"fetchMetadataAction",
        b"api/v2/torrents/fetchMetadata",
        b"saveMetadataAction",
        b"handleDownloadParam",
        b"#download=",
        b"requestedDownload",
        b"WildBuzzardTorrentDownloadRouted",
    ):
        if marker in binary:
            raise SystemExit(
                "qBittorrent binary contains forbidden integration marker: "
                + marker.decode()
            )
    if (
        b"Only canonical BTIH magnet links are accepted in the `urls` field"
        not in binary
    ):
        raise SystemExit("qBittorrent binary lacks its magnet-only add boundary")

    source_offer = load_json(
        root / "share/doc/wildbuzzard-qbittorrent-runtime/source-offer.json"
    )
    if (
        source_offer.get("schema") != 1
        or source_offer.get("component") != "wildbuzzard-qbittorrent-runtime"
        or source_offer.get("wildbuzzardCommit") != commit
    ):
        raise SystemExit("unsupported qBittorrent source offer")
    external_sources = source_offer.get("correspondingSource", {}).get("externalArtifacts")
    validate_external_sources(external_sources, commit)
    if set(source_offer.get("correspondingSource", {})) != {"externalArtifacts"}:
        raise SystemExit("corresponding source must remain outside the installed runtime")
    if external_sources != manifest.get("externalSourceArtifacts"):
        raise SystemExit("runtime manifest and source offer differ")
    if arguments.artifacts:
        validate_external_source_files(external_sources, arguments.artifacts)

    inventory = load_json(
        root
        / "share/doc/wildbuzzard-qbittorrent-runtime/runtime-component-inventory.json"
    )
    if (
        inventory.get("schema") != 2
        or inventory.get("component") != "wildbuzzard-qbittorrent-runtime"
        or inventory.get("platform") != "linux-x64"
        or inventory.get("qt", {}).get("version") != "6.10.2"
        or inventory.get("qt", {}).get("lreleaseSha256")
        != "e9f9f468f45fe73b1fe56a235438d802d51fd45dd55b52f06b212029bce458b8"
    ):
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

    sbom = load_json(
        root / "share/doc/wildbuzzard-qbittorrent-runtime/sbom.spdx.json"
    )
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
