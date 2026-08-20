# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import pathlib
import stat
import tempfile
import tomllib
import unittest
from dataclasses import dataclass


COMPONENT_ROOT = pathlib.Path(__file__).parents[1]
SOURCE_ROOT = COMPONENT_ROOT.parents[1]
MODULE_PATH = COMPONENT_ROOT / "src" / "buzzard_youtube_transcript.py"
VENDOR_ROOT = (
    SOURCE_ROOT / "third_party" / "mit" / "youtube-transcript-api"
)
SPEC = importlib.util.spec_from_file_location("buzzard_youtube_transcript", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


@dataclass
class FakeSnippet:
    text: str
    start: float
    duration: float


class FakeFetchedTranscript(list[FakeSnippet]):
    video_id = "dQw4w9WgXcQ"
    language = "English"
    language_code = "en"
    is_generated = False


class FakeApi:
    def __init__(self, snippets: list[FakeSnippet] | None = None) -> None:
        self.snippets = snippets or [
            FakeSnippet("First <line>", 1.25, 2.0),
            FakeSnippet("Second\nline", 61.9996, 1.0),
        ]
        self.calls: list[tuple[object, ...]] = []

    def fetch(
        self,
        video_id: str,
        *,
        languages: tuple[str, ...],
        preserve_formatting: bool,
    ) -> FakeFetchedTranscript:
        self.calls.append((video_id, languages, preserve_formatting))
        return FakeFetchedTranscript(self.snippets)


class YouTubeInputTest(unittest.TestCase):
    def test_common_inputs_canonicalize(self) -> None:
        expected_id = "dQw4w9WgXcQ"
        expected_url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        inputs = [
            expected_id,
            "https://youtube.com/watch?v=dQw4w9WgXcQ&t=10#chapter",
            "https://www.youtube.com/watch/?list=PL123&v=dQw4w9WgXcQ",
            "https://youtu.be/dQw4w9WgXcQ?si=tracking#fragment",
            "https://m.youtube.com/shorts/dQw4w9WgXcQ?feature=share",
            "https://youtube.com/embed/dQw4w9WgXcQ/",
            "http://music.youtube.com/live/dQw4w9WgXcQ?app=desktop",
            "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
        ]
        for source in inputs:
            with self.subTest(source=source):
                self.assertEqual(
                    MODULE.canonicalize_youtube_input(source),
                    (expected_id, expected_url),
                )

    def test_invalid_and_credentialed_inputs_are_rejected(self) -> None:
        inputs = [
            "",
            "dQw4w9WgXc",
            "dQw4w9WgXcQx",
            "https://example.com/watch?v=dQw4w9WgXcQ",
            "https://youtube.com.example/watch?v=dQw4w9WgXcQ",
            "https://user@youtube.com/watch?v=dQw4w9WgXcQ",
            "https://user:secret@youtube.com/watch?v=dQw4w9WgXcQ",
            "https://youtube.com:443/watch?v=dQw4w9WgXcQ",
            "https://youtube.com/playlist?list=PL123",
            "https://youtube.com/watch?list=PL123",
            "https://youtube.com/watch?v=dQw4w9WgXcQ&v=aaaaaaaaaaa",
            "https://youtu.be/dQw4w9WgXcQ/extra",
            "ftp://youtube.com/watch?v=dQw4w9WgXcQ",
            "//youtube.com/watch?v=dQw4w9WgXcQ",
        ]
        for source in inputs:
            with self.subTest(source=source):
                with self.assertRaises(MODULE.InvalidYouTubeInput):
                    MODULE.canonicalize_youtube_input(source)


class TranscriptOutputTest(unittest.TestCase):
    def test_complete_private_markdown_and_metadata(self) -> None:
        api = FakeApi()
        with tempfile.TemporaryDirectory() as temporary_directory:
            directory = pathlib.Path(temporary_directory)
            directory.chmod(0o755)
            result = MODULE.fetch_youtube_transcript(
                "https://youtube.com/watch?v=dQw4w9WgXcQ&token=do-not-copy",
                output_directory=directory,
                languages=["de", "en", "en"],
                api=api,
                title_fetcher=lambda _: "../A <script> / Пример [video]",
            )

            output_path = pathlib.Path(str(result["path"]))
            markdown = output_path.read_text(encoding="utf-8")
            self.assertTrue(output_path.is_absolute())
            self.assertEqual(output_path.parent, directory.resolve())
            self.assertNotIn("..", output_path.name)
            self.assertNotIn("do-not-copy", json.dumps(result))
            self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(output_path.stat().st_mode), 0o600)
            self.assertEqual(
                result["url"], "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
            )
            self.assertEqual(
                result["language"],
                {"name": "English", "code": "en", "generated": False},
            )
            self.assertEqual(result["segment_count"], 2)
            self.assertEqual(result["content"], markdown)
            self.assertEqual(result["content_length"], len(markdown))
            self.assertFalse(result["truncated"])
            self.assertIn("&lt;script&gt;", markdown)
            self.assertNotIn("<script>", markdown)
            self.assertIn("**00:00:01.250**", markdown)
            self.assertIn("**00:01:02.000**", markdown)
            self.assertIn("First &lt;line&gt;", markdown)
            self.assertIn("Second\n    line", markdown)
            self.assertEqual(api.calls, [("dQw4w9WgXcQ", ("de", "en"), False)])

    def test_inline_content_is_truncated_but_file_is_complete(self) -> None:
        ending = "THE-COMPLETE-END"
        long_text = "x" * 17_000 + ending
        with tempfile.TemporaryDirectory() as temporary_directory:
            result = MODULE.fetch_youtube_transcript(
                "dQw4w9WgXcQ",
                output_directory=pathlib.Path(temporary_directory),
                api=FakeApi([FakeSnippet(long_text, 0, 1)]),
                title_fetcher=lambda _: "Long transcript",
            )
            full_content = pathlib.Path(str(result["path"])).read_text(encoding="utf-8")
            inline_content = str(result["content"])
            self.assertTrue(result["truncated"])
            self.assertEqual(inline_content[:16_000], full_content[:16_000])
            self.assertIn("... (truncated,", inline_content)
            self.assertTrue(full_content.rstrip().endswith(ending))
            self.assertEqual(result["content_length"], len(full_content))

    def test_missing_title_uses_bounded_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            result = MODULE.fetch_youtube_transcript(
                "dQw4w9WgXcQ",
                output_directory=pathlib.Path(temporary_directory),
                api=FakeApi(),
                title_fetcher=lambda _: None,
            )
            self.assertEqual(result["title"], "YouTube video dQw4w9WgXcQ")
            self.assertLessEqual(
                len(pathlib.Path(str(result["path"])).name.encode()), 95
            )

    def test_relative_output_and_invalid_languages_are_rejected(self) -> None:
        with self.assertRaises(MODULE.YouTubeTranscriptError):
            MODULE.fetch_youtube_transcript(
                "dQw4w9WgXcQ",
                output_directory=pathlib.Path("relative"),
                api=FakeApi(),
                title_fetcher=lambda _: "Title",
            )
        with tempfile.TemporaryDirectory() as temporary_directory:
            with self.assertRaises(MODULE.InvalidYouTubeInput):
                MODULE.fetch_youtube_transcript(
                    "dQw4w9WgXcQ",
                    output_directory=pathlib.Path(temporary_directory),
                    languages=["../../etc"],
                    api=FakeApi(),
                    title_fetcher=lambda _: "Title",
                )

    def test_http_session_does_not_use_environment_proxies(self) -> None:
        previous = os.environ.get("HTTPS_PROXY")
        os.environ["HTTPS_PROXY"] = "http://127.0.0.1:9"
        try:
            session = MODULE._new_http_session()
            self.assertFalse(session.trust_env)
            self.assertEqual(session.proxies, {})
            session.close()
        finally:
            if previous is None:
                os.environ.pop("HTTPS_PROXY", None)
            else:
                os.environ["HTTPS_PROXY"] = previous


class YouTubeDependencyProvenanceTest(unittest.TestCase):
    def test_pinned_release_and_license(self) -> None:
        metadata = tomllib.loads((VENDOR_ROOT / "UPSTREAM.toml").read_text())
        self.assertEqual(metadata["version"], "1.2.4")
        self.assertEqual(
            metadata["commit"], "505f412a5a691cc1bac6430dd35144222c667598"
        )
        self.assertEqual(metadata["license"], "MIT")
        self.assertEqual(
            metadata["pypi"]["sdist_sha256"],
            "b72d0e96a335df599d67cee51d49e143cff4f45b84bcafc202ff51291603ddcd",
        )
        license_bytes = (VENDOR_ROOT / "upstream" / "LICENSE").read_bytes()
        self.assertEqual(
            hashlib.sha256(license_bytes).hexdigest(),
            metadata["license_sha256"],
        )
        self.assertIn(b"Copyright (c) 2018 Jonas Depoix", license_bytes)

    def test_pristine_source_manifest(self) -> None:
        entries = (VENDOR_ROOT / "SOURCE-MANIFEST.sha256").read_text().splitlines()
        self.assertEqual(len(entries), 35)
        for entry in entries:
            digest, relative_path = entry.split("  ", 1)
            source_file = VENDOR_ROOT / relative_path
            self.assertTrue(source_file.is_file(), relative_path)
            self.assertEqual(
                hashlib.sha256(source_file.read_bytes()).hexdigest(), digest
            )


if __name__ == "__main__":
    unittest.main()
