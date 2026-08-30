#!/usr/bin/env python3

import importlib.util
import pathlib
import subprocess
import tempfile
import unittest

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
        }
        contents = {
            "arti": b"binary",
            "artiProvenance": b"provenance",
            "artiSource": b"source",
        }
        for name, path in artifacts.items():
            path.write_bytes(contents[name])
        digests = {name: MANIFEST.digest(path) for name, path in artifacts.items()}
        (pin_directory / "arti.toml").write_text(
            "\n".join([
                'tag = "arti-v2.5.1"',
                f'commit = "{"a" * 40}"',
                f'tree = "{"b" * 40}"',
                f'source_sha256 = "{digests["artiSource"]}"',
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

    def test_requires_arti_corresponding_source(self):
        self.assertEqual(
            MANIFEST.REQUIRED_ARTIFACTS["artiSource"],
            "wildbuzzard-arti-*-source.tar.xz",
        )

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

    def test_rejects_source_tests_fixtures_build_caches_and_dev_tools(self):
        forbidden = [
            "opt/wildbuzzard/tests/test_browser.py",
            "opt/wildbuzzard/browser/fixtures/result.json",
            "opt/wildbuzzard/target/release/helper",
            "opt/wildbuzzard/.cache/compiler/state",
            "opt/wildbuzzard/browser/devtools/source.map",
            "opt/wildbuzzard/Cargo.toml",
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
