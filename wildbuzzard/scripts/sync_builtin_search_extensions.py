#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path, PurePosixPath
from xml.etree import ElementTree

REPOSITORY = Path(__file__).resolve().parents[2]
EXTENSIONS_ROOT = REPOSITORY / "wildbuzzard" / "browser" / "extensions"
SOURCE_LOCK = EXTENSIONS_ROOT / "SOURCES.lock.json"
STRICT_CSP = (
    "default-src 'self'; connect-src 'none'; frame-src 'none'; "
    "object-src 'none'; script-src 'self'; style-src 'self'; "
    "img-src 'self' data:"
)
VERSION_RE = re.compile(r"^[0-9]+(?:\.[0-9]+){1,3}$")
LOCALE_REFERENCE_RE = re.compile(
    r"__MSG_([A-Za-z0-9_]+)__|data-i18n(?:-[a-z-]+)?=[\"']([A-Za-z0-9_]+)"
)
FORBIDDEN_SOURCE_RE = re.compile(
    r"\b(?:fetch|eval|XMLHttpRequest|WebSocket|EventSource)\b"
    r"|\b(?-i:Function|importScripts)\b"
    r"|\.(?:innerHTML|outerHTML)\s*=|insertAdjacentHTML\s*\("
    r"|createContextualFragment\s*\(|document\.write\s*\("
    r"|\bimport\s*\(|\b(?:sendNativeMessage|connectNative)\s*\("
    r"|<iframe\b|<script[^>]+src=[\"'](?:https?:)?//"
    r"|@import\s+(?:url\()?\s*[\"']?(?:https?:)?//"
    r"|url\(\s*[\"']?(?:https?:)?//",
    re.IGNORECASE,
)
FORBIDDEN_GLOBAL_ACCESS_RE = re.compile(
    r"\b(?:browser|chrome|globalThis|window|self|this)\s*\["
    r"|\b(?:const|let|var)\s+(?:\{[^}]+\}|[A-Za-z_$][A-Za-z0-9_$]*)"
    r"\s*=\s*(?:browser|chrome|globalThis|window|self)\b",
    re.DOTALL,
)
FORBIDDEN_NATIVE_RE = re.compile(
    r"native[_-]?messaging|/usr/bin/|\bSubprocess\b|\bchild_process\b|\bjackett\b",
    re.IGNORECASE,
)
MAX_FILE_BYTES = 2 * 1024 * 1024


class ValidationError(Exception):
    pass


@dataclass(frozen=True)
class ExtensionConfig:
    slug: str
    repository: str
    source_path: str
    extension_id: str
    backend_package: str
    backend_executable: str
    api_namespace: str
    allowed_browser_namespaces: frozenset[str]
    files: tuple[str, ...]


WEB = ExtensionConfig(
    slug="web-search",
    repository="wildbuzzard-extensions",
    source_path="extensions/web-search",
    extension_id="web-search@extensions.wildbuzzard",
    backend_package="buzzard-search",
    backend_executable="/usr/bin/buzzard-search",
    api_namespace="browser.buzzardSearch",
    allowed_browser_namespaces=frozenset({
        "buzzardSearch",
        "i18n",
        "omnibox",
        "runtime",
        "sidebarAction",
        "storage",
        "tabs",
    }),
    files=(
        "LICENSE",
        "manifest.json",
        "_locales/en/messages.json",
        "background/background.js",
        "common/base.css",
        "common/constants.js",
        "common/localize.js",
        "icons/search.svg",
        "options/options.css",
        "options/options.html",
        "options/options.js",
        "popup/popup.css",
        "popup/popup.html",
        "popup/popup.js",
        "search/search.css",
        "search/search.html",
        "search/search.js",
    ),
)

TORRENT = ExtensionConfig(
    slug="torrent-search",
    repository="wildbuzzard-extensions",
    source_path="extensions/torrent-search",
    extension_id="torrent-search@extensions.wildbuzzard",
    backend_package="buzzard-minijtt",
    backend_executable="/usr/bin/buzzard-minijtt",
    api_namespace="browser.torrentSearch",
    allowed_browser_namespaces=frozenset({
        "i18n",
        "omnibox",
        "runtime",
        "storage",
        "tabs",
        "torrentSearch",
    }),
    files=(
        "LICENSE",
        "manifest.json",
        "_locales/en/messages.json",
        "icons/torrent-search.svg",
        "src/background.js",
        "src/contract.js",
        "src/i18n.js",
        "src/options.css",
        "src/options.html",
        "src/options.js",
        "src/popup.css",
        "src/popup.html",
        "src/popup.js",
    ),
)

CONFIGS = (WEB, TORRENT)


def web_manifest(version):
    return {
        "manifest_version": 2,
        "name": "__MSG_extensionName__",
        "description": "__MSG_extensionDescription__",
        "version": version,
        "default_locale": "en",
        "incognito": "not_allowed",
        "browser_specific_settings": {
            "gecko": {
                "id": WEB.extension_id,
                "strict_min_version": "128.0",
            }
        },
        "permissions": ["storage"],
        "icons": {
            "16": "icons/search.svg",
            "32": "icons/search.svg",
            "48": "icons/search.svg",
            "96": "icons/search.svg",
        },
        "browser_action": {
            "browser_style": False,
            "default_icon": "icons/search.svg",
            "default_popup": "popup/popup.html",
            "default_title": "__MSG_toolbarTitle__",
        },
        "sidebar_action": {
            "browser_style": False,
            "default_icon": "icons/search.svg",
            "default_panel": "search/search.html?surface=sidebar",
            "default_title": "__MSG_sidebarTitle__",
            "open_at_install": False,
        },
        "options_ui": {
            "browser_style": False,
            "open_in_tab": True,
            "page": "options/options.html",
        },
        "background": {"scripts": ["common/constants.js", "background/background.js"]},
        "omnibox": {"keyword": "buzz"},
        "chrome_settings_overrides": {
            "search_provider": {
                "name": "__MSG_extensionName__",
                "search_url": "search/search.html",
                "search_url_get_params": "q={searchTerms}",
                "keyword": "@buzz",
                "is_default": False,
            }
        },
        "commands": {
            "_execute_browser_action": {
                "suggested_key": {"default": "Alt+Shift+S"},
                "description": "__MSG_openSearchCommand__",
            }
        },
        "content_security_policy": STRICT_CSP,
    }


def torrent_manifest(version):
    return {
        "manifest_version": 2,
        "name": "__MSG_extensionName__",
        "version": version,
        "description": "__MSG_extensionDescription__",
        "default_locale": "en",
        "incognito": "not_allowed",
        "author": "WildBuzzard contributors",
        "browser_specific_settings": {
            "gecko": {
                "id": TORRENT.extension_id,
                "strict_min_version": "128.0",
            }
        },
        "permissions": ["storage"],
        "background": {"scripts": ["src/background.js"]},
        "browser_action": {
            "default_title": "__MSG_browserActionTitle__",
            "default_popup": "src/popup.html",
            "default_icon": {
                "16": "icons/torrent-search.svg",
                "32": "icons/torrent-search.svg",
            },
        },
        "icons": {
            "48": "icons/torrent-search.svg",
            "96": "icons/torrent-search.svg",
        },
        "omnibox": {"keyword": "torrent"},
        "chrome_settings_overrides": {
            "search_provider": {
                "name": "__MSG_extensionName__",
                "search_url": "src/popup.html",
                "search_url_get_params": "query={searchTerms}",
                "keyword": "@torrent",
                "is_default": False,
            }
        },
        "options_ui": {"page": "src/options.html", "open_in_tab": False},
        "commands": {
            "_execute_browser_action": {
                "suggested_key": {
                    "default": "Ctrl+Shift+Y",
                    "mac": "MacCtrl+Shift+Y",
                },
                "description": "__MSG_openSearchCommand__",
            }
        },
        "content_security_policy": STRICT_CSP,
    }


EXPECTED_MANIFEST = {
    WEB.slug: web_manifest,
    TORRENT.slug: torrent_manifest,
}


def no_duplicate_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValidationError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def load_json(data, label):
    try:
        return json.loads(data, object_pairs_hook=no_duplicate_object)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValidationError(f"invalid JSON in {label}: {error}") from error


def ensure_regular_file(root, relative):
    current = root
    for part in PurePosixPath(relative).parts:
        current = current / part
        try:
            info = current.lstat()
        except FileNotFoundError as error:
            raise ValidationError(f"missing allowlisted file: {relative}") from error
        if current != root / relative and not current.is_dir():
            raise ValidationError(f"non-directory source path: {current}")
        if current.is_symlink():
            raise ValidationError(f"symlinked source path is forbidden: {current}")
    if not current.is_file():
        raise ValidationError(f"non-regular source file: {current}")
    if info.st_size > MAX_FILE_BYTES:
        raise ValidationError(f"allowlisted file is too large: {relative}")
    return current.read_bytes()


def local_reference(document, reference):
    if not reference or reference.startswith(("#", "?")):
        return None
    lowered = reference.lower()
    if (
        ":" in reference.split("/", 1)[0]
        or reference.startswith(("//", "/", "\\"))
        or lowered.startswith(("data:", "javascript:"))
    ):
        raise ValidationError(
            f"remote or absolute reference in {document}: {reference}"
        )
    path = PurePosixPath(document).parent.joinpath(reference.split("?", 1)[0])
    parts = []
    for part in path.parts:
        if part in ("", "."):
            continue
        if part == "..":
            if not parts:
                raise ValidationError(f"escaping reference in {document}: {reference}")
            parts.pop()
        else:
            parts.append(part)
    return "/".join(parts)


class ExtensionHTMLParser(HTMLParser):
    def __init__(self, document, allowed_files):
        super().__init__(convert_charrefs=True)
        self.document = document
        self.allowed_files = allowed_files

    def handle_starttag(self, tag, attrs):
        self._validate_tag(tag, attrs)

    def handle_startendtag(self, tag, attrs):
        self._validate_tag(tag, attrs)

    def _validate_tag(self, tag, attrs):
        tag = tag.lower()
        if tag in {"iframe", "object", "embed"}:
            raise ValidationError(f"forbidden element in {self.document}: {tag}")
        names = set()
        values = {}
        for name, value in attrs:
            normalized_name = name.lower()
            if normalized_name in names:
                raise ValidationError(
                    f"duplicate HTML attribute in {self.document}: {normalized_name}"
                )
            names.add(normalized_name)
            values[normalized_name] = value or ""
            if normalized_name.startswith("on") or normalized_name == "style":
                raise ValidationError(
                    "inline executable/style attribute in "
                    f"{self.document}: {normalized_name}"
                )
        if tag == "script" and "src" not in values:
            raise ValidationError(f"inline script in {self.document}")
        for name in ("src", "href", "action", "formaction", "poster"):
            if name not in values:
                continue
            reference = local_reference(self.document, values[name])
            if reference and reference not in self.allowed_files:
                raise ValidationError(
                    f"unbundled reference in {self.document}: {values[name]}"
                )


def validate_svg(data, relative):
    text = data.decode("utf-8")
    if "<!DOCTYPE" in text.upper() or "<!ENTITY" in text.upper():
        raise ValidationError(f"DTD/entity is forbidden in {relative}")
    try:
        root = ElementTree.fromstring(text)
    except ElementTree.ParseError as error:
        raise ValidationError(f"invalid SVG in {relative}: {error}") from error
    for element in root.iter():
        name = element.tag.rsplit("}", 1)[-1].lower()
        if name in {"script", "foreignobject"}:
            raise ValidationError(f"active SVG element in {relative}: {name}")
        for attribute, value in element.attrib.items():
            normalized_attribute = attribute.rsplit("}", 1)[-1].lower()
            if normalized_attribute.startswith("on"):
                raise ValidationError(f"active SVG attribute in {relative}")
            if normalized_attribute in {
                "href",
                "src",
            } and value.strip().lower().startswith((
                "http:",
                "https:",
                "//",
                "javascript:",
                "data:",
            )):
                raise ValidationError(f"remote SVG reference in {relative}")


def validate_manifest(config, data):
    manifest = load_json(data, f"{config.repository}/manifest.json")
    version = manifest.get("version")
    if not isinstance(version, str) or not VERSION_RE.fullmatch(version):
        raise ValidationError(f"invalid extension version for {config.slug}")
    if manifest != EXPECTED_MANIFEST[config.slug](version):
        raise ValidationError(f"manifest policy mismatch for {config.slug}")
    return manifest


def validate_locale(data, relative):
    messages = load_json(data, relative)
    if not isinstance(messages, dict) or not messages:
        raise ValidationError(f"empty or invalid locale catalog: {relative}")
    for key, entry in messages.items():
        if not re.fullmatch(r"[A-Za-z0-9_]+", key):
            raise ValidationError(f"invalid locale key in {relative}: {key}")
        if not isinstance(entry, dict) or not isinstance(entry.get("message"), str):
            raise ValidationError(f"invalid locale message in {relative}: {key}")
    return messages


def validate_files(config, files):
    expected = set(config.files)
    if set(files) != expected:
        missing = sorted(expected - set(files))
        extra = sorted(set(files) - expected)
        raise ValidationError(
            f"allowlist mismatch for {config.slug}; missing={missing}, extra={extra}"
        )
    for relative, data in files.items():
        if len(data) > MAX_FILE_BYTES or b"\0" in data:
            raise ValidationError(f"invalid allowlisted file: {relative}")
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError as error:
            raise ValidationError(f"non-UTF-8 allowlisted file: {relative}") from error
        if relative.endswith((".js", ".html", ".css", ".svg")):
            if FORBIDDEN_NATIVE_RE.search(text):
                raise ValidationError(
                    f"embedded native/provider implementation in {relative}"
                )
            if FORBIDDEN_SOURCE_RE.search(text):
                raise ValidationError(
                    f"forbidden executable/remote surface in {relative}"
                )
        if relative.endswith(".js") and FORBIDDEN_GLOBAL_ACCESS_RE.search(text):
            raise ValidationError(f"computed or aliased global access in {relative}")
    manifest = validate_manifest(config, files["manifest.json"])
    messages = validate_locale(
        files["_locales/en/messages.json"], "_locales/en/messages.json"
    )
    allowed_files = set(config.files)
    for relative, data in files.items():
        if relative.endswith(".html"):
            parser = ExtensionHTMLParser(relative, allowed_files)
            parser.feed(data.decode("utf-8"))
            parser.close()
        elif relative.endswith(".svg"):
            validate_svg(data, relative)
        if relative.endswith((".html", ".js")) or relative == "manifest.json":
            for match in LOCALE_REFERENCE_RE.finditer(data.decode("utf-8")):
                key = match.group(1) or match.group(2)
                if key not in messages:
                    raise ValidationError(
                        f"missing locale key referenced by {relative}: {key}"
                    )
    scripts = "\n".join(
        data.decode("utf-8")
        for relative, data in files.items()
        if relative.endswith(".js")
    )
    if config.api_namespace not in scripts:
        raise ValidationError(f"missing constrained API call for {config.slug}")
    other_api = TORRENT.api_namespace if config is WEB else WEB.api_namespace
    if other_api in scripts:
        raise ValidationError(f"cross-extension API call in {config.slug}")
    if re.search(r"\bbrowser\b(?!\.[A-Za-z])|\bchrome\b", scripts):
        raise ValidationError(f"computed or aliased extension API in {config.slug}")
    namespaces = set(re.findall(r"\bbrowser\.([A-Za-z][A-Za-z0-9]*)", scripts))
    unexpected_namespaces = namespaces - config.allowed_browser_namespaces
    if unexpected_namespaces:
        raise ValidationError(
            f"unexpected browser API namespace in {config.slug}: "
            f"{sorted(unexpected_namespaces)}"
        )
    return manifest


def read_source(config, source):
    if source.is_symlink() or not source.is_dir():
        raise ValidationError(f"source repository is not a regular directory: {source}")
    files = {
        relative: ensure_regular_file(source, relative) for relative in config.files
    }
    manifest = validate_files(config, files)
    return files, manifest


def tree_hash(files):
    digest = hashlib.sha256()
    for relative in sorted(files):
        path = relative.encode("utf-8")
        data = files[relative]
        digest.update(len(path).to_bytes(4, "big"))
        digest.update(path)
        digest.update(len(data).to_bytes(8, "big"))
        digest.update(data)
    return digest.hexdigest()


def render_source(config, files, manifest):
    provenance = {
        "schema": 3,
        "componentRole": "browser-ui-only",
        "backendRole": "standalone-system-cli-no-browser-or-web-ui",
        "backendPackage": config.backend_package,
        "backendExecutable": config.backend_executable,
        "backendInstallCommand": f"sudo apt install {config.backend_package}",
        "sourceRepository": config.repository,
        "sourcePath": config.source_path,
        "extensionId": config.extension_id,
        "version": manifest["version"],
        "treeHashAlgorithm": "sha256-length-prefixed-path-and-content",
        "runtimeTreeSha256": tree_hash(files),
        "files": [
            {
                "path": relative,
                "size": len(files[relative]),
                "sha256": hashlib.sha256(files[relative]).hexdigest(),
            }
            for relative in sorted(files)
        ],
    }
    return (json.dumps(provenance, indent=2, sort_keys=True) + "\n").encode()


def target_expression(relative_directory):
    expression = "FINAL_TARGET_FILES.chrome.browser"
    expression += f'["builtin-addons"]["{relative_directory[0]}"]'
    for part in relative_directory[1:]:
        expression += f"[{json.dumps(part)}]"
    return expression


def render_moz_build(config):
    groups = {(): ["SOURCE.json"]}
    for relative in config.files:
        directory = PurePosixPath(relative).parent.parts
        if directory == (".",):
            directory = ()
        groups.setdefault(directory, []).append(f"extension/{relative}")
    lines = [
        "# SPDX-License-Identifier: AGPL-3.0-or-later",
        "",
        "# Generated by wildbuzzard/scripts/sync_builtin_search_extensions.py.",
    ]
    for directory in sorted(groups):
        expression = target_expression((config.slug, *directory))
        lines.extend(("", f"{expression} += ["))
        lines.extend(
            f"    {json.dumps(path)},"
            for path in sorted(groups[directory], key=str.lower)
        )
        lines.append("]")
    lines.append("")
    return "\n".join(lines).encode()


def render_bundle(config, files, manifest):
    rendered = {f"extension/{relative}": data for relative, data in files.items()}
    rendered["SOURCE.json"] = render_source(config, files, manifest)
    rendered["moz.build"] = render_moz_build(config)
    return rendered


def render_lock(rendered):
    extensions = []
    for config in CONFIGS:
        bundle = rendered[config.slug]
        provenance = load_json(bundle["SOURCE.json"], f"{config.slug}/SOURCE.json")
        extensions.append({
            "slug": config.slug,
            "componentRole": provenance["componentRole"],
            "backendRole": provenance["backendRole"],
            "backendPackage": provenance["backendPackage"],
            "backendExecutable": provenance["backendExecutable"],
            "backendInstallCommand": provenance["backendInstallCommand"],
            "sourceRepository": config.repository,
            "sourcePath": config.source_path,
            "extensionId": config.extension_id,
            "version": provenance["version"],
            "sourceTreeSha256": provenance["runtimeTreeSha256"],
            "sourceManifestSha256": hashlib.sha256(bundle["SOURCE.json"]).hexdigest(),
            "bundleTreeSha256": tree_hash(bundle),
        })
    lock = {
        "schema": 3,
        "treeHashAlgorithm": "sha256-length-prefixed-path-and-content",
        "extensions": extensions,
    }
    return (json.dumps(lock, indent=2, sort_keys=True) + "\n").encode()


def bundle_files(config, bundle):
    expected = {
        "SOURCE.json",
        "moz.build",
        *(f"extension/{relative}" for relative in config.files),
    }
    actual = set()
    if bundle.is_symlink() or not bundle.is_dir():
        raise ValidationError(f"missing bundled extension: {bundle}")
    for path in bundle.rglob("*"):
        relative = path.relative_to(bundle).as_posix()
        if path.is_symlink():
            raise ValidationError(f"symlinked bundled path: {relative}")
        if path.is_file():
            actual.add(relative)
        elif not path.is_dir():
            raise ValidationError(f"special bundled path: {relative}")
    if actual != expected:
        raise ValidationError(
            f"bundled file set mismatch for {config.slug}; "
            f"missing={sorted(expected - actual)}, extra={sorted(actual - expected)}"
        )
    return {relative: (bundle / relative).read_bytes() for relative in sorted(actual)}


def validate_bundle(config, bundle, source_rendered=None):
    actual = bundle_files(config, bundle)
    extension_files = {
        relative: actual[f"extension/{relative}"] for relative in config.files
    }
    manifest = validate_files(config, extension_files)
    expected = render_bundle(config, extension_files, manifest)
    for relative, data in expected.items():
        if actual[relative] != data:
            raise ValidationError(
                f"generated bundle metadata differs for {config.slug}: {relative}"
            )
    if source_rendered is not None:
        for relative, data in source_rendered.items():
            if actual[relative] != data:
                raise ValidationError(
                    f"bundle differs from {config.repository}: {relative}"
                )
    return expected


def validate_lock(rendered, path=None):
    path = SOURCE_LOCK if path is None else path
    if path.is_symlink() or not path.is_file():
        raise ValidationError(f"missing regular source lock: {path}")
    if path.read_bytes() != render_lock(rendered):
        raise ValidationError(f"source lock differs from bundled extensions: {path}")


def resolve_source(args, config):
    source = args.extensions_source
    if source is None and os.environ.get("WILDBUZZARD_EXTENSIONS_SOURCE"):
        source = Path(os.environ["WILDBUZZARD_EXTENSIONS_SOURCE"])
    if source is None:
        source = REPOSITORY.parent / config.repository
    return source / config.source_path


def source_renderings(args):
    result = {}
    for config in CONFIGS:
        files, manifest = read_source(config, resolve_source(args, config))
        result[config.slug] = render_bundle(config, files, manifest)
    return result


def write_rendered(directory, rendered):
    for relative, data in rendered.items():
        target = directory / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        target.chmod(0o644)


def remove_output(path):
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    else:
        path.unlink()


def stage_outputs(staged, rendered):
    for config in CONFIGS:
        write_rendered(staged / config.slug, rendered[config.slug])
    staged_lock = staged / SOURCE_LOCK.name
    staged_lock.write_bytes(render_lock(rendered))
    staged_lock.chmod(0o644)
    staged_rendered = {
        config.slug: validate_bundle(
            config, staged / config.slug, rendered[config.slug]
        )
        for config in CONFIGS
    }
    validate_lock(staged_rendered, staged_lock)


def replace_outputs(rendered):
    EXTENSIONS_ROOT.mkdir(parents=True, exist_ok=True)
    pending = sorted(EXTENSIONS_ROOT.glob(".builtin-search-transaction-*"))
    if pending:
        raise ValidationError(
            f"unfinished sync transaction requires recovery: {pending[0]}"
        )
    transaction = Path(
        tempfile.mkdtemp(prefix=".builtin-search-transaction-", dir=EXTENSIONS_ROOT)
    )
    staged = transaction / "staged"
    backup = transaction / "backup"
    staged.mkdir()
    backup.mkdir()
    try:
        stage_outputs(staged, rendered)
    except Exception:
        shutil.rmtree(transaction)
        raise

    names = [*(config.slug for config in CONFIGS), SOURCE_LOCK.name]
    moved = []
    installed = []
    try:
        for name in names:
            destination = EXTENSIONS_ROOT / name
            if destination.is_symlink():
                raise ValidationError(f"refusing to replace symlink: {destination}")
            if destination.exists():
                os.replace(destination, backup / name)
                moved.append(name)
        for name in names:
            os.replace(staged / name, EXTENSIONS_ROOT / name)
            installed.append(name)
    except Exception as error:
        rollback_errors = []
        for name in reversed(installed):
            destination = EXTENSIONS_ROOT / name
            try:
                if destination.exists() or destination.is_symlink():
                    os.replace(destination, staged / name)
            except OSError as rollback_error:
                rollback_errors.append(str(rollback_error))
        for name in reversed(moved):
            destination = EXTENSIONS_ROOT / name
            try:
                if destination.exists() or destination.is_symlink():
                    remove_output(destination)
                os.replace(backup / name, destination)
            except OSError as rollback_error:
                rollback_errors.append(str(rollback_error))
        if rollback_errors:
            raise ValidationError(
                f"sync rollback incomplete; recovery data retained at {transaction}: "
                f"{'; '.join(rollback_errors)}"
            ) from error
        shutil.rmtree(transaction)
        raise
    shutil.rmtree(transaction)


def run_sync(args):
    rendered = source_renderings(args)
    replace_outputs(rendered)
    run_check(args)


def run_check(args):
    rendered = None if getattr(args, "bundled_only", False) else source_renderings(args)
    actual = {}
    for config in CONFIGS:
        actual[config.slug] = validate_bundle(
            config,
            EXTENSIONS_ROOT / config.slug,
            None if rendered is None else rendered[config.slug],
        )
    validate_lock(actual)


def add_source_arguments(parser):
    parser.add_argument("--extensions-source", type=Path)


def generate_build_lock(output, *ignored):
    run_check(argparse.Namespace(bundled_only=True))
    output.write(SOURCE_LOCK.read_text(encoding="utf-8"))
    return 0


def main():
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    sync_parser = subparsers.add_parser("sync")
    add_source_arguments(sync_parser)
    check_parser = subparsers.add_parser("check")
    add_source_arguments(check_parser)
    check_parser.add_argument("--bundled-only", action="store_true")
    args = parser.parse_args()
    try:
        if args.command == "sync":
            run_sync(args)
        else:
            run_check(args)
    except (OSError, ValidationError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
