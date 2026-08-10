# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import argparse
import collections
import concurrent.futures
import contextlib
import datetime
import hashlib
import html.parser
import http.client
import json
import os
import pathlib
import re
import secrets
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time
import urllib.parse
from collections.abc import Callable

HERE = pathlib.Path(__file__).resolve().parent
CHECKOUT = HERE.parents[3]
FIRECRAWL_REPOSITORY = "https://github.com/firecrawl/firecrawl.git"
FIRECRAWL_TAG = "v2.11.193"
FIRECRAWL_COMMIT = "448ef4bf815d8df798d1a676f0303285e54cabdb"
FIRECRAWL_TAG_OBJECT = "f13353ea529b12b4f17aef76d1a01e6d90784850"
BASE_PLATFORM = "linux/amd64"
PLAYWRIGHT_INTERNAL_PORT = 3000
PLAYWRIGHT_START_COMMAND = ("node", "dist/api.js")
REFERENCE_BUILD_ARGUMENTS = {
    "api": (f"GIT_SHA={FIRECRAWL_COMMIT}",),
    "playwright": (f"PORT={PLAYWRIGHT_INTERNAL_PORT}",),
}
CANCELLATION_FIXTURE_MS = 5000
CANCELLATION_PROMPT_BOUND_MS = 3000
BASE_IMAGES = (
    {
        "from": "node:22-slim",
        "repository": "docker.io/library/node",
        "indexDigest": "sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436",
        "platformDigest": "sha256:a17d50af28002a160548bd4225b3cfcb12c5efcb171f79e68758f2885fb1b066",
        "configDigest": "sha256:fc8cd9deea7389d01d9a70cc83a5d09465c2050f2ae322d67300a9794433edad",
    },
    {
        "from": "golang:1.24",
        "repository": "docker.io/library/golang",
        "indexDigest": "sha256:d2d2bc1c84f7e60d7d2438a3836ae7d0c847f4888464e7ec9ba3a1339a1ee804",
        "platformDigest": "sha256:46fdd02b6cbcd624a4087ea298e4c8505e5d400c4ee5181e4dd06e2297d647ae",
        "configDigest": "sha256:00925efecb9c93b3208f48a9e8ae8b1d426be1fff78baf2fc9d394d198fe9fc8",
    },
    {
        "from": "redis:alpine",
        "repository": "docker.io/library/redis",
        "indexDigest": "sha256:978f0e01593e65eed801f2402944efcd936d43b5027e4908a7897baf88ed6241",
        "platformDigest": "sha256:a6a88248ad5b0c724b7f2b380b7d21f46097db158b2b077ef85bcb97f90aee3a",
        "configDigest": "sha256:cc48e0fe25c0095fb69b711b6c110b3801e7b30189e14358a5f16d4a747c9ec0",
    },
)
TOKEN_PATTERN = re.compile(r"[\w]+(?:['’-][\w]+)*", re.UNICODE)
BEARER_PATTERN = re.compile(r"(?i)(authorization:\s*bearer\s+)[^\s\"']+")
FIXTURE_PORT_ALIASES: dict[int, str] = {}


def utc_now() -> str:
    return (
        datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    )


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def canonical_sha256_digest(value: object) -> str:
    if not isinstance(value, str):
        raise RuntimeError("OCI digest is not a string")
    digest = value.removeprefix("sha256:")
    if not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise RuntimeError("OCI digest is malformed")
    return f"sha256:{digest}"


def write_json(path: pathlib.Path, value: object) -> None:
    path.write_text(
        json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    path.chmod(0o600)


def write_bytes(path: pathlib.Path, value: bytes) -> None:
    path.write_bytes(value)
    path.chmod(0o600)


class Redactor:
    def __init__(self) -> None:
        self.replacements: list[tuple[str, str]] = []

    def add(self, value: str, replacement: str) -> None:
        if value:
            self.replacements.append((value, replacement))
            self.replacements.sort(key=lambda item: len(item[0]), reverse=True)

    def text(self, value: str) -> str:
        result = BEARER_PATTERN.sub(r"\1<redacted>", value)
        for original, replacement in self.replacements:
            result = result.replace(original, replacement)
        return result

    def data(self, value: bytes) -> bytes:
        return self.text(value.decode("utf-8", "replace")).encode()


class Recorder:
    def __init__(self, artifacts: pathlib.Path, redactor: Redactor):
        self.artifacts = artifacts
        self.redactor = redactor
        self.commands: list[dict[str, object]] = []

    def run(
        self,
        name: str,
        command: list[str],
        *,
        cwd: pathlib.Path | None = None,
        check: bool = True,
        timeout: float | None = None,
    ) -> subprocess.CompletedProcess[str]:
        started = time.monotonic()
        process = subprocess.Popen(
            command,
            cwd=cwd,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        interrupted: str | None = None
        pending_error: BaseException | None = None
        try:
            stdout, _stderr = process.communicate(timeout=timeout)
        except (KeyboardInterrupt, subprocess.TimeoutExpired) as error:
            interrupted = type(error).__name__
            with contextlib.suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGTERM)
            try:
                stdout, _stderr = process.communicate(timeout=15)
            except subprocess.TimeoutExpired:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(process.pid, signal.SIGKILL)
                stdout, _stderr = process.communicate(timeout=5)
            pending_error = (
                error
                if isinstance(error, KeyboardInterrupt)
                else RuntimeError(f"{name} timed out")
            )
        result = subprocess.CompletedProcess(command, process.returncode, stdout)
        output_path = self.artifacts / f"command-{len(self.commands):02d}-{name}.log"
        output_path.write_text(self.redactor.text(result.stdout), encoding="utf-8")
        output_path.chmod(0o600)
        self.commands.append({
            "name": name,
            "argv": [self.redactor.text(item) for item in command],
            "cwd": self.redactor.text(str(cwd)) if cwd else None,
            "exitCode": result.returncode,
            "durationMilliseconds": round((time.monotonic() - started) * 1000),
            "output": output_path.name,
            "interrupted": interrupted,
        })
        if pending_error:
            raise pending_error
        if check and result.returncode:
            raise RuntimeError(f"{name} failed with exit code {result.returncode}")
        return result


class SemanticHTMLParser(html.parser.HTMLParser):
    def __init__(self, base_url: str):
        super().__init__(convert_charrefs=True)
        self.base_url = base_url
        self.title_parts: list[str] = []
        self.text_parts: list[str] = []
        self.headings: list[dict[str, object]] = []
        self.links: list[str] = []
        self.final_url: str | None = None
        self.hidden_depth = 0
        self.title_depth = 0
        self.heading: tuple[int, list[str]] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        if tag in {"script", "style", "template", "noscript", "head"}:
            self.hidden_depth += 1
        if tag == "title":
            self.title_depth += 1
        if re.fullmatch(r"h[1-6]", tag):
            self.heading = (int(tag[1]), [])
        if tag == "a" and values.get("href"):
            self.links.append(urllib.parse.urljoin(self.base_url, values["href"]))
        if tag == "base" and values.get("href"):
            self.base_url = urllib.parse.urljoin(self.base_url, values["href"])
        if tag == "html" and values.get("data-fixture-final-url"):
            self.final_url = values["data-fixture-final-url"]

    def handle_endtag(self, tag: str) -> None:
        if re.fullmatch(r"h[1-6]", tag) and self.heading:
            level, parts = self.heading
            text = " ".join("".join(parts).split())
            self.headings.append({"level": level, "text": text})
            self.heading = None
        if tag == "title" and self.title_depth:
            self.title_depth -= 1
        if tag in {"script", "style", "template", "noscript", "head"}:
            self.hidden_depth = max(0, self.hidden_depth - 1)

    def handle_data(self, data: str) -> None:
        if self.title_depth:
            self.title_parts.append(data)
        if self.heading:
            self.heading[1].append(data)
        if not self.hidden_depth and data.strip():
            self.text_parts.append(data)

    def result(self) -> dict[str, object]:
        return {
            "title": " ".join("".join(self.title_parts).split()),
            "headings": self.headings,
            "links": self.links,
            "visibleText": " ".join(" ".join(self.text_parts).split()),
            "finalUrl": self.final_url,
        }


def parse_html(value: str, base_url: str) -> dict[str, object]:
    parser = SemanticHTMLParser(base_url)
    parser.feed(value)
    parser.close()
    return parser.result()


def tokens(value: str) -> collections.Counter[str]:
    return collections.Counter(
        match.group(0).casefold() for match in TOKEN_PATTERN.finditer(value)
    )


def token_recall(reference: str, candidate: str) -> float:
    expected = tokens(reference)
    if not expected:
        return 1.0
    actual = tokens(candidate)
    matched = sum(min(count, actual[token]) for token, count in expected.items())
    return matched / sum(expected.values())


def normalize_fixture_url(value: str | None) -> str | None:
    if value is None:
        return None
    parsed = urllib.parse.urlsplit(value)
    hosts = {
        "fixture:8080": "fixture.test",
        "other-fixture:8080": "other-fixture.test",
        "fixture.test:8080": "fixture.test",
        "other-fixture.test:8080": "other-fixture.test",
    }
    authority = hosts.get(parsed.netloc, parsed.netloc)
    if parsed.hostname in {"127.0.0.1", "localhost", "::1"}:
        authority = FIXTURE_PORT_ALIASES.get(parsed.port or 0, "fixture.test")
    query = []
    for name, query_value in urllib.parse.parse_qsl(
        parsed.query, keep_blank_values=True
    ):
        query_url = urllib.parse.urlsplit(query_value)
        normalized_query_value = query_value
        if query_url.scheme in {"http", "https"} and query_url.netloc:
            normalized_query_value = normalize_fixture_url(query_value) or query_value
        query.append((name, normalized_query_value))
    return urllib.parse.urlunsplit((
        parsed.scheme,
        authority,
        parsed.path,
        urllib.parse.urlencode(query),
        parsed.fragment,
    ))


def content_type(headers: list[tuple[str, str]]) -> str:
    for name, value in headers:
        if name.lower() == "content-type":
            return value
    return ""


def random_loopback_ports(count: int) -> list[int]:
    listeners = []
    try:
        for _index in range(count):
            listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            listener.bind(("127.0.0.1", 0))
            listeners.append(listener)
        return [int(listener.getsockname()[1]) for listener in listeners]
    finally:
        for listener in listeners:
            listener.close()


def wait_ports_closed(ports: list[int], timeout: float = 5) -> dict[str, object]:
    deadline = time.monotonic() + timeout
    open_ports = list(ports)
    while open_ports:
        current = []
        for port in open_ports:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
                probe.settimeout(0.1)
                if probe.connect_ex(("127.0.0.1", port)) == 0:
                    current.append(port)
        open_ports = current
        if not open_ports or time.monotonic() >= deadline:
            break
        time.sleep(0.05)
    return {"passed": not open_ports, "openPorts": open_ports}


def bounded_timeout(value: str) -> float:
    result = float(value)
    if not 1 <= result <= 3600:
        raise argparse.ArgumentTypeError("timeout must be from 1 through 3600 seconds")
    return result


def cancellation_prompt_passed(duration_milliseconds: object) -> bool:
    return (
        isinstance(duration_milliseconds, (int, float))
        and 0 <= duration_milliseconds < CANCELLATION_PROMPT_BOUND_MS
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifacts", required=True)
    parser.add_argument("--source-root")
    parser.add_argument("--gecko-connection")
    parser.add_argument("--timeout", type=bounded_timeout, default=180.0)
    parser.add_argument("--skip-stress", action="store_true")
    return parser.parse_args()


def validate_artifacts(value: str) -> pathlib.Path:
    artifacts = pathlib.Path(value).resolve()
    try:
        artifacts.relative_to(CHECKOUT)
    except ValueError:
        pass
    else:
        raise RuntimeError("Comparison artifacts must be outside the checkout")
    artifacts.mkdir(mode=0o700, parents=True, exist_ok=False)
    artifacts.chmod(0o700)
    return artifacts


def create_ephemeral_podman_run_root(
    base: pathlib.Path | None = None,
) -> pathlib.Path:
    uid = os.geteuid()
    runtime_base = (
        base
        if base is not None
        else pathlib.Path(os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{uid}"))
    ).resolve(strict=True)
    metadata = runtime_base.stat()
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or metadata.st_uid != uid
        or metadata.st_mode & 0o077
    ):
        raise RuntimeError("User runtime directory is not private and owner-controlled")
    run_root = pathlib.Path(
        tempfile.mkdtemp(prefix="wildbuzzard-firecrawl-podman-", dir=runtime_base)
    )
    run_root.chmod(0o700)
    return run_root


def configure_isolated_podman_storage(
    work: pathlib.Path, run_root: pathlib.Path
) -> dict[str, object]:
    graph_root = work / "podman-graph"
    graph_root.mkdir(mode=0o700)
    if not run_root.is_dir() or run_root.stat().st_mode & 0o077:
        raise RuntimeError("Podman run root must be a private directory")
    storage_config = work / "storage.conf"
    value = (
        "[storage]\n"
        'driver = "overlay"\n'
        f"graphroot = {json.dumps(str(graph_root))}\n"
        f"runroot = {json.dumps(str(run_root))}\n"
    )
    storage_config.write_text(value, encoding="utf-8")
    storage_config.chmod(0o600)
    crun_wrapper = work / "crun-wrapper"
    crun_wrapper.write_text(
        "#!/bin/bash\n"
        "set -euo pipefail\n"
        "arguments=()\n"
        "inserted=0\n"
        'for argument in "$@"; do\n'
        '  arguments+=("$argument")\n'
        '  if [[ "$inserted" == 0 && '
        '("$argument" == create || "$argument" == run) ]]; then\n'
        '    arguments+=("--no-new-keyring")\n'
        "    inserted=1\n"
        "  fi\n"
        "done\n"
        'exec /usr/bin/crun "${arguments[@]}"\n',
        encoding="utf-8",
    )
    crun_wrapper.chmod(0o700)
    engine_config = work / "containers.conf"
    engine_config.write_text(
        '[engine]\nruntime = "oracle-crun"\n\n'
        f'[engine.runtimes]\noracle-crun = [{json.dumps(str(crun_wrapper))}]\n',
        encoding="utf-8",
    )
    engine_config.chmod(0o600)
    os.environ["CONTAINERS_STORAGE_CONF"] = str(storage_config)
    os.environ["CONTAINERS_CONF"] = str(engine_config)
    return {
        "driver": "overlay",
        "configSha256": sha256_file(storage_config),
        "engineConfigSha256": sha256_file(engine_config),
        "runtimeWrapperSha256": sha256_file(crun_wrapper),
        "runtime": "oracle-crun",
        "runtimeFlags": ["no-new-keyring"],
        "isolated": True,
        "ephemeralUserRunRoot": True,
    }


def current_key_quota() -> dict[str, int]:
    uid = os.geteuid()
    for line in pathlib.Path("/proc/key-users").read_text(encoding="utf-8").splitlines():
        match = re.fullmatch(
            rf"\s*{uid}:\s+(\d+)\s+(\d+)/(\d+)\s+(\d+)/(\d+)\s+"
            r"(\d+)/(\d+)\s*",
            line,
        )
        if match:
            return {
                "usage": int(match.group(1)),
                "instantiated": int(match.group(2)),
                "instantiatedQuota": int(match.group(3)),
                "keyUsage": int(match.group(4)),
                "keyQuota": int(match.group(5)),
                "byteUsage": int(match.group(6)),
                "byteQuota": int(match.group(7)),
            }
    raise RuntimeError("Current user key quota is unavailable")


def verify_rootless_podman(recorder: Recorder) -> dict[str, object]:
    if os.geteuid() == 0:
        raise RuntimeError("The Firecrawl comparison must not run as root")
    version = recorder.run("podman-version", ["podman", "version", "--format", "json"])
    info = recorder.run(
        "podman-rootless", ["podman", "info", "--format", "{{.Host.Security.Rootless}}"]
    )
    if info.stdout.strip() != "true":
        raise RuntimeError("Podman is not operating rootlessly")
    return json.loads(version.stdout)


def dockerfile_from_references(value: str) -> list[str]:
    references = []
    for line in value.splitlines():
        match = re.match(
            r"^\s*FROM(?:\s+--platform=\S+)?\s+(\S+)(?:\s+AS\s+\S+)?\s*$",
            line,
            re.IGNORECASE,
        )
        if match:
            references.append(match.group(1))
    return references


def verify_dockerfile_base_references(source: pathlib.Path) -> dict[str, list[str]]:
    paths = {
        "api": source / "apps" / "api" / "Dockerfile",
        "playwright": source / "apps" / "playwright-service-ts" / "Dockerfile",
    }
    actual = {
        name: dockerfile_from_references(path.read_text(encoding="utf-8"))
        for name, path in paths.items()
    }
    expected = {
        "api": ["node:22-slim", "golang:1.24", "base", "base"],
        "playwright": ["node:22-slim"],
    }
    if actual != expected:
        raise RuntimeError("Firecrawl Dockerfile base references changed")
    return actual


def verify_upstream_runtime_contract(source: pathlib.Path) -> dict[str, object]:
    compose_path = source / "docker-compose.yaml"
    dockerfile_path = source / "apps" / "playwright-service-ts" / "Dockerfile"
    package_path = source / "apps" / "playwright-service-ts" / "package.json"
    compose = compose_path.read_text(encoding="utf-8")
    dockerfile = dockerfile_path.read_text(encoding="utf-8")
    package = json.loads(package_path.read_text(encoding="utf-8"))
    compose_port = re.search(
        r"(?ms)^  playwright-service:\s*.*?^    environment:\s*.*?"
        r"^      PORT:\s*([0-9]+)\s*$",
        compose,
    )
    compose_url = re.search(
        r"(?m)^  PLAYWRIGHT_MICROSERVICE_URL:.*?playwright-service:([0-9]+)/scrape",
        compose,
    )
    dockerfile_contract = re.search(
        r"(?m)^ARG PORT\s*$\n^ENV PORT=\$\{PORT\}\s*$\n\s*^EXPOSE \$\{PORT\}\s*$",
        dockerfile,
    )
    ports = {
        int(match.group(1))
        for match in (compose_port, compose_url)
        if match is not None
    }
    if (
        compose_port is None
        or compose_url is None
        or ports != {PLAYWRIGHT_INTERNAL_PORT}
        or dockerfile_contract is None
        or package.get("scripts", {}).get("start")
        != " ".join(PLAYWRIGHT_START_COMMAND)
        or package.get("packageManager") != "pnpm@11.4.0"
    ):
        raise RuntimeError("Firecrawl Playwright runtime contract changed")
    return {
        "composeSha256": sha256_file(compose_path),
        "playwrightPort": PLAYWRIGHT_INTERNAL_PORT,
        "playwrightBuildArguments": list(REFERENCE_BUILD_ARGUMENTS["playwright"]),
        "playwrightStartCommand": list(PLAYWRIGHT_START_COMMAND),
        "playwrightPackageSha256": sha256_file(package_path),
    }


def reference_image_build_command(
    service: str,
    image: str,
    dockerfile: pathlib.Path,
    context: pathlib.Path,
) -> list[str]:
    if service not in REFERENCE_BUILD_ARGUMENTS:
        raise RuntimeError(f"Unknown Firecrawl reference service: {service}")
    command = [
        "podman",
        "build",
        "--pull=never",
        "--platform",
        BASE_PLATFORM,
        "--rm=true",
        "--force-rm=true",
    ]
    for argument in REFERENCE_BUILD_ARGUMENTS[service]:
        command.extend(["--build-arg", argument])
    command.extend(["--tag", image, "--file", str(dockerfile), str(context)])
    return command


def prepare_source(
    args: argparse.Namespace, work: pathlib.Path, recorder: Recorder
) -> tuple[pathlib.Path, dict[str, object]]:
    if args.source_root:
        source = pathlib.Path(args.source_root).resolve(strict=True)
    else:
        source = work / "firecrawl"
        recorder.run(
            "source-clone",
            [
                "git",
                "clone",
                "--depth",
                "1",
                "--branch",
                FIRECRAWL_TAG,
                FIRECRAWL_REPOSITORY,
                str(source),
            ],
        )
    head = recorder.run("source-head", ["git", "rev-parse", "HEAD"], cwd=source)
    tag = recorder.run(
        "source-tag", ["git", "describe", "--exact-match", "--tags", "HEAD"], cwd=source
    )
    tag_object = recorder.run(
        "source-tag-object",
        ["git", "rev-parse", f"{FIRECRAWL_TAG}^{{tag}}"],
        cwd=source,
    )
    tag_metadata = recorder.run(
        "source-tag-metadata", ["git", "cat-file", "tag", FIRECRAWL_TAG], cwd=source
    )
    tag_signature = recorder.run(
        "source-tag-signature",
        ["git", "tag", "--verify", FIRECRAWL_TAG],
        cwd=source,
        check=False,
    )
    remote_tags = recorder.run(
        "source-remote-tags",
        [
            "git",
            "ls-remote",
            "--tags",
            FIRECRAWL_REPOSITORY,
            f"refs/tags/{FIRECRAWL_TAG}",
            f"refs/tags/{FIRECRAWL_TAG}^{{}}",
        ],
    )
    tree = recorder.run("source-tree", ["git", "rev-parse", "HEAD^{tree}"], cwd=source)
    status_result = recorder.run(
        "source-status",
        ["git", "status", "--porcelain=v1", "--untracked-files=all"],
        cwd=source,
    )
    remote = recorder.run(
        "source-remote", ["git", "remote", "get-url", "origin"], cwd=source
    )
    if head.stdout.strip() != FIRECRAWL_COMMIT:
        raise RuntimeError("Firecrawl source commit mismatch")
    if tag.stdout.strip() != FIRECRAWL_TAG:
        raise RuntimeError("Firecrawl source tag mismatch")
    if tag_object.stdout.strip() != FIRECRAWL_TAG_OBJECT:
        raise RuntimeError("Firecrawl annotated tag object mismatch")
    metadata_lines = tag_metadata.stdout.splitlines()
    if (
        f"object {FIRECRAWL_COMMIT}" not in metadata_lines
        or "type commit" not in metadata_lines
        or f"tag {FIRECRAWL_TAG}" not in metadata_lines
    ):
        raise RuntimeError("Firecrawl annotated tag metadata mismatch")
    expected_remote_tags = {
        f"{FIRECRAWL_TAG_OBJECT}\trefs/tags/{FIRECRAWL_TAG}",
        f"{FIRECRAWL_COMMIT}\trefs/tags/{FIRECRAWL_TAG}^{{}}",
    }
    if set(remote_tags.stdout.splitlines()) != expected_remote_tags:
        raise RuntimeError("Firecrawl remote tag or peeled commit mismatch")
    if status_result.stdout:
        raise RuntimeError("Firecrawl source checkout is not pristine")
    if remote.stdout.strip() != FIRECRAWL_REPOSITORY:
        raise RuntimeError("Firecrawl source remote mismatch")
    identity = {
        "repository": FIRECRAWL_REPOSITORY,
        "tag": FIRECRAWL_TAG,
        "tagObject": FIRECRAWL_TAG_OBJECT,
        "tagAnnotated": True,
        "tagMetadataSha256": sha256_bytes(tag_metadata.stdout.encode()),
        "tagSignatureVerified": tag_signature.returncode == 0,
        "tagSignatureStatus": (
            "verified" if tag_signature.returncode == 0 else "unsigned annotated tag"
        ),
        "commit": FIRECRAWL_COMMIT,
        "tree": tree.stdout.strip(),
        "dockerfileBaseReferences": verify_dockerfile_base_references(source),
        "runtimeContract": verify_upstream_runtime_contract(source),
        "dockerfiles": {
            "api": sha256_file(source / "apps" / "api" / "Dockerfile"),
            "playwright": sha256_file(
                source / "apps" / "playwright-service-ts" / "Dockerfile"
            ),
        },
        "locks": {
            "api": sha256_file(source / "apps" / "api" / "pnpm-lock.yaml"),
            "playwright": sha256_file(
                source / "apps" / "playwright-service-ts" / "pnpm-lock.yaml"
            ),
        },
    }
    return source, identity


def inspect_image(recorder: Recorder, name: str, reference: str) -> dict[str, object]:
    result = recorder.run(name, ["podman", "image", "inspect", reference])
    value = json.loads(result.stdout)[0]
    return {
        "reference": reference,
        "id": value.get("Id"),
        "digest": value.get("Digest"),
        "repoDigests": value.get("RepoDigests", []),
        "created": value.get("Created"),
        "architecture": value.get("Architecture"),
        "os": value.get("Os"),
        "rootfsLayers": value.get("RootFS", {}).get("Layers", []),
    }


def base_tag_reference(image: dict[str, str]) -> str:
    tag = image["from"].split(":", 1)[1]
    return f"{image['repository']}:{tag}"


def base_platform_reference(image: dict[str, str]) -> str:
    return f"{image['repository']}@{image['platformDigest']}"


def pinned_platform_descriptor(
    index: dict[str, object], image: dict[str, str]
) -> dict[str, object]:
    manifests = index.get("manifests")
    if not isinstance(manifests, list):
        raise RuntimeError("Pinned base index has no manifest list")
    matches = []
    for descriptor in manifests:
        if not isinstance(descriptor, dict):
            continue
        platform_value = descriptor.get("platform")
        if not isinstance(platform_value, dict):
            continue
        if (
            platform_value.get("os") == "linux"
            and platform_value.get("architecture") == "amd64"
            and not platform_value.get("variant")
        ):
            matches.append(descriptor)
    if len(matches) != 1 or matches[0].get("digest") != image["platformDigest"]:
        raise RuntimeError("Pinned base index platform descriptor mismatch")
    return matches[0]


def validate_base_identity(image: dict[str, str], identity: dict[str, object]) -> None:
    try:
        config_digest = canonical_sha256_digest(identity.get("id"))
    except RuntimeError as error:
        raise RuntimeError("Pinned base config digest mismatch") from error
    if config_digest != image["configDigest"]:
        raise RuntimeError("Pinned base config digest mismatch")
    try:
        platform_digest = canonical_sha256_digest(identity.get("digest"))
    except RuntimeError as error:
        raise RuntimeError("Pinned base platform digest mismatch") from error
    if platform_digest != image["platformDigest"]:
        raise RuntimeError("Pinned base platform digest mismatch")
    if identity.get("os") != "linux" or identity.get("architecture") != "amd64":
        raise RuntimeError("Pinned base platform identity mismatch")


def pull_bases(recorder: Recorder) -> list[dict[str, object]]:
    identities = []
    for index, image in enumerate(BASE_IMAGES):
        index_reference = f"{image['repository']}@{image['indexDigest']}"
        platform_reference = base_platform_reference(image)
        manifest_result = recorder.run(
            f"base-index-{index}",
            ["podman", "manifest", "inspect", index_reference],
        )
        descriptor = pinned_platform_descriptor(
            json.loads(manifest_result.stdout), image
        )
        recorder.run(
            f"base-pull-{index}",
            [
                "podman",
                "pull",
                "--platform",
                BASE_PLATFORM,
                platform_reference,
            ],
        )
        pinned = inspect_image(
            recorder, f"base-pinned-inspect-{index}", platform_reference
        )
        validate_base_identity(image, pinned)
        tag_reference = base_tag_reference(image)
        recorder.run(
            f"base-tag-{index}", ["podman", "tag", str(pinned["id"]), tag_reference]
        )
        tagged = inspect_image(recorder, f"base-tagged-inspect-{index}", tag_reference)
        literal = inspect_image(
            recorder, f"base-literal-inspect-{index}", image["from"]
        )
        validate_base_identity(image, tagged)
        validate_base_identity(image, literal)
        identities.append({
            "from": image["from"],
            "platform": BASE_PLATFORM,
            "indexDigest": image["indexDigest"],
            "platformDescriptor": descriptor,
            "platformDigest": image["platformDigest"],
            "configDigest": image["configDigest"],
            "pinned": pinned,
            "tagged": tagged,
            "literal": literal,
        })
    return identities


def verify_tagged_bases(recorder: Recorder, phase: str) -> list[dict[str, object]]:
    identities = []
    for index, image in enumerate(BASE_IMAGES):
        identity = inspect_image(
            recorder, f"base-{phase}-inspect-{index}", image["from"]
        )
        validate_base_identity(image, identity)
        identities.append(identity)
    return identities


def wait_http(
    port: int,
    path: str,
    timeout: float,
    *,
    expected: int = 200,
) -> bytes:
    deadline = time.monotonic() + timeout
    last_error = "not started"
    while time.monotonic() < deadline:
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        try:
            connection.request("GET", path, headers={"Connection": "close"})
            response = connection.getresponse()
            body = response.read()
            if response.status == expected:
                return body
            last_error = f"HTTP {response.status}: {body[:200]!r}"
        except (OSError, http.client.HTTPException) as error:
            last_error = str(error)
        finally:
            connection.close()
        time.sleep(0.2)
    raise RuntimeError(f"Timed out waiting for {path}: {last_error}")


def create_container(
    recorder: Recorder,
    name: str,
    arguments: list[str],
    created_containers: list[str],
) -> str:
    result = recorder.run(
        f"container-create-{name.rsplit('-', 1)[-1]}",
        ["podman", "create", "--pull=never", "--name", name, *arguments],
    )
    identity = result.stdout.strip()
    if not identity:
        raise RuntimeError(f"Podman did not return a container ID for {name}")
    created_containers.append(name)
    recorder.run(
        f"container-start-{name.rsplit('-', 1)[-1]}", ["podman", "start", name]
    )
    return identity


def http_json_request(
    port: int,
    method: str,
    path: str,
    payload: object | None,
    timeout: float,
) -> dict[str, object]:
    body = (
        b"" if payload is None else json.dumps(payload, separators=(",", ":")).encode()
    )
    headers = {
        "Accept": "application/json",
        "Connection": "close",
        "User-Agent": "WildBuzzard-Firecrawl-Comparator/1",
    }
    if payload is not None:
        headers["Content-Type"] = "application/json"
        headers["Content-Length"] = str(len(body))
    started = time.monotonic()
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    try:
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        response_body = response.read()
        return {
            "status": response.status,
            "reason": response.reason,
            "headers": list(response.getheaders()),
            "body": response_body,
            "durationMilliseconds": round((time.monotonic() - started) * 1000),
            "requestHeaders": list(headers.items()),
            "requestBody": body,
        }
    finally:
        connection.close()


def request_transcript(method: str, path: str, response: dict[str, object]) -> bytes:
    headers = "\r\n".join(
        f"{name}: {value}" for name, value in response["requestHeaders"]
    )
    body = response["requestBody"]
    if not isinstance(body, bytes):
        raise TypeError("request body must be bytes")
    return f"{method} {path} HTTP/1.1\r\n{headers}\r\n\r\n".encode() + body


def response_transcript(response: dict[str, object]) -> bytes:
    headers = "\r\n".join(f"{name}: {value}" for name, value in response["headers"])
    body = response["body"]
    if not isinstance(body, bytes):
        raise TypeError("response body must be bytes")
    return (
        f"HTTP/1.1 {response['status']} {response['reason']}\r\n{headers}\r\n\r\n".encode()
        + body
    )


def scenario_definitions(include_stress: bool) -> list[dict[str, object]]:
    scenarios: list[dict[str, object]] = [
        {
            "name": "static-html",
            "path": "/static",
            "status": 200,
            "contentType": "text/html; charset=utf-8",
            "title": "WildBuzzard Static Fixture",
            "headings": [
                {"level": 1, "text": "Static renderer concordance"},
                {"level": 2, "text": "Deterministic link targets"},
            ],
            "visible": "Static renderer concordance amber birch cobalt delta ember fern granite harbor indigo juniper kelp lantern meadow nectar orchid pebble quartz river saffron timber umber violet willow xenon yarrow zephyr Deterministic link targets Relative target External target",
            "links": [
                "http://fixture.test/target/relative?b=2&a=1#fragment",
                "https://example.test/reference?q=one",
            ],
        },
        {
            "name": "javascript-dom",
            "path": "/dynamic",
            "waitFor": 250,
            "status": 200,
            "contentType": "text/html; charset=utf-8",
            "title": "WildBuzzard Dynamic Fixture",
            "headings": [
                {"level": 1, "text": "JavaScript rendered concordance"},
                {"level": 2, "text": "Mutated links"},
            ],
            "visible": "JavaScript rendered concordance apricot beacon cedar dune elm fjord galaxy helix iris jasmine kindle lagoon mosaic nebula opal prairie quasar ridge solar tundra unity velvet wheat xylem yucca zenith Mutated links Dynamic target",
            "links": ["http://fixture.test/target/dynamic"],
        },
        {
            "name": "delayed-selector",
            "path": "/delayed",
            "waitFor": 350,
            "selector": "#ready",
            "status": 200,
            "contentType": "text/html; charset=utf-8",
            "title": "Delayed Selector Fixture",
            "headings": [
                {"level": 1, "text": "Delayed selector concordance"},
                {"level": 2, "text": "Selector became ready"},
            ],
            "visible": "Delayed selector concordance Selector became ready bounded patient deterministic arrival",
            "links": [],
        },
        {
            "name": "redirect-chain",
            "path": "/redirect/start",
            "waitFor": 100,
            "status": 200,
            "contentType": "text/html; charset=utf-8",
            "finalPath": "/redirect/final?hop=two",
            "title": "Redirect Final Fixture",
            "headings": [{"level": 1, "text": "Redirect destination concordance"}],
            "visible": "Redirect destination concordance final location marker preserved exactly Redirect sibling",
            "links": ["http://fixture.test/redirect/sibling"],
        },
        {
            "name": "status-204",
            "path": "/status/204",
            "status": 204,
            "contentType": "",
            "body": "",
            "referenceError": {
                "httpStatus": 500,
                "code": "SCRAPE_ALL_ENGINES_FAILED",
            },
            "documentedDifference": (
                "Firecrawl reports SCRAPE_ALL_ENGINES_FAILED for an HTTP 204 "
                "target while Gecko preserves the 204 response"
            ),
        },
        {
            "name": "status-404",
            "path": "/status/404",
            "status": 404,
            "contentType": "text/html; charset=utf-8",
            "title": "Missing Fixture",
            "headings": [{"level": 1, "text": "Deterministic not found"}],
            "visible": "Deterministic not found missing resource body retained",
            "links": [],
        },
        {
            "name": "json",
            "path": "/json",
            "status": 200,
            "contentType": "application/json; charset=utf-8",
            "body": '{"fixture":"json","unicode":"café 東京","ordered":[1,2,3]}',
        },
        {
            "name": "plain-text",
            "path": "/plain",
            "status": 200,
            "contentType": "text/plain; charset=utf-8",
            "body": "plain fixture alpha beta gamma café 東京",
        },
        {
            "name": "latin1-html",
            "path": "/encoding/latin1",
            "status": 200,
            "contentType": "text/html; charset=iso-8859-1",
            "title": "Latin One Fixture",
            "headings": [{"level": 1, "text": "Encoded concordance"}],
            "visible": "Encoded concordance café naïve façade jalapeño",
            "links": [],
        },
        {
            "name": "csp",
            "path": "/csp",
            "status": 200,
            "contentType": "text/html; charset=utf-8",
            "title": "CSP Fixture",
            "headings": [{"level": 1, "text": "CSP renderer concordance"}],
            "visible": "CSP renderer concordance policy script executed",
            "links": [],
        },
        {
            "name": "iframe",
            "path": "/iframe",
            "status": 200,
            "contentType": "text/html; charset=utf-8",
            "title": "Iframe Fixture",
            "headings": [{"level": 1, "text": "Outer frame concordance"}],
            "visible": "Outer frame concordance",
            "links": [],
        },
        {
            "name": "same-origin-header",
            "path": "/headers",
            "headers": {"X-Requested-With": "fixture-value"},
            "status": 200,
            "contentType": "text/html; charset=utf-8",
            "title": "Header Fixture",
            "headings": [{"level": 1, "text": "Header concordance"}],
            "visible": "Header concordance custom=fixture-value authorization=absent",
            "links": [],
        },
        {
            "name": "cross-origin-header",
            "path": "/redirect/cross-origin",
            "crossOrigin": True,
            "headers": {"X-Requested-With": "fixture-value"},
            "status": 200,
            "contentType": "text/html; charset=utf-8",
            "finalUrl": "http://other-fixture.test/headers",
            "title": "Header Fixture",
            "headings": [{"level": 1, "text": "Header concordance"}],
            "referenceVisible": "Header concordance custom=fixture-value authorization=absent",
            "geckoVisible": "Header concordance custom=absent authorization=absent",
            "links": [],
            "documentedDifference": "cross-origin custom headers are stripped by WildBuzzard",
        },
        {
            "name": "state-write",
            "path": "/state/write",
            "waitFor": 500,
            "status": 200,
            "contentType": "text/html; charset=utf-8",
            "title": "State Writer Fixture",
            "headings": [{"level": 1, "text": "State writer concordance"}],
            "visible": "State writer concordance cookie=true local=present session=present",
            "links": [],
        },
        {
            "name": "state-read-clean",
            "path": "/state/read",
            "waitFor": 500,
            "status": 200,
            "contentType": "text/html; charset=utf-8",
            "title": "State Reader Fixture",
            "headings": [{"level": 1, "text": "State reader concordance"}],
            "visible": "State reader concordance cookie=false;local=null;session=null;cache=false;workers=0",
            "links": [],
        },
    ]
    if include_stress:
        scenarios.extend([
            {
                "name": "oversized-body",
                "path": "/large-body",
                "stress": True,
                "geckoError": ["response"],
            },
            {
                "name": "oversized-dom",
                "path": "/large-dom",
                "stress": True,
                "geckoError": ["DOM node limit"],
            },
            {
                "name": "gzip-bomb",
                "path": "/gzip-bomb",
                "stress": True,
                "geckoError": ["response", "serialized output"],
            },
            {
                "name": "timeout",
                "path": "/slow?ms=2500",
                "timeout": 1000,
                "stress": True,
                "geckoError": ["timeout"],
            },
        ])
    return scenarios


def firecrawl_payload(url: str, scenario: dict[str, object]) -> dict[str, object]:
    payload: dict[str, object] = {
        "url": url,
        "formats": ["rawHtml", "links"],
        "onlyMainContent": False,
        "waitFor": int(scenario.get("waitFor", 100)),
        "timeout": int(scenario.get("timeout", 30000)),
    }
    if scenario.get("headers"):
        payload["headers"] = scenario["headers"]
    return payload


def firecrawl_document(
    response: dict[str, object], request_url: str
) -> tuple[dict[str, object] | None, dict[str, object]]:
    body = response["body"]
    if not isinstance(body, bytes):
        raise TypeError("response body must be bytes")
    try:
        parsed = json.loads(body)
    except json.JSONDecodeError:
        return None, {"parseError": "response is not JSON"}
    if not isinstance(parsed, dict) or parsed.get("success") is not True:
        return None, {"apiStatus": response["status"], "api": parsed}
    data = parsed.get("data")
    if not isinstance(data, dict):
        return None, {"parseError": "response has no data object"}
    metadata = data.get("metadata") if isinstance(data.get("metadata"), dict) else {}
    raw_html = data.get("rawHtml") if isinstance(data.get("rawHtml"), str) else ""
    media_type = str(metadata.get("contentType", ""))
    semantics: dict[str, object] = {
        "status": metadata.get("statusCode"),
        "contentType": media_type,
        "sourceURL": normalize_fixture_url(str(metadata.get("sourceURL", ""))),
        "rawHtmlSha256": sha256_bytes(raw_html.encode()),
        "rawHtmlBytes": len(raw_html.encode()),
    }
    if media_type.lower().startswith(("text/html", "application/xhtml+xml")):
        parsed_html = parse_html(raw_html, request_url)
        parsed_html["links"] = [
            normalize_fixture_url(value) for value in parsed_html["links"]
        ]
        parsed_html["finalUrl"] = normalize_fixture_url(parsed_html["finalUrl"])
        semantics.update(parsed_html)
    else:
        semantics["finalUrl"] = normalize_fixture_url(
            str(metadata.get("sourceURL", ""))
        )
        semantics["bodySha256"] = sha256_bytes(raw_html.encode())
    return data, semantics


def evaluate_reference(
    scenario: dict[str, object], semantics: dict[str, object]
) -> tuple[bool, list[str]]:
    if scenario.get("stress"):
        return True, []
    reference_error = scenario.get("referenceError")
    if isinstance(reference_error, dict):
        api = semantics.get("api")
        failures = []
        if semantics.get("apiStatus") != reference_error.get("httpStatus"):
            failures.append("reference error HTTP status differs")
        if not isinstance(api, dict) or api.get("code") != reference_error.get("code"):
            failures.append("reference error code differs")
        if not isinstance(api, dict) or api.get("success") is not False:
            failures.append("reference error success flag differs")
        return not failures, failures
    failures = []
    for key in ("status", "contentType"):
        if semantics.get(key) != scenario.get(key):
            failures.append(
                f"{key}: expected {scenario.get(key)!r}, got {semantics.get(key)!r}"
            )
    expected_final = scenario.get("finalUrl") or normalize_fixture_url(
        f"http://fixture.test:8080{scenario.get('finalPath', scenario['path'])}"
    )
    if semantics.get("finalUrl") != expected_final:
        failures.append(
            f"finalUrl: expected {expected_final!r}, got {semantics.get('finalUrl')!r}"
        )
    for key in ("title", "headings", "links"):
        if key in scenario and semantics.get(key) != scenario[key]:
            failures.append(f"{key} differs")
    if "body" in scenario:
        expected_hash = sha256_bytes(str(scenario["body"]).encode())
        if semantics.get("bodySha256") != expected_hash:
            failures.append("bodySha256 differs")
    expected_visible = scenario.get("referenceVisible", scenario.get("visible"))
    if expected_visible is not None:
        recall = token_recall(
            str(expected_visible), str(semantics.get("visibleText", ""))
        )
        semantics["fixtureTokenRecall"] = recall
        if recall < 0.95:
            failures.append(f"visible token recall {recall:.4f} is below 0.95")
    return not failures, failures


def playwright_health_state(port: int, timeout: float) -> dict[str, object]:
    response = http_json_request(port, "GET", "/health", None, timeout)
    body = response["body"]
    if response["status"] != 200 or not isinstance(body, bytes):
        raise RuntimeError(f"Playwright health failed with HTTP {response['status']}")
    value = json.loads(body)
    if not isinstance(value, dict):
        raise RuntimeError("Playwright health response is not an object")
    return value


def playwright_health(port: int, timeout: float) -> dict[str, object]:
    value = playwright_health_state(port, timeout)
    if value.get("activePages") != 0:
        raise RuntimeError(
            f"Playwright retained {value.get('activePages')} active pages"
        )
    return value


def fixture_activity(port: int, timeout: float) -> int:
    response = http_json_request(port, "GET", "/activity", None, timeout)
    body = response["body"]
    if response["status"] != 200 or not isinstance(body, bytes):
        raise RuntimeError(f"Fixture activity failed with HTTP {response['status']}")
    value = json.loads(body)
    active = value.get("activeSlowRequests")
    if not isinstance(active, int) or active < 0:
        raise RuntimeError("Fixture returned invalid activity state")
    return active


def wait_fixture_activity(
    port: int, predicate: Callable[[int], bool], timeout: float
) -> tuple[int, int]:
    deadline = time.monotonic() + timeout
    peak = 0
    latest = 0
    while time.monotonic() < deadline:
        latest = fixture_activity(port, min(5, timeout))
        peak = max(peak, latest)
        if predicate(latest):
            return latest, peak
        time.sleep(0.05)
    raise RuntimeError(f"Fixture activity did not reach the expected state: {latest}")


def renderer_processes(
    recorder: Recorder, container: str, name: str
) -> dict[str, object]:
    result = recorder.run(
        name,
        ["podman", "top", container, "pid", "comm", "args"],
    )
    lines = [line for line in result.stdout.splitlines()[1:] if line.strip()]
    renderers = [line for line in lines if "--type=renderer" in line]
    return {"processes": len(lines), "rendererProcesses": len(renderers)}


def wait_reference_cleanup(
    recorder: Recorder,
    playwright_port: int,
    playwright_container: str,
    baseline: dict[str, object],
    name: str,
    timeout: float,
) -> dict[str, object]:
    deadline = time.monotonic() + timeout
    latest: dict[str, object] = {}
    while time.monotonic() < deadline:
        try:
            health = playwright_health_state(playwright_port, min(5, timeout))
            processes = renderer_processes(
                recorder,
                playwright_container,
                f"cleanup-top-{name}-{len(recorder.commands)}",
            )
            latest = {"health": health, **processes}
            if (
                health.get("activePages") == 0
                and processes["rendererProcesses"] <= baseline["rendererProcesses"]
            ):
                latest["baselineRestored"] = True
                return latest
        except Exception as error:
            latest = {"error": f"{type(error).__name__}: {error}"}
        time.sleep(0.2)
    latest["baselineRestored"] = False
    raise RuntimeError(
        f"Playwright renderer process baseline was not restored after {name}"
    )


def record_http_exchange(
    directory: pathlib.Path,
    response: dict[str, object],
    redactor: Redactor,
) -> None:
    write_bytes(
        directory / "reference.request.http",
        redactor.data(request_transcript("POST", "/v2/scrape", response)),
    )
    write_bytes(
        directory / "reference.response.http",
        redactor.data(response_transcript(response)),
    )
    write_json(
        directory / "reference.timing.json",
        {"durationMilliseconds": response["durationMilliseconds"]},
    )


def read_gecko_connection(path_value: str) -> dict[str, object]:
    path = pathlib.Path(path_value).resolve(strict=True)
    path_stat = path.stat()
    if stat.S_IMODE(path_stat.st_mode) != 0o600:
        raise RuntimeError("Gecko browser-control connection file must be mode 0600")
    if path_stat.st_size > 65536:
        raise RuntimeError("Gecko browser-control connection record is too large")
    value = json.loads(path.read_text(encoding="utf-8"))
    if (
        not isinstance(value, dict)
        or not isinstance(value.get("port"), int)
        or not 0 < value["port"] <= 65535
        or not isinstance(value.get("token"), str)
        or not value["token"]
        or len(value["token"]) > 4096
    ):
        raise RuntimeError("Gecko browser-control connection record is invalid")
    return {"port": value["port"], "token": value["token"]}


def gecko_request_bytes(
    connection: dict[str, object],
    args: dict[str, object],
) -> tuple[str, bytes]:
    request_id = f"firecrawl-comparison-{secrets.token_hex(8)}"
    request = {
        "token": connection["token"],
        "id": request_id,
        "tool": "gecko_render",
        "args": args,
        "cwd": str(CHECKOUT),
        "clientId": "firecrawl-comparison",
    }
    return request_id, json.dumps(request, separators=(",", ":")).encode() + b"\n"


def receive_gecko(
    stream: socket.socket, request_id: str, timeout: float
) -> tuple[dict[str, object], bytes]:
    stream.settimeout(timeout)
    chunks = bytearray()
    while b"\n" not in chunks:
        block = stream.recv(65536)
        if not block:
            raise RuntimeError("Gecko closed the browser-control connection")
        chunks.extend(block)
        if len(chunks) > 16 * 1024 * 1024:
            raise RuntimeError("Gecko browser-control response exceeded the limit")
    response_bytes = bytes(chunks).split(b"\n", 1)[0]
    response = json.loads(response_bytes)
    if not isinstance(response, dict):
        raise RuntimeError("Gecko returned a non-object browser-control response")
    if response.get("id") != request_id:
        raise RuntimeError("Gecko returned a mismatched browser-control response")
    if response.get("ok") is not True:
        raise RuntimeError(str(response.get("error", "Gecko render failed")))
    result = response.get("result")
    details = result.get("details") if isinstance(result, dict) else None
    if not isinstance(details, dict):
        raise RuntimeError("Gecko returned no render details")
    return details, response_bytes


def call_gecko(
    connection: dict[str, object],
    args: dict[str, object],
    timeout: float,
) -> tuple[dict[str, object], bytes, bytes]:
    request_id, request_bytes = gecko_request_bytes(connection, args)
    with socket.create_connection(
        ("127.0.0.1", int(connection["port"])), timeout=timeout
    ) as stream:
        stream.sendall(request_bytes)
        details, response_bytes = receive_gecko(stream, request_id, timeout)
    return details, request_bytes, response_bytes


def gecko_semantics(details: dict[str, object]) -> dict[str, object]:
    media_type = str(details.get("contentType", ""))
    value: dict[str, object] = {
        "status": details.get("pageStatusCode"),
        "contentType": media_type,
        "finalUrl": normalize_fixture_url(str(details.get("finalUrl", ""))),
        "pageError": details.get("pageError"),
        "redirectCount": details.get("redirectCount"),
        "decodedBytes": details.get("decodedBytes"),
    }
    content = details.get("content") if isinstance(details.get("content"), str) else ""
    if media_type.lower().startswith(("text/html", "application/xhtml+xml")):
        parsed = parse_html(content, str(details.get("finalUrl", "")))
        parsed["links"] = [normalize_fixture_url(item) for item in parsed["links"]]
        parsed["finalUrlMarker"] = normalize_fixture_url(parsed.pop("finalUrl"))
        value.update(parsed)
    else:
        value["bodySha256"] = sha256_bytes(content.encode())
    value["contentSha256"] = sha256_bytes(content.encode())
    value["contentBytes"] = len(content.encode())
    return value


def assert_gecko_cleanup(details: dict[str, object]) -> None:
    expected = {
        "active": 0,
        "queued": 0,
        "contexts": 0,
        "userContexts": 0,
        "cleanupFailedFlags": 0,
        "leakedContexts": 0,
    }
    if details.get("_testDiagnostics") != expected:
        raise RuntimeError("Gecko cleanup diagnostics are not clean and bounded")


def compare_gecko(
    scenario: dict[str, object],
    reference: dict[str, object],
    candidate: dict[str, object],
) -> tuple[bool, list[str]]:
    failures = []
    if scenario.get("referenceError"):
        for key in ("status", "contentType"):
            if candidate.get(key) != scenario.get(key):
                failures.append(
                    f"{key}: expected {scenario.get(key)!r}, got {candidate.get(key)!r}"
                )
        expected_final = normalize_fixture_url(
            f"http://fixture.test:8080{scenario['path']}"
        )
        if candidate.get("finalUrl") != expected_final:
            failures.append("finalUrl differs from the fixture contract")
        if "body" in scenario:
            expected_hash = sha256_bytes(str(scenario["body"]).encode())
            if candidate.get("bodySha256") != expected_hash:
                failures.append("bodySha256 differs")
        return not failures, failures
    for key in ("status", "contentType", "finalUrl"):
        if reference.get(key) != candidate.get(key):
            failures.append(
                f"{key}: Firecrawl {reference.get(key)!r}, Gecko {candidate.get(key)!r}"
            )
    for key in ("title", "headings", "links"):
        if key in scenario and reference.get(key) != candidate.get(key):
            failures.append(f"{key} differs")
    if "bodySha256" in reference and reference["bodySha256"] != candidate.get(
        "bodySha256"
    ):
        failures.append("bodySha256 differs")
    expected_visible = scenario.get("geckoVisible")
    if expected_visible is not None:
        recall = token_recall(
            str(expected_visible), str(candidate.get("visibleText", ""))
        )
    elif "visible" in scenario:
        recall = token_recall(
            str(reference.get("visibleText", "")), str(candidate.get("visibleText", ""))
        )
    else:
        recall = None
    if recall is not None:
        candidate["firecrawlTokenRecall"] = recall
        if recall < 0.95:
            failures.append(f"visible token recall {recall:.4f} is below 0.95")
    return not failures, failures


def evaluate_gecko_stress(
    scenario: dict[str, object], candidate: dict[str, object]
) -> tuple[bool, list[str]]:
    page_error = str(candidate.get("pageError", ""))
    expected = scenario.get("geckoError", [])
    if isinstance(expected, list) and any(
        isinstance(fragment, str) and fragment in page_error for fragment in expected
    ):
        return True, []
    return False, [f"unexpected bounded-failure result: {page_error!r}"]


def run_scenarios(
    artifacts: pathlib.Path,
    redactor: Redactor,
    recorder: Recorder,
    api_port: int,
    fixture_port: int,
    other_fixture_port: int,
    playwright_port: int,
    playwright_container: str,
    include_stress: bool,
    timeout: float,
    gecko_connection: dict[str, object] | None,
) -> list[dict[str, object]]:
    root = artifacts / "scenarios"
    root.mkdir(mode=0o700)
    baseline = renderer_processes(
        recorder, playwright_container, "playwright-process-baseline"
    )
    results = []
    for index, scenario in enumerate(scenario_definitions(include_stress), 1):
        directory = root / f"{index:02d}-{scenario['name']}"
        directory.mkdir(mode=0o700)
        reference_url = f"http://fixture.test:8080{scenario['path']}"
        gecko_url = f"http://127.0.0.1:{fixture_port}{scenario['path']}"
        if scenario.get("crossOrigin"):
            reference_target = urllib.parse.quote(
                "http://other-fixture.test:8080/headers", safe=""
            )
            gecko_target = urllib.parse.quote(
                f"http://127.0.0.1:{other_fixture_port}/headers", safe=""
            )
            reference_url += f"?target={reference_target}"
            gecko_url += f"?target={gecko_target}"
        payload = firecrawl_payload(reference_url, scenario)
        try:
            response = http_json_request(
                api_port,
                "POST",
                "/v2/scrape",
                payload,
                max(timeout, int(payload["timeout"]) / 1000 + 30),
            )
            record_http_exchange(directory, response, redactor)
            _document, reference = firecrawl_document(response, reference_url)
            reference_ok, reference_failures = evaluate_reference(scenario, reference)
        except Exception as error:
            reference = {"error": f"{type(error).__name__}: {error}"}
            reference_ok = False
            reference_failures = [reference["error"]]
        try:
            cleanup = wait_reference_cleanup(
                recorder,
                playwright_port,
                playwright_container,
                baseline,
                str(scenario["name"]),
                min(timeout, 30),
            )
        except Exception as error:
            cleanup_error = f"{type(error).__name__}: {error}"
            reference_ok = False
            reference_failures.append(f"cleanup: {cleanup_error}")
            cleanup = {"error": cleanup_error}
        write_json(directory / "reference.normalized.json", reference)
        write_json(directory / "reference.cleanup.json", cleanup)
        entry: dict[str, object] = {
            "name": scenario["name"],
            "mapping": {
                "firecrawl": {
                    "method": "POST",
                    "path": "/v2/scrape",
                    "url": normalize_fixture_url(reference_url),
                },
                "gecko": {
                    "tool": "gecko_render",
                    "url": normalize_fixture_url(gecko_url),
                },
            },
            "referencePassed": reference_ok,
            "referenceFailures": reference_failures,
            "artifacts": directory.relative_to(artifacts).as_posix(),
        }
        if scenario.get("documentedDifference"):
            entry["documentedDifference"] = scenario["documentedDifference"]
        if gecko_connection:
            allowed_test_origins = [f"http://127.0.0.1:{fixture_port}"]
            if scenario.get("crossOrigin"):
                allowed_test_origins.append(f"http://127.0.0.1:{other_fixture_port}")
            args: dict[str, object] = {
                "url": gecko_url,
                "waitMs": int(scenario.get("waitFor", 100)),
                "timeoutMs": int(scenario.get("timeout", 30000)),
                "_testAllowedHosts": allowed_test_origins,
                "_testDiagnostics": True,
            }
            if scenario.get("selector"):
                args["waitForSelector"] = scenario["selector"]
            if scenario.get("headers"):
                args["headers"] = scenario["headers"]
            try:
                details, request_bytes, response_bytes = call_gecko(
                    gecko_connection,
                    args,
                    max(timeout, int(args["timeoutMs"]) / 1000 + 15),
                )
                write_bytes(
                    directory / "gecko.request.jsonl", redactor.data(request_bytes)
                )
                write_bytes(
                    directory / "gecko.response.jsonl",
                    redactor.data(response_bytes + b"\n"),
                )
                assert_gecko_cleanup(details)
                candidate = gecko_semantics(details)
                if scenario.get("stress"):
                    parity, failures = evaluate_gecko_stress(scenario, candidate)
                else:
                    parity, failures = compare_gecko(scenario, reference, candidate)
            except Exception as error:
                candidate = {"error": f"{type(error).__name__}: {error}"}
                parity = False
                failures = [candidate["error"]]
            write_json(directory / "gecko.normalized.json", candidate)
            write_json(
                directory / "normalized.diff.json",
                {"equal": parity, "failures": failures},
            )
            entry["geckoPassed"] = parity
            entry["geckoFailures"] = failures
        results.append(entry)
    return results


def cancellation_probe(
    artifacts: pathlib.Path,
    redactor: Redactor,
    recorder: Recorder,
    api_port: int,
    fixture_port: int,
    playwright_port: int,
    playwright_container: str,
    timeout: float,
) -> dict[str, object]:
    payload = firecrawl_payload(
        f"http://fixture.test:8080/slow?ms={CANCELLATION_FIXTURE_MS}",
        {"waitFor": 100, "timeout": 10000},
    )
    body = json.dumps(payload, separators=(",", ":")).encode()
    request = (
        "POST /v2/scrape HTTP/1.1\r\n"
        f"Host: 127.0.0.1:{api_port}\r\n"
        "Accept: application/json\r\n"
        "Content-Type: application/json\r\n"
        f"Content-Length: {len(body)}\r\n"
        "Connection: close\r\n\r\n"
    ).encode() + body
    wait_fixture_activity(fixture_port, lambda value: value == 0, min(timeout, 30))
    baseline = renderer_processes(
        recorder, playwright_container, "cancellation-process-baseline"
    )
    write_bytes(artifacts / "cancellation.request.http", redactor.data(request))
    stream = socket.create_connection(("127.0.0.1", api_port), timeout=5)
    try:
        stream.sendall(request)
        _active, peak = wait_fixture_activity(
            fixture_port, lambda value: value >= 1, min(timeout, 30)
        )
    finally:
        cancelled_at = time.monotonic()
        stream.close()
    deadline = cancelled_at + CANCELLATION_PROMPT_BOUND_MS / 1000
    health: dict[str, object] = {}
    active = 1
    prompt_duration = None
    while True:
        try:
            remaining = max(0.05, deadline - time.monotonic())
            health = playwright_health_state(playwright_port, min(1, remaining))
            active = fixture_activity(fixture_port, min(1, remaining))
            if health.get("activePages") == 0 and active == 0:
                prompt_duration = round((time.monotonic() - cancelled_at) * 1000)
                break
        except Exception:
            pass
        if time.monotonic() >= deadline:
            break
        time.sleep(0.05)
    prompt_observation = {
        "health": health,
        "activeFixtureRequests": active,
    }
    active, eventual_peak = wait_fixture_activity(
        fixture_port, lambda value: value == 0, min(timeout, 30)
    )
    eventual_duration = round((time.monotonic() - cancelled_at) * 1000)
    cleanup = wait_reference_cleanup(
        recorder,
        playwright_port,
        playwright_container,
        baseline,
        "cancellation",
        min(timeout, 30),
    )
    prompt_passed = cancellation_prompt_passed(prompt_duration)
    non_propagation_observed = (
        prompt_duration is None
        and max(peak, eventual_peak) >= 1
        and eventual_duration >= CANCELLATION_FIXTURE_MS
        and active == 0
        and cleanup.get("baselineRestored") is True
    )
    result = {
        "cancelledAfter": "fixture-request-observed",
        "fixtureDelayMilliseconds": CANCELLATION_FIXTURE_MS,
        "promptBoundMilliseconds": CANCELLATION_PROMPT_BOUND_MS,
        "promptDurationMilliseconds": prompt_duration,
        "eventualDurationMilliseconds": eventual_duration,
        "passed": prompt_passed,
        "contractPassed": prompt_passed or non_propagation_observed,
        "disconnectPropagationObserved": prompt_passed,
        "documentedDifference": (
            None
            if prompt_passed
            else "Firecrawl does not propagate API client disconnect to its active page"
        ),
        "peakFixtureRequests": max(peak, eventual_peak),
        "activeFixtureRequests": active,
        "promptObservation": prompt_observation,
        "cleanup": cleanup,
    }
    write_json(artifacts / "reference-cancellation.normalized.json", result)
    return result


def gecko_cancellation_probe(
    artifacts: pathlib.Path,
    redactor: Redactor,
    connection: dict[str, object],
    fixture_port: int,
    timeout: float,
) -> dict[str, object]:
    args = {
        "url": (f"http://127.0.0.1:{fixture_port}/slow?ms={CANCELLATION_FIXTURE_MS}"),
        "waitMs": 100,
        "timeoutMs": 10000,
        "_testAllowedHosts": [f"http://127.0.0.1:{fixture_port}"],
        "_testDiagnostics": True,
    }
    request_id, request_bytes = gecko_request_bytes(connection, args)
    cancel_bytes = (
        json.dumps(
            {"token": connection["token"], "id": request_id, "cancel": True},
            separators=(",", ":"),
        ).encode()
        + b"\n"
    )
    write_bytes(
        artifacts / "gecko-cancellation.request.jsonl",
        redactor.data(request_bytes + cancel_bytes),
    )
    wait_fixture_activity(fixture_port, lambda value: value == 0, min(timeout, 30))
    details = None
    response_bytes = None
    prompt_errors = []
    prompt_duration = None
    with socket.create_connection(
        ("127.0.0.1", int(connection["port"])), timeout=timeout
    ) as stream:
        stream.sendall(request_bytes)
        _active, peak = wait_fixture_activity(
            fixture_port, lambda value: value >= 1, min(timeout, 30)
        )
        cancelled_at = time.monotonic()
        deadline = cancelled_at + CANCELLATION_PROMPT_BOUND_MS / 1000
        stream.sendall(cancel_bytes)
        try:
            details, response_bytes = receive_gecko(
                stream, request_id, max(0.05, deadline - time.monotonic())
            )
        except Exception as error:
            prompt_errors.append(f"response: {type(error).__name__}: {error}")
        if details is not None:
            if "aborted" not in str(details.get("_testError", "")):
                prompt_errors.append("Gecko did not report caller abort")
            try:
                assert_gecko_cleanup(details)
            except Exception as error:
                prompt_errors.append(f"diagnostics: {type(error).__name__}: {error}")
        try:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError("prompt deadline elapsed before fixture cleanup")
            active, prompt_peak = wait_fixture_activity(
                fixture_port, lambda value: value == 0, remaining
            )
            prompt_duration = round((time.monotonic() - cancelled_at) * 1000)
        except Exception as error:
            active = fixture_activity(fixture_port, min(1, timeout))
            prompt_peak = active
            prompt_errors.append(f"fixture: {type(error).__name__}: {error}")
    if response_bytes is not None:
        write_bytes(
            artifacts / "gecko-cancellation.response.jsonl",
            redactor.data(response_bytes + b"\n"),
        )
    active, eventual_peak = wait_fixture_activity(
        fixture_port, lambda value: value == 0, min(timeout, 30)
    )
    eventual_duration = round((time.monotonic() - cancelled_at) * 1000)
    followup, _request, _response = call_gecko(
        connection,
        {
            "url": f"http://127.0.0.1:{fixture_port}/fast",
            "waitMs": 100,
            "timeoutMs": 5000,
            "_testAllowedHosts": [f"http://127.0.0.1:{fixture_port}"],
            "_testDiagnostics": True,
        },
        timeout,
    )
    assert_gecko_cleanup(followup)
    if followup.get("pageError") is not None:
        raise RuntimeError("Gecko override lock was unusable after cancellation")
    passed = not prompt_errors and cancellation_prompt_passed(prompt_duration)
    result = {
        "cancelledAfter": "fixture-request-observed",
        "fixtureDelayMilliseconds": CANCELLATION_FIXTURE_MS,
        "promptBoundMilliseconds": CANCELLATION_PROMPT_BOUND_MS,
        "promptDurationMilliseconds": prompt_duration,
        "eventualDurationMilliseconds": eventual_duration,
        "passed": passed,
        "promptErrors": prompt_errors,
        "peakFixtureRequests": max(peak, prompt_peak, eventual_peak),
        "activeFixtureRequests": active,
        "cleanup": details.get("_testDiagnostics") if details else None,
        "followupCleanup": followup["_testDiagnostics"],
    }
    write_json(artifacts / "gecko-cancellation.normalized.json", result)
    return result


def concurrent_probe(
    recorder: Recorder,
    api_port: int,
    playwright_port: int,
    playwright_container: str,
    timeout: float,
) -> dict[str, object]:
    baseline = renderer_processes(
        recorder, playwright_container, "concurrency-process-baseline"
    )
    cases = [
        ("http://fixture.test:8080/static", {"waitFor": 100}),
        ("http://fixture.test:8080/dynamic", {"waitFor": 250}),
        ("http://fixture.test:8080/slow?ms=400", {"waitFor": 100}),
    ]

    def run(case: tuple[str, dict[str, object]]) -> int:
        url, scenario = case
        response = http_json_request(
            api_port,
            "POST",
            "/v2/scrape",
            firecrawl_payload(url, scenario),
            timeout,
        )
        return int(response["status"])

    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
        statuses = list(executor.map(run, cases))
    cleanup = wait_reference_cleanup(
        recorder,
        playwright_port,
        playwright_container,
        baseline,
        "concurrency",
        min(timeout, 30),
    )
    return {
        "statuses": statuses,
        "cleanup": cleanup,
        "passed": statuses == [200, 200, 200],
    }


def main() -> int:
    args = parse_args()
    artifacts = validate_artifacts(args.artifacts)
    redactor = Redactor()
    recorder = Recorder(artifacts, redactor)
    work = artifacts / "work"
    work.mkdir(mode=0o700)
    redactor.add(str(work), "<work>")
    previous_storage_config = os.environ.get("CONTAINERS_STORAGE_CONF")
    previous_engine_config = os.environ.get("CONTAINERS_CONF")
    run_id = secrets.token_hex(8)
    prefix = f"wildbuzzard-firecrawl-{run_id}"
    names = {
        "redis": f"{prefix}-redis",
        "playwright": f"{prefix}-playwright",
        "fixture": f"{prefix}-fixture",
        "api": f"{prefix}-api",
    }
    network = f"{prefix}-network"
    api_image = f"localhost/{prefix}-api:reference"
    playwright_image = f"localhost/{prefix}-playwright:reference"
    created_containers: list[str] = []
    created_images: list[str] = []
    network_created = False
    published_ports: list[int] = []
    summary: dict[str, object] = {
        "schema": 1,
        "startedAt": utc_now(),
        "outcome": "infrastructure-failure",
        "reference": "Firecrawl /v2/scrape",
        "geckoComparisonRequested": bool(args.gecko_connection),
    }
    cleanup: dict[str, object] = {}
    interrupted = False
    isolated_storage_configured = False
    podman_run_root: pathlib.Path | None = None
    podman_available = shutil.which("podman") is not None
    key_quota_before = current_key_quota()
    summary["keyQuotaBefore"] = key_quota_before
    try:
        podman_run_root = create_ephemeral_podman_run_root()
        redactor.add(str(podman_run_root), "<podman-run-root>")
        summary["podmanStorage"] = configure_isolated_podman_storage(
            work, podman_run_root
        )
        isolated_storage_configured = True
        summary["podman"] = verify_rootless_podman(recorder)
        source, source_identity = prepare_source(args, work, recorder)
        summary["source"] = source_identity
        summary["baseImages"] = pull_bases(recorder)
        created_images.extend([api_image, playwright_image])
        recorder.run(
            "api-image-build",
            reference_image_build_command(
                "api",
                api_image,
                source / "apps" / "api" / "Dockerfile",
                source / "apps" / "api",
            ),
            timeout=3600,
        )
        recorder.run(
            "playwright-image-build",
            reference_image_build_command(
                "playwright",
                playwright_image,
                source / "apps" / "playwright-service-ts" / "Dockerfile",
                source / "apps" / "playwright-service-ts",
            ),
            timeout=3600,
        )
        summary["builtImages"] = {
            "api": inspect_image(recorder, "api-image-inspect", api_image),
            "playwright": inspect_image(
                recorder, "playwright-image-inspect", playwright_image
            ),
        }
        for identity in summary["builtImages"].values():
            if identity.get("os") != "linux" or identity.get("architecture") != "amd64":
                raise RuntimeError("Built reference image platform mismatch")
        summary["baseImagesAfterBuild"] = verify_tagged_bases(recorder, "after-build")
        if recorder.run(
            "source-status-after-build",
            ["git", "status", "--porcelain=v1", "--untracked-files=all"],
            cwd=source,
        ).stdout:
            raise RuntimeError("Firecrawl build modified the pristine checkout")
        recorder.run(
            "network-create", ["podman", "network", "create", "--internal", network]
        )
        network_created = True
        api_port, playwright_port, fixture_port, other_fixture_port = (
            random_loopback_ports(4)
        )
        published_ports = [
            api_port,
            playwright_port,
            fixture_port,
            other_fixture_port,
        ]
        FIXTURE_PORT_ALIASES.update({
            fixture_port: "fixture.test",
            other_fixture_port: "other-fixture.test",
        })
        for value, replacement in (
            (f"http://127.0.0.1:{api_port}", "http://127.0.0.1:<firecrawl-port>"),
            (
                f"http://127.0.0.1:{playwright_port}",
                "http://127.0.0.1:<playwright-port>",
            ),
            (f"http://127.0.0.1:{fixture_port}", "http://fixture.test"),
            (
                f"http://127.0.0.1:{other_fixture_port}",
                "http://other-fixture.test",
            ),
            ("http://fixture:8080", "http://fixture.test"),
            ("http://other-fixture:8080", "http://other-fixture.test"),
            ("http://fixture.test:8080", "http://fixture.test"),
            ("http://other-fixture.test:8080", "http://other-fixture.test"),
        ):
            redactor.add(value, replacement)
        summary["ports"] = {
            "firecrawl": api_port,
            "playwright": playwright_port,
            "fixture": fixture_port,
            "otherFixture": other_fixture_port,
        }
        redis_id = create_container(
            recorder,
            names["redis"],
            [
                "--network",
                network,
                "--network-alias",
                "redis",
                "--cap-drop=all",
                "--security-opt",
                "no-new-privileges",
                "--read-only",
                "--tmpfs",
                "/data:rw,noexec,nosuid,nodev,size=64m",
                base_platform_reference(BASE_IMAGES[2]),
                "redis-server",
                "--bind",
                "0.0.0.0",
                "--save",
                "",
                "--appendonly",
                "no",
            ],
            created_containers,
        )
        fixture_id = create_container(
            recorder,
            names["fixture"],
            [
                "--network",
                network,
                "--network-alias",
                "fixture",
                "--network-alias",
                "other-fixture",
                "--network-alias",
                "fixture.test",
                "--network-alias",
                "other-fixture.test",
                "--cap-drop=all",
                "--security-opt",
                "no-new-privileges",
                "--read-only",
                "--tmpfs",
                "/tmp:rw,noexec,nosuid,nodev,size=32m",
                "--publish",
                f"127.0.0.1:{fixture_port}:8080",
                "--publish",
                f"127.0.0.1:{other_fixture_port}:8080",
                "--volume",
                f"{HERE / 'fixture-server.mjs'}:/fixture/fixture-server.mjs:ro",
                "--env",
                "HOST=0.0.0.0",
                "--env",
                "PORT=8080",
                "--entrypoint",
                "node",
                api_image,
                "/fixture/fixture-server.mjs",
            ],
            created_containers,
        )
        playwright_id = create_container(
            recorder,
            names["playwright"],
            [
                "--network",
                network,
                "--network-alias",
                "playwright",
                "--cap-drop=all",
                "--security-opt",
                "no-new-privileges",
                "--read-only",
                "--tmpfs",
                "/tmp:rw,noexec,nosuid,nodev,size=1g",
                "--shm-size",
                "512m",
                "--publish",
                f"127.0.0.1:{playwright_port}:{PLAYWRIGHT_INTERNAL_PORT}",
                "--env",
                f"PORT={PLAYWRIGHT_INTERNAL_PORT}",
                "--env",
                "ALLOW_LOCAL_WEBHOOKS=TRUE",
                "--env",
                "MAX_CONCURRENT_PAGES=4",
                playwright_image,
                *PLAYWRIGHT_START_COMMAND,
            ],
            created_containers,
        )
        api_environment = {
            "HOST": "0.0.0.0",
            "PORT": "3002",
            "ENV": "local",
            "USE_DB_AUTHENTICATION": "false",
            "TEST_SUITE_SELF_HOSTED": "true",
            "ALLOW_LOCAL_WEBHOOKS": "true",
            "DISABLE_BLOCKLIST": "true",
            "REDIS_URL": "redis://redis:6379",
            "REDIS_EVICT_URL": "redis://redis:6379",
            "REDIS_RATE_LIMIT_URL": "redis://redis:6379",
            "PLAYWRIGHT_MICROSERVICE_URL": (
                f"http://playwright:{PLAYWRIGHT_INTERNAL_PORT}/scrape"
            ),
            "LOGGING_LEVEL": "ERROR",
        }
        api_args = [
            "--network",
            network,
            "--network-alias",
            "firecrawl",
            "--cap-drop=all",
            "--security-opt",
            "no-new-privileges",
            "--read-only",
            "--tmpfs",
            "/tmp:rw,noexec,nosuid,nodev,size=256m",
            "--publish",
            f"127.0.0.1:{api_port}:3002",
        ]
        for key, value in api_environment.items():
            api_args.extend(["--env", f"{key}={value}"])
        api_args.extend([api_image, "node", "dist/src/index.js"])
        api_id = create_container(recorder, names["api"], api_args, created_containers)
        summary["containers"] = {
            "redis": redis_id,
            "fixture": fixture_id,
            "playwright": playwright_id,
            "api": api_id,
            "network": network,
        }
        summary["configuration"] = {
            "apiRedactedSha256": sha256_bytes(
                json.dumps(
                    api_environment, sort_keys=True, separators=(",", ":")
                ).encode()
            ),
            "fixtureSha256": sha256_file(HERE / "fixture-server.mjs"),
            "basePlatform": BASE_PLATFORM,
            "dockerfileSourcesPristine": True,
            "allPublishedPortsLoopbackOnly": True,
            "containerNetworkInternal": True,
        }
        wait_http(fixture_port, "/health", args.timeout)
        wait_http(playwright_port, "/health", args.timeout)
        wait_http(api_port, "/e2e-test", args.timeout)
        connection = (
            read_gecko_connection(args.gecko_connection)
            if args.gecko_connection
            else None
        )
        if connection:
            redactor.add(str(connection["token"]), "<redacted>")
        results = run_scenarios(
            artifacts,
            redactor,
            recorder,
            api_port,
            fixture_port,
            other_fixture_port,
            playwright_port,
            names["playwright"],
            not args.skip_stress,
            args.timeout,
            connection,
        )
        summary["scenarios"] = results
        cancellation = cancellation_probe(
            artifacts,
            redactor,
            recorder,
            api_port,
            fixture_port,
            playwright_port,
            names["playwright"],
            args.timeout,
        )
        summary["cancellation"] = cancellation
        gecko_cancellation = None
        if connection:
            gecko_cancellation = gecko_cancellation_probe(
                artifacts,
                redactor,
                connection,
                fixture_port,
                args.timeout,
            )
            summary["geckoCancellation"] = gecko_cancellation
        concurrency = concurrent_probe(
            recorder,
            api_port,
            playwright_port,
            names["playwright"],
            args.timeout,
        )
        summary["concurrency"] = concurrency
        reference_passed = (
            all(item["referencePassed"] for item in results)
            and bool(cancellation["contractPassed"])
            and bool(concurrency["passed"])
        )
        if connection:
            gecko_passed = all(
                item.get("geckoPassed") is True for item in results
            ) and bool(gecko_cancellation and gecko_cancellation["passed"])
            summary["outcome"] = (
                "passed" if reference_passed and gecko_passed else "parity-failure"
            )
        else:
            summary["outcome"] = (
                "reference-passed-gecko-gated"
                if reference_passed
                else "reference-failure"
            )
            summary["geckoGate"] = (
                "A fresh WildBuzzard binary and mode-0600 browser-control connection "
                "record are required for the side-by-side gate"
            )
    except KeyboardInterrupt:
        interrupted = True
        summary["outcome"] = "interrupted"
        summary["error"] = "KeyboardInterrupt: comparison interrupted"
    except Exception as error:
        summary["error"] = f"{type(error).__name__}: {error}"
    finally:
        service_logs: dict[str, str] = {}
        for name in reversed(created_containers):
            short = name.rsplit("-", 1)[-1]
            logs = recorder.run(
                f"container-logs-{short}", ["podman", "logs", name], check=False
            )
            log_path = artifacts / f"{short}-service.log"
            log_path.write_text(redactor.text(logs.stdout), encoding="utf-8")
            log_path.chmod(0o600)
            service_logs[short] = log_path.name
            stop = recorder.run(
                f"container-stop-{short}",
                ["podman", "stop", "--time", "10", name],
                check=False,
            )
            inspect = recorder.run(
                f"container-exit-{short}",
                ["podman", "inspect", "--format", "{{.State.ExitCode}}", name],
                check=False,
            )
            remove = recorder.run(
                f"container-remove-{short}",
                ["podman", "rm", "--force", name],
                check=False,
            )
            cleanup[short] = {
                "stopExitCode": stop.returncode,
                "serviceExitCode": inspect.stdout.strip(),
                "removed": remove.returncode == 0,
            }
        if network_created:
            remove_network = recorder.run(
                "network-remove", ["podman", "network", "rm", network], check=False
            )
            cleanup["networkRemoved"] = remove_network.returncode == 0
        if podman_available:
            orphan_check = recorder.run(
                "container-orphan-check",
                [
                    "podman",
                    "ps",
                    "--all",
                    "--filter",
                    f"name={prefix}",
                    "--format",
                    "{{.ID}}",
                ],
                check=False,
            )
            cleanup["noContainers"] = (
                orphan_check.returncode == 0 and not orphan_check.stdout.strip()
            )
        else:
            cleanup["noContainers"] = not created_containers
        for image in reversed(created_images):
            short = "playwright" if "playwright" in image else "api"
            remove_image = recorder.run(
                f"image-remove-{short}",
                ["podman", "image", "rm", "--force", image],
                check=False,
            )
            cleanup[f"{short}ImageRemoved"] = remove_image.returncode == 0
        if isolated_storage_configured and podman_available:
            reset_storage = recorder.run(
                "podman-storage-reset",
                ["podman", "system", "reset", "--force"],
                check=False,
            )
            cleanup["podmanStorageReset"] = reset_storage.returncode == 0
        if podman_run_root is not None:
            shutil.rmtree(podman_run_root, ignore_errors=True)
        cleanup["podmanRunRootRemoved"] = (
            podman_run_root is None or not podman_run_root.exists()
        )
        shutil.rmtree(work, ignore_errors=True)
        cleanup["workDirectoryRemoved"] = not work.exists()
        cleanup["engineFilesRemoved"] = all(
            not (work / name).exists()
            for name in ("containers.conf", "crun-wrapper")
        )
        if previous_storage_config is None:
            os.environ.pop("CONTAINERS_STORAGE_CONF", None)
        else:
            os.environ["CONTAINERS_STORAGE_CONF"] = previous_storage_config
        if previous_engine_config is None:
            os.environ.pop("CONTAINERS_CONF", None)
        else:
            os.environ["CONTAINERS_CONF"] = previous_engine_config
        cleanup["environmentRestored"] = {
            "storageConfig": (
                os.environ.get("CONTAINERS_STORAGE_CONF") == previous_storage_config
            ),
            "engineConfig": os.environ.get("CONTAINERS_CONF")
            == previous_engine_config,
        }
        cleanup["environmentRestored"]["passed"] = all(
            cleanup["environmentRestored"].values()
        )
        key_quota_after = current_key_quota()
        cleanup["keyQuota"] = {
            "before": key_quota_before,
            "after": key_quota_after,
            "noIncrease": key_quota_after["usage"] <= key_quota_before["usage"],
        }
        cleanup["publishedPorts"] = wait_ports_closed(published_ports)
        cleanup["passed"] = (
            all(
                item["removed"]
                for item in cleanup.values()
                if isinstance(item, dict) and "removed" in item
            )
            and (not network_created or cleanup.get("networkRemoved") is True)
            and cleanup.get("noContainers") is True
            and all(
                cleanup.get(f"{name}ImageRemoved") is True
                for name in ("api", "playwright")
                if created_images
            )
            and (
                not isolated_storage_configured
                or not podman_available
                or cleanup.get("podmanStorageReset") is True
            )
            and cleanup["podmanRunRootRemoved"]
            and cleanup["workDirectoryRemoved"]
            and cleanup["engineFilesRemoved"]
            and cleanup["environmentRestored"]["passed"]
            and cleanup["keyQuota"]["noIncrease"]
            and cleanup["publishedPorts"]["passed"]
        )
        if not cleanup["passed"] and not interrupted:
            summary["outcome"] = "cleanup-failure"
            summary["error"] = "Firecrawl comparison cleanup gate failed"
        cleanup["serviceLogs"] = service_logs
        summary["commands"] = recorder.commands
        summary["cleanup"] = cleanup
        summary["finishedAt"] = utc_now()
        write_json(artifacts / "summary.json", summary)
    if summary["outcome"] == "passed":
        print(f"Firecrawl/Gecko comparison passed: {artifacts / 'summary.json'}")
        return 0
    if summary["outcome"] == "reference-passed-gecko-gated":
        print(
            f"Firecrawl reference passed; Gecko gate remains: {artifacts / 'summary.json'}",
            file=sys.stderr,
        )
        return 2
    if interrupted:
        print(
            f"Firecrawl comparison interrupted: {artifacts / 'summary.json'}",
            file=sys.stderr,
        )
        return 130
    print(
        f"Firecrawl comparison failed ({summary['outcome']}): {artifacts / 'summary.json'}",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
