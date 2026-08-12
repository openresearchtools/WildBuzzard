#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path


UPSTREAM_COMMIT = "b023a28bab8839dba9eac96e9a51cc91bbd0a267"
EXPLICIT_CREDENTIAL_FREE = {"devicons", "json_engine", "lucide", "tonline", "xpath"}


def scalar(value: str) -> str:
    value = value.split(" #", 1)[0].strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    return value


def parse_settings(source: str) -> list[dict[str, object]]:
    entries: list[dict[str, object]] = []
    current: dict[str, object] | None = None
    in_engines = False
    for line in source.splitlines():
        if line == "engines:":
            in_engines = True
            continue
        if not in_engines:
            continue
        if line and not line.startswith(" ") and not line.startswith("#"):
            break
        if line.startswith("  - name:"):
            if current:
                entries.append(current)
            current = {
                "name": scalar(line.removeprefix("  - name:")),
                "module": "",
                "shortcut": "",
                "disabledUpstream": False,
                "inactiveUpstream": False,
            }
        elif current is not None:
            fields = {
                "    engine:": "module",
                "    shortcut:": "shortcut",
                "    disabled:": "disabledUpstream",
                "    inactive:": "inactiveUpstream",
            }
            for prefix, field in fields.items():
                if line.startswith(prefix):
                    value = scalar(line.removeprefix(prefix))
                    current[field] = (
                        value == "true" if field.endswith("Upstream") else value
                    )
                    break
    if current:
        entries.append(current)
    return entries


def trait_value(source: str, value: str) -> bool:
    return any(
        "require_api_key" in line
        and (f": {value}" in line or f"={value}" in line or f"= {value}" in line)
        for line in source.splitlines()
    )


def derive(source_root: Path) -> dict[str, object]:
    upstream = (source_root / "UPSTREAM.toml").read_text(encoding="utf-8")
    if f'commit = "{UPSTREAM_COMMIT}"' not in upstream:
        raise RuntimeError("SearXNG upstream pin changed")
    settings_path = source_root / "upstream" / "searx" / "settings.yml"
    engine_root = source_root / "upstream" / "searx" / "engines"
    entries = parse_settings(settings_path.read_text(encoding="utf-8"))
    if len(entries) != 343 or len({entry["name"] for entry in entries}) != 343:
        raise RuntimeError("unexpected configured SearXNG engine catalog")
    modules: dict[str, tuple[bool, str]] = {}
    for entry in entries:
        module = entry["module"]
        if not isinstance(module, str) or not re.fullmatch(
            r"[a-z0-9][a-z0-9_]{0,63}", module
        ):
            raise RuntimeError(f"invalid engine module for {entry['name']}")
        if module not in modules:
            source_path = engine_root / f"{module}.py"
            source = source_path.read_text(encoding="utf-8")
            requires_key = trait_value(source, "True")
            credential_free = trait_value(source, "False")
            if requires_key == credential_free:
                if not requires_key and module in EXPLICIT_CREDENTIAL_FREE:
                    credential_free = True
                else:
                    raise RuntimeError(
                        f"ambiguous credential classification for {module}"
                    )
            modules[module] = (
                requires_key,
                hashlib.sha256(source_path.read_bytes()).hexdigest(),
            )
        requires_key, digest = modules[module]
        entry["requiresCredentials"] = requires_key
        entry["upstreamPath"] = f"searx/engines/{module}.py"
        entry["upstreamSha256"] = digest
    eligible = [entry for entry in entries if not entry["requiresCredentials"]]
    required = [entry for entry in entries if entry["requiresCredentials"]]
    eligible_modules = {entry["module"] for entry in eligible}
    required_modules = {entry["module"] for entry in required}
    if (
        len(modules) != 222
        or len(eligible) != 332
        or len(eligible_modules) != 211
        or len(required) != 11
        or len(required_modules) != 11
    ):
        raise RuntimeError("unexpected SearXNG credential classification counts")
    return {
        "schema": 1,
        "upstreamCommit": UPSTREAM_COMMIT,
        "settingsSha256": hashlib.sha256(settings_path.read_bytes()).hexdigest(),
        "counts": {
            "totalEntries": len(entries),
            "totalModules": len(modules),
            "eligibleEntries": len(eligible),
            "eligibleModules": len(eligible_modules),
            "credentialRequiredEntries": len(required),
            "credentialRequiredModules": len(required_modules),
            "eligibleUpstreamInactiveEntries": sum(
                entry["inactiveUpstream"] is True for entry in eligible
            ),
        },
        "engines": entries,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-root", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    catalog = derive(args.source_root.resolve(strict=True))
    args.output.write_text(
        json.dumps(catalog, sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(catalog["counts"], sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
