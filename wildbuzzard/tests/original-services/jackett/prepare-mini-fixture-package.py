#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later

import argparse
import hashlib
import json
import pathlib

SOURCES = {
    "showrss": ("showRSS", "main"),
    "linuxtracker": ("LinuxTracker", "alternate"),
}


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def render(template, destination, indexer_id, name, origin, source):
    value = template.read_text(encoding="utf-8")
    replacements = {
        "__INDEXER_ID__": indexer_id,
        "__INDEXER_NAME__": name,
        "__FIXTURE_ORIGIN__": origin,
        "__FIXTURE_SOURCE__": source,
    }
    for old, new in replacements.items():
        value = value.replace(old, new)
    if "__" in value:
        raise RuntimeError("fixture definition has an unresolved placeholder")
    destination.write_text(value, encoding="utf-8")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--shipping-catalog", required=True, type=pathlib.Path)
    parser.add_argument("--template", required=True, type=pathlib.Path)
    parser.add_argument("--origin", default="http://127.0.0.1:18080")
    parser.add_argument("--output", required=True, type=pathlib.Path)
    args = parser.parse_args()
    shipping = json.loads(args.shipping_catalog.read_text(encoding="utf-8"))
    by_id = {entry["indexerId"]: entry for entry in shipping["entries"]}
    if not set(SOURCES).issubset(shipping["enabledIndexerIds"]):
        raise RuntimeError("fixture sources are not enabled by the shipping policy")
    args.output.mkdir(parents=True, exist_ok=False)
    definitions = args.output / "Definitions"
    definitions.mkdir()
    entries = []
    for indexer_id in sorted(SOURCES):
        name, source = SOURCES[indexer_id]
        definition = definitions / f"{indexer_id}.yml"
        render(args.template, definition, indexer_id, name, args.origin, source)
        entry = dict(by_id[indexer_id])
        entry["definitionSha256"] = sha256(definition)
        entry["name"] = name
        entry["reasons"] = ["deterministic-side-by-side-test-fixture"]
        entries.append(entry)
    canonical = json.dumps(entries, sort_keys=True, separators=(",", ":")).encode()
    catalog = {
        "schemaVersion": 1,
        "jackettVersion": shipping["jackettVersion"],
        "jackettCommit": shipping["jackettCommit"],
        "adultCategoryRange": shipping["adultCategoryRange"],
        "entries": entries,
        "enabledIndexerIds": sorted(SOURCES),
        "policySha256": hashlib.sha256(canonical).hexdigest(),
    }
    (args.output / "catalog.json").write_text(
        json.dumps(catalog, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    (args.output / "fixture-binding.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "testFixture": True,
                "fixtureOrigin": args.origin,
                "shippingPolicySha256": shipping["policySha256"],
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
