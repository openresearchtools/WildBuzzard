#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later

import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

SHA256 = re.compile(r"^[0-9a-f]{64}$")
COMMIT = re.compile(r"^[0-9a-f]{40}$")


def fail(message):
    raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def required_object(value, keys, label):
    if not isinstance(value, dict) or set(value) != set(keys):
        fail(f"invalid {label} fields")
    return value


def load_lock(path):
    lock = json.loads(path.read_text(encoding="utf-8"))
    required_object(
        lock,
        [
            "schema",
            "platform",
            "piWeb",
            "piPackages",
            "node",
            "runtimeArchive",
            "runtimePayload",
        ],
        "lock",
    )
    if lock["schema"] != 1 or lock["platform"] != "linux-x64":
        fail("unsupported Pi Web runtime lock")
    pi_web = required_object(
        lock["piWeb"],
        [
            "commit",
            "tree",
            "repository",
            "name",
            "version",
            "packageManager",
            "packageJsonSha256",
            "packageLockSha256",
            "packageArchiveSha256",
            "licenseSha256",
        ],
        "Pi Web pin",
    )
    node = required_object(
        lock["node"], ["version", "archive", "url", "sha256"], "Node pin"
    )
    if not COMMIT.fullmatch(pi_web["commit"]) or not COMMIT.fullmatch(pi_web["tree"]):
        fail("invalid Pi Web commit or tree pin")
    if pi_web["repository"] != "https://github.com/openresearchtools/pi-web.git":
        fail("invalid Pi Web repository pin")
    for key in (
        "packageJsonSha256",
        "packageLockSha256",
        "packageArchiveSha256",
        "licenseSha256",
    ):
        if not SHA256.fullmatch(pi_web[key]):
            fail(f"invalid Pi Web {key} pin")
    if (
        not re.fullmatch(r"\d+\.\d+\.\d+", node["version"])
        or node["archive"] != f"node-v{node['version']}-linux-x64.tar.xz"
        or node["url"]
        != f"https://nodejs.org/dist/v{node['version']}/{node['archive']}"
        or not SHA256.fullmatch(node["sha256"])
    ):
        fail("invalid Node archive pin")
    expected_pi = {
        "@earendil-works/pi-agent-core": "0.84.1",
        "@earendil-works/pi-ai": "0.84.1",
        "@earendil-works/pi-coding-agent": "0.84.1",
    }
    if lock["piPackages"] != expected_pi:
        fail("invalid Pi package pins")
    runtime_archive = required_object(
        lock["runtimeArchive"],
        ["bootstrapBlocked", "sourceCommit", "sha256"],
        "runtime archive pin",
    )
    if (
        not isinstance(runtime_archive["bootstrapBlocked"], bool)
        or not COMMIT.fullmatch(runtime_archive["sourceCommit"])
        or not SHA256.fullmatch(runtime_archive["sha256"])
        or runtime_archive["bootstrapBlocked"]
        != (
            runtime_archive["sourceCommit"] == "0" * 40
            and runtime_archive["sha256"] == "0" * 64
        )
    ):
        fail("invalid runtime archive pin")
    payload = lock["runtimePayload"]
    if (
        not isinstance(payload, dict)
        or not payload
        or any(
            not isinstance(path, str)
            or not path
            or not isinstance(pin, dict)
            or set(pin) != {"sha256", "executable"}
            or not SHA256.fullmatch(str(pin.get("sha256", "")))
            or not isinstance(pin.get("executable"), bool)
            for path, pin in payload.items()
        )
    ):
        fail("invalid Pi Web runtime payload pins")
    return lock


def git(repo, *arguments):
    result = subprocess.run(
        ["git", "-C", str(repo), *arguments],
        check=False,
        capture_output=True,
    )
    if result.returncode:
        fail("Pi Web Git verification failed")
    return result.stdout


def verify_fork(lock, repo):
    if git(repo, "status", "--porcelain", "--untracked-files=all").strip():
        fail("the Pi Web fork must be clean")
    pi_web = lock["piWeb"]
    head = git(repo, "rev-parse", "--verify", "HEAD^{commit}").decode().strip()
    if head != pi_web["commit"]:
        fail("Pi Web checkout is not at the pinned commit")
    commit = (
        git(repo, "rev-parse", "--verify", f"{pi_web['commit']}^{{commit}}")
        .decode()
        .strip()
    )
    if commit != pi_web["commit"]:
        fail("Pi Web commit pin drift")
    tree = git(repo, "show", "-s", "--format=%T", commit).decode().strip()
    if tree != pi_web["tree"]:
        fail("Pi Web tree pin drift")
    files = {
        "package.json": "packageJsonSha256",
        "package-lock.json": "packageLockSha256",
        "LICENSE": "licenseSha256",
    }
    contents = {}
    for name, pin in files.items():
        contents[name] = git(repo, "show", f"{commit}:{name}")
        if digest(contents[name]) != pi_web[pin]:
            fail(f"Pi Web {name} pin drift")
    manifest = json.loads(contents["package.json"])
    package_lock = json.loads(contents["package-lock.json"])
    if (
        manifest.get("name") != pi_web["name"]
        or manifest.get("version") != pi_web["version"]
        or manifest.get("packageManager") != pi_web["packageManager"]
    ):
        fail("Pi Web package manifest drift")
    if package_lock.get("lockfileVersion") != 3:
        fail("Pi Web package lock must use lockfile version 3")
    root = package_lock.get("packages", {}).get("")
    if not isinstance(root, dict):
        fail("Pi Web package lock has no root package")
    if root.get("name") != pi_web["name"] or root.get("version") != pi_web["version"]:
        fail("Pi Web package lock root drift")
    if root.get("dependencies") != manifest.get("dependencies"):
        fail("Pi Web production dependencies are not locked")
    packages = package_lock.get("packages")
    if not isinstance(packages, dict):
        fail("Pi Web package lock inventory is invalid")
    for name, version in lock["piPackages"].items():
        entry = packages.get(f"node_modules/{name}")
        if (
            not isinstance(entry, dict)
            or entry.get("version") != version
            or not str(entry.get("resolved", "")).startswith(
                "https://registry.npmjs.org/"
            )
            or not str(entry.get("integrity", "")).startswith("sha512-")
        ):
            fail(f"Pi package lock drift: {name}")


def values(lock):
    pi_web = lock["piWeb"]
    node = lock["node"]
    for value in (
        pi_web["commit"],
        pi_web["tree"],
        pi_web["name"],
        pi_web["version"],
        pi_web["packageManager"],
        pi_web["repository"],
        pi_web["packageLockSha256"],
        node["version"],
        node["archive"],
        node["url"],
        node["sha256"],
    ):
        print(value)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("check", "fork", "values"))
    parser.add_argument("lock", type=Path)
    parser.add_argument("repo", type=Path, nargs="?")
    args = parser.parse_args()
    try:
        lock = load_lock(args.lock)
        if args.command == "fork":
            if args.repo is None:
                fail("fork verification requires a repository")
            verify_fork(lock, args.repo)
        elif args.command == "values":
            values(lock)
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
        print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
