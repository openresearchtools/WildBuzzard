#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import argparse
import base64
import binascii
import contextlib
import fcntl
import http.client
import json
import os
import pathlib
import secrets
import signal
import socket
import stat
import subprocess
import sys
import time
import urllib.parse
import uuid
from typing import Any


VERSION = "0.1.0"
PROTOCOL_VERSION = 1
QBITTORRENT_VERSION = "v5.2.3"
MAX_RESPONSE = 16 * 1024 * 1024
MAX_TORRENT = 12 * 1024 * 1024
TORRENT_FILTERS = {
    "all", "downloading", "seeding", "completed", "stopped", "running",
    "active", "inactive", "stalled", "stalled_uploading",
    "stalled_downloading", "errored",
}
TORRENT_SORTS = {
    "name", "size", "progress", "dlspeed", "upspeed", "priority",
    "num_seeds", "num_leechs", "eta", "ratio", "added_on", "completion_on",
}
TORRENT_SECTIONS = {"overview", "files", "trackers", "peers"}


class UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, socket_path: str, timeout: float = 30) -> None:
        super().__init__("localhost", timeout=timeout)
        self.socket_path = socket_path

    def connect(self) -> None:
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.socket_path)


def xdg(variable: str, fallback: pathlib.Path) -> pathlib.Path:
    return pathlib.Path(os.environ.get(variable, fallback))


def paths() -> dict[str, pathlib.Path]:
    home = pathlib.Path.home()
    data = xdg("XDG_DATA_HOME", home / ".local" / "share") / "buzzard" / "torrent"
    runtime_base = os.environ.get("XDG_RUNTIME_DIR")
    state = (
        pathlib.Path(runtime_base) / "buzzard" / "torrent"
        if runtime_base
        else pathlib.Path("/tmp") / f"buzzard-{os.getuid()}" / "torrent"
    )
    return {
        "data": data,
        "profile": data / "profile",
        "state": state,
        "socket": state / "q",
        "api_key": state / "api-key",
        "connection": state / "connection.json",
        "runtime": pathlib.Path(
            os.environ.get("BUZZARD_TORRENT_RUNTIME", "/usr/lib/buzzard-torrent/runtime")
        ),
    }


def private_directory(path: pathlib.Path) -> pathlib.Path:
    if path.is_symlink():
        raise RuntimeError(f"refusing symlink directory: {path}")
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.chmod(0o700)
    status = path.stat()
    if status.st_uid != os.getuid() or stat.S_IMODE(status.st_mode) != 0o700:
        raise RuntimeError(f"unsafe private directory: {path}")
    return path.resolve()


def process_start_time(pid: int) -> str:
    value = pathlib.Path(f"/proc/{pid}/stat").read_text(encoding="ascii")
    return value[value.rfind(")") + 2 :].split()[19]


def process_matches(record: dict[str, Any]) -> bool:
    try:
        return (
            process_start_time(int(record["pid"])) == str(record["pidStartTime"])
            and pathlib.Path(f"/proc/{record['pid']}/exe").resolve() == pathlib.Path(record["executable"])
        )
    except (OSError, KeyError, ValueError):
        return False


def atomic_json(path: pathlib.Path, value: dict[str, Any]) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{secrets.token_hex(8)}")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        json.dump(value, stream, separators=(",", ":"), sort_keys=True)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    path.chmod(0o600)


@contextlib.contextmanager
def launch_lock(state: pathlib.Path):
    location = state / "launch.lock"
    descriptor = os.open(
        location,
        os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW,
        0o600,
    )
    try:
        status = os.fstat(descriptor)
        if not stat.S_ISREG(status.st_mode) or status.st_uid != os.getuid():
            raise RuntimeError("qBittorrent launch lock is unsafe")
        os.fchmod(descriptor, 0o600)
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)


def api_key() -> str:
    location = paths()["api_key"]
    try:
        status = os.stat(location, follow_symlinks=False)
        value = location.read_text(encoding="ascii").strip()
        if stat.S_ISREG(status.st_mode) and stat.S_IMODE(status.st_mode) == 0o600 and value.startswith("qbt_") and len(value) == 32:
            return value
    except OSError:
        pass
    value = f"qbt_{secrets.token_hex(14)}"
    descriptor = os.open(location, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w", encoding="ascii") as stream:
        stream.write(f"{value}\n")
    location.chmod(0o600)
    return value


def read_connection() -> dict[str, Any] | None:
    location = paths()["connection"]
    try:
        status = os.stat(location, follow_symlinks=False)
        if not stat.S_ISREG(status.st_mode) or stat.S_IMODE(status.st_mode) != 0o600:
            return None
        value = json.loads(location.read_text(encoding="utf-8"))
        if value.get("schema") != 1 or value.get("protocolVersion") != PROTOCOL_VERSION:
            return None
        return value
    except (OSError, ValueError):
        return None


def request(
    target: str,
    method: str = "GET",
    body: bytes | None = None,
    content_type: str | None = None,
    maximum: int = MAX_RESPONSE,
) -> tuple[int, dict[str, str], bytes]:
    connection = UnixHTTPConnection(str(paths()["socket"]))
    headers = {"Authorization": f"Bearer {api_key()}", "Connection": "close"}
    if content_type:
        headers["Content-Type"] = content_type
    connection.request(method, target, body=body, headers=headers)
    response = connection.getresponse()
    payload = response.read(maximum + 1)
    connection.close()
    if len(payload) > maximum:
        raise RuntimeError("buzzard-torrent response exceeded its limit")
    return response.status, {key.lower(): value for key, value in response.headers.items()}, payload


def request_text(target: str, method: str = "GET", body: bytes | None = None, content_type: str | None = None) -> str:
    status, _, payload = request(target, method, body, content_type)
    if not 200 <= status < 300:
        raise RuntimeError(f"qBittorrent request failed ({status})")
    return payload.decode("utf-8")


def request_json(target: str) -> Any:
    return json.loads(request_text(target))


def form_post(target: str, values: dict[str, Any]) -> None:
    body = urllib.parse.urlencode({key: str(value) for key, value in values.items()}).encode()
    request_text(target, "POST", body, "application/x-www-form-urlencoded")


def healthy(record: dict[str, Any]) -> bool:
    if not process_matches(record):
        return False
    try:
        return request_text("/api/v2/app/version").strip() == QBITTORRENT_VERSION
    except (OSError, RuntimeError):
        return False


def read_lock(executable: pathlib.Path) -> dict[str, Any]:
    lock = paths()["profile"] / "qBittorrent" / "config" / "lockfile"
    lines = lock.read_text(encoding="utf-8").strip().splitlines()
    if len(lines) != 5:
        raise RuntimeError("qBittorrent returned an invalid process lock")
    pid = int(lines[0])
    uuid.UUID(lines[4])
    record = {
        "pid": pid,
        "pidStartTime": process_start_time(pid),
        "instanceId": lines[4],
        "executable": str(executable),
    }
    if not process_matches(record):
        raise RuntimeError("qBittorrent process identity could not be verified")
    return record


def ensure() -> dict[str, Any]:
    owned = paths()
    for key in ("data", "profile", "state"):
        private_directory(owned[key])
    with launch_lock(owned["state"]):
        existing = read_connection()
        if existing and healthy(existing):
            return existing
        executable = (owned["runtime"] / "bin" / "qbittorrent-nox").resolve(strict=True)
        if executable.parent.parent != owned["runtime"].resolve(strict=True):
            raise RuntimeError("qBittorrent executable leaves its package runtime")
        owned["connection"].unlink(missing_ok=True)
        owned["socket"].unlink(missing_ok=True)
        environment = {
            "HOME": str(pathlib.Path.home()),
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
            "PATH": "/usr/bin:/bin",
            "QT_PLUGIN_PATH": str(owned["runtime"] / "plugins"),
            "TZ": "UTC",
            "WILDBUZZARD_QBITTORRENT_API_KEY_FILE": str(owned["api_key"]),
            "WILDBUZZARD_QBITTORRENT_SOCKET": str(owned["socket"]),
        }
        library = owned["runtime"] / "lib"
        if library.is_dir():
            environment["LD_LIBRARY_PATH"] = str(library)
        downloads = pathlib.Path(os.environ.get("BUZZARD_TORRENT_DOWNLOADS", pathlib.Path.home() / "Downloads"))
        downloads.mkdir(mode=0o755, parents=True, exist_ok=True)
        api_key()
        result = subprocess.run(
            [
                executable,
                "--daemon",
                "--confirm-legal-notice",
                f"--profile={owned['profile']}",
                f"--save-path={downloads}",
            ],
            check=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=environment,
            timeout=30,
        )
        if result.returncode != 0:
            raise RuntimeError("qBittorrent failed to start")
        last_error: Exception | None = None
        for _ in range(80):
            try:
                identity = read_lock(executable)
                version = request_text("/api/v2/app/version").strip()
                if version != QBITTORRENT_VERSION:
                    raise RuntimeError("qBittorrent version differs from its package pin")
                record = {
                    "schema": 1,
                    "protocolVersion": PROTOCOL_VERSION,
                    **identity,
                    "profileDirectory": str(owned["profile"]),
                    "socketPath": str(owned["socket"]),
                    "apiKeyPath": str(owned["api_key"]),
                    "version": version,
                }
                atomic_json(owned["connection"], record)
                return record
            except (OSError, RuntimeError, ValueError) as error:
                last_error = error
            time.sleep(0.25)
        raise last_error or RuntimeError("qBittorrent did not become ready")


def status() -> dict[str, Any]:
    record = read_connection()
    if not record or not healthy(record):
        return {"running": False}
    return {"running": True, "healthy": True, "pid": record["pid"], "version": record["version"]}


def stop() -> dict[str, Any]:
    owned = paths()
    private_directory(owned["state"])
    with launch_lock(owned["state"]):
        record = read_connection()
        if record and healthy(record):
            try:
                request("/api/v2/app/shutdown", "POST", b"", "application/x-www-form-urlencoded")
            except OSError:
                pass
            deadline = time.monotonic() + 10
            while process_matches(record) and time.monotonic() < deadline:
                time.sleep(0.1)
            if process_matches(record):
                os.kill(record["pid"], signal.SIGTERM)
        owned["connection"].unlink(missing_ok=True)
        owned["socket"].unlink(missing_ok=True)
    return {"running": False}


def require_hash(value: Any) -> str:
    if not isinstance(value, str) or len(value) != 40 or any(character not in "0123456789abcdefABCDEF" for character in value):
        raise ValueError("torrent id must be a 40-character info hash")
    return value.lower()


def assert_keys(value: dict[str, Any], allowed: set[str], tool: str) -> None:
    unknown = set(value) - allowed
    if unknown:
        raise ValueError(f"{tool} contains unknown arguments: {', '.join(sorted(unknown))}")


def bounded_text(value: Any, name: str, maximum: int) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{name} must be a string")
    result = value.strip()
    if not result or len(result) > maximum or any(ord(character) < 32 for character in result):
        raise ValueError(f"{name} must be non-empty bounded text")
    return result


def validate_list(arguments: dict[str, Any]) -> dict[str, Any]:
    assert_keys(arguments, {"filter", "category", "tag", "sort", "reverse", "limit", "offset"}, "torrent_list")
    result = {
        "filter": arguments.get("filter", "all"),
        "sort": arguments.get("sort", "added_on"),
        "reverse": arguments.get("reverse", True),
        "limit": arguments.get("limit", 50),
        "offset": arguments.get("offset", 0),
    }
    if result["filter"] not in TORRENT_FILTERS:
        raise ValueError("torrent_list filter is invalid")
    if result["sort"] not in TORRENT_SORTS:
        raise ValueError("torrent_list sort is invalid")
    if not isinstance(result["reverse"], bool):
        raise ValueError("torrent_list reverse must be a boolean")
    if not isinstance(result["limit"], int) or isinstance(result["limit"], bool) or not 1 <= result["limit"] <= 100:
        raise ValueError("torrent_list limit must be between 1 and 100")
    if not isinstance(result["offset"], int) or isinstance(result["offset"], bool) or not 0 <= result["offset"] <= 100_000:
        raise ValueError("torrent_list offset must be between 0 and 100000")
    for key in ("category", "tag"):
        if key in arguments:
            result[key] = bounded_text(arguments[key], f"torrent_list {key}", 256)
    return result


def safe_text(value: Any, maximum: int) -> str:
    if not isinstance(value, str):
        return ""
    return "".join(character for character in value if ord(character) >= 32 and ord(character) != 127)[:maximum]


def safe_number(value: Any, minimum: float = 0) -> int | float | None:
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= minimum else None


def torrent_summary(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise RuntimeError("qBittorrent returned an invalid torrent entry")
    return {
        "id": require_hash(value.get("hash")),
        "name": safe_text(value.get("name"), 512),
        "state": safe_text(value.get("state"), 64),
        "progress": safe_number(value.get("progress")),
        "sizeBytes": safe_number(value.get("total_size")),
        "downloadedBytes": safe_number(value.get("downloaded")),
        "uploadedBytes": safe_number(value.get("uploaded")),
        "downloadSpeed": safe_number(value.get("dlspeed")),
        "uploadSpeed": safe_number(value.get("upspeed")),
        "seeds": safe_number(value.get("num_seeds")),
        "peers": safe_number(value.get("num_leechs")),
        "etaSeconds": safe_number(value.get("eta")),
        "ratio": safe_number(value.get("ratio"), -1),
        "addedAt": safe_number(value.get("added_on")),
        "completedAt": safe_number(value.get("completion_on")),
        "savePath": safe_text(value.get("save_path"), 4096),
        "category": safe_text(value.get("category"), 256),
        "tags": safe_text(value.get("tags"), 1024),
        "forceStart": bool(value.get("force_start")),
        "sequentialDownload": bool(value.get("seq_dl")),
        "firstLastPiecePriority": bool(value.get("f_l_piece_prio")),
    }


def list_torrents(arguments: dict[str, Any]) -> dict[str, Any]:
    value = validate_list(arguments)
    query = urllib.parse.urlencode(
        {
            key: str(item).lower() if isinstance(item, bool) else item
            for key, item in value.items()
            if item is not None
        }
    )
    response = request_json(f"/api/v2/torrents/info{'?' + query if query else ''}")
    if not isinstance(response, list) or len(response) > value["limit"]:
        raise RuntimeError("qBittorrent returned an invalid torrent list")
    return {
        "offset": value["offset"],
        "limit": value["limit"],
        "torrents": [torrent_summary(item) for item in response],
    }


def details(arguments: dict[str, Any]) -> dict[str, Any]:
    assert_keys(arguments, {"id", "section", "offset", "limit"}, "torrent_details")
    torrent_id = require_hash(arguments.get("id"))
    section = arguments.get("section", "overview")
    if section not in TORRENT_SECTIONS:
        raise ValueError("torrent_details section is invalid")
    offset = arguments.get("offset", 0)
    limit = arguments.get("limit", 100)
    if not isinstance(offset, int) or isinstance(offset, bool) or not 0 <= offset <= 100_000:
        raise ValueError("torrent_details offset must be between 0 and 100000")
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 500:
        raise ValueError("torrent_details limit must be between 1 and 500")
    target = {
        "overview": f"/api/v2/torrents/properties?hash={torrent_id}",
        "files": f"/api/v2/torrents/files?hash={torrent_id}",
        "trackers": f"/api/v2/torrents/trackers?hash={torrent_id}",
        "peers": f"/api/v2/sync/torrentPeers?hash={torrent_id}&rid=0",
    }.get(section)
    response = request_json(target)
    if section == "overview":
        if not isinstance(response, dict):
            raise RuntimeError("qBittorrent returned invalid torrent details")
        return {
            "id": torrent_id,
            "section": section,
            "name": safe_text(response.get("name"), 512),
            "infohashV1": safe_text(response.get("infohash_v1"), 40),
            "infohashV2": safe_text(response.get("infohash_v2"), 64),
            "totalSizeBytes": safe_number(response.get("total_size")),
            "downloadedBytes": safe_number(response.get("total_downloaded")),
            "uploadedBytes": safe_number(response.get("total_uploaded")),
            "downloadSpeed": safe_number(response.get("dl_speed")),
            "uploadSpeed": safe_number(response.get("up_speed")),
            "seeds": safe_number(response.get("seeds")),
            "peers": safe_number(response.get("peers")),
            "etaSeconds": safe_number(response.get("eta")),
            "ratio": safe_number(response.get("share_ratio"), -1),
            "availability": safe_number(response.get("availability"), -1),
            "connections": safe_number(response.get("nb_connections")),
            "savePath": safe_text(response.get("save_path"), 4096),
            "downloadPath": safe_text(response.get("download_path"), 4096),
            "private": None if response.get("private") is None else bool(response.get("private")),
        }
    if section == "peers" and isinstance(response, dict):
        response = list((response.get("peers") or {}).values())
    if not isinstance(response, list) or len(response) > 100_000:
        raise RuntimeError("qBittorrent returned invalid torrent details")
    items = [detail_item(section, item) for item in response[offset : offset + limit]]
    return {
        "id": torrent_id,
        "section": section,
        "total": len(response),
        "offset": offset,
        "items": items,
        "truncated": offset + limit < len(response),
    }


def detail_item(section: str, value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise RuntimeError("qBittorrent returned an invalid detail entry")
    if section == "files":
        return {
            "index": safe_number(value.get("index")),
            "name": safe_text(value.get("name"), 4096),
            "sizeBytes": safe_number(value.get("size")),
            "progress": safe_number(value.get("progress")),
            "priority": safe_number(value.get("priority")),
            "availability": safe_number(value.get("availability"), -1),
        }
    if section == "trackers":
        return {
            "url": safe_tracker_url(value.get("url")),
            "status": safe_number(value.get("status")),
            "tier": safe_number(value.get("tier"), -1),
            "peers": safe_number(value.get("num_peers"), -1),
            "seeds": safe_number(value.get("num_seeds"), -1),
            "leeches": safe_number(value.get("num_leeches"), -1),
            "downloaded": safe_number(value.get("num_downloaded"), -1),
            "message": safe_text(value.get("msg"), 512),
        }
    return {
        "ip": safe_text(value.get("ip") or value.get("i2p_dest"), 256),
        "port": safe_number(value.get("port")),
        "client": safe_text(value.get("client"), 256),
        "connection": safe_text(value.get("connection"), 64),
        "country": safe_text(value.get("country"), 128),
        "progress": safe_number(value.get("progress")),
        "downloadSpeed": safe_number(value.get("dl_speed")),
        "uploadSpeed": safe_number(value.get("up_speed")),
        "downloadedBytes": safe_number(value.get("downloaded")),
        "uploadedBytes": safe_number(value.get("uploaded")),
        "flags": safe_text(value.get("flags"), 128),
    }


def safe_tracker_url(value: Any) -> str:
    source = safe_text(value, 4096)
    if "://" not in source:
        return source
    try:
        parsed = urllib.parse.urlsplit(source)
        host = parsed.hostname or ""
        if parsed.port:
            host = f"{host}:{parsed.port}"
        return urllib.parse.urlunsplit((parsed.scheme, host, parsed.path, "", ""))
    except ValueError:
        return "invalid tracker URL"


def multipart_torrent(payload: bytes) -> tuple[bytes, str]:
    boundary = f"buzzard-{secrets.token_hex(16)}"
    prefix = f'--{boundary}\r\nContent-Disposition: form-data; name="torrents"; filename="torrent.torrent"\r\nContent-Type: application/x-bittorrent\r\n\r\n'.encode()
    suffix = f"\r\n--{boundary}--\r\n".encode()
    return prefix + payload + suffix, f"multipart/form-data; boundary={boundary}"


def add(arguments: dict[str, Any]) -> dict[str, Any]:
    assert_keys(arguments, {"magnet", "torrentBase64", "downloadPath", "confirmed"}, "torrent_add")
    if arguments.get("confirmed") is not True:
        raise ValueError("torrent_add requires explicit user confirmation")
    magnet = arguments.get("magnet")
    torrent = arguments.get("torrentBase64")
    if (magnet is None) == (torrent is None):
        raise ValueError("torrent_add requires exactly one magnet or torrentBase64")
    if magnet is not None:
        if not isinstance(magnet, str) or len(magnet) > 32_768 or not magnet.startswith("magnet:?xt=urn:btih:"):
            raise ValueError("torrent_add magnet is invalid")
        download_path = arguments.get("downloadPath", "")
        if download_path and (not isinstance(download_path, str) or len(download_path) > 4096 or "\0" in download_path):
            raise ValueError("torrent_add downloadPath is invalid")
        form_post("/api/v2/torrents/add", {"urls": magnet, "savepath": download_path})
    else:
        if not isinstance(torrent, str):
            raise ValueError("torrent_add payload is invalid")
        try:
            payload = base64.b64decode(torrent, validate=True)
        except (binascii.Error, ValueError) as error:
            raise ValueError("torrent_add payload is invalid") from error
        if not payload or len(payload) > MAX_TORRENT:
            raise ValueError("torrent_add payload is invalid or oversized")
        body, content_type = multipart_torrent(payload)
        request_text("/api/v2/torrents/add", "POST", body, content_type)
    return {"added": True}


def action(arguments: dict[str, Any]) -> dict[str, Any]:
    assert_keys(arguments, {"id", "action"}, "torrent_action")
    torrent_id = require_hash(arguments.get("id"))
    name = arguments.get("action")
    endpoint = {"start": "start", "resume": "start", "stop": "stop", "pause": "stop", "reannounce": "reannounce", "recheck": "recheck"}.get(name)
    if not endpoint:
        raise ValueError("torrent_action action is invalid")
    form_post(f"/api/v2/torrents/{endpoint}", {"hashes": torrent_id})
    return {"id": torrent_id, "action": name, "completed": True}


def control(arguments: dict[str, Any]) -> dict[str, Any]:
    assert_keys(
        arguments,
        {"ids", "action", "confirmed", "deleteData", "fileIds", "priority", "downloadLimit", "uploadLimit", "name", "enabled"},
        "torrent_control",
    )
    operation = arguments.get("action")
    ids = arguments.get("ids")
    if not isinstance(ids, list) or not ids or len(ids) > 100 or any(not isinstance(value, str) for value in ids) or len(set(ids)) != len(ids):
        raise ValueError("torrent_control ids must contain one to 100 unique torrent IDs")
    normalized_ids = [require_hash(value) for value in ids]
    hashes = "|".join(normalized_ids)
    supported = {"start", "stop", "forceStart", "autoStart", "reannounce", "recheck", "delete", "filePriority", "limits", "rename", "sequential", "firstLastPiece"}
    if operation not in supported:
        raise ValueError("torrent_control operation is invalid")
    if operation in {"start", "stop", "reannounce", "recheck"}:
        form_post(f"/api/v2/torrents/{operation}", {"hashes": hashes})
    elif operation in {"forceStart", "autoStart"}:
        form_post("/api/v2/torrents/setForceStart", {"hashes": hashes, "value": str(operation == "forceStart").lower()})
    elif operation == "delete":
        if arguments.get("confirmed") is not True:
            raise ValueError("deleting a torrent requires explicit user confirmation")
        if "deleteData" in arguments and not isinstance(arguments["deleteData"], bool):
            raise ValueError("torrent_control deleteData must be a boolean")
        form_post("/api/v2/torrents/delete", {"hashes": hashes, "deleteFiles": str(arguments.get("deleteData", False)).lower()})
    elif operation == "filePriority":
        file_ids = arguments.get("fileIds")
        priority = arguments.get("priority")
        if len(normalized_ids) != 1 or not isinstance(file_ids, list) or not file_ids or len(file_ids) > 10_000 or any(not isinstance(value, int) or isinstance(value, bool) or value < 0 for value in file_ids) or len(set(file_ids)) != len(file_ids):
            raise ValueError("filePriority requires one torrent and unique file indexes")
        if priority not in {0, 1, 6, 7}:
            raise ValueError("filePriority priority must be 0, 1, 6, or 7")
        form_post("/api/v2/torrents/filePrio", {"hash": normalized_ids[0], "id": "|".join(map(str, file_ids)), "priority": priority})
    elif operation == "limits":
        limits = [("downloadLimit", "/api/v2/torrents/setDownloadLimit"), ("uploadLimit", "/api/v2/torrents/setUploadLimit")]
        if all(name not in arguments for name, _ in limits):
            raise ValueError("limits requires downloadLimit or uploadLimit")
        for name, endpoint in limits:
            if name not in arguments:
                continue
            value = arguments[name]
            if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= 2_147_483_647:
                raise ValueError(f"{name} must be between 0 and 2147483647")
            form_post(endpoint, {"hashes": hashes, "limit": value})
    elif operation == "rename":
        if len(normalized_ids) != 1:
            raise ValueError("rename requires one torrent ID")
        form_post("/api/v2/torrents/rename", {"hash": normalized_ids[0], "name": bounded_text(arguments.get("name"), "torrent name", 512)})
    else:
        if len(normalized_ids) != 1 or not isinstance(arguments.get("enabled"), bool):
            raise ValueError(f"{operation} requires one torrent ID and enabled")
        torrents = request_json("/api/v2/torrents/info")
        if not isinstance(torrents, list):
            raise RuntimeError("qBittorrent returned an invalid torrent list")
        torrent = next((item for item in torrents if isinstance(item, dict) and str(item.get("hash", "")).lower() == normalized_ids[0]), None)
        if torrent is None:
            raise ValueError("torrent was not found")
        key = "seq_dl" if operation == "sequential" else "f_l_piece_prio"
        if bool(torrent.get(key)) != arguments["enabled"]:
            endpoint = "toggleSequentialDownload" if operation == "sequential" else "toggleFirstLastPiecePrio"
            form_post(f"/api/v2/torrents/{endpoint}", {"hashes": normalized_ids[0]})
    return {"ids": normalized_ids, "action": operation, "applied": True}


def invoke(tool: str, arguments: Any) -> Any:
    if not isinstance(arguments, dict):
        raise ValueError(f"{tool} arguments must be an object")
    if tool == "torrent_status":
        ensure()
        torrents = request_json("/api/v2/torrents/info")
        transfer = request_json("/api/v2/transfer/info")
        if not isinstance(torrents, list) or not isinstance(transfer, dict):
            raise RuntimeError("qBittorrent returned invalid status data")
        return {
            "ready": True,
            "version": request_text("/api/v2/app/version").strip(),
            "torrentCount": len(torrents),
            "transfer": {
                "downloadedBytes": safe_number(transfer.get("dl_info_data")),
                "uploadedBytes": safe_number(transfer.get("up_info_data")),
                "downloadSpeed": safe_number(transfer.get("dl_info_speed")),
                "uploadSpeed": safe_number(transfer.get("up_info_speed")),
                "connectionStatus": safe_text(transfer.get("connection_status"), 64),
                "dhtNodes": safe_number(transfer.get("dht_nodes")),
            },
        }
    ensure()
    if tool == "torrent_list":
        return list_torrents(arguments)
    if tool == "torrent_details":
        return details(arguments)
    if tool == "torrent_files":
        return details({**arguments, "section": "files"})
    if tool == "torrent_trackers":
        return details({**arguments, "section": "trackers"})
    if tool == "torrent_peers":
        return details({**arguments, "section": "peers"})
    if tool == "torrent_add":
        return add(arguments)
    if tool == "torrent_action":
        return action(arguments)
    if tool == "torrent_control":
        return control(arguments)
    raise ValueError(f"unknown torrent tool: {tool}")


def parse_json(source: str | None) -> Any:
    if source is None:
        return {}
    return json.loads(sys.stdin.read() if source == "-" else source)


def main() -> int:
    parser = argparse.ArgumentParser(prog="buzzard-torrent")
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("version", "start", "status", "stop"):
        commands.add_parser(name)
    call = commands.add_parser("call")
    call.add_argument("tool")
    call.add_argument("arguments", nargs="?")
    args = parser.parse_args()
    if args.command == "version":
        value = {"package": "buzzard-torrent", "version": VERSION, "protocolVersion": PROTOCOL_VERSION, "qbittorrentVersion": QBITTORRENT_VERSION}
    elif args.command == "start":
        value = ensure()
    elif args.command == "status":
        value = status()
    elif args.command == "stop":
        value = stop()
    else:
        value = invoke(args.tool, parse_json(args.arguments))
    print(json.dumps(value, separators=(",", ":"), sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, separators=(",", ":")), file=sys.stderr)
        raise SystemExit(1)
