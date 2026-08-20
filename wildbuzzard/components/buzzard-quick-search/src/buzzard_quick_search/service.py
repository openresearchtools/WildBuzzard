# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

from dataclasses import dataclass
import threading
from typing import Any

from ._upstream import search_runtime
from ._upstream.search_runtime import _truncate_page_text, _web_search
from ._upstream.web_access_policy import normalize_website_policy
from .artifacts import MAX_PAGE_CHARS, plain_text_with_path, title_for_document, write_markdown
from .github_repository import fetch_github_repository

PROVENANCE = {
    "component": "buzzard-quick-search",
    "version": "0.1.0",
    "upstream": {
        "name": "Unsloth Studio",
        "repository": "https://github.com/unslothai/unsloth.git",
        "commit": "bfcaea46574d63ec470ce9c7d7221471a38ea7e4",
        "license": "AGPL-3.0-only",
    },
    "searchProvider": {
        "name": "ddgs",
        "version": "9.14.4",
    },
    "resultContract": "unsloth-studio-web-search-v1",
}

_COMPLETE_PAGE_LIMIT = 8 * 1024 * 1024
_COMPLETE_FETCH_LOCK = threading.Lock()
_MAX_SEARCH_OUTPUT_CHARS = 64 * 1024


def _fetch_complete_page_text(
    source: str,
    *,
    timeout: int,
    website_policy: dict[str, Any] | None,
) -> str:
    with _COMPLETE_FETCH_LOCK:
        inline_limit = search_runtime._MAX_PAGE_CHARS
        search_runtime._MAX_PAGE_CHARS = _COMPLETE_PAGE_LIMIT
        try:
            return search_runtime._fetch_page_text(
                source,
                max_chars = _COMPLETE_PAGE_LIMIT,
                timeout = timeout,
                website_policy = website_policy,
            )
        finally:
            search_runtime._MAX_PAGE_CHARS = inline_limit


@dataclass(frozen = True)
class QuickSearchOutput:
    content: str
    full_markdown_path: str | None = None
    content_length: int | None = None

    @property
    def truncated(self) -> bool:
        return self.content_length is not None and self.content_length > MAX_PAGE_CHARS

    def as_text(self) -> str:
        if self.full_markdown_path is None:
            return self.content
        return plain_text_with_path(self.content, self.full_markdown_path)

    def as_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {"content": self.content, "provenance": PROVENANCE}
        if self.full_markdown_path is not None:
            result.update(
                {
                    "fullMarkdownPath": self.full_markdown_path,
                    "contentLength": self.content_length,
                    "truncated": self.truncated,
                }
            )
        return result


def _website_policy(
    allowed_domains: list[str] | None,
    blocked_domains: list[str] | None,
) -> dict[str, Any] | None:
    if not (allowed_domains or blocked_domains):
        return None
    return normalize_website_policy(
        {
            "allowedDomains": allowed_domains or [],
            "blockedDomains": blocked_domains or [],
        }
    )


def quick_search_output(
    query: str = "",
    *,
    url: str | None = None,
    max_results: int = 5,
    timeout: int = 300,
    allowed_domains: list[str] | None = None,
    blocked_domains: list[str] | None = None,
) -> QuickSearchOutput:
    if not isinstance(query, str) or len(query) > 512:
        raise ValueError("query must be a string of at most 512 characters")
    if url is not None and (not isinstance(url, str) or len(url) > 8192):
        raise ValueError("url must be a string of at most 8192 characters")
    if (
        not isinstance(max_results, int)
        or isinstance(max_results, bool)
        or not 1 <= max_results <= 20
    ):
        raise ValueError("max_results must be between 1 and 20")
    if not isinstance(timeout, int) or isinstance(timeout, bool) or not 1 <= timeout <= 300:
        raise ValueError("timeout must be between 1 and 300 seconds")
    policy = _website_policy(allowed_domains, blocked_domains)
    if url and url.strip():
        source = url.strip()
        github_document = fetch_github_repository(
            source,
            timeout = min(timeout, 60),
            website_policy = policy,
        )
        if github_document is not None:
            path = write_markdown(github_document.title, github_document.markdown)
            return QuickSearchOutput(
                content = _truncate_page_text(github_document.markdown, MAX_PAGE_CHARS),
                full_markdown_path = str(path),
                content_length = len(github_document.markdown),
            )
        full_markdown = _fetch_complete_page_text(
            source,
            timeout = min(timeout, 60),
            website_policy = policy,
        )
        title = title_for_document(full_markdown, source)
        path = write_markdown(title, full_markdown)
        return QuickSearchOutput(
            content = _truncate_page_text(full_markdown, MAX_PAGE_CHARS),
            full_markdown_path = str(path),
            content_length = len(full_markdown),
        )
    content = _web_search(
        query,
        max_results = max_results,
        timeout = timeout,
        website_policy = policy,
    )
    if len(content) > _MAX_SEARCH_OUTPUT_CHARS:
        content = content[:_MAX_SEARCH_OUTPUT_CHARS] + "\n\n... (search output truncated)"
    return QuickSearchOutput(content = content)


def quick_search(
    query: str = "",
    *,
    url: str | None = None,
    max_results: int = 5,
    timeout: int = 300,
    allowed_domains: list[str] | None = None,
    blocked_domains: list[str] | None = None,
) -> str:
    return quick_search_output(
        query,
        max_results = max_results,
        timeout = timeout,
        url = url,
        allowed_domains = allowed_domains,
        blocked_domains = blocked_domains,
    ).as_text()
