# SPDX-License-Identifier: AGPL-3.0-only
# Copyright 2026-present the Unsloth AI Inc. team. All rights reserved.
# Modified by the Wild Buzzard Project in 2026: extracted the web-search and page-fetch implementation into a standalone package; adjusted package-local imports and logging.

from __future__ import annotations

import codecs
import http.client
import logging
import os
import queue
import random
import re
import ssl
import threading
import time
import urllib.parse
import urllib.request

logger = logging.getLogger(__name__)

_EXEC_TIMEOUT = 300
_POLICY_OVERFETCH = 4
_DISABLE_DNS_PINNING_ENV = "UNSLOTH_STUDIO_DISABLE_DNS_PINNING"
EMPTY_SEARCH_RESULTS = (
    "No results found.",
    "No results found within the website access limits.",
)
_DDGS_EMPTY_SWEEP = "No results found"

_MAX_PAGE_CHARS = 16000  # cap fetched page text (after HTML-to-MD conversion)
# Raw download cap > _MAX_PAGE_CHARS since SSR pages embed large <head> sections
# stripped during conversion; 512 KB still reaches article content.
_MAX_FETCH_BYTES = 512 * 1024
# PDF cross-reference data lives at EOF, so extraction needs the whole body.
_MAX_PDF_FETCH_BYTES = 10 * 1024 * 1024
_MAX_WEB_PDF_PAGES = 50
# Control/undecodable chars, excluding text whitespace and ESC (for ANSI logs).
# Binary when they exceed 12.5%, after allowing 16 minor encoding glitches.
_BINARY_CHAR_RE = re.compile("[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1a\\x1c-\\x1f\\x7f-\\x9f\\ufffd]")
_MIN_BINARY_CHARS = 16
_BINARY_CHAR_DIVISOR = 8
# Common binary signatures that can otherwise look text-heavy when mislabeled.
_PDF_MAGIC = b"%PDF-"
_BINARY_MAGIC = (
    _PDF_MAGIC,
    b"PK\x03\x04",  # zip / docx / xlsx / pptx / epub / jar
    b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1",  # OLE / legacy Office
    b"\x89PNG\r\n\x1a\n",  # PNG
    b"\xff\xd8\xff",  # JPEG
    b"GIF87a",
    b"GIF89a",
    b"\x1f\x8b",  # gzip
    b"BZh",  # bzip2
    b"\xfd7zXZ\x00",  # xz
    b"\x28\xb5\x2f\xfd",  # zstd
)

# Check UTF-32 first because its little-endian BOM starts with the UTF-16 BOM.
_UNICODE_BOM_CODECS = (
    (codecs.BOM_UTF32_LE, "utf-32"),
    (codecs.BOM_UTF32_BE, "utf-32"),
    (codecs.BOM_UTF16_LE, "utf-16"),
    (codecs.BOM_UTF16_BE, "utf-16"),
    (codecs.BOM_UTF8, "utf-8-sig"),
)

# A cp1252 retry needs 75% ASCII structure so it cannot rescue high-byte binary.
_MIN_SINGLE_BYTE_ASCII_RATIO = 3 / 4
_ASCII_TEXT_BYTES = frozenset((*range(0x20, 0x7F), 0x09, 0x0A, 0x0D, 0x1B))


def _looks_binary(text: str) -> bool:
    """Whether control or undecodable characters exceed the binary threshold."""
    return len(_BINARY_CHAR_RE.findall(text)) > max(
        _MIN_BINARY_CHARS, len(text) // _BINARY_CHAR_DIVISOR
    )


def _magic_head(data: bytes) -> bytes:
    head = data[:1024].lstrip()
    for bom, _codec in _UNICODE_BOM_CODECS:
        if head.startswith(bom):
            head = head.removeprefix(bom).lstrip()
            break
    return head


def _has_pdf_magic(data: bytes) -> bool:
    return _magic_head(data).startswith(_PDF_MAGIC)


def _has_binary_magic(data: bytes) -> bool:
    """Whether a common binary signature follows optional BOM or whitespace."""
    return _magic_head(data).startswith(_BINARY_MAGIC)


def _has_single_byte_text_evidence(data: bytes) -> bool:
    """True when *data* has enough ASCII structure for a cp1252 text retry."""
    if not data:
        return True
    ascii_text_bytes = sum(byte in _ASCII_TEXT_BYTES for byte in data)
    return ascii_text_bytes / len(data) >= _MIN_SINGLE_BYTE_ASCII_RATIO


def _extract_pdf_text(data: bytes) -> str:
    """Extract page-delimited text with the same parser used by RAG ingestion."""
    from ._rag.parsers import parse_pdf_bytes

    pages, total_pages = parse_pdf_bytes(data, max_pages = _MAX_WEB_PDF_PAGES)
    page_limit_reached = total_pages > _MAX_WEB_PDF_PAGES
    parts: list[str] = []
    length = 0
    text_limited = False
    for page in pages:
        page_text = page.text.strip()
        if not page_text:
            continue
        section = f"## Page {page.page_number}\n\n{page_text}"
        piece = ("\n\n" if parts else "") + section
        remaining = _MAX_PAGE_CHARS - length
        if len(piece) > remaining:
            parts.append(piece[:remaining])
            text_limited = True
            break
        parts.append(piece)
        length += len(piece)

    text = "".join(parts).rstrip()
    if not text:
        if page_limit_reached:
            return f"(PDF contains no extractable text in the first {_MAX_WEB_PDF_PAGES} pages)"
        return ""
    limits = []
    if text_limited:
        limits.append(f"text limited to {_MAX_PAGE_CHARS:,} characters")
    if page_limit_reached:
        limits.append(f"page processing capped at {_MAX_WEB_PDF_PAGES} pages")
    if limits:
        marker = f"\n\n... (PDF extraction {'; '.join(limits)})"
        text = text[: _MAX_PAGE_CHARS - len(marker)].rstrip() + marker
    return text


_USER_AGENTS = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15",
)

_tls_ctx = ssl.create_default_context()


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    """HTTPS connection to a pinned IP, using a different hostname for SNI and
    cert verification.

    SSRF IP-pinning rewrites URLs to raw IPs; a normal HTTPSConnection would then
    send no SNI and verify the cert against the IP (both fail). This splits the
    concerns: TCP connects to the pinned IP (``host``), TLS uses ``sni_hostname``.
    """

    def __init__(self, host: str, *, sni_hostname: str, **kwargs):
        super().__init__(host, **kwargs)
        self._sni_hostname = sni_hostname

    def connect(self):
        # TCP connect to the pinned IP in self.host.
        http.client.HTTPConnection.connect(self)
        # TLS handshake with the real hostname for SNI + cert verification.
        self.sock = self._context.wrap_socket(
            self.sock,
            server_hostname = self._sni_hostname,
        )


class _SNIHTTPSHandler(urllib.request.HTTPSHandler):
    """HTTPS handler sending the correct SNI hostname during TLS handshake.

    SSRF IP-pinning breaks SNI and cert verification; this returns a
    ``_PinnedHTTPSConnection`` that connects to the pinned IP but verifies TLS
    against the original hostname.
    """

    def __init__(self, hostname: str):
        super().__init__(context = _tls_ctx)
        self._sni_hostname = hostname

    def https_open(self, req):
        return self.do_open(self._sni_connection, req)

    def _sni_connection(self, host, **kwargs):
        kwargs["context"] = _tls_ctx
        return _PinnedHTTPSConnection(host, sni_hostname = self._sni_hostname, **kwargs)


def _explicit_proxy_applies(scheme: str, host: str) -> bool:
    """Whether urllib routes a *scheme* request for *host* through a proxy.

    Only a proxied fetch may keep the hostname in the request URL: the proxy
    resolves it, so this host never looks it up again. A direct one would, which
    is the DNS-rebinding window, so it stays pinned to the validated IP.

    *host* must be the ``host[:port]`` form ``Request.host`` carries, since that
    is what ``ProxyHandler`` passes to ``proxy_bypass``; probing the bare hostname
    instead would disagree with it on a port-qualified NO_PROXY entry.
    """
    from urllib.request import getproxies, proxy_bypass

    # ProxyHandler lowercases every mapping key, and the Windows registry can hand
    # back "HTTPS=...", so normalize before testing or a proxy-only host goes direct.
    if scheme not in {key.lower() for key in getproxies()}:
        return False
    try:
        return not proxy_bypass(host)
    except (OSError, ValueError):
        # proxy_bypass reads system config on macOS/Windows; failure falls back to pinning.
        return False


def _validate_and_resolve_host(hostname: str, port: int) -> tuple[bool, str, str]:
    """Resolve *hostname*, reject non-public IPs, return a pinned IP string.

    Returns ``(ok, reason_or_empty, resolved_ip)``. The caller should connect
    to *resolved_ip* (with a ``Host`` header) to prevent DNS rebinding between
    validation and the actual fetch.
    """
    import ipaddress
    import socket

    try:
        infos = socket.getaddrinfo(hostname, port, type = socket.SOCK_STREAM)
    except (OSError, UnicodeError) as e:
        # IDNA encoding rejects a hostname with UnicodeError, not OSError.
        return False, f"Failed to resolve host: {e}", ""

    if not infos:
        return False, f"Failed to resolve host: no addresses for {hostname!r}", ""

    for *_, sockaddr in infos:
        ip = ipaddress.ip_address(sockaddr[0])
        # `not ip.is_global` is the source of truth (also rejects CGNAT and
        # benchmarking/doc ranges); the explicit predicates only label the error.
        if (
            not ip.is_global
            or ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_multicast
            or ip.is_reserved
            or ip.is_unspecified
        ):
            return False, f"Blocked: refusing to fetch non-public address {ip}.", ""

    # Return the first resolved address for pinning.
    first_ip = infos[0][4][0]
    return True, "", first_ip


# Binary application subtypes rejected by MIME; other application types are
# sniffed so textual artifacts such as SQL stay usable.
_BINARY_APPLICATION_SUBTYPES = frozenset(
    {
        "epub+zip",
        "gzip",
        "java-archive",
        "pdf",
        "vnd.apple.installer+xml",
        "wasm",
        "x-7z-compressed",
        "x-bzip2",
        "x-gzip",
        "x-rar-compressed",
        "x-tar",
        "x-xz",
        "zip",
        "zstd",
    }
)


def _is_text_candidate_content_type(content_type: str | None) -> bool:
    """Whether a MIME type is textual or ambiguous enough for byte sniffing."""
    match = re.match(r"[\w.+-]+/[\w.+-]+", content_type or "")
    if not match:
        return True
    ct = match.group(0).lower()
    if ct.startswith("text/"):
        return True
    if ct.startswith("application/"):
        subtype = ct[len("application/") :]
        return subtype not in _BINARY_APPLICATION_SUBTYPES
    return False


# First path segments on github.com that are site pages, not repo owners.
_GITHUB_NON_OWNER_SEGMENTS = frozenset(
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
_GITHUB_NAME_RE = re.compile(r"\A[A-Za-z0-9_.\-]{1,100}\Z")


def _github_repo_readme_api_url(url: str) -> str | None:
    """README API URL for a ``github.com/{owner}/{repo}`` page, else None.

    A repo root page rendered as HTML is mostly UI chrome (nav, file table,
    stats); the ``/readme`` API returns the raw README markdown unauthenticated,
    which is what the model actually wants to read.
    """
    from urllib.parse import urlparse

    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if host not in ("github.com", "www.github.com"):
        return None
    parts = [p for p in parsed.path.split("/") if p]
    if len(parts) != 2:
        return None
    owner, repo = parts
    if owner.lower() in _GITHUB_NON_OWNER_SEGMENTS:
        return None
    if repo.endswith(".git"):
        repo = repo[: -len(".git")]
    if not (_GITHUB_NAME_RE.match(owner) and _GITHUB_NAME_RE.match(repo)):
        return None
    return f"https://api.github.com/repos/{owner}/{repo}/readme"


# A single fetch can chain several steps (README API attempt, HTML fallback, up
# to five redirect hops, each reading a body). A per-operation socket timeout
# bounds one stalled step but not their sum, and nothing aborts on client
# disconnect, so one overall wall-clock deadline (plus a cooperative
# cancel_event) bounds the whole fetch instead.
def _fetch_budget_exceeded(deadline, cancel_event):
    """User-facing error string when the fetch must stop early, else None."""
    if cancel_event is not None and cancel_event.is_set():
        return "Failed to fetch URL: cancelled."
    if deadline is not None and time.monotonic() >= deadline:
        return "Failed to fetch URL: timed out."
    return None


def _fetch_hop_timeout(timeout, deadline):
    """Per-operation socket timeout: the lesser of the caller's per-op timeout
    and the time left on the deadline, so one slow hop cannot overrun the whole
    budget. Callers check ``_fetch_budget_exceeded`` first, so remaining time is
    positive here; the tiny floor only guards a race."""
    if deadline is None:
        return timeout
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        remaining = 0.001
    return remaining if timeout is None else min(timeout, remaining)


def _resolve_with_budget(hostname, port, deadline, cancel_event):
    """``_validate_and_resolve_host`` bounded by the overall fetch budget.

    ``getaddrinfo`` is blocking with no deadline of its own, so a slow resolver
    (or a request cancelled before dispatch) could run past the budget. Resolve
    on a daemon thread and poll the budget so the fetch aborts on time; the
    abandoned lookup is discarded. With no deadline and no cancel_event this is a
    plain synchronous call, so opt-out callers keep the old behavior and cost.
    """
    budget_error = _fetch_budget_exceeded(deadline, cancel_event)
    if budget_error is not None:
        return False, budget_error, ""
    if deadline is None and cancel_event is None:
        return _validate_and_resolve_host(hostname, port)

    result: "queue.Queue" = queue.Queue(maxsize = 1)

    def _resolve():
        try:
            result.put(_validate_and_resolve_host(hostname, port))
        except Exception as exc:  # defensive: never let the worker die silently
            result.put((False, f"Failed to resolve host: {exc}", ""))

    threading.Thread(target = _resolve, name = "web-fetch-dns", daemon = True).start()
    while True:
        budget_error = _fetch_budget_exceeded(deadline, cancel_event)
        if budget_error is not None:
            return False, budget_error, ""
        try:
            return result.get(timeout = 0.05)
        except queue.Empty:
            continue


def _read_capped_body(resp, max_bytes, timeout, deadline, cancel_event):
    """Read up to ``max_bytes``, enforcing the overall budget between chunks.

    A single ``resp.read(max_bytes)`` can block for the whole transfer if the
    server dribbles bytes just inside each socket-inactivity timeout, so the body
    is read in chunks with the budget re-checked (and the socket timeout
    re-tightened toward the deadline) each round. The joined bytes are identical
    to one capped read. Returns ``(error_or_None, body_bytes)``.
    """
    # Best-effort handle on the underlying socket so its timeout tightens as the
    # deadline nears; absent on test doubles, where the between-chunk budget
    # check still bounds the read.
    sock = getattr(getattr(getattr(resp, "fp", None), "raw", None), "_sock", None)
    chunks = []
    remaining = max_bytes
    while remaining > 0:
        budget_error = _fetch_budget_exceeded(deadline, cancel_event)
        if budget_error is not None:
            try:
                resp.close()
            except Exception:
                pass
            return budget_error, b""
        if sock is not None:
            try:
                sock.settimeout(_fetch_hop_timeout(timeout, deadline))
            except Exception:
                pass
        chunk = resp.read(min(65536, remaining))
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    budget_error = _fetch_budget_exceeded(deadline, cancel_event)
    if budget_error is not None:
        try:
            resp.close()
        except Exception:
            pass
        return budget_error, b""
    return None, b"".join(chunks)


_DOTTED_HOST_RE = re.compile(r"[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+")
# ASCII-only because str.isdigit() is True for digits int() refuses ("²"), and
# capped at 5 digits so the range check never converts an unbounded integer.
_PORT_RE = re.compile(r"[0-9]{1,5}")


def _normalize_url_scheme(url: str) -> str:
    """Prepend ``https://`` to bare hosts (``google.com``, ``example.com:8443``).

    ``urlparse`` reads the host of a ``host:port`` input as the scheme, so those
    are recognised by a dotted host-like scheme with an empty netloc. Rewrites a
    dotted host with an optional in-range port, and the ``//host`` form. Real
    schemes (``file:``, ``javascript:``, including ``file:80``), root-relative
    paths (``/login``) and bad ports are returned untouched so the caller
    rejects them. A dotted scheme is indistinguishable from ``host:port``, so
    ``com.acme.app:443/cb`` is rewritten too; an empty port (``example.com:``)
    is kept as-is, matching ``https://example.com:``.

    The host is matched against the raw authority, never against what
    ``urlparse`` returned, because urlsplit strips tabs/newlines (3.10) and
    leading C0/space (3.12). Anything it would strip fails the match, so the
    decision and the rewritten string cannot disagree across versions."""
    from urllib.parse import urlparse

    url = url.strip()
    try:
        parsed = urlparse(url)
    except ValueError:
        # Unmatched IPv6 brackets, or an NFKC-decomposing netloc: not a bare host.
        return url
    if parsed.scheme:
        if parsed.netloc or not _DOTTED_HOST_RE.fullmatch(parsed.scheme):
            return url
        rest = url
    elif url.startswith("//"):
        rest = url[2:]
    elif url.startswith("/"):
        return url
    else:
        rest = url

    authority = re.split(r"[/?#]", rest, maxsplit = 1)[0]
    host, _, port = authority.partition(":")
    if not _DOTTED_HOST_RE.fullmatch(host):
        return url
    if port and not (_PORT_RE.fullmatch(port) and 1 <= int(port) <= 65535):
        return url
    return "https://" + rest


def _fetch_url_raw(
    url: str,
    timeout: int = 30,
    extra_headers: dict | None = None,
    deadline: float | None = None,
    cancel_event = None,
    website_policy: dict | None = None,
) -> tuple[str | None, str, str]:
    """Fetch a URL with SSRF protection; return ``(error, body_text, content_type)``.

    ``error`` is a user-facing message string when the fetch failed (the
    existing "Blocked:" / "Failed to fetch URL:" wording), else ``None``.
    Blocks private/loopback/link-local targets and caps the download size.
    No input reaches the caller as an exception: the URL is model-supplied, so
    every malformed form resolves to one of these strings.

    ``deadline`` is an optional ``time.monotonic`` cutoff for the whole fetch
    (redirect hops and body read included) and ``cancel_event`` aborts it when
    the caller goes away; both default off so callers keep the old behavior.
    """
    from urllib.parse import urlparse
    from .web_access_policy import check_url_access

    # Before the policy gate: it requires an http(s) scheme, so a bare host
    # would be refused there and never reach the fetch.
    url = _normalize_url_scheme(url)
    allowed, reason, canonical_host = check_url_access(url, website_policy)
    if not allowed:
        return reason, "", ""

    # check_url_access already parsed this and read .port, so this cannot raise.
    parsed = urlparse(url)
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    ok, reason, pinned_ip = _resolve_with_budget(
        canonical_host,
        port,
        deadline,
        cancel_event,
    )
    if not ok:
        return reason, "", ""

    try:
        from urllib.error import HTTPError as _HTTPError
        from urllib.parse import urljoin, urlunparse

        max_bytes = _MAX_FETCH_BYTES
        current_url = url
        current_host = canonical_host
        ua = random.choice(_USER_AGENTS)

        for _hop in range(5):
            budget_error = _fetch_budget_exceeded(deadline, cancel_event)
            if budget_error is not None:
                return budget_error, "", ""
            cp = urlparse(current_url)
            # Bracket IPv6 so the netloc stays a valid URL.
            validated_netloc = f"[{current_host}]" if ":" in current_host else current_host
            if cp.port:
                validated_netloc = f"{validated_netloc}:{cp.port}"
            # Decide routing once, on the netloc urllib tests: a pinned request
            # carries an IP, which no NO_PROXY entry matches, so the opener below
            # has to carry the decision rather than re-derive it.
            proxied = _explicit_proxy_applies(cp.scheme, validated_netloc)
            if os.environ.get(_DISABLE_DNS_PINNING_ENV) == "1" and proxied:
                # Enterprise proxies need the hostname in CONNECT for policy and TLS
                # interception, and they resolve it, so nothing rebinds behind us.
                request_url = urlunparse(cp._replace(netloc = validated_netloc))
            else:
                # Pin to the validated IP to prevent DNS rebinding.
                ip_str = f"[{pinned_ip}]" if ":" in pinned_ip else pinned_ip
                ip_netloc = f"{ip_str}:{cp.port}" if cp.port else ip_str
                request_url = urlunparse(cp._replace(netloc = ip_netloc))

            handlers = [_NoRedirect, _SNIHTTPSHandler(current_host)]
            if not proxied:
                # An empty ProxyHandler is the documented way to opt a request out.
                handlers.append(urllib.request.ProxyHandler({}))
            opener = urllib.request.build_opener(*handlers)

            headers = {
                "User-Agent": ua,
                "Host": validated_netloc,
            }
            if extra_headers:
                headers.update(extra_headers)
            req = urllib.request.Request(request_url, headers = headers)
            try:
                # Cap the socket timeout at the time left on the overall deadline
                # so a single slow hop cannot outlast the whole fetch budget.
                resp = opener.open(req, timeout = _fetch_hop_timeout(timeout, deadline))
            except _HTTPError as e:
                if e.code not in (301, 302, 303, 307, 308):
                    return f"Failed to fetch URL: HTTP {e.code} {getattr(e, 'reason', '')}", "", ""
                location = e.headers.get("Location")
                if not location:
                    return "Failed to fetch URL: redirect missing Location header.", "", ""
                current_url = urljoin(current_url, location)
                # Server-controlled, so never scheme-upgraded; the gate below
                # reads .port first, so the parse after it cannot raise.
                allowed, policy_reason, redirect_host = check_url_access(
                    current_url,
                    website_policy,
                )
                if not allowed:
                    return policy_reason, "", ""
                rp = urlparse(current_url)
                rp_port = rp.port or (443 if rp.scheme == "https" else 80)
                ok2, reason2, pinned_ip = _resolve_with_budget(
                    redirect_host,
                    rp_port,
                    deadline,
                    cancel_event,
                )
                if not ok2:
                    return reason2, "", ""
                current_host = redirect_host
                continue

            # get_content_type() defaults to "text/plain" when the header is
            # absent (RFC 2045); report "" instead so callers can tell a missing
            # header apart from a server that really declared text/plain.
            if resp.headers.get("Content-Type") is None:
                content_type = ""
            else:
                content_type = (resp.headers.get_content_type() or "").lower()

            # Success: read the capped body enforcing the budget between chunks
            # (see _read_capped_body), so a slow-drip server can't stretch a
            # single resp.read past the deadline.
            declared_pdf = content_type == "application/pdf"
            read_limit = _MAX_PDF_FETCH_BYTES + 1 if declared_pdf else max_bytes
            body_error, raw_bytes = _read_capped_body(
                resp,
                read_limit,
                timeout,
                deadline,
                cancel_event,
            )
            if body_error is not None:
                return body_error, "", ""

            # A missing or wrong PDF MIME type is common: once the initial text-sized
            # read identifies PDF magic, finish the bounded download to reach the EOF xref.
            if not declared_pdf and len(raw_bytes) == max_bytes and _has_pdf_magic(raw_bytes):
                tail_error, tail = _read_capped_body(
                    resp,
                    _MAX_PDF_FETCH_BYTES - max_bytes + 1,
                    timeout,
                    deadline,
                    cancel_event,
                )
                if tail_error is not None:
                    return tail_error, "", ""
                raw_bytes += tail
            break
        else:
            return "Failed to fetch URL: too many redirects.", "", ""

        is_pdf = declared_pdf or _has_pdf_magic(raw_bytes)
        if is_pdf:
            if len(raw_bytes) > _MAX_PDF_FETCH_BYTES:
                return (
                    "(PDF content exceeds the download limit; not readable as text)",
                    "",
                    content_type,
                )
            budget_error = _fetch_budget_exceeded(deadline, cancel_event)
            if budget_error is not None:
                return budget_error, "", content_type
            try:
                pdf_text = _extract_pdf_text(raw_bytes)
            except Exception as exc:
                logger.debug("web PDF text extraction failed (%s)", type(exc).__name__)
                return "(PDF content could not be read as text)", "", content_type
            budget_error = _fetch_budget_exceeded(deadline, cancel_event)
            if budget_error is not None:
                return budget_error, "", content_type
            if not pdf_text:
                pdf_text = "(PDF contains no extractable text)"
            # Report the true type even for a mislabeled body so the caller's "html"
            # check routes the extracted text to the plain-text path, not html_to_markdown.
            return None, pdf_text, "application/pdf"

        # Reject known-binary MIME types before decoding. Binary is returned as the
        # error string so the caller surfaces the placeholder, not replacement chars.
        if not _is_text_candidate_content_type(content_type):
            # Only echo a clean MIME token back to the model.
            m = re.match(r"[\w.+-]+/[\w.+-]+", content_type or "")
            safe_type = m.group(0) if m else "unknown type"
            return (
                f"(non-text content: {safe_type}, {len(raw_bytes)} bytes; not readable as text)",
                "",
                content_type,
            )

        # Catch text-labeled binary via its magic signature.
        if _has_binary_magic(raw_bytes):
            return (
                f"(binary content, {len(raw_bytes)} bytes; not readable as text)",
                "",
                content_type,
            )

        declared = resp.headers.get_content_charset()
        declared_codec = codecs.lookup(declared).name if declared else None
        bom_codec = next(
            (codec for bom, codec in _UNICODE_BOM_CODECS if raw_bytes.startswith(bom)),
            None,
        )
        raw_html = raw_bytes.decode(declared or bom_codec or "utf-8", errors = "replace")

        # Catch mislabeled or unlabeled binary, including valid UTF-8 controls.
        if _looks_binary(raw_html):
            # Rescue undeclared cp1252 only when the bytes have text structure.
            alt = (
                raw_bytes.decode("cp1252", "replace")
                if declared_codec in (None, "iso8859-1")
                and _has_single_byte_text_evidence(raw_bytes)
                else None
            )
            if alt is not None and not _looks_binary(alt):
                raw_html = alt
            else:
                return (
                    f"(binary content, {len(raw_bytes)} bytes; not readable as text)",
                    "",
                    content_type,
                )

        return None, raw_html, content_type
    except _HTTPError as e:
        return f"Failed to fetch URL: HTTP {e.code} {getattr(e, 'reason', '')}", "", ""
    except Exception as e:
        return f"Failed to fetch URL: {e}", "", ""


# Tags that, at the very START of a body, mark it as HTML. Excludes ambiguous
# tags (<div>/<p>/<span>/<a>/<img>/<h1>..<h6>/<table>) that legitimately open
# centered-logo or badge-layout Markdown READMEs and must stay Markdown.
_HTML_LEADING_TAGS = (
    "html",
    "head",
    "body",
    "title",
    "meta",
    "link",
    "script",
    "style",
    "article",
    "section",
    "main",
    "header",
    "footer",
    "nav",
    "aside",
    "figure",
    "form",
    "ul",
    "ol",
    "dl",
    "pre",
    "blockquote",
)
_HTML_LEADING_RE = re.compile(r"<(?:!doctype\s+html|/?(?:" + "|".join(_HTML_LEADING_TAGS) + r")\b)")


def _looks_like_html(body: str) -> bool:
    """True only when the document ITSELF opens with HTML.

    Matches an HTML doctype or a leading document/structure tag after optional
    whitespace, not a mere substring, so a Markdown README with a fenced HTML
    example or tags further down stays Markdown. Also detects bare fragments
    (``<body>``/``<article>``/...) with no doctype, so a page with a
    missing/wrong Content-Type is still converted.
    """
    probe = body.lstrip()[:256].lower()
    return bool(_HTML_LEADING_RE.match(probe))


# Stricter than _HTML_LEADING_RE: only a real document opener (doctype or leading
# <html>/<head>/<body>), never a block tag a Markdown file can open with. Used on
# the raw GitHub README body so a Markdown README starting with an HTML block is
# not run through html_to_markdown, which would collapse its headings, lists and
# fenced code onto one line.
_HTML_DOCUMENT_RE = re.compile(r"<(?:!doctype\s+html\b|/?(?:html|head|body)\b)")


def _looks_like_html_document(body: str) -> bool:
    """True only when the body opens as a full HTML document (e.g. a .html README)."""
    probe = body.lstrip()[:256].lower()
    return bool(_HTML_DOCUMENT_RE.match(probe))


def _truncate_page_text(text: str, max_chars: int) -> str:
    if not text:
        return "(page returned no readable text)"
    if len(text) > max_chars:
        return text[:max_chars] + f"\n\n... (truncated, {len(text)} chars total)"
    return text


def _fetch_page_text(
    url: str,
    max_chars: int = _MAX_PAGE_CHARS,
    timeout: int = 30,
    cancel_event = None,
    website_policy: dict | None = None,
) -> str:
    """Fetch a URL and return readable text content.

    HTML responses are converted to Markdown with a main-content heuristic
    (``<article>``/``<main>`` scoping, hidden-element and boilerplate
    stripping); non-HTML text responses are returned as-is. GitHub repo root
    pages are rewritten to the README API so the model reads the README
    instead of the repo page's UI chrome. Blocks private/loopback/link-local
    targets (SSRF protection) and caps the download size.
    """
    # One wall-clock budget for the whole fetch. The README API attempt and its
    # HTML fallback both draw from it, so a slow/failed API call cannot hand the
    # fallback a fresh full timeout and double the worst case.
    deadline = None if timeout is None else time.monotonic() + timeout
    from .web_access_policy import check_url_access

    # Before the policy gate (needs a scheme) and the README routing (reads host/path).
    url = _normalize_url_scheme(url)
    allowed, reason, _hostname = check_url_access(url, website_policy)
    if not allowed:
        return reason
    policy_kwargs = {"website_policy": website_policy} if website_policy is not None else {}
    readme_api_url = _github_repo_readme_api_url(url)
    if readme_api_url:
        err, body, _ctype = _fetch_url_raw(
            readme_api_url,
            timeout = timeout,
            extra_headers = {
                "Accept": "application/vnd.github.raw+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            deadline = deadline,
            cancel_event = cancel_event,
            **policy_kwargs,
        )
        # The README API is unauthenticated and rate-limited; on any failure fall
        # back to the HTML page fetch. A 200 body is authoritative even when it is
        # HTML (a .html README): convert it rather than falling back to the repo
        # page's UI chrome, keeping the raw body if extraction yields nothing.
        if err is None and body.strip():
            readme_body = body
            # The raw file is almost always Markdown. Only a real HTML document (a
            # .html README) is converted; a Markdown README that merely opens with
            # a block tag is kept as-is (see _HTML_DOCUMENT_RE).
            if _looks_like_html_document(body):
                from ._html_to_md import html_to_markdown
                converted = html_to_markdown(body, main_content = True)
                readme_body = converted if converted.strip() else body
            if readme_body.strip():
                return _truncate_page_text(
                    f"README of {url} (fetched via the GitHub README API):\n\n" + readme_body,
                    max_chars,
                )

    err, body, content_type = _fetch_url_raw(
        url,
        timeout = timeout,
        deadline = deadline,
        cancel_event = cancel_event,
        **policy_kwargs,
    )
    if err is not None:
        return err

    # Trust a declared HTML type, and otherwise sniff the body: servers with a
    # missing or wrong Content-Type (e.g. text/plain on an HTML page) still get
    # converted, matching the pre-extraction behavior of always converting.
    is_html = "html" in content_type or _looks_like_html(body)
    if not is_html:
        # Plain text / markdown / JSON (e.g. raw.githubusercontent.com):
        # converting through the HTML renderer would collapse its whitespace.
        return _truncate_page_text(body.strip(), max_chars)

    # Convert HTML to Markdown with the builtin converter (no external deps).
    from ._html_to_md import html_to_markdown

    return _truncate_page_text(html_to_markdown(body, main_content = True), max_chars)


def _search_failure_message(exc: BaseException, timeout: int) -> str:
    """Turn a ddgs exception into text the model and the UI can act on.

    ddgs raises for an empty sweep as well as for refusals, so an unclassified
    ``Search failed: {exc}`` reports "nothing matched" and "every engine throttled us" the same
    way. Matched by class name because ddgs is imported lazily and tests stub the module.

    The RatelimitException arm is forward-looking: ddgs 9.14.4 defines the class but raises it
    nowhere, and no engine inspects the status code, so a throttled sweep parses to zero items
    and arrives here as the empty-sweep DDGSException instead.
    """
    name = type(exc).__name__
    if name == "RatelimitException":
        return (
            "Search failed: the search engines are rate limiting this machine. Wait a minute "
            'before searching again, or read a known page directly with {"url": "<URL>"}.'
        )
    if name == "TimeoutException":
        budget = f" within {timeout}s" if timeout else ""
        return f"Search failed: the search engines did not respond{budget}."
    # Only the base exception, so a subclass that happens to quote the phrase stays an error.
    if name == "DDGSException" and _DDGS_EMPTY_SWEEP in str(exc):
        return EMPTY_SEARCH_RESULTS[0]
    return f"Search failed: {exc}"


def _web_search(
    query: str,
    max_results: int = 5,
    timeout: int = _EXEC_TIMEOUT,
    url: str | None = None,
    cancel_event = None,
    website_policy: dict | None = None,
) -> str:
    """Search the web and return formatted results.

    ddgs fans the query out across its search engines, so a single engine refusing is already
    covered. If ``url`` is provided, fetches that page directly instead of searching.
    """
    # Direct URL fetch mode.
    if url and url.strip():
        fetch_timeout = 60 if timeout is None else min(timeout, 60)
        return _fetch_page_text(
            url.strip(),
            timeout = fetch_timeout,
            cancel_event = cancel_event,
            website_policy = website_policy,
        )

    if not query or not query.strip():
        return "No query provided."
    # A disconnect sets cancel_event; DDGS.text() is blocking and cannot be
    # interrupted mid-flight, so gate on either side: skip an already-cancelled
    # request, and discard results that land after the client has gone.
    if cancel_event is not None and cancel_event.is_set():
        return "Search cancelled."
    try:
        from ddgs import DDGS

        from .web_access_policy import check_url_access, scope_search_query

        effective_query = scope_search_query(query, website_policy)
        # The policy filters below, so ask for a deeper pool when one actually restricts: a page
        # whose top hits are all disallowed otherwise yields nothing even when valid results rank
        # just under them. Test the domain lists, not the dict: a run always stores a normalized
        # policy, which is truthy even when unrestricted.
        restricted = any(
            (website_policy or {}).get(key) for key in ("allowedDomains", "blockedDomains")
        )
        wanted = max_results * _POLICY_OVERFETCH if restricted else max_results
        results = DDGS(timeout = timeout).text(effective_query, max_results = wanted)
        if cancel_event is not None and cancel_event.is_set():
            return "Search cancelled."
        if not results:
            return EMPTY_SEARCH_RESULTS[0]
        parts = []
        for r in results:
            if len(parts) >= max_results:
                break
            href = str(r.get("href") or "").strip()
            allowed, _reason, _hostname = check_url_access(href, website_policy)
            if not allowed:
                continue
            title = " ".join(str(r.get("title") or "").split())
            snippet = " ".join(str(r.get("body") or "").split())
            parts.append(f"Title: {title}\nURL: {href}\nSnippet: {snippet}")
        if not parts:
            return EMPTY_SEARCH_RESULTS[1]
        text = "\n\n---\n\n".join(parts)
        text += (
            "\n\n---\n\nIMPORTANT: These are only short snippets. "
            "To get the full page content, call web_search with "
            'the url parameter (e.g. {"url": "<URL>"}).'
        )
        return text
    except Exception as e:
        return _search_failure_message(e, timeout)
