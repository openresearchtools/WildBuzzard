# SPDX-License-Identifier: AGPL-3.0-or-later

import hashlib
import importlib.util
import io
import json
import stat
import tarfile
import tempfile
import unittest
import warnings
import zipfile
from pathlib import Path

SCRIPTS = Path(__file__).parents[1]
MODULE_PATH = SCRIPTS / "validate-host-native-runtime-archive.py"
SPEC = importlib.util.spec_from_file_location(
    "host_native_runtime_validator", MODULE_PATH
)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
COPY_PATH = SCRIPTS.parent / "copy_validated_host_native_runtime.py"
COPY_SPEC = importlib.util.spec_from_file_location(
    "copy_host_native_runtime", COPY_PATH
)
COPY_MODULE = importlib.util.module_from_spec(COPY_SPEC)
COPY_SPEC.loader.exec_module(COPY_MODULE)


def sha256(value):
    return hashlib.sha256(value).hexdigest()


def source_archive(mode, prefix, files):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode=mode) as archive:
        root = tarfile.TarInfo(prefix)
        root.type = tarfile.DIRTYPE
        root.mode = 0o755
        archive.addfile(root)
        for name, value in sorted(files.items()):
            entry = tarfile.TarInfo(f"{prefix}/{name}")
            entry.size = len(value)
            entry.mode = 0o644
            archive.addfile(entry, io.BytesIO(value))
    return output.getvalue()


def file_entry(path, value, executable=False):
    return {
        "executable": executable,
        "path": path,
        "sha256": sha256(value),
        "size": len(value),
    }


def write_zip(path, files, manifest_name, manifest, epoch):
    timestamp = __import__("time").gmtime(epoch)[:6]
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_STORED) as archive:
        for name, value in sorted({**files, manifest_name: manifest}.items()):
            entry = zipfile.ZipInfo(name, timestamp)
            entry.create_system = 3
            executable = name in {
                "bin/wildbuzzard-torrent",
                "node/bin/node",
                "jackett-mini",
            }
            entry.external_attr = (
                stat.S_IFREG | (0o755 if executable else 0o644)
            ) << 16
            entry.compress_type = zipfile.ZIP_STORED
            archive.writestr(entry, value)


def finish_lock(path, archive, lock):
    archive_bytes = archive.read_bytes()
    lock["archive"] = {"sha256": sha256(archive_bytes), "size": len(archive_bytes)}
    path.write_text(json.dumps(lock, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def torrent_fixture(root):
    epoch = 1_786_375_860
    commit = "a" * 40
    webtorrent_commit = "b" * 40
    package_lock = json.dumps(
        {"lockfileVersion": 3, "packages": {"": {"name": "fixture"}}},
        sort_keys=True,
    ).encode()
    service = b"export const fixture = true;\n"
    upstreams = f'''[webtorrent]
commit = "{webtorrent_commit}"
version = "3.0.21"
'''.encode()
    webtorrent_package = b'{"name":"webtorrent","version":"3.0.21"}\n'
    prefix = f"wildbuzzard-torrent-runtime-{commit}"
    source = source_archive(
        "w:xz",
        prefix,
        {
            "third_party/webtorrent/package.json": webtorrent_package,
            "wildbuzzard/torrent-runtime/package-lock.json": package_lock,
            "wildbuzzard/torrent-runtime/service.mjs": service,
            "wildbuzzard/upstreams.toml": upstreams,
        },
    )
    source_path = (
        "share/wildbuzzard/torrent/"
        f"wildbuzzard-torrent-runtime-1.0.0-{commit[:12]}-source.tar.xz"
    )
    sbom_path = "share/wildbuzzard/torrent/sbom.cdx.json"
    node_sha = "c" * 64
    sbom = {
        "bomFormat": "CycloneDX",
        "specVersion": "1.6",
        "metadata": {
            "component": {
                "name": "wildbuzzard-torrent-runtime",
                "version": "1.0.0",
                "properties": [
                    {"name": "wildbuzzard:commit", "value": commit},
                    {
                        "name": "wildbuzzard:package-lock-sha256",
                        "value": sha256(package_lock),
                    },
                    {
                        "name": "wildbuzzard:webtorrent-commit",
                        "value": webtorrent_commit,
                    },
                ],
            }
        },
        "components": [
            {
                "type": "framework",
                "name": "Node.js",
                "version": "22.23.2",
                "purl": "pkg:generic/node@22.23.2",
                "hashes": [{"alg": "SHA-256", "content": node_sha}],
            },
            {
                "type": "library",
                "name": "webtorrent",
                "version": "3.0.21",
                "purl": "pkg:npm/webtorrent@3.0.21",
            },
        ],
    }
    files = {
        "WEBTORRENT-LICENSE": b"WebTorrent license\n",
        "WILDBUZZARD-LICENSE": b"WildBuzzard license\n",
        "app/package-lock.json": package_lock,
        "app/package.json": b'{"name":"fixture"}\n',
        "app/service.mjs": service,
        "bin/wildbuzzard-torrent": b"#!/bin/sh\nexit 0\n",
        "node/LICENSE": b"Node license\n",
        "node/bin/node": b"node fixture\n",
        sbom_path: (json.dumps(sbom, indent=2) + "\n").encode(),
        source_path: source,
    }
    entries = [
        file_entry(
            name,
            value,
            name in {"bin/wildbuzzard-torrent", "node/bin/node"},
        )
        for name, value in sorted(files.items())
    ]
    payload = "".join(
        f"{entry['path']}\0{entry['size']}\0{entry['sha256']}\0{1 if entry['executable'] else 0}\n"
        for entry in entries
    ).encode()
    pins = {
        "architecture": "x86_64",
        "component": "wildbuzzard-torrent-runtime",
        "correspondingSource": source_path,
        "dependencyLockSha256": sha256(package_lock),
        "licenseLocations": [
            "WEBTORRENT-LICENSE",
            "WILDBUZZARD-LICENSE",
            "node/LICENSE",
        ],
        "nodeArchiveSha256": node_sha,
        "nodeVersion": "22.23.2",
        "packageLockSha256": sha256(package_lock),
        "payloadSha256": sha256(payload),
        "platform": "linux-x64",
        "protocolVersion": 1,
        "sbom": sbom_path,
        "schema": 3,
        "sourceSha256": sha256(source),
        "utpBuiltFromSource": True,
        "version": "1.0.0",
        "webTorrentImportCommit": webtorrent_commit,
        "webTorrentVersion": "3.0.21",
        "wildbuzzardCommit": commit,
    }
    manifest = (json.dumps({**pins, "files": entries}, indent=2) + "\n").encode()
    archive = root / "torrent.zip"
    manifest_name = "wildbuzzard-torrent-runtime.json"
    write_zip(archive, files, manifest_name, manifest, epoch)
    lock = {
        "component": "wildbuzzard-torrent-runtime",
        "manifest": {"path": manifest_name, "sha256": sha256(manifest)},
        "manifestPins": pins,
        "requiredFiles": {
            name: {key: entry[key] for key in ("executable", "sha256", "size")}
            for name, entry in {entry["path"]: entry for entry in entries}.items()
        },
        "schemaVersion": 1,
        "sourceDateEpoch": epoch,
    }
    lock_path = root / "torrent-lock.json"
    finish_lock(lock_path, archive, lock)
    return archive, lock_path


def jackett_fixture(root):
    epoch = 1_786_253_932
    commit = "d" * 40
    source = source_archive(
        "w:gz",
        f"Jackett-{commit}",
        {"README.md": b"Jackett source\n"},
    )
    sdk = {
        "architecture": "x86_64",
        "archive": "dotnet-sdk.tar.gz",
        "releaseMetadata": "https://example.invalid/releases.json",
        "rid": "linux-x64",
        "schemaVersion": 1,
        "sha512": "e" * 128,
        "size": 10,
        "url": "https://example.invalid/dotnet.tar.gz",
        "version": "9.0.304",
    }
    sdk_bytes = (json.dumps(sdk, sort_keys=True) + "\n").encode()
    policy_sha = "f" * 64
    catalog = {"enabledIndexerIds": ["fixture"], "policySha256": policy_sha}
    catalog_bytes = (json.dumps(catalog, sort_keys=True) + "\n").encode()
    licenses = {
        "packages": [{"name": "Dependency", "version": "1.0.0", "license": "MIT"}]
    }
    license_bytes = (json.dumps(licenses, sort_keys=True) + "\n").encode()
    upstream = f'''version = "v0.24.2360"
commit = "{commit}"
source_sha256 = "{sha256(source)}"
'''.encode()
    preliminary = {
        "catalog.json": catalog_bytes,
        "jackett-mini": b"native executable\n",
        "licenses/dotnet/LICENSE.txt": b"dotnet license\n",
        "licenses/dotnet/ThirdPartyNotices.txt": b"dotnet notices\n",
        "licenses/jackett/LICENSE": b"jackett license\n",
        "licenses/jackett/THIRD_PARTY_NOTICES.md": b"jackett notices\n",
        "source/jackett/UPSTREAM.toml": upstream,
        "source/jackett/build-jackett-mini.sh": b"#!/bin/sh\n",
        "source/jackett/packaging/dotnet-sdk-linux-x64.json": sdk_bytes,
        "source/jackett/packaging/nuget-licenses.json": license_bytes,
        "source/jackett/patches/series": b"fixture.patch\n",
        "source/jackett/provider-policy/catalog.json": catalog_bytes,
        "source/jackett/upstream/SOURCE-MANIFEST.sha256": b"source manifest\n",
        "source/jackett/upstream/jackett-v0.24.2360.tar.gz": source,
    }
    preliminary_entries = [
        file_entry(name, value, name == "jackett-mini")
        for name, value in sorted(preliminary.items())
    ]
    sbom = {
        "SPDXID": "SPDXRef-DOCUMENT",
        "spdxVersion": "SPDX-2.3",
        "name": "jackett-mini-runtime",
        "packages": [
            {
                "SPDXID": "SPDXRef-Package-jackett-mini",
                "name": "jackett-mini",
                "versionInfo": "0.24.2360-wildbuzzard.1",
                "licenseDeclared": "GPL-2.0-only",
            },
            {
                "SPDXID": "SPDXRef-Package-Dependency",
                "name": "Dependency",
                "versionInfo": "1.0.0",
                "licenseDeclared": "MIT",
            },
        ],
        "files": [
            {
                "SPDXID": f"SPDXRef-File-{index}",
                "fileName": "./" + entry["path"],
                "checksums": [
                    {"algorithm": "SHA256", "checksumValue": entry["sha256"]}
                ],
            }
            for index, entry in enumerate(preliminary_entries, 1)
        ],
        "relationships": [],
    }
    files = dict(preliminary)
    files["jackett-mini.spdx.json"] = (json.dumps(sbom, indent=2) + "\n").encode()
    entries = [
        file_entry(name, value, name == "jackett-mini")
        for name, value in sorted(files.items())
    ]
    runtime_sha = sha256(
        json.dumps(entries, sort_keys=True, separators=(",", ":")).encode()
    )
    sdk_manifest = {**sdk, "lockSha256": sha256(sdk_bytes)}
    pins = {
        "architecture": "x86_64",
        "catalogFileSha256": sha256(catalog_bytes),
        "component": "jackett-mini",
        "correspondingSource": "source/jackett",
        "dashboardIncluded": False,
        "dependencyLockSha256": "1" * 64,
        "enabledProviderCount": 1,
        "executableName": "jackett-mini",
        "libc": "glibc",
        "license": "GPL-2.0-only",
        "licenseLocations": [
            "licenses/jackett/LICENSE",
            "licenses/jackett/THIRD_PARTY_NOTICES.md",
            "licenses/dotnet/LICENSE.txt",
            "licenses/dotnet/ThirdPartyNotices.txt",
        ],
        "platform": "linux",
        "protocolVersion": 1,
        "providerPolicySha256": policy_sha,
        "runtimeSha256": runtime_sha,
        "sbom": "jackett-mini.spdx.json",
        "schemaVersion": 1,
        "sdkToolchain": sdk_manifest,
        "semanticVersion": "0.24.2360-wildbuzzard.1",
        "sourceSha256": sha256(source),
        "testFixture": False,
        "updaterIncluded": False,
        "upstreamCommit": commit,
        "upstreamVersion": "v0.24.2360",
    }
    manifest = (json.dumps({**pins, "files": entries}, indent=2) + "\n").encode()
    archive = root / "jackett.zip"
    manifest_name = "jackett-mini-runtime.json"
    write_zip(archive, files, manifest_name, manifest, epoch)
    lock = {
        "component": "jackett-mini",
        "manifest": {"path": manifest_name, "sha256": sha256(manifest)},
        "manifestPins": pins,
        "requiredFiles": {
            name: {key: entry[key] for key in ("executable", "sha256", "size")}
            for name, entry in {entry["path"]: entry for entry in entries}.items()
            if name in MODULE.JACKETT_REQUIRED
        },
        "schemaVersion": 1,
        "sourceDateEpoch": epoch,
    }
    lock_path = root / "jackett-lock.json"
    finish_lock(lock_path, archive, lock)
    return archive, lock_path


def rewrite_archive(
    path, *, replace=None, omit=(), extra=None, extra_mode=stat.S_IFREG | 0o644
):
    replace = replace or {}
    with zipfile.ZipFile(path) as source:
        entries = [
            (entry, replace.get(entry.filename, source.read(entry)))
            for entry in source.infolist()
            if entry.filename not in omit
        ]
    if extra:
        entry = zipfile.ZipInfo(extra[0], (2026, 8, 10, 15, 31, 0))
        entry.create_system = 3
        entry.external_attr = extra_mode << 16
        entries.append((entry, extra[1]))
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_STORED) as output:
        for entry, value in entries:
            output.writestr(entry, value)


def repin_archive(lock_path, archive):
    lock = json.loads(lock_path.read_text(encoding="utf-8"))
    finish_lock(lock_path, archive, lock)


class HostNativeRuntimeValidationTests(unittest.TestCase):
    def test_validates_pinned_torrent_and_jackett_archives(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            torrent, torrent_lock = torrent_fixture(root)
            jackett, jackett_lock = jackett_fixture(root)
            MODULE.validate_path(torrent, torrent_lock, "torrent")
            MODULE.validate_path(jackett, jackett_lock, "jackett")

    def test_validated_copy_uses_an_immutable_snapshot(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive, lock = torrent_fixture(root)
            output = io.BytesIO()
            COPY_MODULE.main(output, archive, "torrent", lock)
            self.assertEqual(output.getvalue(), archive.read_bytes())

    def test_rejects_archive_pin_tampering(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive, lock = torrent_fixture(root)
            archive.write_bytes(archive.read_bytes() + b"tampered")
            with self.assertRaisesRegex(ValueError, "archive differs"):
                MODULE.validate_path(archive, lock, "torrent")

    def test_rejects_manifest_tampering(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive, lock = torrent_fixture(root)
            with zipfile.ZipFile(archive) as source:
                size = source.getinfo("wildbuzzard-torrent-runtime.json").file_size
            rewrite_archive(
                archive,
                replace={"wildbuzzard-torrent-runtime.json": b"x" * size},
            )
            repin_archive(lock, archive)
            with self.assertRaisesRegex(ValueError, "manifest differs"):
                MODULE.validate_path(archive, lock, "torrent")

    def test_rejects_tampered_runtime_payload(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive, lock = torrent_fixture(root)
            with zipfile.ZipFile(archive) as source:
                size = source.getinfo("app/service.mjs").file_size
            rewrite_archive(archive, replace={"app/service.mjs": b"x" * size})
            repin_archive(lock, archive)
            with self.assertRaisesRegex(ValueError, "payload differs"):
                MODULE.validate_path(archive, lock, "torrent")

    def test_rejects_unsafe_zip_entry(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive, lock = torrent_fixture(root)
            rewrite_archive(archive, extra=("../escape", b"tampered"))
            repin_archive(lock, archive)
            with self.assertRaisesRegex(ValueError, "unsafe torrent runtime ZIP"):
                MODULE.validate_path(archive, lock, "torrent")

    def test_rejects_symlink_zip_entry(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive, lock = torrent_fixture(root)
            rewrite_archive(
                archive,
                extra=("unsafe-link", b"app/service.mjs"),
                extra_mode=stat.S_IFLNK | 0o777,
            )
            repin_archive(lock, archive)
            with self.assertRaisesRegex(ValueError, "unsafe torrent runtime ZIP"):
                MODULE.validate_path(archive, lock, "torrent")

    def test_rejects_duplicate_zip_entry(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive, lock = torrent_fixture(root)
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", UserWarning)
                rewrite_archive(
                    archive,
                    extra=("app/service.mjs", b"duplicate"),
                )
            repin_archive(lock, archive)
            with self.assertRaisesRegex(ValueError, "unsafe torrent runtime ZIP"):
                MODULE.validate_path(archive, lock, "torrent")

    def test_rejects_wrong_source_revision(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive, lock_path = torrent_fixture(root)
            lock = json.loads(lock_path.read_text(encoding="utf-8"))
            lock["manifestPins"]["wildbuzzardCommit"] = "9" * 40
            lock_path.write_text(json.dumps(lock), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "manifest differs"):
                MODULE.validate_path(archive, lock_path, "torrent")

    def test_rejects_wrong_dependency_lock(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive, lock_path = torrent_fixture(root)
            lock = json.loads(lock_path.read_text(encoding="utf-8"))
            lock["manifestPins"]["packageLockSha256"] = "8" * 64
            lock_path.write_text(json.dumps(lock), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "manifest differs"):
                MODULE.validate_path(archive, lock_path, "torrent")

    def test_rejects_missing_entrypoint(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive, lock = jackett_fixture(root)
            rewrite_archive(archive, omit=("jackett-mini",))
            repin_archive(lock, archive)
            with self.assertRaisesRegex(ValueError, "inventories differ"):
                MODULE.validate_path(archive, lock, "jackett")

    def test_rejects_tampered_dependency_sbom(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive, lock = jackett_fixture(root)
            with zipfile.ZipFile(archive) as source:
                size = source.getinfo("jackett-mini.spdx.json").file_size
            rewrite_archive(archive, replace={"jackett-mini.spdx.json": b"x" * size})
            repin_archive(lock, archive)
            with self.assertRaisesRegex(ValueError, "payload differs"):
                MODULE.validate_path(archive, lock, "jackett")

    def test_shipping_paths_declare_strict_validation(self):
        root = SCRIPTS.parent
        configure = (root / "moz.configure").read_text(encoding="utf-8")
        mozbuild = (root / "moz.build").read_text(encoding="utf-8")
        external = (SCRIPTS / "build-linux-external.sh").read_text(encoding="utf-8")
        appimage = (SCRIPTS / "package-appimage.sh").read_text(encoding="utf-8")
        deb = (SCRIPTS / "package-deb.sh").read_text(encoding="utf-8")
        for value in (configure, mozbuild, external, appimage, deb):
            self.assertIn("validate-host-native-runtime-archive.py", value)
            self.assertIn("torrent-runtime-lock.json", value)
            self.assertIn("jackett-mini-runtime-lock.json", value)
        self.assertIn("copy_validated_host_native_runtime.py", mozbuild)


if __name__ == "__main__":
    unittest.main()
