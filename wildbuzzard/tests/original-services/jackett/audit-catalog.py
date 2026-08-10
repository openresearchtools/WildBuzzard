#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later

import argparse
import collections
import hashlib
import json
import pathlib


ALLOWED_CONTENT = {"general", "mixed-general", "adult-only", "not-applicable"}
ALLOWED_ELIGIBILITY = {
    "enabled-public",
    "excluded-adult-only",
    "excluded-credentialed",
    "excluded-non-public",
    "excluded-external-runtime",
}


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalog", required=True, type=pathlib.Path)
    parser.add_argument("--source", required=True, type=pathlib.Path)
    parser.add_argument("--runtime", required=True, type=pathlib.Path)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    args = parser.parse_args()

    catalog = json.loads(args.catalog.read_text(encoding="utf-8"))
    entries = catalog["entries"]
    ids = [entry["indexerId"] for entry in entries]
    if len(ids) != len(set(ids)):
        raise RuntimeError("catalog contains duplicate provider IDs")
    if any(entry["contentClass"] not in ALLOWED_CONTENT for entry in entries):
        raise RuntimeError("catalog contains an invalid content class")
    if any(entry["eligibility"] not in ALLOWED_ELIGIBILITY for entry in entries):
        raise RuntimeError("catalog contains an invalid eligibility")

    enabled = [entry for entry in entries if entry["eligibility"] == "enabled-public"]
    mechanical = [
        entry
        for entry in entries
        if entry["access"] == "public"
        and not entry["requiresCredentials"]
        and not entry["requiresExternalSolver"]
        and entry["contentClass"] != "adult-only"
    ]
    if [entry["indexerId"] for entry in enabled] != catalog["enabledIndexerIds"]:
        raise RuntimeError("enabled provider list differs from catalog entries")
    if {entry["indexerId"] for entry in enabled} != {entry["indexerId"] for entry in mechanical}:
        raise RuntimeError("enabled provider set differs from mechanical policy")

    for entry in entries:
        source_path = args.source / entry["sourcePath"]
        if sha256(source_path) != entry["definitionSha256"]:
            raise RuntimeError(f"source hash mismatch for {entry['indexerId']}")

    enabled_yaml = {
        pathlib.Path(entry["sourcePath"]).name: entry
        for entry in enabled
        if entry["sourceKind"] == "cardigann-yaml"
    }
    runtime_yaml = {path.name: path for path in (args.runtime / "Definitions").glob("*.yml")}
    if set(enabled_yaml) != set(runtime_yaml):
        raise RuntimeError("runtime definitions differ from enabled YAML providers")
    for name, path in runtime_yaml.items():
        if sha256(path) != enabled_yaml[name]["definitionSha256"]:
            raise RuntimeError(f"runtime definition hash mismatch for {name}")

    forbidden_runtime_paths = [
        "Content",
        "Jackett.Updater",
        "JackettConsole",
        "jackett_updater",
        "FlareSolverrSharp.dll",
        "ServerConfig.json",
        "Indexers",
        "DataProtection-Keys",
    ]
    present_forbidden = [name for name in forbidden_runtime_paths if (args.runtime / name).exists()]
    if present_forbidden:
        raise RuntimeError(f"forbidden runtime paths present: {present_forbidden}")

    counter_fields = ("sourceKind", "access", "contentClass", "eligibility")
    report = {
        "schemaVersion": 1,
        "jackettCommit": catalog["jackettCommit"],
        "catalogSha256": sha256(args.catalog),
        "policySha256": catalog["policySha256"],
        "totalEffectiveProviders": len(entries),
        "enabledProviderCount": len(enabled),
        "enabledYamlCount": len(enabled_yaml),
        "enabledNativeCount": sum(entry["sourceKind"] == "native-csharp" for entry in enabled),
        "enabledMixedGeneralIds": [
            entry["indexerId"] for entry in enabled if entry["contentClass"] == "mixed-general"
        ],
        "counts": {
            field: dict(sorted(collections.Counter(entry[field] for entry in entries).items()))
            for field in counter_fields
        },
        "checks": {
            "allEntriesUniquelyClassified": True,
            "allSourceHashesMatch": True,
            "enabledSetEqualsMechanicalPolicy": True,
            "enabledProvidersNeedNoCredentials": all(not entry["requiresCredentials"] for entry in enabled),
            "enabledProvidersNeedNoExternalRuntime": all(
                not entry["requiresExternalSolver"] for entry in enabled
            ),
            "adultOnlyProvidersExcluded": all(
                entry["contentClass"] != "adult-only" for entry in enabled
            ),
            "mixedGeneralProvidersRetained": any(
                entry["contentClass"] == "mixed-general" for entry in enabled
            ),
            "runtimeDefinitionsExactlyMatchEnabledYaml": True,
            "forbiddenRuntimePathsAbsent": True,
            "credentialStoreAbsent": True,
        },
    }
    args.output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
