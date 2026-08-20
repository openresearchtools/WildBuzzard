# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import html
import os
from pathlib import Path
import re
import secrets
import stat
from urllib.parse import parse_qsl, urlsplit

MAX_PAGE_CHARS = 16_000
FULL_MARKDOWN_MARKER = "BUZZARD_FULL_MARKDOWN_PATH="


def _private_directory(path: Path) -> Path:
    if path.is_symlink():
        raise RuntimeError(f"refusing symlink directory: {path}")
    path.mkdir(mode = 0o700, parents = True, exist_ok = True)
    path.chmod(0o700)
    status = path.stat()
    if status.st_uid != os.getuid() or stat.S_IMODE(status.st_mode) != 0o700:
        raise RuntimeError(f"unsafe private directory: {path}")
    return path.resolve()


def document_directory() -> Path:
    runtime = os.environ.get("XDG_RUNTIME_DIR")
    if runtime:
        runtime_root = Path(runtime)
        if not runtime_root.is_absolute() or runtime_root.is_symlink():
            raise RuntimeError("XDG_RUNTIME_DIR is unsafe")
        metadata = runtime_root.stat()
        if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.getuid():
            raise RuntimeError("XDG_RUNTIME_DIR is unsafe")
        root = runtime_root / "buzzard" / "search"
    else:
        owner = _private_directory(Path("/tmp") / f"buzzard-{os.getuid()}")
        root = owner / "search"
    return _private_directory(_private_directory(root) / "documents")


def _safe_title(title: str) -> str:
    value = html.unescape(title)
    value = re.sub(r"\s+", " ", value).strip()
    value = value.encode("ascii", "ignore").decode("ascii")
    value = re.sub(r"[^A-Za-z0-9]+", "-", value).strip("-.")
    return value or "page"


def title_for_document(markdown: str, source_url: str, preferred: str | None = None) -> str:
    parsed = urlsplit(source_url)
    match = re.search(r"(?m)^#{1,6}\s+(.+?)\s*$", markdown[:32_000])
    title = preferred or (match.group(1).strip(" #") if match else parsed.hostname or "page")
    for _, secret in parse_qsl(parsed.query, keep_blank_values = False):
        if secret:
            title = title.replace(secret, "redacted")
    return re.sub(r"\s+", " ", title).strip()


def write_markdown(title: str, markdown: str, output_directory: Path | None = None) -> Path:
    directory = _private_directory(output_directory) if output_directory else document_directory()
    suffix = f"--{secrets.token_hex(8)}.md"
    name_max = os.pathconf(directory, "PC_NAME_MAX")
    path_max = os.pathconf(directory, "PC_PATH_MAX")
    prefix_budget = min(
        120,
        name_max - len(suffix.encode()),
        path_max - len(os.fsencode(directory)) - len(suffix.encode()) - 1,
    )
    if prefix_budget < 1:
        raise RuntimeError("quick-search document path has no safe filename space")
    prefix = _safe_title(title)[:prefix_budget].rstrip("-.") or "page"
    filename = f"{prefix}{suffix}"
    directory_descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    descriptor = -1
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(filename, flags, 0o600, dir_fd = directory_descriptor)
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding = "utf-8", newline = "\n") as output:
            descriptor = -1
            output.write(markdown)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        os.close(directory_descriptor)
    path = directory / filename
    if len(os.fsencode(path)) >= path_max:
        raise RuntimeError("quick-search document path exceeded PATH_MAX")
    return path


def plain_text_with_path(content: str, path: str) -> str:
    return f"{content}\n\n{FULL_MARKDOWN_MARKER}{path}"
