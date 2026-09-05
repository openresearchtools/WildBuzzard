# SPDX-License-Identifier: AGPL-3.0-or-later

import importlib.util
import pathlib
import subprocess
import sys
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location(
    "firefox_release",
    pathlib.Path(__file__).resolve().parents[1] / "firefox_release.py",
)
RELEASE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RELEASE)


class FirefoxReleaseTests(unittest.TestCase):
    def git(self, repository, *args):
        return subprocess.run(
            [
                "git",
                "-C",
                str(repository),
                "-c",
                "user.name=Release Test",
                "-c",
                "user.email=release@example.invalid",
                *args,
            ],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()

    def commit(self, repository):
        self.git(repository, "add", ".")
        self.git(repository, "commit", "-qm", "Fixture change")

    def upstream_release(self, version, feature="upstream"):
        config = self.upstream / "browser/config"
        config.mkdir(parents=True, exist_ok=True)
        (config / "version.txt").write_text(version + "\n")
        (config / "version_display.txt").write_text(version + "esr\n")
        (self.upstream / "feature.txt").write_text(feature + "\n")
        self.commit(self.upstream)
        self.git(self.upstream, "tag", RELEASE.release_tag(version))

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="wildbuzzard-release-")
        self.addCleanup(temporary.cleanup)
        self.root = pathlib.Path(temporary.name)
        self.upstream = self.root / "upstream"
        self.upstream.mkdir()
        self.git(self.upstream, "init", "-q")
        self.upstream_release("153.1.0", "base")
        self.repository = self.root / "product"
        self.git(self.root, "clone", "-q", str(self.upstream), str(self.repository))
        self.git(self.repository, "config", "user.name", "Release Test")
        self.git(self.repository, "config", "user.email", "release@example.invalid")
        (self.repository / "wildbuzzard/config").mkdir(parents=True)
        self.version_path = self.repository / RELEASE.PRODUCT_VERSION
        self.version_path.write_text("153.1\n")
        self.pin_path = self.repository / RELEASE.PIN_FILE
        self.pin_path.write_text(
            "[firefox]\n"
            f'remote = "{self.upstream}"\n'
            'ref = "FIREFOX_153_1_0esr_RELEASE"\n'
            f'commit = "{self.git(self.upstream, "rev-parse", "HEAD")}"\n'
            'version = "153.1.0esr"\n'
            'tracking_branch = "mozilla/esr153"\n'
            '\n[donor]\nversion = "unchanged"\n'
        )
        self.commit(self.repository)
        self.upstream_release("153.2.0")

    def test_product_revisions_and_upstream_hotfixes_increase(self):
        for current, firefox, expected in [
            ("153.2", "153.2.0esr", "153.2.1"),
            ("153.2.9", "153.2.0esr", "153.2.10"),
            ("153.2.3", "153.2.1esr", "153.2.4"),
            ("153.2.9", "153.3.0esr", "153.3"),
            ("153.14.3", "166.0esr", "166.0"),
        ]:
            with self.subTest(current=current, firefox=firefox):
                self.assertEqual(
                    RELEASE.next_product_version(current, firefox), expected
                )
        with self.assertRaises(RELEASE.ReleaseError):
            RELEASE.next_product_version("153.3", "153.2")

    def test_initial_esr_release_uses_mozillas_two_component_tag(self):
        self.assertEqual(RELEASE.release_tag("166.0"), "FIREFOX_166_0esr_RELEASE")
        self.assertEqual(RELEASE.esr_version("166.0.0"), "166.0esr")
        self.assertEqual(RELEASE.release_tag("166.0.1"), "FIREFOX_166_0_1esr_RELEASE")

    def test_command_line_checks_and_bumps_the_product(self):
        command = [
            sys.executable,
            str(pathlib.Path(RELEASE.__file__)),
            "--repository",
            str(self.repository),
        ]
        result = subprocess.run(
            [*command, "check", "--latest"], capture_output=True, text=True, check=False
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("security update available", result.stderr)
        result = subprocess.run(
            [*command, "bump"], capture_output=True, text=True, check=False
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "153.1.1")
        self.assertEqual(RELEASE.pins(self.repository)["version"], "153.1.0esr")

    def test_rejects_invalid_and_mismatched_versions(self):
        for value in ["153.2.0", "153.2esr", "153.02", "153.3", "153.2.1.1"]:
            self.version_path.write_text(value + "\n")
            with self.subTest(value=value), self.assertRaises(RELEASE.ReleaseError):
                RELEASE.validate_versions(self.repository)

    def test_checks_latest_release_without_changing_the_checkout(self):
        self.assertEqual(RELEASE.latest_release(self.repository), "153.2.0esr")
        self.assertEqual(self.git(self.repository, "status", "--porcelain"), "")
        RELEASE.validate_history(self.repository)

    def test_update_merges_the_exact_tag_and_stages_matching_metadata(self):
        RELEASE.update(self.repository, "153.2")
        versions = RELEASE.validate_versions(self.repository)
        self.assertEqual(versions["wildbuzzard"], "153.2")
        self.assertEqual(
            versions["commit"], self.git(self.upstream, "rev-parse", "HEAD")
        )
        self.assertIn('[donor]\nversion = "unchanged"', self.pin_path.read_text())
        self.assertIn(
            RELEASE.PRODUCT_VERSION,
            self.git(self.repository, "diff", "--cached", "--name-only"),
        )
        self.commit(self.repository)
        RELEASE.validate_history(self.repository)

    def test_upstream_hotfix_preserves_product_version_order(self):
        RELEASE.update(self.repository, "153.2")
        self.commit(self.repository)
        self.version_path.write_text("153.2.3\n")
        self.commit(self.repository)
        self.upstream_release("153.2.1")
        RELEASE.update(self.repository, "153.2.1")
        self.assertEqual(self.version_path.read_text(), "153.2.4\n")

    def test_conflict_can_be_resolved_and_finished_without_losing_product_changes(self):
        feature = self.repository / "feature.txt"
        feature.write_text("product\n")
        self.commit(self.repository)
        with self.assertRaisesRegex(RELEASE.ReleaseError, "finish 153.2"):
            RELEASE.update(self.repository, "153.2")
        self.assertEqual(RELEASE.pins(self.repository)["version"], "153.1.0esr")
        feature.write_text("combined\n")
        self.git(self.repository, "add", "feature.txt")
        RELEASE.finish_update(self.repository, "153.2")
        self.commit(self.repository)
        RELEASE.validate_history(self.repository)
        self.assertEqual(feature.read_text(), "combined\n")

    def test_dirty_checkout_is_preserved(self):
        self.version_path.write_text("153.1.1\n")
        with self.assertRaisesRegex(RELEASE.ReleaseError, "Commit or stash"):
            RELEASE.update(self.repository, "153.2")
        self.assertEqual(self.version_path.read_text(), "153.1.1\n")

    def test_rejects_a_tag_with_the_wrong_engine_version(self):
        self.git(self.upstream, "tag", "FIREFOX_153_3_0esr_RELEASE")
        with self.assertRaisesRegex(
            RELEASE.ReleaseError, "expected Firefox version files"
        ):
            RELEASE.update(self.repository, "153.3")
        self.assertEqual(self.git(self.repository, "status", "--porcelain"), "")

    def test_rejects_downgrades_and_unrelated_finish(self):
        with self.assertRaisesRegex(RELEASE.ReleaseError, "newer"):
            RELEASE.update(self.repository, "153.0")
        with self.assertRaisesRegex(RELEASE.ReleaseError, "pending merge"):
            RELEASE.finish_update(self.repository, "153.1")


if __name__ == "__main__":
    unittest.main()
