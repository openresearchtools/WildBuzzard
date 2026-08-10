#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-only

import argparse
import hashlib
import json
import re
import shutil
import sys
from pathlib import Path


COMMIT = "0cd8622b735922a909a128d8d6943bb8565a640f"
ALLOWED_ACCESS = {"public", "semi-private", "private"}
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
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def yaml_value(text, key):
    match = re.search(rf"(?m)^{re.escape(key)}:\s*(?:\"([^\"]*)\"|'([^']*)'|([^#\n]*))", text)
    if not match:
        raise ValueError(f"missing top-level {key}")
    return next(value.strip() for value in match.groups() if value is not None)


def discover_yaml(root):
    definitions = root / "src" / "Jackett.Common" / "Definitions"
    for path in sorted(definitions.glob("*.yml")):
        text = path.read_text(encoding="utf-8")
        yield {
            "indexerId": yaml_value(text, "id"),
            "name": yaml_value(text, "name"),
            "access": yaml_value(text, "type"),
            "sourceKind": "cardigann-yaml",
            "sourcePath": path.relative_to(root).as_posix(),
            "definitionSha256": sha256(path),
        }


def native_access(text, base):
    match = re.search(r'override\s+string\s+Type\s*=>\s*"([^"]+)"', text)
    if match:
        return match.group(1)
    inherited = {
        "PublicBrazilianIndexerBase": "public",
        "AvistazTracker": "private",
    }
    if base not in inherited:
        raise ValueError(f"unreviewed native base class {base}")
    return inherited[base]


def discover_native(root):
    definitions = root / "src" / "Jackett.Common" / "Indexers" / "Definitions"
    for path in sorted(definitions.rglob("*.cs")):
        text = path.read_text(encoding="utf-8")
        match = re.search(r"public\s+class\s+(\w+)\s*:\s*(\w+)", text)
        id_match = re.search(r'override\s+string\s+Id\s*=>\s*"([^"]+)"', text)
        name_match = re.search(r'override\s+string\s+Name\s*=>\s*"([^"]+)"', text)
        namespace_match = re.search(r"namespace\s+([A-Za-z0-9_.]+)", text)
        if not id_match:
            continue
        if not match or not name_match or not namespace_match:
            raise ValueError(f"cannot inventory native provider {path}")
        yield {
            "indexerId": id_match.group(1),
            "name": name_match.group(1),
            "access": native_access(text, match.group(2)),
            "sourceKind": "native-csharp",
            "sourcePath": path.relative_to(root).as_posix(),
            "nativeType": f"{namespace_match.group(1)}.{match.group(1)}",
            "definitionSha256": sha256(path),
        }


def discover(root):
    entries = list(discover_yaml(root)) + list(discover_native(root))
    by_id = {}
    for entry in entries:
        indexer_id = entry["indexerId"]
        if indexer_id in by_id:
            raise ValueError(f"duplicate effective provider id {indexer_id}")
        if entry["access"] not in ALLOWED_ACCESS:
            raise ValueError(f"invalid access for {indexer_id}: {entry['access']}")
        by_id[indexer_id] = entry
    return by_id


def load_review(path):
    document = json.loads(path.read_text(encoding="utf-8"))
    if document.get("jackettCommit") != COMMIT:
        raise ValueError("review targets a different Jackett commit")
    entries = document.get("entries")
    if not isinstance(entries, list):
        raise ValueError("review entries must be an array")
    by_id = {}
    for entry in entries:
        indexer_id = entry.get("indexerId")
        if not indexer_id or indexer_id in by_id:
            raise ValueError(f"missing or duplicate reviewed id {indexer_id}")
        if entry.get("contentClass") not in ALLOWED_CONTENT:
            raise ValueError(f"invalid content class for {indexer_id}")
        if entry.get("eligibility") not in ALLOWED_ELIGIBILITY:
            raise ValueError(f"invalid eligibility for {indexer_id}")
        if not isinstance(entry.get("requiresCredentials"), bool):
            raise ValueError(f"invalid credential review for {indexer_id}")
        if not isinstance(entry.get("requiresExternalSolver"), bool):
            raise ValueError(f"invalid external-runtime review for {indexer_id}")
        reasons = entry.get("reasons")
        if not isinstance(reasons, list) or not reasons or reasons != sorted(set(reasons)):
            raise ValueError(f"reasons must be a non-empty deterministic array for {indexer_id}")
        by_id[indexer_id] = entry
    return by_id


def build_catalog(source, reviewed):
    source_ids = set(source)
    review_ids = set(reviewed)
    missing = sorted(source_ids - review_ids)
    stale = sorted(review_ids - source_ids)
    if missing or stale:
        raise ValueError(f"catalog review mismatch: missing={missing}, stale={stale}")
    entries = []
    for indexer_id in sorted(source):
        actual = source[indexer_id]
        review = reviewed[indexer_id]
        for key in ("definitionSha256", "sourceKind", "sourcePath", "access"):
            if review.get(key) != actual.get(key):
                raise ValueError(f"reviewed {key} changed for {indexer_id}")
        entry = dict(actual)
        for key in (
            "contentClass",
            "requiresCredentials",
            "requiresExternalSolver",
            "eligibility",
            "reasons",
        ):
            entry[key] = review[key]
        entries.append(entry)
    enabled = [entry["indexerId"] for entry in entries if entry["eligibility"] == "enabled-public"]
    document = {
        "schemaVersion": 1,
        "jackettVersion": "v0.24.2360",
        "jackettCommit": COMMIT,
        "adultCategoryRange": [6000, 6999],
        "entries": entries,
        "enabledIndexerIds": enabled,
    }
    canonical_entries = json.dumps(entries, sort_keys=True, separators=(",", ":")).encode()
    document["policySha256"] = hashlib.sha256(canonical_entries).hexdigest()
    return json.dumps(document, indent=2, sort_keys=True) + "\n"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--review", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--stage-definitions", type=Path)
    args = parser.parse_args()
    try:
        catalog = build_catalog(discover(args.source), load_review(args.review))
        if args.check:
            if not args.output.exists() or args.output.read_text(encoding="utf-8") != catalog:
                raise ValueError("checked-in catalog is stale")
        else:
            args.output.write_text(catalog, encoding="utf-8")
        if args.stage_definitions:
            args.stage_definitions.mkdir(parents=True, exist_ok=False)
            document = json.loads(catalog)
            for entry in document["entries"]:
                if entry["eligibility"] == "enabled-public" and entry["sourceKind"] == "cardigann-yaml":
                    shutil.copy2(args.source / entry["sourcePath"], args.stage_definitions / Path(entry["sourcePath"]).name)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"jackett catalog error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
