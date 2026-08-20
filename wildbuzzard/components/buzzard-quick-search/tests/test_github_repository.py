# SPDX-License-Identifier: AGPL-3.0-only

from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import time
import unittest

from buzzard_quick_search.github_repository import (
    GitHubFetchError,
    GitHubUrlError,
    MAX_FILE_BYTES,
    _fetch_repository_from_remote,
    fetch_github_repository,
    parse_github_repository_url,
    resolve_ref_and_path,
)


FIXTURE = Path(__file__).parent / "fixtures" / "github-repository"


class GitHubUrlTest(unittest.TestCase):
    def test_normalizes_repository_tree_and_blob_urls(self):
        root = parse_github_repository_url(
            "https://github.com/mozilla/gecko-dev.git/?token=discarded#fragment"
        )
        self.assertIsNotNone(root)
        self.assertEqual(root.canonical_url, "https://github.com/mozilla/gecko-dev")
        self.assertEqual(root.kind, "repository")

        tree = parse_github_repository_url(
            "https://github.com/example/project/tree/feature/wrong/docs"
        )
        self.assertIsNotNone(tree)
        self.assertEqual(tree.tail, ("feature", "wrong", "docs"))
        self.assertEqual(
            tree.canonical_url,
            "https://github.com/example/project/tree/feature/wrong/docs",
        )

        blob = parse_github_repository_url(
            "https://github.com/example/project/blob/main/a%20file.md"
        )
        self.assertIsNotNone(blob)
        self.assertEqual(blob.tail, ("main", "a file.md"))
        self.assertEqual(
            blob.canonical_url,
            "https://github.com/example/project/blob/main/a%20file.md",
        )

        commit = "ABCDEF0123456789ABCDEF0123456789ABCDEF01"
        pinned = parse_github_repository_url(
            f"https://github.com/example/project/blob/{commit}/README.md"
        )
        self.assertIsNotNone(pinned)
        self.assertIn(commit.lower(), pinned.canonical_url)

    def test_rejects_credentials_ports_traversal_and_incomplete_scopes(self):
        for url in (
            "https://user@github.com/example/project",
            "https://user:secret@github.com/example/project",
            "http://github.com/example/project",
            "https://github.com:443/example/project",
            "https://github.com/example/project/blob/main/%2e%2e/secret",
            "https://github.com/example/project/blob/main/%2Fetc%2Fpasswd",
            "https://github.com/example/project/tree/feature%2Fwrong/docs",
            "https://github.com/example/project/tree/",
        ):
            with self.subTest(url = url), self.assertRaises(GitHubUrlError):
                parse_github_repository_url(url)

    def test_non_repository_and_lookalike_urls_return_none(self):
        for url in (
            "https://github.com.evil.test/example/project",
            "https://gitlab.com/example/project",
            "https://github.com/about/project",
            "https://github.com/example/project/issues/1",
            "not a url",
        ):
            with self.subTest(url = url):
                self.assertIsNone(parse_github_repository_url(url))

    def test_resolves_the_longest_slash_containing_ref(self):
        location = parse_github_repository_url(
            "https://github.com/example/project/tree/feature/slash/docs"
        )
        self.assertIsNotNone(location)
        self.assertEqual(
            resolve_ref_and_path(location, ["feature", "feature/slash"]),
            ("feature/slash", "docs"),
        )

    def test_public_entrypoint_does_not_claim_non_github_urls(self):
        self.assertIsNone(fetch_github_repository("https://example.com/repository"))

    def test_public_entrypoint_enforces_website_policy_before_network(self):
        with self.assertRaisesRegex(GitHubFetchError, "policy disallows"):
            fetch_github_repository(
                "https://github.com/example/project",
                website_policy = {"blockedDomains": ["github.com"]},
            )

    def test_git_process_obeys_the_overall_timeout(self):
        location = parse_github_repository_url(
            "https://github.com/example/project/tree/main/docs"
        )
        self.assertIsNotNone(location)
        with tempfile.TemporaryDirectory(prefix = "buzzard-github-timeout-") as directory:
            fake_git = Path(directory) / "git"
            fake_git.write_text("#!/bin/sh\nsleep 5\n", encoding = "utf-8")
            fake_git.chmod(0o700)
            started = time.monotonic()
            with self.assertRaisesRegex(GitHubFetchError, "timed out"):
                _fetch_repository_from_remote(
                    location,
                    "https://github.com/example/project.git",
                    timeout = 1,
                    cancel_event = None,
                    git_executable = fake_git,
                )
            self.assertLess(time.monotonic() - started, 2)

    def test_git_failure_never_exposes_stderr_or_local_paths(self):
        location = parse_github_repository_url("https://github.com/example/project")
        self.assertIsNotNone(location)
        with tempfile.TemporaryDirectory(prefix = "buzzard-github-failure-") as directory:
            fake_git = Path(directory) / "git"
            fake_git.write_text(
                "#!/bin/sh\nprintf '%s\\n' 'Authorization: Bearer secret /home/private' >&2\nexit 9\n",
                encoding = "utf-8",
            )
            fake_git.chmod(0o700)
            with self.assertRaises(GitHubFetchError) as raised:
                _fetch_repository_from_remote(
                    location,
                    "https://github.com/example/project.git",
                    timeout = 5,
                    cancel_event = None,
                    git_executable = fake_git,
                )
            self.assertEqual(str(raised.exception), "Git operation failed")
            self.assertNotIn("secret", str(raised.exception))
            self.assertNotIn(directory, str(raised.exception))


@unittest.skipUnless(shutil.which("git"), "Git is required")
class GitHubLocalRepositoryTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix = "buzzard-github-fixture-")
        cls.root = Path(cls.temporary.name)
        cls.work = cls.root / "work"
        cls.remote = cls.root / "remote.git"
        shutil.copytree(FIXTURE, cls.work)
        (cls.work / "binary.dat").write_bytes(b"\x00\x01\x02fixture")
        (cls.work / "large.txt").write_bytes(b"x" * (MAX_FILE_BYTES + 1))
        os.symlink("README.md", cls.work / "readme-link")
        cls._git("init", "--quiet", "--initial-branch=main", str(cls.work), cwd = cls.root)
        cls._git("config", "user.email", "fixture@example.invalid", cwd = cls.work)
        cls._git("config", "user.name", "Fixture", cwd = cls.work)
        cls._git("add", ".", cwd = cls.work)
        cls._git("commit", "--quiet", "-m", "fixture", cwd = cls.work)
        cls.commit = cls._git("rev-parse", "HEAD", cwd = cls.work).strip()
        cls._git("branch", "feature/slash", cwd = cls.work)
        cls._git("init", "--quiet", "--bare", str(cls.remote), cwd = cls.root)
        cls._git("remote", "add", "origin", str(cls.remote), cwd = cls.work)
        cls._git("push", "--quiet", "origin", "main", "feature/slash", cwd = cls.work)
        cls._git("symbolic-ref", "HEAD", "refs/heads/main", cwd = cls.remote)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    @classmethod
    def _git(cls, *arguments, cwd):
        result = subprocess.run(
            [shutil.which("git"), *arguments],
            cwd = cwd,
            check = True,
            stdout = subprocess.PIPE,
            stderr = subprocess.PIPE,
            text = True,
        )
        return result.stdout

    def _fetch(self, url, *, cancel_event = None, timeout = 10):
        location = parse_github_repository_url(url)
        self.assertIsNotNone(location)
        return _fetch_repository_from_remote(
            location,
            str(self.remote),
            timeout = timeout,
            cancel_event = cancel_event,
            git_executable = shutil.which("git"),
            allow_file_protocol = True,
        )

    def test_root_inspection_has_provenance_structure_and_useful_text(self):
        document = self._fetch("https://github.com/example/fixture?access_token=secret")
        self.assertEqual(document.title, "example/fixture")
        self.assertEqual(document.canonical_url, "https://github.com/example/fixture")
        self.assertEqual(document.commit, self.commit)
        self.assertEqual(
            document.pinned_url,
            f"https://github.com/example/fixture/tree/{self.commit}",
        )
        self.assertIn("README.md", document.markdown)
        self.assertIn("Fixture repository", document.markdown)
        self.assertIn("Fixture license text", document.markdown)
        self.assertIn("src/main.py", document.markdown)
        self.assertIn(f"large.txt: exceeds {MAX_FILE_BYTES:,} bytes", document.markdown)
        self.assertIn("readme-link [symbolic link; not followed]", document.markdown)
        self.assertNotIn("access_token", document.markdown)
        self.assertNotIn("secret", document.markdown)
        self.assertNotIn(str(self.root), document.markdown)

    def test_tree_scope_does_not_include_other_repository_content(self):
        document = self._fetch(
            "https://github.com/example/fixture/tree/main/docs?ignored=true"
        )
        self.assertEqual(document.path, "docs")
        self.assertIn("Tree-scoped fixture content", document.markdown)
        self.assertNotIn("Fixture repository", document.markdown)
        self.assertNotIn("src/main.py", document.markdown)

    def test_blob_scope_resolves_branch_names_containing_slashes(self):
        document = self._fetch(
            "https://github.com/example/fixture/blob/feature/slash/src/main.py"
        )
        self.assertEqual(document.ref, "feature/slash")
        self.assertEqual(document.path, "src/main.py")
        self.assertIn("return 42", document.markdown)
        self.assertNotIn("docs/guide.md", document.markdown)

    def test_symlink_blob_is_reported_but_never_followed(self):
        document = self._fetch(
            "https://github.com/example/fixture/blob/main/readme-link"
        )
        self.assertIn("symbolic link; not followed", document.markdown)
        self.assertIn("non-regular Git object", document.markdown)
        self.assertNotIn("Fixture repository", document.markdown)

    def test_oversized_blob_is_omitted_without_truncating_markdown(self):
        document = self._fetch(
            "https://github.com/example/fixture/blob/main/large.txt"
        )
        self.assertIn(f"large.txt: exceeds {MAX_FILE_BYTES:,} bytes", document.markdown)
        self.assertNotIn("x" * 1000, document.markdown)

    def test_pre_cancelled_fetch_never_starts_git(self):
        cancelled = threading.Event()
        cancelled.set()
        started = time.monotonic()
        with self.assertRaisesRegex(GitHubFetchError, "cancelled"):
            self._fetch(
                "https://github.com/example/fixture/tree/main/docs",
                cancel_event = cancelled,
            )
        self.assertLess(time.monotonic() - started, 1)


if __name__ == "__main__":
    unittest.main()
