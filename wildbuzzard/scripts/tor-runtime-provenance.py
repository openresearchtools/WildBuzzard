#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0

import argparse
import hashlib
import json
import re
import stat
import subprocess
import tarfile
import zipfile
from pathlib import Path

import tomllib

VERSION = "0.4.9.11"
MANIFEST = "wildbuzzard-tor-runtime.json"


def digest(data):
    return hashlib.sha256(data).hexdigest()


def regular(path, maximum=64 * 1024 * 1024):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_size > maximum:
        raise ValueError(f"Unsafe Tor runtime input: {path}")
    return path.read_bytes()


def pins(path):
    value = tomllib.loads(regular(path).decode())
    if (value["version"] != VERSION or value["tag"] != f"tor-{VERSION}"
            or value["repository"] != "https://gitlab.torproject.org/tpo/core/tor.git"
            or value["subtree"] != "third_party/tor"
            or not re.fullmatch(r"[0-9a-f]{40}", value["commit"])):
        raise ValueError("Invalid Tor release pin")
    return value


def verify_source(config, source, root):
    metadata = pins(config)
    if digest(regular(source)) != metadata["source_sha256"]:
        raise ValueError("Tor source archive differs from the pinned commit")
    expected = set()
    with tarfile.open(source) as archive:
        for member in archive:
            path = root / member.name
            if member.isfile():
                expected.add(member.name)
                if regular(path) != archive.extractfile(member).read():
                    raise ValueError(f"Vendored Tor source differs: {member.name}")
            elif not member.isdir():
                raise ValueError("Unexpected non-file in Tor source")
    actual = {p.relative_to(root).as_posix() for p in root.rglob("*") if not p.is_dir()}
    if actual != expected:
        raise ValueError("Vendored Tor source contains missing or extra files")


def validate(binary, config, installed, provenance, inventory):
    metadata = pins(config)
    if regular(installed) != regular(config):
        raise ValueError("Installed Tor metadata differs from the release pin")
    with zipfile.ZipFile(provenance) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)) or any(
            info.file_size > 8 * 1024 * 1024 for info in archive.infolist()
        ):
            raise ValueError("Invalid Tor provenance archive")
        manifest = json.loads(archive.read(MANIFEST))
        if (manifest["schema"] != 1 or manifest["upstream"] != metadata
                or manifest["binarySha256"] != digest(regular(binary))
                or manifest["inventorySha256"] != digest(regular(inventory))):
            raise ValueError("Tor binary or source provenance does not match")
        inv = json.loads(regular(inventory))
        expected = {MANIFEST, "THIRD-PARTY.json", "tor.toml"}
        if archive.read("THIRD-PARTY.json") != regular(inventory):
            raise ValueError("Tor license inventory differs")
        if archive.read("tor.toml") != regular(config):
            raise ValueError("Tor provenance release pin differs")
        for package in inv["packages"]:
            for entry in package["licenseFiles"]:
                name = entry["installedPath"]
                expected.add(name)
                if digest(archive.read(name)) != entry["sha256"]:
                    raise ValueError("Tor dependency license differs")
        if set(names) != expected:
            raise ValueError("Tor provenance has missing or extra entries")


def create(args):
    metadata = pins(args.pin_config)
    if digest(regular(args.source)) != metadata["source_sha256"]:
        raise ValueError("Tor source differs from the release pin")
    version = subprocess.check_output([str(args.binary), "--version"], text=True)
    if f"Tor version {VERSION}" not in version:
        raise ValueError("Built Tor has the wrong version")
    linked = subprocess.check_output(["ldd", str(args.binary)], text=True)
    if re.search(r"lib(?:ssl|crypto|event|zstd|lzma|z)\b", linked):
        raise ValueError("Tor dependencies must be statically linked")
    root = args.source_root / "wildbuzzard/third_party/tor-notices"
    inventory = root / "THIRD-PARTY.json"
    inv = json.loads(regular(inventory))
    for package, deb in zip(inv["packages"][1:], ["libssl-dev", "libevent-dev", "zlib1g-dev"]):
        actual = subprocess.check_output(["dpkg-query", "-W", "-f=${Version}", deb], text=True)
        if actual != package["version"]:
            raise ValueError(f"Build dependency version differs: {deb}")
    manifest = dict(schema=1, upstream=metadata,
                    binarySha256=digest(regular(args.binary)),
                    inventorySha256=digest(regular(inventory)),
                    sourceArtifact=args.source.name,
                    compiler=subprocess.check_output(["cc", "--version"], text=True).splitlines()[0],
                    configure="static libevent, OpenSSL, zlib; no lzma/zstd; hardened")
    with zipfile.ZipFile(args.provenance, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(MANIFEST, json.dumps(manifest, indent=2) + "\n")
        archive.write(inventory, "THIRD-PARTY.json")
        archive.write(args.pin_config, "tor.toml")
        for package in inv["packages"]:
            for entry in package["licenseFiles"]:
                path = root / entry["installedPath"]
                if digest(regular(path)) != entry["sha256"]:
                    raise ValueError("Tor license source differs")
                archive.write(path, entry["installedPath"])
    validate(args.binary, args.pin_config, args.pin_config, args.provenance, inventory)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["create", "validate", "verify-source"])
    for name in ["binary", "pin-config", "installed-config", "provenance", "inventory", "source", "source-root"]:
        parser.add_argument("--" + name, type=Path)
    args = parser.parse_args()
    try:
        if args.command == "create":
            create(args)
        elif args.command == "verify-source":
            verify_source(args.pin_config, args.source, args.source_root)
        else:
            validate(args.binary, args.pin_config, args.installed_config, args.provenance, args.inventory)
    except (OSError, ValueError, KeyError, zipfile.BadZipFile) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
