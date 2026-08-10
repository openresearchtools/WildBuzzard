#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later

import argparse
import json
import pathlib
import re
import stat

TEXT_SUFFIXES = {
    "",
    ".c",
    ".cc",
    ".cpp",
    ".cs",
    ".csproj",
    ".css",
    ".h",
    ".html",
    ".js",
    ".json",
    ".jsx",
    ".mjs",
    ".mozbuild",
    ".py",
    ".rs",
    ".sh",
    ".ts",
    ".tsx",
    ".toml",
    ".webidl",
    ".xml",
}
IGNORED_PARTS = {"docs", "test", "tests", "__pycache__"}
FORBIDDEN_PATTERNS = {
    "jackett-assembly-or-namespace": re.compile(
        rb"\bJackett\.(?:Common|Console|Server|Updater|Web|Services|Controllers|Indexers)(?:\b|\.)"
    ),
    "clr-hosting": re.compile(
        rb"\b(?:hostfxr(?:\b|_)|nethost(?:\b|_)|coreclr_(?:initialize|create_delegate)\b|load_assembly_and_get_function_pointer\b)",
        re.IGNORECASE,
    ),
    "copied-jackett-surface": re.compile(
        rb"(?:/UI/Dashboard\b|/api/v2\.0/indexers\b|Jackett(?:\.Web)?/Content/)"
    ),
    "gpl-package-path": re.compile(
        rb"(?:^|[/'\"])(?:wildbuzzard/)?third_party/gpl2/jackett(?:[/'\"]|$)"
    ),
}
FORBIDDEN_RUNTIME_PARTS = {
    "Content",
    "DataProtection-Keys",
    "FlareSolverrSharp.dll",
    "Indexers",
    "Jackett.Updater",
    "JackettConsole",
    "ServerConfig.json",
    "jackett_updater",
}


def source_files(roots):
    for root in roots:
        if not root.is_dir():
            raise RuntimeError(f"boundary scan root is missing: {root}")
        for path in sorted(root.rglob("*")):
            relative = path.relative_to(root)
            if any(part in IGNORED_PARTS for part in relative.parts):
                continue
            info = path.lstat()
            if stat.S_ISLNK(info.st_mode):
                raise RuntimeError(f"boundary scan encountered a link: {path}")
            if stat.S_ISREG(info.st_mode) and path.suffix.lower() in TEXT_SUFFIXES:
                yield root, path


def scan_sources(roots):
    findings = []
    for root, path in source_files(roots):
        payload = path.read_bytes()
        for rule, pattern in FORBIDDEN_PATTERNS.items():
            for match in pattern.finditer(payload):
                findings.append({
                    "path": path.relative_to(root).as_posix(),
                    "root": root.name,
                    "rule": rule,
                    "offset": match.start(),
                })
    if findings:
        raise RuntimeError(
            "GPL process boundary violations:\n"
            + "\n".join(
                f"{finding['root']}/{finding['path']}: {finding['rule']}"
                for finding in findings
            )
        )
    return {"fileCount": sum(1 for _ in source_files(roots)), "findings": []}


def verify_runtime(runtime, catalog_path):
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    enabled = {
        pathlib.PurePosixPath(entry["sourcePath"]).name
        for entry in catalog["entries"]
        if entry["eligibility"] == "enabled-public"
        and entry["sourceKind"] == "cardigann-yaml"
    }
    actual_definitions = set()
    files = []
    for path in sorted(runtime.rglob("*")):
        info = path.lstat()
        relative = path.relative_to(runtime)
        if stat.S_ISLNK(info.st_mode) or not (
            stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)
        ):
            raise RuntimeError(
                f"Mini runtime contains a link or special file: {relative}"
            )
        if not stat.S_ISREG(info.st_mode):
            continue
        files.append(relative.as_posix())
        if relative.parts[0] in {"licenses", "source"}:
            continue
        if any(part in FORBIDDEN_RUNTIME_PARTS for part in relative.parts):
            raise RuntimeError(f"Mini runtime contains a forbidden path: {relative}")
        if relative.suffix == ".yml":
            if len(relative.parts) != 2 or relative.parts[0] != "Definitions":
                raise RuntimeError(
                    f"Mini runtime contains a raw definition: {relative}"
                )
            actual_definitions.add(relative.name)
    if actual_definitions != enabled:
        raise RuntimeError(
            "Mini runtime definitions differ from the reviewed active set"
        )
    return {
        "dashboardAbsent": True,
        "definitionCount": len(actual_definitions),
        "fileCount": len(files),
        "rawDefinitionsAbsent": True,
        "updaterAbsent": True,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", action="append", required=True, type=pathlib.Path)
    parser.add_argument("--runtime", type=pathlib.Path)
    parser.add_argument("--catalog", type=pathlib.Path)
    parser.add_argument("--output", type=pathlib.Path)
    args = parser.parse_args()
    if bool(args.runtime) != bool(args.catalog):
        parser.error("--runtime and --catalog must be supplied together")
    report = {"schemaVersion": 1, "sourceBoundary": scan_sources(args.root)}
    if args.runtime:
        report["runtimeBoundary"] = verify_runtime(args.runtime, args.catalog)
    serialized = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.output:
        args.output.write_text(serialized, encoding="utf-8")
    else:
        print(serialized, end="")


if __name__ == "__main__":
    main()
