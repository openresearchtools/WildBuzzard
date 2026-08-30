#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later

import argparse
import datetime
import fnmatch
import hashlib
import json
import posixpath
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path, PurePosixPath

import tomllib

REQUIRED_ARTIFACTS = {
    "arti": "arti-*-linux-x86_64",
    "artiProvenance": "wildbuzzard-arti-*-provenance.zip",
    "artiSource": "wildbuzzard-arti-*-source.tar.xz",
    "artiCargoVendor": "wildbuzzard-arti-*-cargo-vendor.tar.xz",
    "browserAppImage": "WildBuzzard-*-x86_64.AppImage",
    "browserArchive": "wildbuzzard-*.en-US.linux-x86_64.tar.*",
    "blockerAssetSource": "wildbuzzard-blocker-assets-source.tar.xz",
    "browserDeb": "wildbuzzard_*_amd64.deb",
    "minijttDeb": "buzzard-minijtt_*_amd64.deb",
    "minijttSource": "buzzard-minijtt-*-source-license.tar.xz",
    "qbittorrentRuntime": "wildbuzzard-qbittorrent-runtime-linux-x64-*.zip",
    "qbittorrentCoreSource": "wildbuzzard-qbittorrent-runtime-*-source.tar.xz",
    "qbittorrentBoostSource": "wildbuzzard-qbittorrent-boost-1.88.0-source.tar.bz2",
    "qbittorrentQtSource": "wildbuzzard-qbittorrent-qtbase-6.10.2-source.tar.xz",
    "qbittorrentSystemSource": "wildbuzzard-qbittorrent-ubuntu-24.04-system-sources-*.tar.xz",
    "runnerCratesSource": "wildbuzzard-runner-crates-source.tar.xz",
    "searchDeb": "buzzard-search_*_amd64.deb",
    "searchSource": "buzzard-search-*-source-license.tar.xz",
    "torrentDeb": "buzzard-torrent_*_amd64.deb",
    "torrentSearchXpi": "wildbuzzard-torrent-search-*.xpi",
    "webSearchXpi": "wildbuzzard-web-search-*.xpi",
}

EXPECTED_MAINTAINER = (
    "openresearchtools <229047507+openresearchtools@users.noreply.github.com>"
)

TORRENT_DEB_FIXED_FILES = {
    "usr/bin/buzzard-torrent",
    "usr/bin/buzzard-torrent-mcp",
    "usr/lib/buzzard-torrent/buzzard_torrent.py",
    "usr/lib/buzzard-torrent/buzzard_torrent_mcp.py",
    "usr/share/doc/buzzard-torrent/LICENSE.packaging",
    "usr/share/doc/buzzard-torrent/README.md",
    "usr/share/doc/buzzard-torrent/changelog.Debian.gz",
    "usr/share/doc/buzzard-torrent/copyright",
}
TORRENT_DEB_RUNTIME_ROOT = "usr/lib/buzzard-torrent/runtime"

RUNNER_CRATE_LEGAL_RELATIVE_PATHS = {
    "THIRD-PARTY.json",
    "licenses/Apache-2.0.txt",
    "licenses/MIT-dtolnay-serde.txt",
    "licenses/Unicode-3.0.txt",
    "licenses/Unlicense.txt",
    "licenses/memchr-COPYING.txt",
    "licenses/memchr-MIT.txt",
}

BROWSER_DEB_LEGAL_PATHS = (
    {
        "opt/wildbuzzard/notices/BLOCKER-ASSET-SOURCE-NOTICE",
        "opt/wildbuzzard/notices/COPYING",
        "opt/wildbuzzard/notices/LICENSE",
        "opt/wildbuzzard/notices/MOZILLA-MCP-LICENSE",
        "opt/wildbuzzard/notices/NOTICE",
        "opt/wildbuzzard/notices/SOURCE-NOTICE",
        "opt/wildbuzzard/notices/blocker/SOURCES.lock.json",
        "usr/share/doc/wildbuzzard/BLOCKER-ASSET-SOURCE-NOTICE",
        "usr/share/doc/wildbuzzard/COPYING",
        "usr/share/doc/wildbuzzard/LICENSE",
        "usr/share/doc/wildbuzzard/MOZILLA-MCP-LICENSE",
        "usr/share/doc/wildbuzzard/SOURCE-NOTICE",
        "usr/share/doc/wildbuzzard/blocker/SOURCES.lock.json",
        "usr/share/doc/wildbuzzard/cli-NOTICE",
    }
    | {
        f"opt/wildbuzzard/notices/wildbuzzard-cli/{path}"
        for path in RUNNER_CRATE_LEGAL_RELATIVE_PATHS
    }
    | {
        f"usr/share/doc/wildbuzzard/runner-third-party/{path}"
        for path in RUNNER_CRATE_LEGAL_RELATIVE_PATHS
    }
)

BROWSER_DEB_EXTERNAL_FILES = {
    path for path in BROWSER_DEB_LEGAL_PATHS if path.startswith("usr/")
} | {
    "usr/bin/wildbuzzard",
    "usr/share/applications/org.wildbuzzard.WildBuzzard.desktop",
    "usr/share/icons/hicolor/scalable/apps/org.wildbuzzard.WildBuzzard.svg",
    "usr/share/wildbuzzard/skills/wildbuzzard/SKILL.md",
}

BROWSER_DEB_REQUIRED_RUNTIME_FILES = (
    BROWSER_DEB_EXTERNAL_FILES
    | {
        "opt/wildbuzzard/wildbuzzard",
        "opt/wildbuzzard/runtime/tor/arti",
        "opt/wildbuzzard/runtime/tor/arti.toml",
        "opt/wildbuzzard/notices/source/wildbuzzard-arti-2.5.1-provenance.zip",
    }
    | BROWSER_DEB_LEGAL_PATHS
)

BROWSER_DEB_FORBIDDEN_COMPONENTS = {
    ".cache",
    ".cargo",
    ".git",
    ".github",
    ".hg",
    ".mypy_cache",
    ".nox",
    ".pytest_cache",
    ".ruff_cache",
    ".rustup",
    ".svn",
    ".tox",
    "__pycache__",
    "artifacts",
    "bench",
    "benches",
    "benchmark",
    "benchmarks",
    "build",
    "builds",
    "cache",
    "caches",
    "coverage",
    "example",
    "examples",
    "fixture",
    "fixtures",
    "logs",
    "node_modules",
    "obj",
    "objects",
    "sample",
    "samples",
    "target",
    "temp",
    "test",
    "test-data",
    "testdata",
    "testing",
    "tests",
    "tmp",
}

BROWSER_DEB_FORBIDDEN_FILENAMES = {
    ".coverage",
    "cargo.lock",
    "cargo.toml",
    "cmakelists.txt",
    "makefile",
    "moz.build",
    "moz.configure",
    "package-lock.json",
    "package.json",
    "pnpm-lock.yaml",
    "pyproject.toml",
    "requirements.txt",
    "uv.lock",
    "xpcshell",
    "yarn.lock",
}

BROWSER_DEB_FORBIDDEN_SUFFIXES = {
    ".a",
    ".c",
    ".cc",
    ".cmake",
    ".cpp",
    ".crate",
    ".cxx",
    ".dwo",
    ".dwp",
    ".h",
    ".hpp",
    ".la",
    ".map",
    ".o",
    ".obj",
    ".pdb",
    ".py",
    ".pyc",
    ".pyo",
    ".rlib",
    ".rmeta",
    ".rs",
    ".ts",
    ".tsbuildinfo",
    ".tsx",
}

EXPECTED_PACKAGES = {
    "buzzard-minijtt": "buzzard-minijtt_*_amd64.deb",
    "buzzard-search": "buzzard-search_*_amd64.deb",
    "buzzard-torrent": "buzzard-torrent_*_amd64.deb",
    "wildbuzzard": "wildbuzzard_*_amd64.deb",
}

EXPECTED_REPOSITORIES = {
    "buzzard-minijtt",
    "buzzard-search",
    "extensions",
    "wildbuzzard",
}

EXPECTED_BUILD_MANIFESTS = {
    "arti": "arti-build-manifest.txt",
    "browser": "browser-build-manifest.txt",
    "qbittorrent": "qbittorrent-build-manifest.txt",
}

EXACT_BROWSER_LEGAL_ROOTS = {
    "opt/wildbuzzard/notices/arti-crates",
    "opt/wildbuzzard/notices/blocker",
    "opt/wildbuzzard/notices/wildbuzzard-cli",
    "usr/share/doc/wildbuzzard/arti-third-party",
    "usr/share/doc/wildbuzzard/blocker",
    "usr/share/doc/wildbuzzard/runner-third-party",
}


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def git(repository, *arguments):
    return subprocess.run(
        ["git", "-C", str(repository), *arguments],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def parse_mapping(values, option):
    mappings = {}
    for value in values:
        if "=" not in value:
            raise SystemExit(f"{option} requires NAME=PATH: {value}")
        name, raw_path = value.split("=", 1)
        if not name or name in mappings:
            raise SystemExit(f"invalid or duplicate {option} name: {name}")
        path = Path(raw_path).resolve()
        if not path.exists():
            raise SystemExit(f"{option} path does not exist: {path}")
        mappings[name] = path
    return mappings


def parse_build_manifest(path):
    values = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line or "=" not in line:
            continue
        name, value = line.split("=", 1)
        if not name or name in values:
            raise SystemExit(f"invalid or duplicate field in {path.name}: {name}")
        values[name] = value
    return values


def configure_arti_legal_paths(repository):
    verifier = repository / "wildbuzzard/scripts/arti_crate_provenance.py"
    result = subprocess.run(
        [sys.executable, "-I", "-B", str(verifier), "verify"],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode:
        message = result.stderr.strip() or result.stdout.strip()
        raise SystemExit(
            "invalid Arti crate legal payload: "
            + (message or f"verifier exited {result.returncode}")
        )
    inventory_path = repository / "wildbuzzard/third_party/arti-crates/THIRD-PARTY.json"
    inventory = json.loads(inventory_path.read_text(encoding="utf-8"))
    relative = {"THIRD-PARTY.json"}
    relative.update(
        license_file["installedPath"]
        for package in inventory["packages"]
        for license_file in package["licenseFiles"]
    )
    browser_paths = {f"opt/wildbuzzard/notices/arti-crates/{path}" for path in relative}
    documentation_paths = {
        f"usr/share/doc/wildbuzzard/arti-third-party/{path}" for path in relative
    }
    BROWSER_DEB_LEGAL_PATHS.update(browser_paths | documentation_paths)
    BROWSER_DEB_EXTERNAL_FILES.update(documentation_paths)
    BROWSER_DEB_REQUIRED_RUNTIME_FILES.update(browser_paths | documentation_paths)


def verify_wildbuzzard_build_provenance(build_manifests, commit):
    browser = parse_build_manifest(build_manifests["browser"])
    qbittorrent = parse_build_manifest(build_manifests["qbittorrent"])
    expectations = {
        "browser": (browser, ("base_commit", "build_commit")),
        "qbittorrent": (
            qbittorrent,
            ("base_commit", "wildbuzzard_commit"),
        ),
    }
    for name, (manifest, fields) in expectations.items():
        if manifest.get("working_tree") != "false":
            raise SystemExit(f"{name} build used a working-tree snapshot")
        for field in fields:
            if manifest.get(field) != commit:
                raise SystemExit(
                    f"{name} build {field} does not match the release commit"
                )


def verify_firefox_release_provenance(repository, commit):
    pins = tomllib.loads(
        (repository / "wildbuzzard" / "upstreams.toml").read_text(encoding="utf-8")
    )["firefox"]
    release_ref = pins.get("ref", "")
    release_commit = pins.get("commit", "")
    release_version = pins.get("version", "")
    if not re.fullmatch(r"FIREFOX_[0-9_]+esr_RELEASE", release_ref) or not re.fullmatch(
        r"[0-9a-f]{40}", release_commit
    ):
        raise SystemExit("Firefox is not pinned to an exact ESR release")
    shallow = git(repository, "rev-parse", "--is-shallow-repository") == "true"
    tag_available = (
        subprocess.run(
            [
                "git",
                "-C",
                str(repository),
                "show-ref",
                "--verify",
                "--quiet",
                f"refs/tags/{release_ref}",
            ],
            check=False,
        ).returncode
        == 0
    )
    if tag_available:
        try:
            resolved_commit = git(repository, "rev-parse", f"{release_ref}^{{commit}}")
        except subprocess.CalledProcessError as error:
            raise SystemExit("Firefox release tag is unavailable") from error
        if resolved_commit != release_commit:
            raise SystemExit("Firefox release tag does not match its pinned commit")
    elif not shallow:
        raise SystemExit("Firefox release tag is unavailable")
    if not shallow:
        ancestor = subprocess.run(
            [
                "git",
                "-C",
                str(repository),
                "merge-base",
                "--is-ancestor",
                release_commit,
                commit,
            ],
            check=False,
        )
        if ancestor.returncode != 0:
            raise SystemExit("WildBuzzard does not contain the pinned Firefox release")
    display_version = (
        (repository / "browser" / "config" / "version_display.txt")
        .read_text(encoding="utf-8")
        .strip()
    )
    source_version = (
        (repository / "browser" / "config" / "version.txt")
        .read_text(encoding="utf-8")
        .strip()
    )
    if display_version != release_version or f"{source_version}esr" != release_version:
        raise SystemExit("Firefox version files do not match the release pin")


def verify_arti_build_provenance(build_manifest, artifacts, repository):
    manifest = parse_build_manifest(build_manifest)
    pins = tomllib.loads(
        (repository / "wildbuzzard" / "third_party" / "arti.toml").read_text(
            encoding="utf-8"
        )
    )
    for field in ("arti_tag", "arti_commit", "arti_tree"):
        pin = field.removeprefix("arti_")
        if manifest.get(field) != pins.get(pin):
            raise SystemExit(f"Arti build {field} does not match the source pin")
    expectations = {
        "arti": ("artifact", "binary_sha256", None),
        "artiProvenance": ("provenance", "provenance_sha256", None),
        "artiSource": ("source", "source_sha256", "source_sha256"),
        "artiCargoVendor": (
            "cargo_vendor",
            "cargo_vendor_sha256",
            "cargo_vendor_sha256",
        ),
    }
    for name, (path_field, digest_field, pin_field) in expectations.items():
        artifact = artifacts[name]
        if Path(manifest.get(path_field, "")).name != artifact.name:
            raise SystemExit(f"Arti {path_field} does not match the release artifact")
        declared_digest = manifest.get(digest_field)
        if digest(artifact) != declared_digest:
            raise SystemExit(f"Arti {name} digest does not match its build manifest")
        if pin_field and declared_digest != pins.get(pin_field):
            raise SystemExit(f"Arti {name} digest does not match the source pin")
    inventory = repository / "wildbuzzard/third_party/arti-crates/THIRD-PARTY.json"
    if (
        Path(manifest.get("cargo_license_inventory", "")) != inventory
        or manifest.get("cargo_license_inventory_sha256")
        != pins.get("cargo_license_inventory_sha256")
        or digest(inventory) != pins.get("cargo_license_inventory_sha256")
    ):
        raise SystemExit("Arti crate license inventory differs from its build manifest")
    validator = repository / "wildbuzzard/scripts/arti-runtime-provenance.py"
    runtime_config = Path(manifest.get("config", ""))
    if not runtime_config.is_file() or digest(runtime_config) != manifest.get(
        "config_sha256"
    ):
        raise SystemExit("Arti runtime config differs from its build manifest")
    result = subprocess.run(
        [
            sys.executable,
            "-I",
            "-B",
            str(validator),
            "validate",
            "--binary",
            str(artifacts["arti"]),
            "--pin-config",
            str(runtime_config),
            "--installed-config",
            str(runtime_config),
            "--inventory",
            str(inventory),
            "--provenance",
            str(artifacts["artiProvenance"]),
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode:
        message = result.stderr.strip() or result.stdout.strip()
        raise SystemExit(
            "invalid Arti runtime provenance: "
            + (message or f"verifier exited {result.returncode}")
        )
    source_validator = repository / "wildbuzzard/scripts/arti_crate_provenance.py"
    result = subprocess.run(
        [
            sys.executable,
            "-I",
            "-B",
            str(source_validator),
            "verify",
            "--source-bundle",
            str(artifacts["artiCargoVendor"]),
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode:
        message = result.stderr.strip() or result.stdout.strip()
        raise SystemExit(
            "invalid Arti Cargo vendor source: "
            + (message or f"verifier exited {result.returncode}")
        )


def verify_runner_crate_source(path, repository):
    verifier = repository / "wildbuzzard" / "scripts" / "runner_crate_provenance.py"
    result = subprocess.run(
        [
            sys.executable,
            "-I",
            "-B",
            str(verifier),
            "verify",
            "--source-bundle",
            str(path),
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode:
        message = result.stderr.strip() or result.stdout.strip()
        raise SystemExit(
            "invalid WildBuzzard CLI corresponding source: "
            + (message or f"verifier exited {result.returncode}")
        )


def verify_search_source(path, repository):
    verifier = repository / "scripts/verify_source_bundle.py"
    result = subprocess.run(
        [sys.executable, "-I", "-B", str(verifier), str(path)],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode:
        message = result.stderr.strip() or result.stdout.strip()
        raise SystemExit(
            "invalid buzzard-search source/license artifact: "
            + (message or f"verifier exited {result.returncode}")
        )


def verify_minijtt_source(path, repository):
    verifier = repository / "scripts/verify-source-license-artifact.py"
    result = subprocess.run(
        [sys.executable, "-I", "-B", str(verifier), str(path)],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode:
        message = result.stderr.strip() or result.stdout.strip()
        raise SystemExit(
            "invalid buzzard-minijtt source/license artifact: "
            + (message or f"verifier exited {result.returncode}")
        )


def verify_blocker_asset_source(path, repository):
    verifier = repository / "wildbuzzard" / "scripts" / "blocker_asset_provenance.py"
    result = subprocess.run(
        [
            sys.executable,
            "-I",
            "-B",
            str(verifier),
            "verify",
            "--repository",
            str(repository),
            "--source-bundle",
            str(path),
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode:
        message = result.stderr.strip() or result.stdout.strip()
        raise SystemExit(
            "invalid blocker corresponding source: "
            + (message or f"verifier exited {result.returncode}")
        )


def verify_qbittorrent_sources(build_manifest, artifacts, external_sources):
    manifest = parse_build_manifest(build_manifest)
    expectations = {
        "core": (
            "qbittorrentCoreSource",
            "core_source",
            {"name", "sha256", "size"},
        ),
        "boost": (
            "qbittorrentBoostSource",
            "boost_source",
            {"name", "sha256", "size", "url"},
        ),
        "qt": (
            "qbittorrentQtSource",
            "qt_source",
            {"name", "sha256", "size", "url"},
        ),
        "system": (
            "qbittorrentSystemSource",
            "system_source",
            {"name", "sha256", "size", "platform"},
        ),
    }
    if set(external_sources) != set(expectations):
        raise SystemExit("qBittorrent runtime lacks exact external source classes")
    for component, (artifact_name, field, record_fields) in expectations.items():
        artifact = artifacts[artifact_name]
        record = external_sources[component]
        if (
            not isinstance(record, dict)
            or set(record) != record_fields
            or record["name"] != artifact.name
            or record["sha256"] != digest(artifact)
            or record["size"] != artifact.stat().st_size
        ):
            raise SystemExit(
                f"qBittorrent {component} source differs from its runtime source offer"
            )
    if (
        external_sources["boost"]["url"]
        != "https://archives.boost.io/release/1.88.0/source/boost_1_88_0.tar.bz2"
        or external_sources["qt"]["url"]
        != "https://download.qt.io/official_releases/qt/6.10/6.10.2/submodules/qtbase-everywhere-src-6.10.2.tar.xz"
        or external_sources["system"]["platform"] != "ubuntu-24.04"
    ):
        raise SystemExit("qBittorrent external source identity differs")
        if Path(manifest.get(field, "")).name != artifact.name or manifest.get(
            f"{field}_sha256"
        ) != digest(artifact):
            raise SystemExit(
                f"qBittorrent {component} source differs from its build manifest"
            )
    runtime = artifacts["qbittorrentRuntime"]
    if (
        Path(manifest.get("runtime_zip", "")).name != runtime.name
        or manifest.get("runtime_sha256") != digest(runtime)
        or manifest.get("runtime_size") != str(runtime.stat().st_size)
    ):
        raise SystemExit("qBittorrent runtime differs from its build manifest")


def exactly_one(files, pattern):
    matches = [path for path in files if fnmatch.fnmatch(path.name, pattern)]
    if len(matches) != 1:
        raise SystemExit(
            f"expected exactly one artifact matching {pattern}, found {len(matches)}"
        )
    return matches[0]


def verify_browser_debian_legal_members(members):
    invalid = sorted(
        path for path in BROWSER_DEB_LEGAL_PATHS if members.get(path) != ["file"]
    )
    if invalid:
        raise SystemExit(
            "wildbuzzard Debian package lacks exact regular legal files: "
            + ", ".join(invalid)
        )
    for root in EXACT_BROWSER_LEGAL_ROOTS:
        expected = {
            path for path in BROWSER_DEB_LEGAL_PATHS if path.startswith(root + "/")
        }
        actual = {
            path
            for path, kinds in members.items()
            if path.startswith(root + "/") and kinds == ["file"]
        }
        if actual != expected:
            raise SystemExit(f"wildbuzzard Debian legal directory is not exact: {root}")


def archive_member_name(name):
    if "\\" in name:
        raise SystemExit(f"unsafe Debian payload path: {name}")
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts:
        raise SystemExit(f"unsafe Debian payload path: {name}")
    normalized = path.as_posix()
    return "" if normalized == "." else normalized


def external_parent_directories():
    directories = set()
    for filename in BROWSER_DEB_EXTERNAL_FILES:
        parent = PurePosixPath(filename).parent
        while parent.as_posix() != ".":
            directories.add(parent.as_posix())
            parent = parent.parent
    return directories


def safe_browser_symlink_target(path, target):
    if (
        not target
        or "\\" in target
        or PurePosixPath(target).is_absolute()
        or posixpath.normpath(target) != target
    ):
        return False
    resolved = list(PurePosixPath(path).parent.parts)
    for component in PurePosixPath(target).parts:
        if component == "..":
            if not resolved:
                return False
            resolved.pop()
        else:
            resolved.append(component)
    destination = PurePosixPath(*resolved)
    root = PurePosixPath("opt/wildbuzzard")
    return destination == root or root in destination.parents


def verify_browser_debian_runtime_members(members, *, archive_only=False):
    invalid = []
    external_directories = external_parent_directories()
    for path, kinds in members.items():
        if not path:
            continue
        if len(kinds) != 1:
            invalid.append(path)
            continue
        entry = kinds[0]
        kind = entry[0] if isinstance(entry, tuple) else entry
        if kind == "symlink":
            if (
                not isinstance(entry, tuple)
                or len(entry) != 2
                or not safe_browser_symlink_target(path, entry[1])
            ):
                invalid.append(path)
                continue
        if path in {"opt", "opt/wildbuzzard"}:
            if kind != "directory":
                invalid.append(path)
            continue
        if path.startswith("opt/wildbuzzard/"):
            if kind not in {"directory", "file", "symlink"}:
                invalid.append(path)
                continue
            relative = PurePosixPath(path).relative_to("opt/wildbuzzard")
            components = {component.casefold() for component in relative.parts}
            filename = relative.name.casefold()
            if (
                components & BROWSER_DEB_FORBIDDEN_COMPONENTS
                or filename in BROWSER_DEB_FORBIDDEN_FILENAMES
                or PurePosixPath(filename).suffix in BROWSER_DEB_FORBIDDEN_SUFFIXES
                or filename.endswith(("-gtest", "_unittest"))
            ):
                invalid.append(path)
            continue
        if path in BROWSER_DEB_EXTERNAL_FILES:
            if kind != "file":
                invalid.append(path)
            continue
        if path in external_directories:
            if kind != "directory":
                invalid.append(path)
            continue
        invalid.append(path)
    required = BROWSER_DEB_REQUIRED_RUNTIME_FILES
    if archive_only:
        required = {path for path in required if path.startswith("opt/")}
    missing = sorted(path for path in required if members.get(path) != ["file"])
    if invalid or missing:
        details = []
        if invalid:
            details.append("forbidden or non-runtime: " + ", ".join(sorted(invalid)))
        if missing:
            details.append("missing runtime: " + ", ".join(missing))
        raise SystemExit("invalid wildbuzzard Debian payload: " + "; ".join(details))


def verify_browser_runtime_root(root):
    if root.is_symlink() or not root.is_dir() or root.name != "opt":
        raise SystemExit(f"invalid WildBuzzard browser runtime root: {root}")
    members = {"opt": ["directory"]}
    for path in root.rglob("*"):
        name = (PurePosixPath("opt") / path.relative_to(root).as_posix()).as_posix()
        if path.is_symlink():
            kind = ("symlink", str(path.readlink()))
        elif path.is_dir():
            kind = "directory"
        elif path.is_file():
            kind = "file"
        else:
            kind = "other"
        members.setdefault(name, []).append(kind)
    verify_browser_debian_runtime_members(members, archive_only=True)


def verify_browser_debian_legal_payload(path):
    process = subprocess.Popen(
        ["dpkg-deb", "--fsys-tarfile", str(path)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    members = {}
    try:
        with tarfile.open(fileobj=process.stdout, mode="r|*") as archive:
            for member in archive:
                name = archive_member_name(member.name)
                if member.isdir():
                    kind = "directory"
                elif member.isfile():
                    kind = "file"
                elif member.issym():
                    kind = ("symlink", member.linkname)
                else:
                    kind = "other"
                members.setdefault(name, []).append(kind)
    except (OSError, tarfile.TarError) as error:
        process.kill()
        process.wait()
        raise SystemExit(f"could not inspect Debian payload: {path.name}") from error
    finally:
        process.stdout.close()
    stderr = process.stderr.read().decode(errors="replace").strip()
    returncode = process.wait()
    if returncode:
        raise SystemExit(
            f"could not inspect Debian payload: {path.name}: "
            + (stderr or f"dpkg-deb exited {returncode}")
        )
    verify_browser_debian_legal_members(members)
    verify_browser_debian_runtime_members(members)


def torrent_parent_directories():
    directories = set()
    for filename in TORRENT_DEB_FIXED_FILES | {TORRENT_DEB_RUNTIME_ROOT}:
        parent = PurePosixPath(filename).parent
        while parent.as_posix() != ".":
            directories.add(parent.as_posix())
            parent = parent.parent
    return directories


def verify_torrent_debian_runtime_members(members):
    invalid = []
    parents = torrent_parent_directories()
    for path, kinds in members.items():
        if not path:
            if kinds != ["directory"]:
                invalid.append(path)
            continue
        if len(kinds) != 1:
            invalid.append(path)
            continue
        kind = kinds[0]
        if path in TORRENT_DEB_FIXED_FILES:
            if kind != "file":
                invalid.append(path)
            continue
        if path == TORRENT_DEB_RUNTIME_ROOT:
            if kind != "directory":
                invalid.append(path)
            continue
        if path.startswith(TORRENT_DEB_RUNTIME_ROOT + "/"):
            if kind not in {"directory", "file"}:
                invalid.append(path)
            continue
        if path in parents:
            if kind != "directory":
                invalid.append(path)
            continue
        invalid.append(path)
    missing = sorted(
        path for path in TORRENT_DEB_FIXED_FILES if members.get(path) != ["file"]
    )
    runtime_manifest = (
        TORRENT_DEB_RUNTIME_ROOT + "/wildbuzzard-qbittorrent-runtime.json"
    )
    if members.get(runtime_manifest) != ["file"]:
        missing.append(runtime_manifest)
    if invalid or missing:
        details = []
        if invalid:
            details.append("forbidden or non-runtime: " + ", ".join(sorted(invalid)))
        if missing:
            details.append("missing runtime: " + ", ".join(sorted(missing)))
        raise SystemExit(
            "invalid buzzard-torrent Debian payload: " + "; ".join(details)
        )


def verify_torrent_debian_payload(path, repository):
    verifier = (
        repository
        / "wildbuzzard"
        / "components"
        / "buzzard-torrent"
        / "scripts"
        / "verify-runtime.py"
    )
    with tempfile.TemporaryDirectory(prefix="wildbuzzard-torrent-deb-") as directory:
        root = Path(directory)
        process = subprocess.Popen(
            ["dpkg-deb", "--fsys-tarfile", str(path)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        members = {}
        try:
            with tarfile.open(fileobj=process.stdout, mode="r|*") as archive:
                for member in archive:
                    name = archive_member_name(member.name)
                    if member.mode & 0o7000:
                        kind = "other"
                    elif member.isdir():
                        kind = "directory"
                    elif member.isfile():
                        kind = "file"
                    else:
                        kind = "other"
                    if name in members:
                        members[name].append(kind)
                        continue
                    members[name] = [kind]
                    destination = root / name
                    if kind == "directory":
                        destination.mkdir(parents=True, exist_ok=True)
                    elif kind == "file":
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        extracted = archive.extractfile(member)
                        if extracted is None:
                            raise SystemExit(f"unreadable Debian payload file: {name}")
                        with extracted, destination.open("xb") as output:
                            shutil.copyfileobj(extracted, output)
                        destination.chmod(member.mode & 0o777)
        except SystemExit:
            process.kill()
            process.wait()
            process.stderr.close()
            raise
        except (OSError, tarfile.TarError) as error:
            process.kill()
            process.wait()
            process.stderr.close()
            raise SystemExit(
                f"could not inspect Debian payload: {path.name}"
            ) from error
        finally:
            process.stdout.close()
        stderr = process.stderr.read().decode(errors="replace").strip()
        process.stderr.close()
        returncode = process.wait()
        if returncode:
            raise SystemExit(
                f"could not inspect Debian payload: {path.name}: "
                + (stderr or f"dpkg-deb exited {returncode}")
            )
        verify_torrent_debian_runtime_members(members)
        runtime = root / TORRENT_DEB_RUNTIME_ROOT
        result = subprocess.run(
            [sys.executable, "-I", "-B", str(verifier), "--runtime", str(runtime)],
            check=False,
            capture_output=True,
            text=True,
        )
        if result.returncode:
            message = result.stderr.strip() or result.stdout.strip()
            raise SystemExit(
                "invalid buzzard-torrent runtime: "
                + (message or f"verifier exited {result.returncode}")
            )
        runtime_manifest = json.loads(
            (runtime / "wildbuzzard-qbittorrent-runtime.json").read_text(
                encoding="utf-8"
            )
        )
        return runtime_manifest.get("externalSourceArtifacts")


def debian_metadata(path, expected_name):
    fields = subprocess.run(
        [
            "dpkg-deb",
            "--show",
            "--showformat=${Package}\n${Version}\n${Architecture}\n${Depends}\n${Suggests}\n${Maintainer}\n${Installed-Size}\nEND\n",
            str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.splitlines()
    if len(fields) != 8 or fields[-1] != "END":
        raise SystemExit(f"could not read Debian metadata from {path.name}")
    package, version, architecture, dependencies, suggestions, maintainer, size, _ = (
        fields
    )
    if (
        package != expected_name
        or architecture != "amd64"
        or maintainer != EXPECTED_MAINTAINER
        or not size.isdigit()
    ):
        raise SystemExit(f"unexpected Debian identity in {path.name}")
    return {
        "architecture": architecture,
        "depends": dependencies,
        "file": path.name,
        "installedSizeKiB": int(size),
        "maintainer": maintainer,
        "package": package,
        "suggests": suggestions,
        "version": version,
    }


def debian_dependency_names(value):
    return {
        alternative.strip().split(maxsplit=1)[0]
        for group in value.split(",")
        for alternative in group.split("|")
        if alternative.strip()
    }


def verify_torrent_package_size(path, metadata):
    if (
        path.stat().st_size > 96 * 1024 * 1024
        or metadata["installedSizeKiB"] > 128 * 1024
    ):
        raise SystemExit("buzzard-torrent Debian package exceeds its hard size limits")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifact-dir")
    parser.add_argument("--verify-browser-runtime-root")
    parser.add_argument("--repository", action="append", default=[])
    parser.add_argument("--build-manifest", action="append", default=[])
    arguments = parser.parse_args()

    if arguments.verify_browser_runtime_root:
        if arguments.artifact_dir or arguments.repository or arguments.build_manifest:
            parser.error(
                "--verify-browser-runtime-root cannot be combined with release options"
            )
        verify_browser_runtime_root(
            Path(arguments.verify_browser_runtime_root).resolve(strict=True)
        )
        return
    if not arguments.artifact_dir:
        parser.error("--artifact-dir is required")

    artifact_dir = Path(arguments.artifact_dir).resolve()
    repositories = parse_mapping(arguments.repository, "--repository")
    build_manifests = parse_mapping(arguments.build_manifest, "--build-manifest")
    if set(repositories) != EXPECTED_REPOSITORIES:
        raise SystemExit(
            "repository mappings must be exactly: "
            + ", ".join(sorted(EXPECTED_REPOSITORIES))
        )
    if set(build_manifests) != set(EXPECTED_BUILD_MANIFESTS):
        raise SystemExit(
            "build manifest mappings must be exactly: "
            + ", ".join(sorted(EXPECTED_BUILD_MANIFESTS))
        )
    for name, repository in repositories.items():
        if git(repository, "status", "--porcelain=v1", "--untracked-files=all"):
            raise SystemExit(f"repository checkout is dirty: {name}")
    configure_arti_legal_paths(repositories["wildbuzzard"])
    wildbuzzard_commit = git(repositories["wildbuzzard"], "rev-parse", "HEAD")
    verify_firefox_release_provenance(repositories["wildbuzzard"], wildbuzzard_commit)
    verify_wildbuzzard_build_provenance(build_manifests, wildbuzzard_commit)

    files = sorted(
        path
        for path in artifact_dir.iterdir()
        if path.is_file() and path.name not in {"release-manifest.json", "SHA256SUMS"}
    )
    resolved = {
        name: exactly_one(files, pattern)
        for name, pattern in REQUIRED_ARTIFACTS.items()
    }
    verify_arti_build_provenance(
        build_manifests["arti"], resolved, repositories["wildbuzzard"]
    )
    verify_runner_crate_source(
        resolved["runnerCratesSource"], repositories["wildbuzzard"]
    )
    verify_search_source(resolved["searchSource"], repositories["buzzard-search"])
    verify_minijtt_source(resolved["minijttSource"], repositories["buzzard-minijtt"])
    verify_blocker_asset_source(
        resolved["blockerAssetSource"], repositories["wildbuzzard"]
    )
    for name, expected_name in EXPECTED_BUILD_MANIFESTS.items():
        path = build_manifests[name]
        if (
            path.parent != artifact_dir
            or path.name != expected_name
            or path not in files
        ):
            raise SystemExit(
                f"{name} build manifest must be {artifact_dir / expected_name}"
            )
    package_paths = {
        package: exactly_one(files, pattern)
        for package, pattern in EXPECTED_PACKAGES.items()
    }
    qbittorrent_external_sources = verify_torrent_debian_payload(
        package_paths["buzzard-torrent"], repositories["wildbuzzard"]
    )
    verify_qbittorrent_sources(
        build_manifests["qbittorrent"], resolved, qbittorrent_external_sources
    )
    unexpected_debs = sorted(
        path.name
        for path in files
        if path.suffix == ".deb" and path not in package_paths.values()
    )
    if unexpected_debs:
        raise SystemExit(
            "unexpected Debian packages in release: " + ", ".join(unexpected_debs)
        )
    packages = [
        debian_metadata(path, package) for package, path in package_paths.items()
    ]
    torrent_package = next(
        package for package in packages if package["package"] == "buzzard-torrent"
    )
    verify_torrent_package_size(package_paths["buzzard-torrent"], torrent_package)
    browser_package = next(
        package for package in packages if package["package"] == "wildbuzzard"
    )
    verify_browser_debian_legal_payload(package_paths["wildbuzzard"])
    dependency_names = debian_dependency_names(browser_package["depends"])
    if "buzzard-torrent" not in dependency_names:
        raise SystemExit("wildbuzzard Debian package lacks buzzard-torrent dependency")
    optional_packages = {"buzzard-minijtt", "buzzard-search"}
    bundled_optionals = dependency_names & optional_packages
    if bundled_optionals:
        raise SystemExit(
            "wildbuzzard Debian package hard-depends on optional packages: "
            + ", ".join(sorted(bundled_optionals))
        )
    suggestion_names = debian_dependency_names(browser_package["suggests"])
    if suggestion_names != optional_packages:
        raise SystemExit(
            "wildbuzzard Debian Suggests must be exactly: "
            + ", ".join(sorted(optional_packages))
        )

    browser_timestamp = int(
        git(
            repositories["wildbuzzard"],
            "show",
            "-s",
            "--format=%ct",
            "HEAD",
        )
    )
    source_date = datetime.datetime.fromtimestamp(
        browser_timestamp, datetime.timezone.utc
    ).replace(microsecond=0)
    payload = {
        "schema": 1,
        "architecture": "amd64",
        "artifacts": [
            {
                "name": path.name,
                "sha256": digest(path),
                "size": path.stat().st_size,
            }
            for path in files
        ],
        "buildManifests": {
            name: path.name for name, path in sorted(build_manifests.items())
        },
        "packages": packages,
        "platform": "ubuntu-24.04",
        "repositories": {
            name: {
                "commit": git(path, "rev-parse", "HEAD"),
                "remote": git(path, "config", "--get", "remote.origin.url"),
            }
            for name, path in sorted(repositories.items())
        },
        "requiredArtifacts": {
            name: path.name for name, path in sorted(resolved.items())
        },
        "sourceDate": source_date.isoformat().replace("+00:00", "Z"),
    }
    output = artifact_dir / "release-manifest.json"
    output.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    main()
