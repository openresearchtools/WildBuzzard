#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later

import argparse
import datetime
import hashlib
import io
import json
import lzma
import os
import re
import shutil
import subprocess
import tarfile
import tempfile
from pathlib import Path, PurePosixPath


QT_VERSION = "6.10.2"
QT_SOURCE_SHA256 = "aeb78d29291a2b5fd53cb55950f8f5065b4978c25fb1d77f627d695ab9adf21e"
BOOST_VERSION = "1.88.0"
BOOST_SOURCE_SHA256 = "46d9d2c06637b219270877c9e16155cbd015b6dc84349af064c088e9b5b12f7b"


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def safe_name(value):
    return re.sub(r"[^A-Za-z0-9.+-]", "-", value)


def parse_deb822(path):
    fields = {}
    current = None
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        if raw_line.startswith((" ", "\t")) and current:
            fields[current] += "\n" + raw_line[1:]
            continue
        if ":" not in raw_line:
            current = None
            continue
        name, value = raw_line.split(":", 1)
        if not re.fullmatch(r"[A-Za-z0-9-]+", name):
            current = None
            continue
        current = name
        fields[name] = value.lstrip()
    return fields


def package_metadata(package):
    output = subprocess.run(
        [
            "dpkg-query",
            "-W",
            "-f=${binary:Package}\t${Version}\t${source:Package}\t${source:Version}\n",
            package,
        ],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.rstrip("\n")
    rows = [line.split("\t") for line in output.splitlines() if line]
    if len(rows) != 1 or len(rows[0]) != 4:
        raise SystemExit(f"could not resolve an exact package identity for {package}")
    binary, version, source, source_version = rows[0]
    binary_name = binary.split(":", 1)[0]
    source = source or binary_name
    source_version = source_version or version
    if not all((binary, version, source, source_version)):
        raise SystemExit(f"incomplete package identity for {package}")
    return {
        "binaryPackage": binary,
        "binaryVersion": version,
        "sourcePackage": source,
        "sourceVersion": source_version,
    }


def package_owners(path):
    candidates = {str(path), str(path.resolve())}
    for candidate in tuple(candidates):
        if candidate.startswith("/lib/"):
            candidates.add("/usr" + candidate)
    owners = set()
    for candidate in sorted(candidates):
        result = subprocess.run(
            ["dpkg-query", "-S", candidate],
            check=False,
            capture_output=True,
            text=True,
        )
        if result.returncode not in (0, 1):
            raise SystemExit(f"dpkg-query failed for {candidate}")
        for line in result.stdout.splitlines():
            if ": " not in line:
                continue
            package_field, owned_path = line.rsplit(": ", 1)
            if owned_path not in candidates:
                continue
            owners.update(part.strip() for part in package_field.split(",") if part.strip())
    identities = {}
    for owner in sorted(owners):
        identity = package_metadata(owner)
        identities[identity["binaryPackage"]] = identity
    if len(identities) != 1:
        names = ", ".join(sorted(identities)) or "none"
        raise SystemExit(f"runtime library {path} has ambiguous package ownership: {names}")
    return next(iter(identities.values()))


def validate_source_download(directory, source, version):
    dsc_files = sorted(directory.glob("*.dsc"))
    if len(dsc_files) != 1:
        raise SystemExit(f"expected one .dsc for {source}={version}")
    dsc = dsc_files[0]
    fields = parse_deb822(dsc)
    if fields.get("Source") != source or fields.get("Version") != version:
        raise SystemExit(f"downloaded source identity differs for {source}={version}")
    checksums = [
        line for line in fields.get("Checksums-Sha256", "").splitlines() if line.strip()
    ]
    expected = {dsc.name}
    for line in checksums:
        parts = line.split()
        if len(parts) != 3 or not re.fullmatch(r"[0-9a-f]{64}", parts[0]):
            raise SystemExit(f"invalid source checksum record in {dsc.name}")
        sha256, raw_size, filename = parts
        if PurePosixPath(filename).name != filename or not raw_size.isdecimal():
            raise SystemExit(f"unsafe source filename in {dsc.name}")
        path = directory / filename
        if not path.is_file() or path.is_symlink():
            raise SystemExit(f"missing source input {filename} for {source}")
        if path.stat().st_size != int(raw_size) or digest(path) != sha256:
            raise SystemExit(f"source input checksum differs for {filename}")
        expected.add(filename)
    actual = {path.name for path in directory.iterdir() if path.is_file()}
    if actual != expected:
        raise SystemExit(f"unexpected source inputs for {source}: {sorted(actual - expected)}")
    subprocess.run(
        ["dpkg-source", "-x", dsc.name, "validated"],
        cwd=directory,
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    shutil.rmtree(directory / "validated")
    return [
        {
            "name": path.name,
            "sha256": digest(path),
            "size": path.stat().st_size,
        }
        for path in sorted(directory.iterdir())
        if path.is_file()
    ]


def add_bytes(archive, name, data, epoch, mode=0o644):
    info = tarfile.TarInfo(name)
    info.size = len(data)
    info.mode = mode
    info.mtime = epoch
    info.uid = 0
    info.gid = 0
    info.uname = "root"
    info.gname = "root"
    archive.addfile(info, io.BytesIO(data))


def deterministic_source_bundle(path, root_name, manifest, downloads, epoch):
    with lzma.open(path, "wb", preset=9 | lzma.PRESET_EXTREME) as compressed:
        with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as archive:
            add_bytes(
                archive,
                f"{root_name}/manifest.json",
                (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode(),
                epoch,
            )
            for source, directory in sorted(downloads.items()):
                for source_file in sorted(directory.iterdir()):
                    if source_file.is_file():
                        add_bytes(
                            archive,
                            f"{root_name}/sources/{safe_name(source)}/{source_file.name}",
                            source_file.read_bytes(),
                            epoch,
                        )
    os.utime(path, (epoch, epoch))


def source_artifact(source, destination, name, url, expected_sha256, epoch):
    if digest(source) != expected_sha256:
        raise SystemExit(f"source archive differs from its pin: {source}")
    target = destination / name
    shutil.copyfile(source, target)
    target.chmod(0o644)
    os.utime(target, (epoch, epoch))
    return {
        "name": target.name,
        "sha256": digest(target),
        "size": target.stat().st_size,
        "url": url,
    }


def existing_source_artifact(path, expected_name, epoch):
    if (
        not path.is_file()
        or path.is_symlink()
        or path.name != expected_name
        or path.stat().st_size <= 0
    ):
        raise SystemExit(f"invalid corresponding-source artifact: {path}")
    path.chmod(0o644)
    os.utime(path, (epoch, epoch))
    return {
        "name": path.name,
        "sha256": digest(path),
        "size": path.stat().st_size,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime", required=True)
    parser.add_argument("--artifacts", required=True)
    parser.add_argument("--component-inputs", required=True)
    parser.add_argument("--core-source-archive", required=True)
    parser.add_argument("--qt-source-archive", required=True)
    parser.add_argument("--boost-source-archive", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--source-date-epoch", required=True, type=int)
    parser.add_argument("--lrelease-sha256", required=True)
    arguments = parser.parse_args()

    runtime = Path(arguments.runtime).resolve()
    artifacts = Path(arguments.artifacts).resolve()
    component_inputs = Path(arguments.component_inputs).resolve()
    epoch = arguments.source_date_epoch
    if not re.fullmatch(r"[0-9a-f]{40}", arguments.commit):
        raise SystemExit("commit must be a full Git object ID")
    artifacts.mkdir(parents=True, exist_ok=True)
    licenses = runtime / "licenses"
    notices = runtime / "share" / "doc" / "buzzard-torrent"
    licenses.mkdir(parents=True, exist_ok=True)
    notices.mkdir(parents=True, exist_ok=True)

    components = []
    system_packages = {}
    for line in component_inputs.read_text(encoding="utf-8").splitlines():
        fields = line.split("\t")
        if len(fields) != 4:
            raise SystemExit("invalid qBittorrent component input")
        relative, soname, raw_source, kind = fields
        if PurePosixPath(relative).is_absolute() or ".." in PurePosixPath(relative).parts:
            raise SystemExit(f"unsafe runtime component path: {relative}")
        target = runtime / relative
        source = Path(raw_source)
        if not target.is_file() or target.is_symlink() or not source.is_file():
            raise SystemExit(f"missing regular runtime component: {relative}")
        entry = {
            "path": relative,
            "soname": soname,
            "sha256": digest(target),
            "size": target.stat().st_size,
        }
        if kind == "qt":
            entry.update({"component": "Qt", "componentVersion": QT_VERSION})
        elif kind == "debian":
            identity = package_owners(source)
            entry.update({"component": identity["binaryPackage"], "componentVersion": identity["binaryVersion"], **identity})
            system_packages[identity["binaryPackage"]] = identity
        else:
            raise SystemExit(f"unknown runtime component kind: {kind}")
        components.append(entry)
    components.sort(key=lambda item: item["path"])
    if len({item["path"] for item in components}) != len(components):
        raise SystemExit("duplicate runtime component paths")

    source_packages = {}
    for binary, identity in sorted(system_packages.items()):
        binary_name = binary.split(":", 1)[0]
        copyright_path = Path("/usr/share/doc") / binary_name / "copyright"
        if not copyright_path.is_file():
            raise SystemExit(f"missing installed Debian copyright for {binary}")
        copyright_name = f"system-{safe_name(binary)}.copyright"
        copyright_target = licenses / copyright_name
        shutil.copyfile(copyright_path, copyright_target)
        copyright_target.chmod(0o644)
        identity["copyrightPath"] = f"licenses/{copyright_name}"
        identity["copyrightSha256"] = digest(copyright_target)
        source_key = (identity["sourcePackage"], identity["sourceVersion"])
        source_packages.setdefault(source_key, []).append(identity)

    downloads = {}
    source_records = []
    with tempfile.TemporaryDirectory(prefix="wildbuzzard-qbittorrent-sources-") as temporary:
        temporary_root = Path(temporary)
        for index, ((source, version), identities) in enumerate(sorted(source_packages.items())):
            if source in downloads:
                raise SystemExit(f"multiple installed source versions for {source}")
            directory = temporary_root / f"{index:03d}-{safe_name(source)}"
            directory.mkdir()
            subprocess.run(
                ["apt-get", "source", "--download-only", "--only-source", f"{source}={version}"],
                cwd=directory,
                check=True,
                env={**os.environ, "LC_ALL": "C", "LANG": "C"},
            )
            files = validate_source_download(directory, source, version)
            downloads[source] = directory
            copyright_files = sorted({identity["copyrightPath"] for identity in identities})
            copyright_hashes = sorted({identity["copyrightSha256"] for identity in identities})
            source_records.append(
                {
                    "sourcePackage": source,
                    "sourceVersion": version,
                    "binaryPackages": sorted(identity["binaryPackage"] for identity in identities),
                    "copyrightFiles": copyright_files,
                    "copyrightSha256": copyright_hashes,
                    "files": files,
                }
            )

        bundle_name = f"wildbuzzard-qbittorrent-ubuntu-24.04-system-sources-{arguments.commit[:12]}.tar.xz"
        bundle_path = artifacts / bundle_name
        bundle_root = bundle_name.removesuffix(".tar.xz")
        bundle_manifest = {
            "schema": 1,
            "component": "wildbuzzard-qbittorrent-runtime-system-sources",
            "platform": "ubuntu-24.04",
            "wildbuzzardCommit": arguments.commit,
            "sourcePackages": source_records,
        }
        deterministic_source_bundle(bundle_path, bundle_root, bundle_manifest, downloads, epoch)

    core_source_name = (
        f"wildbuzzard-qbittorrent-runtime-{arguments.commit[:12]}-source.tar.xz"
    )
    core_source = existing_source_artifact(
        Path(arguments.core_source_archive).resolve(), core_source_name, epoch
    )
    if Path(arguments.core_source_archive).resolve().parent != artifacts:
        raise SystemExit("core corresponding source must be emitted in the artifact directory")

    external_sources = {
        "core": core_source,
        "boost": source_artifact(
            Path(arguments.boost_source_archive),
            artifacts,
            f"wildbuzzard-qbittorrent-boost-{BOOST_VERSION}-source.tar.bz2",
            f"https://archives.boost.io/release/{BOOST_VERSION}/source/boost_1_88_0.tar.bz2",
            BOOST_SOURCE_SHA256,
            epoch,
        ),
        "qt": source_artifact(
            Path(arguments.qt_source_archive),
            artifacts,
            f"wildbuzzard-qbittorrent-qtbase-{QT_VERSION}-source.tar.xz",
            f"https://download.qt.io/official_releases/qt/6.10/{QT_VERSION}/submodules/qtbase-everywhere-src-{QT_VERSION}.tar.xz",
            QT_SOURCE_SHA256,
            epoch,
        ),
        "system": {
            "name": bundle_path.name,
            "sha256": digest(bundle_path),
            "size": bundle_path.stat().st_size,
            "platform": "ubuntu-24.04",
        },
    }

    inventory = {
        "schema": 2,
        "component": "buzzard-torrent-runtime",
        "platform": "linux-x64",
        "qt": {
            "version": QT_VERSION,
            "lreleaseSha256": arguments.lrelease_sha256,
            "plugins": [entry for entry in components if entry["path"].startswith("plugins/")],
        },
        "runtimeLibraries": [entry for entry in components if entry["path"].startswith("lib/")],
        "systemPackages": sorted(system_packages.values(), key=lambda item: item["binaryPackage"]),
        "externalSourceArtifacts": external_sources,
    }
    inventory_path = notices / "runtime-component-inventory.json"
    inventory_path.write_text(json.dumps(inventory, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    source_offer = {
        "schema": 1,
        "component": "wildbuzzard-qbittorrent-runtime",
        "wildbuzzardCommit": arguments.commit,
        "correspondingSource": {
            "externalArtifacts": external_sources,
        },
    }
    (notices / "source-offer.json").write_text(
        json.dumps(source_offer, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )

    packages = [
        {
            "name": "qBittorrent",
            "SPDXID": "SPDXRef-Package-qBittorrent",
            "versionInfo": "5.2.3",
            "downloadLocation": "git+https://github.com/qbittorrent/qBittorrent.git@0b63c3d17373f6132ea211c9dcd4241284ccdfaf",
            "filesAnalyzed": False,
            "licenseConcluded": "GPL-3.0-or-later",
            "licenseDeclared": "GPL-3.0-or-later",
            "copyrightText": "Copyright qBittorrent contributors",
            "externalRefs": [
                {
                    "referenceCategory": "OTHER",
                    "referenceType": "wildbuzzard-source-archive",
                    "referenceLocator": (
                        f"{external_sources['core']['name']}#sha256="
                        f"{external_sources['core']['sha256']}"
                    ),
                }
            ],
        },
        {
            "name": "libtorrent",
            "SPDXID": "SPDXRef-Package-libtorrent",
            "versionInfo": "2.0.14",
            "downloadLocation": "git+https://github.com/arvidn/libtorrent.git@aab2a10e2f60d9eac78e885a696736d043527794",
            "filesAnalyzed": False,
            "licenseConcluded": "BSD-3-Clause",
            "licenseDeclared": "BSD-3-Clause",
            "copyrightText": "Copyright Arvid Norberg and libtorrent contributors",
            "externalRefs": [
                {
                    "referenceCategory": "OTHER",
                    "referenceType": "wildbuzzard-source-archive",
                    "referenceLocator": (
                        f"{external_sources['core']['name']}#sha256="
                        f"{external_sources['core']['sha256']}"
                    ),
                }
            ],
        },
        {
            "name": "Boost",
            "SPDXID": "SPDXRef-Package-Boost",
            "versionInfo": BOOST_VERSION,
            "downloadLocation": external_sources["boost"]["url"],
            "filesAnalyzed": False,
            "licenseConcluded": "BSL-1.0",
            "licenseDeclared": "BSL-1.0",
            "copyrightText": "Copyright Boost contributors",
            "checksums": [{"algorithm": "SHA256", "checksumValue": BOOST_SOURCE_SHA256}],
        },
        {
            "name": "Qt",
            "SPDXID": "SPDXRef-Package-Qt",
            "versionInfo": QT_VERSION,
            "downloadLocation": external_sources["qt"]["url"],
            "filesAnalyzed": False,
            "licenseConcluded": "LGPL-3.0-only OR GPL-2.0-only OR GPL-3.0-only",
            "licenseDeclared": "LGPL-3.0-only OR GPL-2.0-only OR GPL-3.0-only",
            "copyrightText": "Copyright The Qt Company Ltd. and Qt contributors",
            "checksums": [{"algorithm": "SHA256", "checksumValue": QT_SOURCE_SHA256}],
        },
    ]
    extracted_licenses = []
    for record in source_records:
        license_id = f"LicenseRef-Debian-Copyright-{safe_name(record['sourcePackage'])}"
        texts = []
        for relative in record["copyrightFiles"]:
            texts.append((runtime / relative).read_text(encoding="utf-8", errors="replace"))
        extracted_licenses.append(
            {
                "licenseId": license_id,
                "name": f"Debian copyright for {record['sourcePackage']} {record['sourceVersion']}",
                "extractedText": "\n\n".join(texts),
            }
        )
        packages.append(
            {
                "name": record["sourcePackage"],
                "SPDXID": f"SPDXRef-Package-{safe_name(record['sourcePackage'])}",
                "versionInfo": record["sourceVersion"],
                "downloadLocation": f"https://packages.ubuntu.com/source/noble/{record['sourcePackage']}",
                "filesAnalyzed": False,
                "licenseConcluded": license_id,
                "licenseDeclared": license_id,
                "copyrightText": "; ".join(record["copyrightFiles"]),
                "externalRefs": [
                    {
                        "referenceCategory": "OTHER",
                        "referenceType": "wildbuzzard-source-archive",
                        "referenceLocator": (
                            f"{external_sources['system']['name']}#sha256="
                            f"{external_sources['system']['sha256']}"
                        ),
                    }
                ],
            }
        )
    created = datetime.datetime.fromtimestamp(epoch, datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    sbom = {
        "spdxVersion": "SPDX-2.3",
        "dataLicense": "CC0-1.0",
        "SPDXID": "SPDXRef-DOCUMENT",
        "name": f"buzzard-torrent-runtime-{arguments.commit[:12]}",
        "documentNamespace": f"https://github.com/openresearchtools/wildbuzzard/sbom/buzzard-torrent/{arguments.commit}",
        "creationInfo": {
            "created": created,
            "creators": ["Organization: openresearchtools", "Tool: generate-qbittorrent-runtime-provenance.py"],
        },
        "packages": packages,
        "relationships": [
            {"spdxElementId": "SPDXRef-DOCUMENT", "relationshipType": "DESCRIBES", "relatedSpdxElement": package["SPDXID"]}
            for package in packages
        ],
        "hasExtractedLicensingInfos": extracted_licenses,
    }
    (notices / "sbom.spdx.json").write_text(
        json.dumps(sbom, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    for path in runtime.rglob("*"):
        os.utime(path, (epoch, epoch), follow_symlinks=False)
    print(json.dumps(external_sources, sort_keys=True))


if __name__ == "__main__":
    main()
