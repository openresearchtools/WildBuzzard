# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (c) 2025 Nico Bailon
# Modified by the Wild Buzzard Project in 2026: reimplemented the repository
# extraction design from agent/extensions/web-access/github.ts as a bounded
# Python Git-object inspector.

from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
import re
import selectors
import shutil
import signal
import stat
import subprocess
import tempfile
import threading
import time
import unicodedata
from urllib.parse import quote, unquote_to_bytes, urlsplit

from ._upstream.web_access_policy import hostname_allowed


MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024
MAX_TREE_OUTPUT_BYTES = 8 * 1024 * 1024
MAX_REPOSITORY_BYTES = 128 * 1024 * 1024
MAX_REPOSITORY_ENTRIES = 100_000
MAX_TREE_ENTRIES = 20_000
MAX_SELECTED_FILES = 128
MAX_FILE_BYTES = 512 * 1024
MAX_DOCUMENT_BYTES = 16 * 1024 * 1024
MAX_TREE_MARKDOWN_BYTES = 4 * 1024 * 1024
MAX_URL_BYTES = 8 * 1024
MAX_PATH_BYTES = 4 * 1024

GITHUB_FETCH_PROVENANCE = {
    "implementation": "buzzard-quick-search-git-object-inspector-v1",
    "derivedFrom": "agent/extensions/web-access/github.ts",
    "upstream": {
        "name": "pi-web-access",
        "copyright": "Copyright (c) 2025 Nico Bailon",
        "license": "AGPL-3.0-or-later",
    },
}

_NON_REPOSITORY_OWNERS = frozenset(
    {
        "about",
        "apps",
        "codespaces",
        "collections",
        "contact",
        "customer-stories",
        "dashboard",
        "discussions",
        "enterprise",
        "explore",
        "features",
        "issues",
        "join",
        "login",
        "marketplace",
        "new",
        "notifications",
        "organizations",
        "orgs",
        "pricing",
        "pulls",
        "search",
        "security",
        "settings",
        "signup",
        "site",
        "sponsors",
        "team",
        "topics",
        "trending",
    }
)
_OWNER_RE = re.compile(r"\A[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\Z")
_REPOSITORY_RE = re.compile(r"\A[A-Za-z0-9._-]{1,100}\Z")
_COMMIT_RE = re.compile(r"\A(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})\Z")
_REF_RE = re.compile(r"\A[A-Za-z0-9._/-]+\Z")
_TEXT_FILENAMES = frozenset(
    {
        ".dockerignore",
        ".editorconfig",
        ".gitattributes",
        ".gitignore",
        ".gitmodules",
        "authors",
        "changelog",
        "changes",
        "citation.cff",
        "code_of_conduct",
        "codeowners",
        "contributing",
        "copying",
        "dockerfile",
        "go.mod",
        "go.sum",
        "license",
        "makefile",
        "manifest.in",
        "notice",
        "readme",
        "security",
    }
)
_TEXT_EXTENSIONS = frozenset(
    {
        ".adoc",
        ".asm",
        ".bat",
        ".c",
        ".cc",
        ".cfg",
        ".cmake",
        ".conf",
        ".cpp",
        ".cs",
        ".css",
        ".csv",
        ".cxx",
        ".diff",
        ".editorconfig",
        ".fish",
        ".go",
        ".graphql",
        ".h",
        ".hh",
        ".hpp",
        ".htm",
        ".html",
        ".ini",
        ".java",
        ".js",
        ".json",
        ".json5",
        ".jsx",
        ".kt",
        ".kts",
        ".less",
        ".lua",
        ".m",
        ".md",
        ".mdx",
        ".mk",
        ".mjs",
        ".mm",
        ".php",
        ".pl",
        ".properties",
        ".proto",
        ".ps1",
        ".py",
        ".rb",
        ".rst",
        ".rs",
        ".sass",
        ".scala",
        ".scss",
        ".sh",
        ".sql",
        ".svelte",
        ".swift",
        ".tex",
        ".text",
        ".toml",
        ".ts",
        ".tsx",
        ".txt",
        ".vue",
        ".xml",
        ".yaml",
        ".yml",
        ".zig",
    }
)
_DEPRIORITIZED_DIRECTORIES = frozenset(
    {
        ".cache",
        ".git",
        ".hg",
        ".svn",
        "build",
        "coverage",
        "dist",
        "node_modules",
        "target",
        "vendor",
    }
)


class GitHubUrlError(ValueError):
    pass


class GitHubFetchError(RuntimeError):
    pass


class _CommandOutputLimit(GitHubFetchError):
    def __init__(self, partial_stdout: bytes):
        super().__init__("Git produced too much output")
        self.partial_stdout = partial_stdout


@dataclass(frozen=True)
class GitHubLocation:
    owner: str
    repository: str
    kind: str
    tail: tuple[str, ...]
    canonical_url: str


@dataclass(frozen=True)
class GitHubDocument:
    title: str
    markdown: str
    canonical_url: str
    pinned_url: str
    commit: str
    ref: str
    path: str
    provenance: str = "github-shallow-git"


@dataclass(frozen=True)
class _TreeEntry:
    mode: str
    object_type: str
    object_id: str
    path: str

    @property
    def is_regular_file(self) -> bool:
        return self.object_type == "blob" and self.mode in {"100644", "100755"}


def _decode_segment(value: str) -> str:
    try:
        decoded = unquote_to_bytes(value).decode("utf-8", "strict")
    except (UnicodeDecodeError, ValueError) as exc:
        raise GitHubUrlError("GitHub URL contains invalid path encoding") from exc
    if (
        not decoded
        or decoded in {".", ".."}
        or "/" in decoded
        or "\\" in decoded
        or any(ord(character) < 32 or ord(character) == 127 for character in decoded)
        or len(decoded.encode("utf-8")) > 255
    ):
        raise GitHubUrlError("GitHub URL contains an unsafe path segment")
    return decoded


def parse_github_repository_url(raw_url: str) -> GitHubLocation | None:
    if not isinstance(raw_url, str) or not raw_url:
        return None
    try:
        if len(raw_url.encode("utf-8")) > MAX_URL_BYTES:
            return None
    except UnicodeEncodeError as exc:
        raise GitHubUrlError("GitHub URL contains invalid Unicode") from exc
    if "\\" in raw_url or any(character.isspace() or ord(character) < 32 for character in raw_url):
        if "github.com" in raw_url.lower():
            raise GitHubUrlError("GitHub URL contains invalid characters")
        return None
    try:
        parsed = urlsplit(raw_url)
        hostname = (parsed.hostname or "").lower()
    except ValueError:
        return None
    if hostname != "github.com":
        return None
    if parsed.scheme.lower() != "https":
        raise GitHubUrlError("GitHub repository URLs must use HTTPS")
    if parsed.username is not None or parsed.password is not None or "%" in parsed.netloc:
        raise GitHubUrlError("GitHub repository URLs cannot contain credentials")
    try:
        if parsed.port is not None:
            raise GitHubUrlError("GitHub repository URLs cannot contain a port")
    except ValueError as exc:
        raise GitHubUrlError("GitHub repository URL has an invalid port") from exc

    raw_segments = [segment for segment in parsed.path.split("/") if segment]
    if len(raw_segments) < 2:
        return None
    segments = tuple(_decode_segment(segment) for segment in raw_segments)
    owner = segments[0]
    repository = re.sub(r"\.git\Z", "", segments[1], flags = re.IGNORECASE)
    if (
        not _OWNER_RE.fullmatch(owner)
        or owner.lower() in _NON_REPOSITORY_OWNERS
        or not _REPOSITORY_RE.fullmatch(repository)
        or repository in {".", ".."}
    ):
        return None

    kind = "repository"
    tail: tuple[str, ...] = ()
    if len(segments) > 2:
        if segments[2] not in {"tree", "blob"}:
            return None
        kind = segments[2]
        tail = segments[3:]
        if not tail or len(tail) > 256 or (kind == "blob" and len(tail) < 2):
            raise GitHubUrlError(f"GitHub {kind} URL is incomplete")
        if len("/".join(tail).encode("utf-8")) > MAX_PATH_BYTES:
            raise GitHubUrlError("GitHub repository path is too long")
        if _COMMIT_RE.fullmatch(tail[0]):
            tail = (tail[0].lower(), *tail[1:])

    encoded_tail = "/".join(quote(segment, safe = "-._~") for segment in tail)
    canonical_url = f"https://github.com/{owner}/{repository}"
    if kind != "repository":
        canonical_url += f"/{kind}/{encoded_tail}"
    return GitHubLocation(owner, repository, kind, tail, canonical_url)


def _valid_ref(value: str) -> bool:
    return bool(
        value
        and len(value.encode("utf-8")) <= 255
        and _REF_RE.fullmatch(value)
        and not value.startswith(("/", ".", "-"))
        and not value.endswith(("/", ".", ".lock"))
        and ".." not in value
        and "//" not in value
        and "@{" not in value
    )


def resolve_ref_and_path(
    location: GitHubLocation, advertised_refs: list[str]
) -> tuple[str, str]:
    if location.kind == "repository":
        return "HEAD", ""
    if _COMMIT_RE.fullmatch(location.tail[0]):
        return location.tail[0].lower(), "/".join(location.tail[1:])
    refs = {reference for reference in advertised_refs if _valid_ref(reference)}
    for length in range(len(location.tail), 0, -1):
        candidate = "/".join(location.tail[:length])
        if candidate in refs:
            path = "/".join(location.tail[length:])
            if location.kind == "blob" and not path:
                raise GitHubUrlError("GitHub blob URL must include a file path")
            return candidate, path
    raise GitHubFetchError("GitHub branch or tag could not be resolved")


def _find_git(git_executable: str | os.PathLike[str] | None) -> str:
    candidate = os.fspath(git_executable) if git_executable is not None else shutil.which("git")
    if not candidate:
        raise GitHubFetchError("Git is required to inspect GitHub repositories")
    resolved = os.path.realpath(candidate)
    try:
        metadata = os.stat(resolved)
    except OSError as exc:
        raise GitHubFetchError("Git is required to inspect GitHub repositories") from exc
    if not stat.S_ISREG(metadata.st_mode) or not os.access(resolved, os.X_OK):
        raise GitHubFetchError("Git is required to inspect GitHub repositories")
    return resolved


def _repository_usage(root: str) -> tuple[int, int]:
    total_bytes = 0
    entries = 0
    pending = [root]
    while pending:
        directory = pending.pop()
        try:
            children = os.scandir(directory)
        except OSError as exc:
            raise GitHubFetchError("GitHub temporary repository could not be inspected") from exc
        with children:
            for child in children:
                entries += 1
                if entries > MAX_REPOSITORY_ENTRIES:
                    raise GitHubFetchError("GitHub repository exceeds inspection limits")
                try:
                    child_stat = child.stat(follow_symlinks = False)
                except OSError as exc:
                    raise GitHubFetchError(
                        "GitHub temporary repository could not be inspected"
                    ) from exc
                if stat.S_ISDIR(child_stat.st_mode):
                    pending.append(child.path)
                elif stat.S_ISREG(child_stat.st_mode):
                    total_bytes += child_stat.st_size
                    if total_bytes > MAX_REPOSITORY_BYTES:
                        raise GitHubFetchError("GitHub repository exceeds inspection limits")
    return total_bytes, entries


class _GitRunner:
    def __init__(
        self,
        git: str,
        temporary_root: str,
        deadline: float,
        cancel_event: threading.Event | None,
        allow_file_protocol: bool,
    ) -> None:
        self.git = git
        self.temporary_root = temporary_root
        self.deadline = deadline
        self.cancel_event = cancel_event
        self.allow_file_protocol = allow_file_protocol
        self.home = os.path.join(temporary_root, "home")
        os.mkdir(self.home, 0o700)

    def _environment(self) -> dict[str, str]:
        return {
            "PATH": os.pathsep.join((os.path.dirname(self.git), "/usr/bin", "/bin")),
            "HOME": self.home,
            "XDG_CONFIG_HOME": self.home,
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_TERMINAL_PROMPT": "0",
            "GCM_INTERACTIVE": "Never",
            "GIT_ASKPASS": "/bin/false",
            "SSH_ASKPASS": "/bin/false",
            "GIT_LFS_SKIP_SMUDGE": "1",
            "GIT_LITERAL_PATHSPECS": "1",
            "GIT_ALLOW_PROTOCOL": "https:file" if self.allow_file_protocol else "https",
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
        }

    def _terminate(self, process: subprocess.Popen[bytes]) -> None:
        if process.poll() is not None:
            return
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        try:
            process.wait(timeout = 0.5)
            return
        except subprocess.TimeoutExpired:
            pass
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout = 1)
        except subprocess.TimeoutExpired:
            pass

    def run(
        self,
        arguments: list[str],
        *,
        cwd: str | None = None,
        output_limit: int = MAX_COMMAND_OUTPUT_BYTES,
    ) -> bytes:
        if self.cancel_event is not None and self.cancel_event.is_set():
            raise GitHubFetchError("GitHub repository inspection was cancelled")
        if time.monotonic() >= self.deadline:
            raise GitHubFetchError("GitHub repository inspection timed out")
        protocol = "always" if self.allow_file_protocol else "never"
        command = [
            self.git,
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "credential.helper=",
            "-c",
            "filter.lfs.smudge=",
            "-c",
            "filter.lfs.required=false",
            "-c",
            "submodule.recurse=false",
            "-c",
            f"protocol.file.allow={protocol}",
            "-c",
            "protocol.ext.allow=never",
            "--literal-pathspecs",
            *arguments,
        ]
        try:
            process = subprocess.Popen(
                command,
                cwd = cwd or self.temporary_root,
                env = self._environment(),
                stdin = subprocess.DEVNULL,
                stdout = subprocess.PIPE,
                stderr = subprocess.PIPE,
                start_new_session = True,
            )
        except OSError as exc:
            raise GitHubFetchError("Git could not be started") from exc
        assert process.stdout is not None
        assert process.stderr is not None
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ, "stdout")
        selector.register(process.stderr, selectors.EVENT_READ, "stderr")
        stdout = bytearray()
        stderr_bytes = 0
        next_disk_check = time.monotonic()
        failure: GitHubFetchError | None = None
        try:
            while selector.get_map() or process.poll() is None:
                for key, _events in selector.select(0.05):
                    try:
                        chunk = os.read(key.fileobj.fileno(), 64 * 1024)
                    except OSError:
                        chunk = b""
                    if not chunk:
                        selector.unregister(key.fileobj)
                        key.fileobj.close()
                        continue
                    if key.data == "stdout":
                        remaining = output_limit + 1 - len(stdout)
                        if remaining > 0:
                            stdout.extend(chunk[:remaining])
                        if len(stdout) > output_limit or len(chunk) > remaining:
                            failure = _CommandOutputLimit(bytes(stdout[:output_limit]))
                    else:
                        stderr_bytes += len(chunk)
                        if stderr_bytes > MAX_COMMAND_OUTPUT_BYTES:
                            failure = GitHubFetchError("Git produced too much diagnostic output")
                now = time.monotonic()
                if self.cancel_event is not None and self.cancel_event.is_set():
                    failure = GitHubFetchError("GitHub repository inspection was cancelled")
                elif now >= self.deadline:
                    failure = GitHubFetchError("GitHub repository inspection timed out")
                elif now >= next_disk_check:
                    try:
                        _repository_usage(self.temporary_root)
                    except GitHubFetchError as exc:
                        failure = exc
                    next_disk_check = now + 0.25
                if failure is not None:
                    self._terminate(process)
                    break
            if failure is not None:
                raise failure
            return_code = process.wait(timeout = 1)
            if return_code != 0:
                raise GitHubFetchError("Git operation failed")
            _repository_usage(self.temporary_root)
            return bytes(stdout)
        finally:
            selector.close()
            self._terminate(process)
            for stream in (process.stdout, process.stderr):
                if not stream.closed:
                    stream.close()


def _advertised_refs(output: bytes) -> list[str]:
    references: list[str] = []
    for line in output.decode("utf-8", "replace").splitlines():
        match = re.fullmatch(
            r"(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})\trefs/(?:heads|tags)/(.+?)(?:\^\{\})?",
            line,
        )
        if match and _valid_ref(match.group(1)) and match.group(1) not in references:
            references.append(match.group(1))
    return references


def _parse_tree(output: bytes) -> tuple[list[_TreeEntry], bool]:
    entries: list[_TreeEntry] = []
    truncated = not output.endswith(b"\0") and bool(output)
    records = output.split(b"\0")
    for index, record in enumerate(records):
        if not record:
            continue
        if index == len(records) - 1 and truncated:
            break
        try:
            metadata, raw_path = record.split(b"\t", 1)
            mode, object_type, object_id = metadata.decode("ascii").split(" ", 2)
        except (ValueError, UnicodeDecodeError):
            raise GitHubFetchError("Git returned an invalid repository tree")
        if (
            not re.fullmatch(r"[0-7]{6}", mode)
            or object_type not in {"blob", "commit", "tree"}
            or not _COMMIT_RE.fullmatch(object_id)
        ):
            raise GitHubFetchError("Git returned an invalid repository tree")
        entries.append(
            _TreeEntry(mode, object_type, object_id.lower(), raw_path.decode("utf-8", "replace"))
        )
        if len(entries) >= MAX_TREE_ENTRIES:
            truncated = True
            break
    return entries, truncated


def _inline_code(value: str) -> str:
    longest = max((len(match.group(0)) for match in re.finditer(r"`+", value)), default = 0)
    fence = "`" * max(1, longest + 1)
    padding = " " if value.startswith("`") or value.endswith("`") else ""
    return f"{fence}{padding}{value}{padding}{fence}"


def _display_path(value: str) -> str:
    return "".join(
        character
        if character != "`" and not unicodedata.category(character).startswith("C")
        else f"\\u{ord(character):04x}"
        for character in value
    )


def _code_block(value: str) -> str:
    longest = max((len(match.group(0)) for match in re.finditer(r"`+", value)), default = 0)
    fence = "`" * max(4, longest + 1)
    return f"{fence}\n{value}\n{fence}"


def _is_text_candidate(path: str) -> bool:
    name = Path(path).name.lower()
    stem = name.split(".", 1)[0]
    return (
        name in _TEXT_FILENAMES
        or stem in _TEXT_FILENAMES
        or Path(name).suffix in _TEXT_EXTENSIONS
    )


def _selection_priority(entry: _TreeEntry) -> tuple[int, int, str]:
    path = entry.path
    parts = path.lower().split("/")
    name = parts[-1]
    stem = name.split(".", 1)[0]
    depth = len(parts)
    if stem in {"readme", "license", "copying", "notice"}:
        priority = 0 if depth == 1 else 1
    elif depth == 1:
        priority = 2
    elif "docs" in parts[:-1] and Path(name).suffix in {".md", ".mdx", ".rst", ".txt", ".adoc"}:
        priority = 3
    elif any(part in _DEPRIORITIZED_DIRECTORIES for part in parts[:-1]):
        priority = 6
    else:
        priority = 4
    return priority, depth, path.casefold()


def _decode_text(data: bytes) -> str | None:
    if b"\0" in data[:8192]:
        return None
    text = data.decode("utf-8", "replace")
    replacements = text.count("\ufffd")
    controls = sum(ord(character) < 32 and character not in "\t\n\r" for character in text)
    if replacements + controls > max(16, len(text) // 8):
        return None
    return text


def _bounded_title(location: GitHubLocation, requested_path: str) -> str:
    title = f"{location.owner}/{location.repository}"
    if requested_path:
        title += f" — {requested_path}"
    if len(title) <= 200:
        return title
    return title[:196].rstrip() + " ..."


def _pinned_url(location: GitHubLocation, commit: str, requested_path: str) -> str:
    root = f"https://github.com/{location.owner}/{location.repository}"
    if not requested_path:
        return f"{root}/tree/{commit}"
    encoded = "/".join(quote(segment, safe = "-._~") for segment in requested_path.split("/"))
    return f"{root}/{location.kind}/{commit}/{encoded}"


def _render_document(
    runner: _GitRunner,
    checkout: str,
    location: GitHubLocation,
    ref: str,
    requested_path: str,
    commit: str,
    entries: list[_TreeEntry],
    tree_truncated: bool,
) -> GitHubDocument:
    pinned_url = _pinned_url(location, commit, requested_path)
    title = _bounded_title(location, requested_path)
    scope = requested_path or "/"
    sections = [
        f"# GitHub repository: {_inline_code(_display_path(title))}",
        "\n".join(
            (
                f"- Source: {location.canonical_url}",
                f"- Immutable source: {pinned_url}",
                f"- Commit: `{commit}`",
                f"- Requested ref: `{ref}`",
                f"- Requested scope: {_inline_code(scope)}",
                "- Retrieval: bounded shallow Git fetch; file contents are untrusted",
            )
        ),
    ]

    tree_lines = ["## Repository structure", "", "```text"]
    tree_bytes = sum(len(line.encode("utf-8")) + 1 for line in tree_lines)
    manifest_truncated = tree_truncated
    for entry in entries:
        suffix = ""
        if entry.mode == "120000":
            suffix = " [symbolic link; not followed]"
        elif entry.object_type == "commit":
            suffix = " [Git submodule; not fetched]"
        line = f"{_display_path(entry.path)}{suffix}"
        line_bytes = len(line.encode("utf-8")) + 1
        if tree_bytes + line_bytes > MAX_TREE_MARKDOWN_BYTES:
            manifest_truncated = True
            break
        tree_lines.append(line)
        tree_bytes += line_bytes
    if manifest_truncated:
        tree_lines.append("... [repository structure limited by deterministic inspection bounds]")
    tree_lines.append("```")
    sections.append("\n".join(tree_lines))
    document_bytes = len("\n\n".join(sections).encode("utf-8"))

    if location.kind == "blob":
        selected = [entry for entry in entries if entry.path == requested_path]
    else:
        selected = sorted(
            (
                entry
                for entry in entries
                if entry.is_regular_file and _is_text_candidate(entry.path)
            ),
            key = _selection_priority,
        )[:MAX_SELECTED_FILES]

    omitted: list[str] = []
    for entry in selected:
        if not entry.is_regular_file:
            omitted.append(f"{_display_path(entry.path)}: non-regular Git object")
            continue
        try:
            raw_content = runner.run(
                ["cat-file", "blob", entry.object_id],
                cwd = checkout,
                output_limit = MAX_FILE_BYTES + 1,
            )
        except _CommandOutputLimit:
            omitted.append(f"{_display_path(entry.path)}: exceeds {MAX_FILE_BYTES:,} bytes")
            continue
        if len(raw_content) > MAX_FILE_BYTES:
            omitted.append(f"{_display_path(entry.path)}: exceeds {MAX_FILE_BYTES:,} bytes")
            continue
        content = _decode_text(raw_content)
        if content is None:
            omitted.append(f"{_display_path(entry.path)}: binary or undecodable content")
            continue
        section = f"## File: {_inline_code(_display_path(entry.path))}\n\n{_code_block(content)}"
        section_bytes = len(section.encode("utf-8")) + 2
        if document_bytes + section_bytes > MAX_DOCUMENT_BYTES:
            omitted.append(f"{_display_path(entry.path)}: document size limit reached")
            continue
        sections.append(section)
        document_bytes += section_bytes

    if omitted:
        omission_lines = ["## Omitted file contents", ""]
        omission_lines.extend(f"- {_inline_code(value)}" for value in omitted)
        omission_section = "\n".join(omission_lines)
        if document_bytes + len(omission_section.encode("utf-8")) + 2 <= MAX_DOCUMENT_BYTES:
            sections.append(omission_section)

    return GitHubDocument(
        title = title,
        markdown = "\n\n".join(sections),
        canonical_url = location.canonical_url,
        pinned_url = pinned_url,
        commit = commit,
        ref = ref,
        path = requested_path,
    )


def _fetch_repository_from_remote(
    location: GitHubLocation,
    remote_url: str,
    *,
    timeout: int,
    cancel_event: threading.Event | None,
    git_executable: str | os.PathLike[str] | None,
    allow_file_protocol: bool = False,
) -> GitHubDocument:
    git = _find_git(git_executable)
    deadline = time.monotonic() + timeout
    with tempfile.TemporaryDirectory(prefix = "wildbuzzard-github-") as temporary_root:
        os.chmod(temporary_root, 0o700)
        runner = _GitRunner(git, temporary_root, deadline, cancel_event, allow_file_protocol)
        try:
            references: list[str] = []
            if location.kind != "repository" and not _COMMIT_RE.fullmatch(location.tail[0]):
                references = _advertised_refs(
                    runner.run(["ls-remote", "--heads", "--tags", remote_url])
                )
            ref, requested_path = resolve_ref_and_path(location, references)
            checkout = os.path.join(temporary_root, "repository")
            runner.run(["init", "--quiet", "--initial-branch=wildbuzzard", checkout])
            runner.run(["remote", "add", "origin", remote_url], cwd = checkout)
            runner.run(
                [
                    "fetch",
                    "--quiet",
                    "--depth=1",
                    f"--filter=blob:limit={MAX_FILE_BYTES + 1}",
                    "--no-tags",
                    "--no-recurse-submodules",
                    "origin",
                    ref,
                ],
                cwd = checkout,
            )
            commit = runner.run(
                ["rev-parse", "--verify", "FETCH_HEAD^{commit}"], cwd = checkout
            ).decode("ascii", "strict").strip().lower()
            if not _COMMIT_RE.fullmatch(commit):
                raise GitHubFetchError("Git returned an invalid commit identity")
            if _COMMIT_RE.fullmatch(ref) and ref.lower() != commit:
                raise GitHubFetchError("Git returned an unexpected commit identity")

            if requested_path:
                direct_output = runner.run(
                    ["ls-tree", "-z", commit, "--", requested_path], cwd = checkout
                )
                direct_entries, _unused = _parse_tree(direct_output)
                direct = next(
                    (entry for entry in direct_entries if entry.path == requested_path),
                    None,
                )
                if direct is None:
                    raise GitHubFetchError("Requested GitHub path does not exist")
                if location.kind == "tree" and direct.object_type != "tree":
                    raise GitHubFetchError("Requested GitHub tree path is not a directory")
                if location.kind == "blob" and direct.object_type != "blob":
                    raise GitHubFetchError("Requested GitHub blob path is not a file")

            tree_arguments = ["ls-tree", "-rz", "--full-tree", commit]
            if requested_path:
                tree_arguments.extend(("--", requested_path))
            try:
                tree_output = runner.run(
                    tree_arguments, cwd = checkout, output_limit = MAX_TREE_OUTPUT_BYTES
                )
                output_truncated = False
            except _CommandOutputLimit as exc:
                tree_output = exc.partial_stdout
                output_truncated = True
            entries, parse_truncated = _parse_tree(tree_output)
            if not entries:
                raise GitHubFetchError("Requested GitHub scope contains no inspectable files")
            if location.kind == "blob":
                exact = [entry for entry in entries if entry.path == requested_path]
                if len(exact) != 1:
                    raise GitHubFetchError("Requested GitHub blob path is not inspectable")
                entries = exact
            return _render_document(
                runner,
                checkout,
                location,
                ref,
                requested_path,
                commit,
                entries,
                output_truncated or parse_truncated,
            )
        except UnicodeDecodeError as exc:
            raise GitHubFetchError("Git returned invalid repository metadata") from exc
        except GitHubFetchError:
            raise
        except (OSError, ValueError, subprocess.SubprocessError) as exc:
            raise GitHubFetchError("GitHub repository inspection failed") from exc


def fetch_github_repository(
    url: str,
    *,
    timeout: int = 60,
    website_policy: dict | None = None,
    cancel_event: threading.Event | None = None,
) -> GitHubDocument | None:
    location = parse_github_repository_url(url)
    if location is None:
        return None
    if not isinstance(timeout, int) or isinstance(timeout, bool) or not 1 <= timeout <= 300:
        raise ValueError("timeout must be an integer from 1 to 300 seconds")
    if not hostname_allowed("github.com", website_policy):
        raise GitHubFetchError("Website access policy disallows github.com")
    remote_url = f"https://github.com/{location.owner}/{location.repository}.git"
    try:
        return _fetch_repository_from_remote(
            location,
            remote_url,
            timeout = timeout,
            cancel_event = cancel_event,
            git_executable = None,
        )
    except GitHubFetchError as exc:
        message = str(exc)
        if message in {
            "GitHub repository inspection was cancelled",
            "GitHub repository inspection timed out",
            "Git is required to inspect GitHub repositories",
            "Website access policy disallows github.com",
        } or message.startswith("Requested GitHub") or message.startswith(
            "GitHub repository exceeds"
        ):
            raise GitHubFetchError(message) from None
        raise GitHubFetchError("GitHub repository is unavailable or is not public") from None


__all__ = [
    "GITHUB_FETCH_PROVENANCE",
    "GitHubDocument",
    "GitHubFetchError",
    "GitHubLocation",
    "GitHubUrlError",
    "fetch_github_repository",
    "parse_github_repository_url",
    "resolve_ref_and_path",
]
