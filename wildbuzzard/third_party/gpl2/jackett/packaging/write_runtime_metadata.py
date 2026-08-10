#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-only

import argparse
import hashlib
import json
import re
from pathlib import Path


COMMIT = "0cd8622b735922a909a128d8d6943bb8565a640f"


def sha256_bytes(value):
    return hashlib.sha256(value).hexdigest()


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def runtime_files(root):
    entries = []
    for path in sorted(candidate for candidate in root.rglob("*") if candidate.is_file()):
        relative = path.relative_to(root).as_posix()
        entries.append(
            {
                "path": relative,
                "sha256": sha256_file(path),
                "size": path.stat().st_size,
                "executable": bool(path.stat().st_mode & 0o111),
            }
        )
    return entries


def lock_inventory_from_source(source):
    paths = sorted(source.glob("src/*/packages.lock.json"))
    packages = {}
    digest = hashlib.sha256()
    for path in paths:
        relative = path.relative_to(source).as_posix().encode()
        data = path.read_bytes()
        digest.update(len(relative).to_bytes(4, "big"))
        digest.update(relative)
        digest.update(data)
        document = json.loads(data)
        for dependencies in document["dependencies"].values():
            for name, details in dependencies.items():
                if details.get("type") == "Project":
                    continue
                packages[(name, details["resolved"])] = details.get("contentHash")
    return digest.hexdigest(), packages


def spdx_id(value):
    return "SPDXRef-" + re.sub(r"[^A-Za-z0-9.-]", "-", value)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime", type=Path, required=True)
    parser.add_argument("--catalog", type=Path, required=True)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--source-sha256", required=True)
    parser.add_argument("--sdk-image", required=True)
    parser.add_argument("--license-inventory", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--sbom", type=Path, required=True)
    args = parser.parse_args()
    files = runtime_files(args.runtime)
    canonical_files = json.dumps(files, sort_keys=True, separators=(",", ":")).encode()
    runtime_digest = sha256_bytes(canonical_files)
    lock_digest, packages = lock_inventory_from_source(args.source)
    catalog = json.loads(args.catalog.read_text(encoding="utf-8"))
    license_inventory = {
        (entry["name"], entry["version"]): entry
        for entry in json.loads(args.license_inventory.read_text(encoding="utf-8"))["packages"]
    }
    if set(license_inventory) != set(packages):
        raise ValueError("NuGet license inventory differs from dependency locks")
    manifest = {
        "schemaVersion": 1,
        "component": "jackett-mini",
        "semanticVersion": "0.24.2360-wildbuzzard.1",
        "upstreamVersion": "v0.24.2360",
        "upstreamCommit": COMMIT,
        "sourceSha256": args.source_sha256,
        "platform": "linux",
        "architecture": "x86_64",
        "libc": "glibc",
        "dependencyLockSha256": lock_digest,
        "runtimeSha256": runtime_digest,
        "protocolVersion": 1,
        "providerPolicySha256": catalog["policySha256"],
        "catalogFileSha256": sha256_file(args.catalog),
        "license": "GPL-2.0-only",
        "correspondingSource": "wildbuzzard/third_party/gpl2/jackett",
        "sdkImage": args.sdk_image,
        "executableName": "jackett-mini",
        "updaterIncluded": False,
        "dashboardIncluded": False,
        "enabledProviderCount": len(catalog["enabledIndexerIds"]),
        "files": files,
    }
    args.manifest.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    package_id = "SPDXRef-Package-jackett-mini"
    spdx_packages = [
        {
            "SPDXID": package_id,
            "name": "jackett-mini",
            "versionInfo": manifest["semanticVersion"],
            "downloadLocation": "NOASSERTION",
            "filesAnalyzed": True,
            "licenseConcluded": "GPL-2.0-only",
            "licenseDeclared": "GPL-2.0-only",
            "copyrightText": "NOASSERTION",
            "checksums": [{"algorithm": "SHA256", "checksumValue": runtime_digest}],
        }
    ]
    relationships = [{"spdxElementId": "SPDXRef-DOCUMENT", "relationshipType": "DESCRIBES", "relatedSpdxElement": package_id}]
    for (name, version), content_hash in sorted(packages.items()):
        license_entry = license_inventory[(name, version)]
        dependency_id = spdx_id(f"Package-NuGet-{name}-{version}")
        package = {
            "SPDXID": dependency_id,
            "name": name,
            "versionInfo": version,
            "downloadLocation": f"https://www.nuget.org/packages/{name}/{version}",
            "filesAnalyzed": False,
            "licenseConcluded": "NOASSERTION",
            "licenseDeclared": license_entry["license"],
            "copyrightText": "NOASSERTION",
            "externalRefs": [
                {
                    "referenceCategory": "PACKAGE-MANAGER",
                    "referenceType": "purl",
                    "referenceLocator": f"pkg:nuget/{name}@{version}",
                }
            ],
        }
        if content_hash:
            package["comment"] = f"NuGet SHA-512 contentHash: {content_hash}"
        spdx_packages.append(package)
        relationships.append({"spdxElementId": package_id, "relationshipType": "DEPENDS_ON", "relatedSpdxElement": dependency_id})
    spdx_files = []
    for index, entry in enumerate(files, 1):
        file_id = f"SPDXRef-File-{index}"
        spdx_files.append(
            {
                "SPDXID": file_id,
                "fileName": "./" + entry["path"],
                "checksums": [{"algorithm": "SHA256", "checksumValue": entry["sha256"]}],
                "licenseConcluded": "NOASSERTION",
                "copyrightText": "NOASSERTION",
            }
        )
        relationships.append({"spdxElementId": package_id, "relationshipType": "CONTAINS", "relatedSpdxElement": file_id})
    sbom = {
        "spdxVersion": "SPDX-2.3",
        "dataLicense": "CC0-1.0",
        "SPDXID": "SPDXRef-DOCUMENT",
        "name": "jackett-mini-runtime",
        "documentNamespace": f"https://wildbuzzard.invalid/spdx/jackett-mini/{runtime_digest}",
        "creationInfo": {"created": "2026-08-09T05:38:52Z", "creators": ["Tool: WildBuzzard Jackett Mini builder"]},
        "packages": spdx_packages,
        "files": spdx_files,
        "relationships": relationships,
    }
    args.sbom.write_text(json.dumps(sbom, indent=2, sort_keys=True) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
