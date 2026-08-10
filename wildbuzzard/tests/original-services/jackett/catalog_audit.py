# SPDX-License-Identifier: AGPL-3.0-or-later

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


def expected_eligibility(entry):
    if entry["access"] != "public":
        return "excluded-non-public"
    if entry["contentClass"] == "adult-only":
        return "excluded-adult-only"
    if entry["requiresCredentials"]:
        return "excluded-credentialed"
    if entry["requiresExternalSolver"]:
        return "excluded-external-runtime"
    return "enabled-public"


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def audit_catalog(catalog_path, source, runtime):
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    entries = catalog["entries"]
    ids = [entry["indexerId"] for entry in entries]
    if len(ids) != len(set(ids)):
        raise RuntimeError("catalog contains duplicate provider IDs")
    if any(entry["contentClass"] not in ALLOWED_CONTENT for entry in entries):
        raise RuntimeError("catalog contains an invalid content class")
    if any(entry["eligibility"] not in ALLOWED_ELIGIBILITY for entry in entries):
        raise RuntimeError("catalog contains an invalid eligibility")
    if any(entry["eligibility"] != expected_eligibility(entry) for entry in entries):
        raise RuntimeError("catalog classification differs from mechanical policy")

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
    if {entry["indexerId"] for entry in enabled} != {
        entry["indexerId"] for entry in mechanical
    }:
        raise RuntimeError("enabled provider set differs from mechanical policy")

    for entry in entries:
        source_path = source / entry["sourcePath"]
        if sha256(source_path) != entry["definitionSha256"]:
            raise RuntimeError(f"source hash mismatch for {entry['indexerId']}")

    enabled_yaml = {
        pathlib.Path(entry["sourcePath"]).name: entry
        for entry in enabled
        if entry["sourceKind"] == "cardigann-yaml"
    }
    runtime_yaml = {path.name: path for path in (runtime / "Definitions").glob("*.yml")}
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
    present_forbidden = [
        name for name in forbidden_runtime_paths if (runtime / name).exists()
    ]
    if present_forbidden:
        raise RuntimeError(f"forbidden runtime paths present: {present_forbidden}")

    excluded = {
        eligibility: sorted(
            entry["indexerId"]
            for entry in entries
            if entry["eligibility"] == eligibility
        )
        for eligibility in sorted(ALLOWED_ELIGIBILITY - {"enabled-public"})
    }
    counter_fields = ("sourceKind", "access", "contentClass", "eligibility")
    return {
        "schemaVersion": 1,
        "jackettCommit": catalog["jackettCommit"],
        "catalogSha256": sha256(catalog_path),
        "policySha256": catalog["policySha256"],
        "totalEffectiveProviders": len(entries),
        "enabledProviderCount": len(enabled),
        "enabledIndexerIds": [entry["indexerId"] for entry in enabled],
        "excludedIndexerIds": excluded,
        "enabledYamlCount": len(enabled_yaml),
        "enabledNativeCount": sum(
            entry["sourceKind"] == "native-csharp" for entry in enabled
        ),
        "enabledMixedGeneralIds": [
            entry["indexerId"]
            for entry in enabled
            if entry["contentClass"] == "mixed-general"
        ],
        "counts": {
            field: dict(
                sorted(collections.Counter(entry[field] for entry in entries).items())
            )
            for field in counter_fields
        },
        "checks": {
            "allEntriesUniquelyClassified": True,
            "allSourceHashesMatch": True,
            "enabledSetEqualsMechanicalPolicy": True,
            "enabledProvidersNeedNoCredentials": all(
                not entry["requiresCredentials"] for entry in enabled
            ),
            "enabledProvidersNeedNoExternalRuntime": all(
                not entry["requiresExternalSolver"] for entry in enabled
            ),
            "adultOnlyProvidersExcluded": all(
                entry["contentClass"] != "adult-only" for entry in enabled
            ),
            "mixedGeneralProvidersRetained": bool(
                any(entry["contentClass"] == "mixed-general" for entry in enabled)
            ),
            "runtimeDefinitionsExactlyMatchEnabledYaml": True,
            "forbiddenRuntimePathsAbsent": True,
            "credentialStoreAbsent": True,
        },
    }
