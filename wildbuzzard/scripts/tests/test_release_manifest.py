#!/usr/bin/env python3

import contextlib
import importlib.util
import json
import pathlib
import subprocess
import tempfile
import unittest
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    "create_release_manifest", HERE.parents[1] / "ci" / "create-release-manifest.py"
)
MANIFEST = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MANIFEST)


class BuildProvenanceTests(unittest.TestCase):
    def manifests(self, root, commit, *, working_tree="false"):
        browser = root / "browser-build-manifest.txt"
        browser.write_text(
            f"base_commit={commit}\nbuild_commit={commit}\nworking_tree={working_tree}\n",
            encoding="utf-8",
        )
        qbittorrent = root / "qbittorrent-build-manifest.txt"
        qbittorrent.write_text(
            f"base_commit={commit}\nwildbuzzard_commit={commit}\n"
            f"working_tree={working_tree}\n",
            encoding="utf-8",
        )
        return {"browser": browser, "qbittorrent": qbittorrent}

    def test_accepts_clean_builds_from_the_exact_release_commit(self):
        commit = "a" * 40
        with tempfile.TemporaryDirectory() as directory:
            MANIFEST.verify_wildbuzzard_build_provenance(
                self.manifests(pathlib.Path(directory), commit), commit
            )

    def test_rejects_snapshots_and_mismatched_commits(self):
        commit = "a" * 40
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            with self.assertRaises(SystemExit):
                MANIFEST.verify_wildbuzzard_build_provenance(
                    self.manifests(root, commit, working_tree="true"), commit
                )
            manifests = self.manifests(root, commit)
            manifests["browser"].write_text(
                f"base_commit={commit}\nbuild_commit={'b' * 40}\nworking_tree=false\n",
                encoding="utf-8",
            )
            with self.assertRaises(SystemExit):
                MANIFEST.verify_wildbuzzard_build_provenance(manifests, commit)

    def firefox_repository(self, root):
        repository = root / "repository"
        (repository / "browser" / "config").mkdir(parents=True)
        (repository / "wildbuzzard").mkdir()
        (repository / "browser" / "config" / "version.txt").write_text(
            "153.1.0\n", encoding="utf-8"
        )
        (repository / "browser" / "config" / "version_display.txt").write_text(
            "153.1.0esr\n", encoding="utf-8"
        )
        subprocess.run(["git", "init", "-q", str(repository)], check=True)
        subprocess.run(
            [
                "git",
                "-C",
                str(repository),
                "-c",
                "user.name=openresearchtools",
                "-c",
                "user.email=229047507+openresearchtools@users.noreply.github.com",
                "add",
                "browser",
            ],
            check=True,
        )
        subprocess.run(
            [
                "git",
                "-C",
                str(repository),
                "-c",
                "user.name=openresearchtools",
                "-c",
                "user.email=229047507+openresearchtools@users.noreply.github.com",
                "commit",
                "-qm",
                "Firefox release",
            ],
            check=True,
        )
        release_commit = subprocess.run(
            ["git", "-C", str(repository), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        subprocess.run(
            [
                "git",
                "-C",
                str(repository),
                "tag",
                "FIREFOX_153_1_0esr_RELEASE",
                release_commit,
            ],
            check=True,
        )
        (repository / "wildbuzzard" / "upstreams.toml").write_text(
            "\n".join([
                "[firefox]",
                'ref = "FIREFOX_153_1_0esr_RELEASE"',
                f'commit = "{release_commit}"',
                'version = "153.1.0esr"',
            ])
            + "\n",
            encoding="utf-8",
        )
        subprocess.run(
            [
                "git",
                "-C",
                str(repository),
                "-c",
                "user.name=openresearchtools",
                "-c",
                "user.email=229047507+openresearchtools@users.noreply.github.com",
                "add",
                "wildbuzzard/upstreams.toml",
            ],
            check=True,
        )
        subprocess.run(
            [
                "git",
                "-C",
                str(repository),
                "-c",
                "user.name=openresearchtools",
                "-c",
                "user.email=229047507+openresearchtools@users.noreply.github.com",
                "commit",
                "-qm",
                "Pin Firefox release",
            ],
            check=True,
        )
        head = subprocess.run(
            ["git", "-C", str(repository), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        return repository, head

    def test_requires_exact_ancestor_firefox_release_tag(self):
        with tempfile.TemporaryDirectory() as directory:
            repository, head = self.firefox_repository(pathlib.Path(directory))
            MANIFEST.verify_firefox_release_provenance(repository, head)
            pin = repository / "wildbuzzard" / "upstreams.toml"
            pin.write_text(
                pin.read_text(encoding="utf-8").replace(
                    "FIREFOX_153_1_0esr_RELEASE", "esr153"
                ),
                encoding="utf-8",
            )
            with self.assertRaises(SystemExit):
                MANIFEST.verify_firefox_release_provenance(repository, head)

    def test_accepts_depth_one_checkout_without_ancestry(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            repository, _ = self.firefox_repository(root)
            shallow = root / "shallow"
            subprocess.run(
                [
                    "git",
                    "clone",
                    "-q",
                    "--depth",
                    "1",
                    repository.resolve().as_uri(),
                    str(shallow),
                ],
                check=True,
            )
            head = subprocess.run(
                ["git", "-C", str(shallow), "rev-parse", "HEAD"],
                check=True,
                capture_output=True,
                text=True,
            ).stdout.strip()
            self.assertEqual(
                subprocess.run(
                    [
                        "git",
                        "-C",
                        str(shallow),
                        "rev-parse",
                        "--is-shallow-repository",
                    ],
                    check=True,
                    capture_output=True,
                    text=True,
                ).stdout.strip(),
                "true",
            )
            MANIFEST.verify_firefox_release_provenance(shallow, head)
            subprocess.run(
                ["git", "-C", str(shallow), "tag", "FIREFOX_153_1_0esr_RELEASE"],
                check=True,
            )
            with self.assertRaises(SystemExit):
                MANIFEST.verify_firefox_release_provenance(shallow, head)

    def test_rejects_firefox_version_or_tag_commit_mismatch(self):
        with tempfile.TemporaryDirectory() as directory:
            repository, head = self.firefox_repository(pathlib.Path(directory))
            version = repository / "browser" / "config" / "version_display.txt"
            version.write_text("153.0esr\n", encoding="utf-8")
            with self.assertRaises(SystemExit):
                MANIFEST.verify_firefox_release_provenance(repository, head)
            version.write_text("153.1.0esr\n", encoding="utf-8")
            pin = repository / "wildbuzzard" / "upstreams.toml"
            pin.write_text(
                "\n".join(
                    'commit = "0000000000000000000000000000000000000000"'
                    if line.startswith("commit = ")
                    else line
                    for line in pin.read_text(encoding="utf-8").splitlines()
                )
                + "\n",
                encoding="utf-8",
            )
            with self.assertRaises(SystemExit):
                MANIFEST.verify_firefox_release_provenance(repository, head)

    def arti_release(self, root):
        repository = root / "repository"
        pin_directory = repository / "wildbuzzard" / "third_party"
        pin_directory.mkdir(parents=True)
        artifacts = {
            "arti": root / "arti-2.5.1-linux-x86_64",
            "artiProvenance": root / "wildbuzzard-arti-2.5.1-provenance.zip",
            "artiSource": root / "wildbuzzard-arti-2.5.1-source.tar.xz",
            "artiCargoVendor": root / "wildbuzzard-arti-2.5.1-cargo-vendor.tar.xz",
        }
        contents = {
            "arti": b"binary",
            "artiProvenance": b"provenance",
            "artiSource": b"source",
            "artiCargoVendor": b"cargo vendor",
        }
        for name, path in artifacts.items():
            path.write_bytes(contents[name])
        digests = {name: MANIFEST.digest(path) for name, path in artifacts.items()}
        inventory = pin_directory / "arti-crates" / "THIRD-PARTY.json"
        inventory.parent.mkdir()
        inventory.write_text("{}\n", encoding="utf-8")
        (pin_directory / "arti.toml").write_text(
            "\n".join([
                'tag = "arti-v2.5.1"',
                f'commit = "{"a" * 40}"',
                f'tree = "{"b" * 40}"',
                f'source_sha256 = "{digests["artiSource"]}"',
                f'cargo_vendor_sha256 = "{digests["artiCargoVendor"]}"',
                f'cargo_license_inventory_sha256 = "{MANIFEST.digest(inventory)}"',
                f'linux_x86_64_binary_sha256 = "{digests["arti"]}"',
            ])
            + "\n",
            encoding="utf-8",
        )
        manifest = root / "arti-build-manifest.txt"
        manifest.write_text(
            "\n".join([
                "arti_tag=arti-v2.5.1",
                f"arti_commit={'a' * 40}",
                f"arti_tree={'b' * 40}",
                f"artifact={artifacts['arti']}",
                f"binary_sha256={digests['arti']}",
                f"source={artifacts['artiSource']}",
                f"source_sha256={digests['artiSource']}",
                f"cargo_vendor={artifacts['artiCargoVendor']}",
                f"cargo_vendor_sha256={digests['artiCargoVendor']}",
                f"cargo_license_inventory={inventory}",
                f"cargo_license_inventory_sha256={MANIFEST.digest(inventory)}",
                f"provenance={artifacts['artiProvenance']}",
                f"provenance_sha256={digests['artiProvenance']}",
            ])
            + "\n",
            encoding="utf-8",
        )
        return manifest, artifacts, repository

    def test_arti_artifacts_match_the_exact_source_build_and_pins(self):
        with tempfile.TemporaryDirectory() as directory:
            release = self.arti_release(pathlib.Path(directory))
            with mock.patch.object(
                MANIFEST.subprocess,
                "run",
                return_value=subprocess.CompletedProcess([], 0, "", ""),
            ):
                MANIFEST.verify_arti_build_provenance(*release)

    def test_rejects_arti_source_that_differs_from_the_build_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            manifest, artifacts, repository = self.arti_release(pathlib.Path(directory))
            artifacts["artiSource"].write_bytes(b"different")
            with self.assertRaises(SystemExit):
                MANIFEST.verify_arti_build_provenance(manifest, artifacts, repository)

    def test_rejects_arti_source_digest_that_differs_from_the_pin(self):
        with tempfile.TemporaryDirectory() as directory:
            manifest, artifacts, repository = self.arti_release(pathlib.Path(directory))
            pin = repository / "wildbuzzard" / "third_party" / "arti.toml"
            pin.write_text(
                pin.read_text(encoding="utf-8").replace(
                    MANIFEST.digest(artifacts["artiSource"]), "c" * 64
                ),
                encoding="utf-8",
            )
            with self.assertRaises(SystemExit):
                MANIFEST.verify_arti_build_provenance(manifest, artifacts, repository)


class ReleasePayloadTests(unittest.TestCase):
    def test_release_uses_one_extension_repository(self):
        self.assertEqual(
            MANIFEST.EXPECTED_REPOSITORIES,
            {"buzzard-minijtt", "buzzard-search", "extensions", "wildbuzzard"},
        )

    def test_release_builds_external_components_from_clean_checkouts(self):
        source = (HERE.parents[1] / "ci" / "build-release.sh").read_text(
            encoding="utf-8"
        )
        self.assertIn('checkout_root="${work_dir}/source-checkouts"', source)
        self.assertIn("git clone --quiet --no-hardlinks --no-checkout", source)
        for name in ("buzzard_search", "buzzard_minijtt", "extensions"):
            self.assertIn(f'{name}="$(clean_checkout', source)
            self.assertIn(
                f'--repository "{name.replace("_", "-")}=${{{name}_repository}}"',
                source,
            )

    def test_release_uses_native_minijtt_gate_and_external_source(self):
        source = (HERE.parents[1] / "ci" / "build-release.sh").read_text(
            encoding="utf-8"
        )
        self.assertIn("./ci/verify-release.sh", source)
        self.assertIn("buzzard-minijtt-*-source-license.tar.xz", source)
        self.assertNotIn("BUZZARD_NODE_ROOT", source)
        self.assertNotIn("process.test.mjs", source)
        self.assertEqual(
            MANIFEST.REQUIRED_ARTIFACTS["minijttSource"],
            "buzzard-minijtt-*-source-license.tar.xz",
        )
        self.assertNotIn("minijttRuntime", MANIFEST.REQUIRED_ARTIFACTS)

    def test_release_uses_search_package_gate_and_external_source(self):
        source = (HERE.parents[1] / "ci" / "build-release.sh").read_text(
            encoding="utf-8"
        )
        self.assertIn("BUZZARD_SEARCH_CI_RUN_ROOT", source)
        self.assertIn("buzzard-search-*-source-license.tar.xz", source)
        self.assertEqual(
            MANIFEST.REQUIRED_ARTIFACTS["searchSource"],
            "buzzard-search-*-source-license.tar.xz",
        )

    def test_minijtt_source_artifact_uses_the_sibling_verifier(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            repository = root / "repository"
            verifier = repository / "scripts/verify-source-license-artifact.py"
            verifier.parent.mkdir(parents=True)
            verifier.write_text("", encoding="utf-8")
            archive_path = root / "buzzard-minijtt-0.1.0-source-license.tar.xz"
            archive_path.write_bytes(b"source")
            success = subprocess.CompletedProcess([], 0, "", "")
            with mock.patch.object(
                MANIFEST.subprocess, "run", return_value=success
            ) as run:
                MANIFEST.verify_minijtt_source(archive_path, repository)
            run.assert_called_once_with(
                [
                    MANIFEST.sys.executable,
                    "-I",
                    "-B",
                    str(verifier),
                    str(archive_path),
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            failure = subprocess.CompletedProcess([], 1, "", "invalid source")
            with mock.patch.object(MANIFEST.subprocess, "run", return_value=failure):
                with self.assertRaisesRegex(SystemExit, "invalid source"):
                    MANIFEST.verify_minijtt_source(archive_path, repository)

    def browser_debian_members(self):
        members = {
            path: ["file"] for path in MANIFEST.BROWSER_DEB_REQUIRED_RUNTIME_FILES
        }
        for filename in MANIFEST.BROWSER_DEB_REQUIRED_RUNTIME_FILES:
            parent = pathlib.PurePosixPath(filename).parent
            while parent.as_posix() != ".":
                members.setdefault(parent.as_posix(), ["directory"])
                parent = parent.parent
        members[""] = ["directory"]
        return members

    def torrent_debian_members(self):
        files = MANIFEST.TORRENT_DEB_FIXED_FILES | {
            MANIFEST.TORRENT_DEB_RUNTIME_ROOT + "/wildbuzzard-qbittorrent-runtime.json",
            MANIFEST.TORRENT_DEB_RUNTIME_ROOT + "/bin/qbittorrent-nox",
        }
        members = {path: ["file"] for path in files}
        for filename in files:
            parent = pathlib.PurePosixPath(filename).parent
            while parent.as_posix() != ".":
                members.setdefault(parent.as_posix(), ["directory"])
                parent = parent.parent
        members[""] = ["directory"]
        return members

    def build_torrent_deb(
        self, root, *, extra_file=None, maintainer=MANIFEST.EXPECTED_MAINTAINER
    ):
        stage = root / "stage"
        (stage / "DEBIAN").mkdir(parents=True)
        (stage / "DEBIAN/control").write_text(
            "Package: buzzard-torrent\n"
            "Version: 1\n"
            "Architecture: amd64\n"
            "Installed-Size: 1\n"
            f"Maintainer: {maintainer}\n"
            "Description: test\n",
            encoding="utf-8",
        )
        for path in MANIFEST.TORRENT_DEB_FIXED_FILES:
            destination = stage / path
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text("runtime package\n", encoding="utf-8")
        runtime = stage / MANIFEST.TORRENT_DEB_RUNTIME_ROOT
        (runtime / "bin").mkdir(parents=True)
        (runtime / "bin/qbittorrent-nox").write_text("binary\n", encoding="utf-8")
        external = {
            "boost": {"name": "boost", "sha256": "a" * 64, "size": 1},
            "qt": {"name": "qt", "sha256": "b" * 64, "size": 2},
            "system": {"name": "system", "sha256": "c" * 64, "size": 3},
        }
        (runtime / "wildbuzzard-qbittorrent-runtime.json").write_text(
            json.dumps({"externalSourceArtifacts": external}), encoding="utf-8"
        )
        if extra_file:
            destination = stage / extra_file
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text("unexpected\n", encoding="utf-8")
        package = root / "buzzard-torrent_1_amd64.deb"
        subprocess.run(
            ["dpkg-deb", "--root-owner-group", "--build", str(stage), str(package)],
            check=True,
            capture_output=True,
        )
        return package, external

    def test_debian_metadata_requires_authenticated_maintainer(self):
        with tempfile.TemporaryDirectory() as directory:
            package, _ = self.build_torrent_deb(pathlib.Path(directory))
            metadata = MANIFEST.debian_metadata(package, "buzzard-torrent")
            self.assertEqual(metadata["maintainer"], MANIFEST.EXPECTED_MAINTAINER)
        with tempfile.TemporaryDirectory() as directory:
            package, _ = self.build_torrent_deb(
                pathlib.Path(directory), maintainer="test <test@example.invalid>"
            )
            with self.assertRaises(SystemExit):
                MANIFEST.debian_metadata(package, "buzzard-torrent")

    def test_requires_arti_corresponding_source(self):
        self.assertEqual(
            MANIFEST.REQUIRED_ARTIFACTS["artiSource"],
            "wildbuzzard-arti-*-source.tar.xz",
        )
        self.assertEqual(
            MANIFEST.REQUIRED_ARTIFACTS["artiCargoVendor"],
            "wildbuzzard-arti-*-cargo-vendor.tar.xz",
        )

    def test_arti_legal_payload_is_exact_in_browser_and_documentation(self):
        repository = HERE.parents[2]
        with contextlib.ExitStack() as stack:
            for name in (
                "BROWSER_DEB_LEGAL_PATHS",
                "BROWSER_DEB_EXTERNAL_FILES",
                "BROWSER_DEB_REQUIRED_RUNTIME_FILES",
            ):
                stack.enter_context(
                    mock.patch.object(
                        MANIFEST,
                        name,
                        set(getattr(MANIFEST, name)),
                    )
                )
            MANIFEST.configure_arti_legal_paths(repository)
            members = {path: ["file"] for path in MANIFEST.BROWSER_DEB_LEGAL_PATHS}
            MANIFEST.verify_browser_debian_legal_members(members)
            members["opt/wildbuzzard/notices/arti-crates/tests/fixture"] = ["file"]
            with self.assertRaises(SystemExit):
                MANIFEST.verify_browser_debian_legal_members(members)

    def test_torrent_package_size_limits_are_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            package = pathlib.Path(directory) / "buzzard-torrent.deb"
            package.write_bytes(b"package")
            MANIFEST.verify_torrent_package_size(
                package, {"installedSizeKiB": 128 * 1024}
            )
            with self.assertRaises(SystemExit):
                MANIFEST.verify_torrent_package_size(
                    package, {"installedSizeKiB": 128 * 1024 + 1}
                )
            with package.open("wb") as stream:
                stream.truncate(96 * 1024 * 1024 + 1)
            with self.assertRaises(SystemExit):
                MANIFEST.verify_torrent_package_size(package, {"installedSizeKiB": 1})

    def test_requires_blocker_corresponding_source(self):
        self.assertEqual(
            MANIFEST.REQUIRED_ARTIFACTS["blockerAssetSource"],
            "wildbuzzard-blocker-assets-source.tar.xz",
        )

    def test_requires_runner_crate_corresponding_source(self):
        self.assertEqual(
            MANIFEST.REQUIRED_ARTIFACTS["runnerCratesSource"],
            "wildbuzzard-runner-crates-source.tar.xz",
        )
        for relative in MANIFEST.RUNNER_CRATE_LEGAL_RELATIVE_PATHS:
            self.assertIn(
                f"opt/wildbuzzard/notices/wildbuzzard-cli/{relative}",
                MANIFEST.BROWSER_DEB_LEGAL_PATHS,
            )
            self.assertIn(
                f"usr/share/doc/wildbuzzard/runner-third-party/{relative}",
                MANIFEST.BROWSER_DEB_LEGAL_PATHS,
            )

    def test_requires_and_cross_checks_qbittorrent_source_artifacts(self):
        release_builder = (HERE.parents[1] / "ci" / "build-release.sh").read_text(
            encoding="utf-8"
        )
        self.assertIn(
            "--qt-source-archive /opt/wildbuzzard-inputs/qtbase-everywhere-src-6.10.2.tar.xz",
            release_builder,
        )
        for field in ("core_source", "boost_source", "qt_source", "system_source"):
            self.assertIn(
                f"copy_artifact \"$(sed -n 's/^{field}=//p'",
                release_builder,
            )
        self.assertEqual(
            {
                name: MANIFEST.REQUIRED_ARTIFACTS[name]
                for name in (
                    "qbittorrentCoreSource",
                    "qbittorrentBoostSource",
                    "qbittorrentQtSource",
                    "qbittorrentSystemSource",
                )
            },
            {
                "qbittorrentCoreSource": "wildbuzzard-qbittorrent-runtime-*-source.tar.xz",
                "qbittorrentBoostSource": "wildbuzzard-qbittorrent-boost-1.88.0-source.tar.bz2",
                "qbittorrentQtSource": "wildbuzzard-qbittorrent-qtbase-6.10.2-source.tar.xz",
                "qbittorrentSystemSource": "wildbuzzard-qbittorrent-ubuntu-24.04-system-sources-*.tar.xz",
            },
        )
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            artifacts = {
                "qbittorrentCoreSource": root
                / "wildbuzzard-qbittorrent-runtime-abc123def456-source.tar.xz",
                "qbittorrentBoostSource": root
                / "wildbuzzard-qbittorrent-boost-1.88.0-source.tar.bz2",
                "qbittorrentQtSource": root
                / "wildbuzzard-qbittorrent-qtbase-6.10.2-source.tar.xz",
                "qbittorrentSystemSource": root
                / "wildbuzzard-qbittorrent-ubuntu-24.04-system-sources-abc123def456.tar.xz",
                "qbittorrentRuntime": root
                / "wildbuzzard-qbittorrent-runtime-linux-x64-abc123def456.zip",
            }
            for index, path in enumerate(artifacts.values(), start=1):
                path.write_bytes(f"artifact {index}\n".encode())
            manifest = root / "qbittorrent-build-manifest.txt"
            manifest.write_text(
                "\n".join([
                    f"core_source={artifacts['qbittorrentCoreSource']}",
                    f"core_source_sha256={MANIFEST.digest(artifacts['qbittorrentCoreSource'])}",
                    f"boost_source={artifacts['qbittorrentBoostSource']}",
                    f"boost_source_sha256={MANIFEST.digest(artifacts['qbittorrentBoostSource'])}",
                    f"qt_source={artifacts['qbittorrentQtSource']}",
                    f"qt_source_sha256={MANIFEST.digest(artifacts['qbittorrentQtSource'])}",
                    f"system_source={artifacts['qbittorrentSystemSource']}",
                    f"system_source_sha256={MANIFEST.digest(artifacts['qbittorrentSystemSource'])}",
                    f"runtime_zip={artifacts['qbittorrentRuntime']}",
                    f"runtime_sha256={MANIFEST.digest(artifacts['qbittorrentRuntime'])}",
                    f"runtime_size={artifacts['qbittorrentRuntime'].stat().st_size}",
                ])
                + "\n",
                encoding="utf-8",
            )
            external = {
                component: {
                    "name": artifacts[name].name,
                    "sha256": MANIFEST.digest(artifacts[name]),
                    "size": artifacts[name].stat().st_size,
                }
                for component, name in {
                    "core": "qbittorrentCoreSource",
                    "boost": "qbittorrentBoostSource",
                    "qt": "qbittorrentQtSource",
                    "system": "qbittorrentSystemSource",
                }.items()
            }
            external["boost"]["url"] = (
                "https://archives.boost.io/release/1.88.0/source/boost_1_88_0.tar.bz2"
            )
            external["qt"]["url"] = (
                "https://download.qt.io/official_releases/qt/6.10/6.10.2/submodules/qtbase-everywhere-src-6.10.2.tar.xz"
            )
            external["system"]["platform"] = "ubuntu-24.04"
            MANIFEST.verify_qbittorrent_sources(manifest, artifacts, external)
            external["qt"]["sha256"] = "0" * 64
            with self.assertRaises(SystemExit):
                MANIFEST.verify_qbittorrent_sources(manifest, artifacts, external)
            external["qt"]["sha256"] = MANIFEST.digest(artifacts["qbittorrentQtSource"])
            external["core"]["unexpected"] = True
            with self.assertRaises(SystemExit):
                MANIFEST.verify_qbittorrent_sources(manifest, artifacts, external)

    def test_torrent_debian_payload_allows_only_wrappers_docs_and_runtime(self):
        valid = self.torrent_debian_members()
        MANIFEST.verify_torrent_debian_runtime_members(valid)
        for path, kind in (
            ("usr/share/buzzard-torrent/tests/fixture.json", "file"),
            ("usr/lib/buzzard-torrent/source/Cargo.toml", "file"),
            ("usr/bin/unrelated", "file"),
            ("usr/lib/buzzard-torrent/runtime/link", "symlink"),
        ):
            with self.subTest(path=path):
                members = self.torrent_debian_members()
                members[path] = [kind]
                with self.assertRaises(SystemExit):
                    MANIFEST.verify_torrent_debian_runtime_members(members)
        missing = self.torrent_debian_members()
        missing.pop("usr/bin/buzzard-torrent")
        with self.assertRaises(SystemExit):
            MANIFEST.verify_torrent_debian_runtime_members(missing)

    def test_torrent_debian_archive_is_extracted_and_gated(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            package, external = self.build_torrent_deb(root)
            verifier_result = subprocess.CompletedProcess([], 0, "", "")
            with mock.patch.object(
                MANIFEST.subprocess, "run", return_value=verifier_result
            ):
                self.assertEqual(
                    MANIFEST.verify_torrent_debian_payload(package, root), external
                )
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            package, _ = self.build_torrent_deb(
                root, extra_file="usr/share/buzzard-torrent/tests/fixture.json"
            )
            with self.assertRaises(SystemExit):
                MANIFEST.verify_torrent_debian_payload(package, root)

    def test_requires_each_browser_legal_file_once_as_a_regular_file(self):
        valid = {path: ["file"] for path in MANIFEST.BROWSER_DEB_LEGAL_PATHS}
        MANIFEST.verify_browser_debian_legal_members(valid)
        missing = dict(valid)
        missing.pop("usr/share/doc/wildbuzzard/COPYING")
        with self.assertRaises(SystemExit):
            MANIFEST.verify_browser_debian_legal_members(missing)
        duplicate = dict(valid)
        duplicate["opt/wildbuzzard/notices/LICENSE"] = ["file", "file"]
        with self.assertRaises(SystemExit):
            MANIFEST.verify_browser_debian_legal_members(duplicate)
        unsafe = dict(valid)
        unsafe["opt/wildbuzzard/notices/SOURCE-NOTICE"] = ["other"]
        with self.assertRaises(SystemExit):
            MANIFEST.verify_browser_debian_legal_members(unsafe)

    def test_accepts_only_browser_runtime_and_exact_external_payload(self):
        valid = self.browser_debian_members()
        valid[
            "opt/wildbuzzard/chrome/browser/builtin-addons/torrent-search/src/popup.js"
        ] = ["file"]
        MANIFEST.verify_browser_debian_runtime_members(valid)

    def test_archive_only_gate_reuses_browser_runtime_policy(self):
        runtime = {
            path: kinds
            for path, kinds in self.browser_debian_members().items()
            if not path or path == "opt" or path.startswith("opt/")
        }
        MANIFEST.verify_browser_debian_runtime_members(runtime, archive_only=True)
        runtime["opt/wildbuzzard/node_modules/package/index.js"] = ["file"]
        with self.assertRaises(SystemExit):
            MANIFEST.verify_browser_debian_runtime_members(runtime, archive_only=True)

    def test_rejects_source_tests_fixtures_build_caches_and_dev_tools(self):
        forbidden = [
            "opt/wildbuzzard/tests/test_browser.py",
            "opt/wildbuzzard/browser/fixtures/result.json",
            "opt/wildbuzzard/target/release/helper",
            "opt/wildbuzzard/.cache/compiler/state",
            "opt/wildbuzzard/browser/devtools/source.map",
            "opt/wildbuzzard/Cargo.toml",
            "opt/wildbuzzard/notices/wildbuzzard-cli/crates/serde-1.0.228.crate",
            "opt/wildbuzzard/notices/wildbuzzard-cli/source/serde/src/lib.rs",
            "opt/wildbuzzard/xpcshell",
        ]
        for path in forbidden:
            with self.subTest(path=path):
                members = self.browser_debian_members()
                members[path] = ["file"]
                with self.assertRaises(SystemExit):
                    MANIFEST.verify_browser_debian_runtime_members(members)

    def test_rejects_unexpected_external_files_and_missing_runtime(self):
        unexpected = self.browser_debian_members()
        unexpected["usr/share/wildbuzzard/source/test.py"] = ["file"]
        with self.assertRaises(SystemExit):
            MANIFEST.verify_browser_debian_runtime_members(unexpected)
        missing = self.browser_debian_members()
        missing.pop("usr/share/wildbuzzard/skills/wildbuzzard/SKILL.md")
        with self.assertRaises(SystemExit):
            MANIFEST.verify_browser_debian_runtime_members(missing)

    def test_accepts_only_normalized_in_tree_symlink_targets(self):
        valid = self.browser_debian_members()
        valid["opt/wildbuzzard/browser/firefox-link"] = [("symlink", "../wildbuzzard")]
        MANIFEST.verify_browser_debian_runtime_members(valid)

        for target in (
            "",
            "/etc/passwd",
            "../../etc/passwd",
            "..\\..\\etc\\passwd",
            "browser/../wildbuzzard",
            "./wildbuzzard",
            "browser//wildbuzzard",
        ):
            with self.subTest(target=target):
                members = self.browser_debian_members()
                members["opt/wildbuzzard/browser/firefox-link"] = [("symlink", target)]
                with self.assertRaises(SystemExit):
                    MANIFEST.verify_browser_debian_runtime_members(members)

    def test_rejects_symlink_without_preserved_target(self):
        members = self.browser_debian_members()
        members["opt/wildbuzzard/browser/firefox-link"] = ["symlink"]
        with self.assertRaises(SystemExit):
            MANIFEST.verify_browser_debian_runtime_members(members)

    def test_rejects_unsafe_archive_member_names(self):
        for name in ("/usr/bin/wildbuzzard", "../wildbuzzard", "usr\\bin"):
            with self.subTest(name=name), self.assertRaises(SystemExit):
                MANIFEST.archive_member_name(name)


if __name__ == "__main__":
    unittest.main()
