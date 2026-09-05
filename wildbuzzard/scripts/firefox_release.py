#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later

import argparse
import json
import pathlib
import re
import subprocess

import tomllib

ROOT = pathlib.Path(__file__).resolve().parents[2]
PRODUCT_VERSION = "wildbuzzard/config/version.txt"
PIN_FILE = "wildbuzzard/upstreams.toml"


class ReleaseError(Exception):
    pass


def git(repository, *arguments):
    result = subprocess.run(
        ["git", "-C", str(repository), *arguments],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode:
        raise ReleaseError(
            "\n".join(
                part.strip() for part in (result.stdout, result.stderr) if part.strip()
            )
            or f"git {arguments[0]} failed ({result.returncode})"
        )
    return result.stdout.strip()


def esr_parts(version):
    value = version.removesuffix("esr")
    if not re.fullmatch(
        r"[1-9][0-9]*\.(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*)){0,2}", value
    ):
        raise ReleaseError(f"Invalid Firefox ESR version: {version}")
    parts = tuple(map(int, value.split(".")))
    return parts + (0,) if len(parts) == 2 else parts


def esr_version(version):
    parts = esr_parts(version)
    if len(parts) == 3 and parts[1:] == (0, 0):
        parts = parts[:2]
    return ".".join(map(str, parts)) + "esr"


def release_tag(version):
    return "FIREFOX_" + esr_version(version).replace(".", "_") + "_RELEASE"


def pins(repository):
    return tomllib.loads((repository / PIN_FILE).read_text(encoding="utf-8"))["firefox"]


def product_parts(version):
    if not re.fullmatch(r"[1-9][0-9]*\.(?:0|[1-9][0-9]*)(?:\.[1-9][0-9]*)?", version):
        raise ReleaseError(f"Invalid WildBuzzard version: {version}")
    return tuple(map(int, version.split(".")))


def next_product_version(current, firefox_version):
    product = product_parts(current)
    base = esr_parts(firefox_version)[:2]
    if base < product[:2]:
        raise ReleaseError("Cannot move WildBuzzard to an older Firefox release line")
    if base == product[:2]:
        base += ((product[2] if len(product) == 3 else 0) + 1,)
    return ".".join(map(str, base))


def validate_engine_versions(repository, version):
    for name, expected in (
        ("version.txt", version.removesuffix("esr")),
        ("version_display.txt", version),
    ):
        actual = (
            (repository / "browser/config" / name).read_text(encoding="utf-8").strip()
        )
        if actual != expected:
            raise ReleaseError("Firefox version files do not match the release pin")


def validate_versions(repository):
    firefox = pins(repository)
    version = firefox["version"]
    if version != esr_version(version) or firefox["ref"] != release_tag(version):
        raise ReleaseError("Firefox version and exact release tag do not match")
    if not re.fullmatch(r"[0-9a-f]{40}", firefox["commit"]):
        raise ReleaseError("Firefox must be pinned to an exact commit")
    validate_engine_versions(repository, version)
    product = (repository / PRODUCT_VERSION).read_text(encoding="utf-8").strip()
    if product_parts(product)[:2] != esr_parts(version)[:2]:
        raise ReleaseError(
            "WildBuzzard version must match the Firefox major and minor version"
        )
    return {
        "wildbuzzard": product,
        "firefox": version,
        "ref": firefox["ref"],
        "commit": firefox["commit"],
    }


def validate_history(repository):
    firefox = pins(repository)
    if git(repository, "rev-parse", "--is-shallow-repository") == "true":
        raise ReleaseError(
            "Fetch full history before checking or updating the Firefox base"
        )
    if (
        git(repository, "rev-parse", f"refs/tags/{firefox['ref']}^{{commit}}")
        != firefox["commit"]
    ):
        raise ReleaseError("Firefox release tag does not match its pinned commit")
    git(repository, "merge-base", "--is-ancestor", firefox["commit"], "HEAD")


def latest_release(repository):
    firefox = pins(repository)
    major = esr_parts(firefox["version"])[0]
    refs = git(
        repository,
        "ls-remote",
        "--tags",
        firefox["remote"],
        f"refs/tags/FIREFOX_{major}_*esr_RELEASE",
    )
    versions = []
    for line in refs.splitlines():
        match = re.fullmatch(
            r"[0-9a-f]{40}\s+refs/tags/FIREFOX_([0-9_]+)esr_RELEASE", line
        )
        if match:
            versions.append(esr_parts(match[1].replace("_", ".")))
    if not versions:
        raise ReleaseError(f"No Firefox ESR {major} release tags found")
    return esr_version(".".join(map(str, max(versions))))


def require_clean(repository):
    if git(repository, "status", "--porcelain"):
        raise ReleaseError(
            "Commit or stash working changes before preparing an upstream update"
        )
    merge_head = pathlib.Path(git(repository, "rev-parse", "--git-path", "MERGE_HEAD"))
    if not merge_head.is_absolute():
        merge_head = repository / merge_head
    if merge_head.exists():
        raise ReleaseError("Finish the existing merge first")


def checked_release(repository, version):
    tag = release_tag(version)
    commit = git(repository, "rev-parse", f"refs/tags/{tag}^{{commit}}")
    for name, expected in (
        ("version.txt", esr_version(version).removesuffix("esr")),
        ("version_display.txt", esr_version(version)),
    ):
        if git(repository, "show", f"{commit}:browser/config/{name}") != expected:
            raise ReleaseError(
                f"{tag} does not contain the expected Firefox version files"
            )
    return tag, commit


def write_pin(repository, version, tag, commit):
    path = repository / PIN_FILE
    source = path.read_text(encoding="utf-8")
    match = re.search(r"(?ms)^\[firefox\]\n.*?(?=^\[|\Z)", source)
    if not match:
        raise ReleaseError("Missing Firefox upstream section")
    section = match[0]
    for key, value in {
        "ref": tag,
        "commit": commit,
        "version": esr_version(version),
        "tracking_branch": f"mozilla/esr{esr_parts(version)[0]}",
    }.items():
        section, count = re.subn(
            rf'(?m)^{key} = "[^"]*"$', f'{key} = "{value}"', section
        )
        if count != 1:
            raise ReleaseError(f"Missing or duplicate Firefox pin: {key}")
    path.write_text(
        source[: match.start()] + section + source[match.end() :], encoding="utf-8"
    )


def finish_update(repository, version):
    tag, commit = checked_release(repository, version)
    if git(repository, "diff", "--name-only", "--diff-filter=U"):
        raise ReleaseError(
            "Resolve and stage all merge conflicts before finishing the update"
        )
    merge_head = pathlib.Path(git(repository, "rev-parse", "--git-path", "MERGE_HEAD"))
    if not merge_head.is_absolute():
        merge_head = repository / merge_head
    if not merge_head.exists() or merge_head.read_text().strip() != commit:
        raise ReleaseError("The pending merge is not the requested Firefox release")
    old = pins(repository)
    if esr_parts(version) <= esr_parts(old["version"]):
        raise ReleaseError(
            "The requested Firefox release must be newer than the current pin"
        )
    product_path = repository / PRODUCT_VERSION
    product = next_product_version(product_path.read_text().strip(), version)
    validate_engine_versions(repository, esr_version(version))
    write_pin(repository, version, tag, commit)
    product_path.write_text(product + "\n", encoding="utf-8")
    validate_versions(repository)
    git(repository, "add", PIN_FILE, PRODUCT_VERSION)
    print(f"Prepared WildBuzzard {product} on {tag} ({commit}).")
    print("Review the staged merge, validate the browser, then commit it.")


def update(repository, version):
    require_clean(repository)
    validate_versions(repository)
    validate_history(repository)
    firefox = pins(repository)
    if esr_parts(version) <= esr_parts(firefox["version"]):
        raise ReleaseError(
            "The requested Firefox release must be newer than the current pin"
        )
    tag = release_tag(version)
    git(
        repository,
        "fetch",
        "--no-tags",
        firefox["remote"],
        f"refs/tags/{tag}:refs/tags/{tag}",
    )
    _, commit = checked_release(repository, version)
    try:
        git(repository, "merge", "--no-commit", "--no-ff", commit)
    except ReleaseError as error:
        raise ReleaseError(
            f"{error}\nResolve and stage the conflicts, then run: "
            f"python3 wildbuzzard/scripts/firefox_release.py finish {version}"
        ) from error
    finish_update(repository, version)


def main():
    parser = argparse.ArgumentParser(
        description="Update the Firefox ESR base and WildBuzzard release version"
    )
    parser.add_argument("--repository", type=pathlib.Path, default=ROOT)
    commands = parser.add_subparsers(dest="command", required=True)
    check = commands.add_parser(
        "check",
        help="Validate versions, optionally check Mozilla for newer ESR releases",
    )
    check.add_argument("--latest", action="store_true")
    check.add_argument(
        "--versions-only",
        action="store_true",
        help="Check version consistency without Git history or network access",
    )
    for name in ("update", "finish"):
        command = commands.add_parser(name)
        command.add_argument(
            "version", help="Exact Firefox ESR version, e.g. 153.2 or 153.2.1"
        )
    commands.add_parser("bump", help="Increment the WildBuzzard-only release number")
    arguments = parser.parse_args()
    repository = arguments.repository.resolve()
    try:
        if arguments.command == "check":
            result = validate_versions(repository)
            if not arguments.versions_only:
                validate_history(repository)
            if arguments.latest:
                result["latestFirefox"] = latest_release(repository)
            print(json.dumps(result, indent=2))
            if arguments.latest and esr_parts(result["latestFirefox"]) > esr_parts(
                result["firefox"]
            ):
                raise ReleaseError(
                    f"Firefox security update available: {result['latestFirefox']}"
                )
        elif arguments.command == "update":
            update(repository, arguments.version)
        elif arguments.command == "finish":
            finish_update(repository, arguments.version)
        else:
            require_clean(repository)
            result = validate_versions(repository)
            version = next_product_version(result["wildbuzzard"], result["firefox"])
            (repository / PRODUCT_VERSION).write_text(version + "\n", encoding="utf-8")
            print(version)
    except (ReleaseError, OSError, KeyError, ValueError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
