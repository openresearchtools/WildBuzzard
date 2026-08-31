#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.


import argparse
import contextlib
import hashlib
import http.server
import json
import os
import pathlib
import pwd
import re
import shlex
import socket
import socketserver
import struct
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
import uuid
import zipfile

PACKAGES = (
    "buzzard-search",
    "buzzard-minijtt",
    "wildbuzzard",
)
ADDONS = {
    "web-search": "web-search@extensions.wildbuzzard",
    "torrent-search": "torrent-search@extensions.wildbuzzard",
}
CORE_BUILTIN_ADDONS = {
    "formautofill@mozilla.org": "formautofill",
    "ipp-activator@mozilla.com": "ipp-activator",
    "newtab@mozilla.org": "newtab",
    "pictureinpicture@mozilla.org": "pictureinpicture",
    "addons-search-detection@mozilla.com": "search-detection",
    "webcompat@mozilla.org": "webcompat",
}
EXPECTED_BUILTIN_ADDONS = {
    **CORE_BUILTIN_ADDONS,
    **{addon_id: slug for slug, addon_id in ADDONS.items()},
}
TOR_CHECK_URL = "https://check.torproject.org/api/ip"
TOR_ONION_HOST = "2gzyxa5ihm7nsggfxnu52rck2vv4rvmdlkiu3zzui5du4xyclen53wid.onion"
TOR_ONION_URL = f"http://{TOR_ONION_HOST}/index.html"
SAFE_NAME = re.compile(r"^[A-Za-z0-9_.+~-]+\.deb$")
UUID_PREF = re.compile(
    r'^user_pref\("extensions\.webextensions\.uuids",\s*("(?:[^"\\]|\\.)*")\);$'
)
TORRENT_FIXTURE_NAME = "wildbuzzard-release-validation.bin"
TORRENT_FIXTURE_PIECE_LENGTH = 16 * 1024
TORRENT_FIXTURE_PAYLOAD = (
    b"WildBuzzard local legal BitTorrent release validation fixture.\n" * 1536
)
TEST_DEPENDENCIES = ("python3-pyatspi",)
ATSPI_HELPER = r"""#!/usr/bin/python3
import argparse
import json
import time

import pyatspi


def children(node):
    try:
        return [node.getChildAtIndex(index) for index in range(node.childCount)]
    except Exception:
        return []


def text(node):
    try:
        return str(node.name or "")
    except Exception:
        return ""


def role(node):
    try:
        return str(node.getRoleName() or "")
    except Exception:
        return ""


def showing(node):
    try:
        state = node.getState()
        return state.contains(pyatspi.STATE_SHOWING) and state.contains(
            pyatspi.STATE_VISIBLE
        )
    except Exception:
        return False


def records(root):
    result = []
    stack = [(root, (), 0)]
    while stack and len(result) < 20000:
        node, ancestors, depth = stack.pop()
        result.append((node, ancestors, depth))
        if depth >= 64:
            continue
        for child in reversed(children(node)):
            stack.append((child, (*ancestors, node), depth + 1))
    return result


def applications(name):
    expected = name.casefold()
    desktop = pyatspi.Registry.getDesktop(0)
    return [app for app in children(desktop) if expected in text(app).casefold()]


def action(node):
    try:
        interface = node.queryAction()
        preferred = ("click", "press", "activate", "open")
        actions = [interface.getName(index).casefold() for index in range(interface.nActions)]
        for name in preferred:
            if name in actions:
                return interface, actions.index(name)
        if actions:
            return interface, 0
    except Exception:
        pass
    return None


def matching(args, require_action=False):
    candidates = []
    for app in applications(args.application):
        for node, ancestors, depth in records(app):
            node_name = text(node)
            node_role = role(node)
            if not showing(node):
                continue
            if args.contains:
                if args.name.casefold() not in node_name.casefold():
                    continue
            elif node_name.casefold() != args.name.casefold():
                continue
            expected_roles = [item for item in args.role.casefold().split("|") if item]
            if expected_roles and not any(
                item in node_role.casefold() for item in expected_roles
            ):
                continue
            if args.ancestor and not any(
                args.ancestor.casefold() in text(item).casefold()
                for item in ancestors
            ):
                continue
            selected_action = action(node)
            if require_action and selected_action is None:
                continue
            candidates.append((depth, node, selected_action))
    candidates.sort(key=lambda item: item[0], reverse=True)
    return candidates


def find(args, require_action=False):
    deadline = time.monotonic() + args.timeout
    while time.monotonic() < deadline:
        candidates = matching(args, require_action=require_action)
        if candidates:
            return candidates[0]
        time.sleep(0.1)
    raise RuntimeError(f"accessible target not found: {args.name!r} ({args.role!r})")


def accept_dialog(args):
    deadline = time.monotonic() + args.timeout
    accepted = {"accept", "add", "ok", "open", "yes"}
    while time.monotonic() < deadline:
        for app in applications(args.application):
            app_records = records(app)
            for node, ancestors, _depth in app_records:
                if args.name.casefold() not in text(node).casefold() or not showing(node):
                    continue
                scopes = [node, *reversed(ancestors)]
                scope = next(
                    (
                        item
                        for item in scopes
                        if role(item).casefold() in {"alert", "dialog"}
                    ),
                    None,
                )
                if scope is None:
                    continue
                buttons = []
                for candidate, _parents, depth in records(scope):
                    selected_action = action(candidate)
                    if (
                        showing(candidate)
                        and "button" in role(candidate).casefold()
                        and text(candidate).strip().casefold() in accepted
                        and selected_action is not None
                    ):
                        buttons.append((depth, candidate, selected_action))
                if buttons:
                    buttons.sort(key=lambda item: item[0], reverse=True)
                    return buttons[0]
        time.sleep(0.1)
    raise RuntimeError(f"native confirmation not found: {args.name!r}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=("activate", "accept-dialog", "set-text", "wait"))
    parser.add_argument("--application", default="WildBuzzard")
    parser.add_argument("--name", required=True)
    parser.add_argument("--role", default="")
    parser.add_argument("--ancestor", default="")
    parser.add_argument("--contains", action="store_true")
    parser.add_argument("--timeout", type=float, default=30)
    parser.add_argument("--value", default="")
    args = parser.parse_args()
    if args.operation == "accept-dialog":
        depth, node, selected_action = accept_dialog(args)
    else:
        depth, node, selected_action = find(
            args, require_action=args.operation == "activate"
        )
    if args.operation in {"activate", "accept-dialog"}:
        interface, index = selected_action
        if not interface.doAction(index):
            raise RuntimeError("accessible action failed")
    elif args.operation == "set-text":
        node.queryComponent().grabFocus()
        node.queryEditableText().setTextContents(args.value)
    print(json.dumps({
        "depth": depth,
        "name": text(node),
        "operation": args.operation,
        "role": role(node),
    }, sort_keys=True))


if __name__ == "__main__":
    main()
"""


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


class Runner:
    def __init__(self, log_path):
        self.log_path = log_path
        self.log_path.parent.mkdir(parents=True, exist_ok=True)

    def run(self, command, *, input_text=None, env=None, timeout=300, check=True):
        with self.log_path.open("a", encoding="utf-8") as log:
            log.write(f"$ {shlex.join(map(str, command))}\n")
            log.flush()
            try:
                result = subprocess.run(
                    list(map(str, command)),
                    input=input_text,
                    text=True,
                    capture_output=True,
                    env=env,
                    timeout=timeout,
                    check=False,
                )
            except subprocess.TimeoutExpired as error:
                for stream_output in (error.stdout, error.stderr):
                    decoded_output = (
                        stream_output.decode(errors="replace")
                        if isinstance(stream_output, bytes)
                        else stream_output
                    )
                    if decoded_output:
                        log.write(decoded_output)
                log.write(f"[timeout after {timeout} seconds]\n")
                raise RuntimeError(
                    f"command timed out after {timeout} seconds: "
                    f"{shlex.join(map(str, command))}"
                ) from error
            log.write(result.stdout)
            log.write(result.stderr)
            log.write(f"[exit {result.returncode}]\n")
        if check and result.returncode != 0:
            raise RuntimeError(
                f"command failed ({result.returncode}): {shlex.join(map(str, command))}"
            )
        return result


class FixtureServer:
    def __init__(self, body):
        self.body = body

    def __enter__(self):
        body = self.body

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                if urllib.parse.urlsplit(self.path).path != "/fixture.html":
                    self.send_error(404)
                    return
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, _format, *_arguments):
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return f"http://127.0.0.1:{self.server.server_address[1]}/fixture.html"

    def __exit__(self, _type, _value, _traceback):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=10)


class BrowserTorrentFixtureServer:
    def __init__(self, fixture):
        self.fixture = fixture

    def __enter__(self):
        fixture = self.fixture
        magnet = (
            f"magnet:?xt=urn:btih:{fixture.info_hash_hex}"
            f"&dn={urllib.parse.quote(TORRENT_FIXTURE_NAME)}"
            f"&tr={urllib.parse.quote(fixture.announce_url, safe='')}"
        )
        escaped_magnet = magnet.replace("&", "&amp;").replace('"', "&quot;")
        body = (
            "<!doctype html><meta charset=utf-8>"
            "<title>WildBuzzard native torrent ingress</title>"
            "<main><h1>WildBuzzard native torrent ingress</h1>"
            '<a id="torrent" href="/release.torrent">Download torrent file</a>'
            f'<a id="magnet" href="{escaped_magnet}">Open magnet link</a>'
            "</main>"
        ).encode()

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                path = urllib.parse.urlsplit(self.path).path
                if path == "/fixture.html":
                    content_type = "text/html; charset=utf-8"
                    payload = body
                elif path == "/release.torrent":
                    content_type = "application/x-bittorrent"
                    payload = fixture.torrent
                else:
                    self.send_error(404)
                    return
                self.send_response(200)
                self.send_header("Content-Type", content_type)
                if path == "/release.torrent":
                    self.send_header(
                        "Content-Disposition",
                        'attachment; filename="wildbuzzard-release-validation.torrent"',
                    )
                self.send_header("Content-Length", str(len(payload)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, _format, *_arguments):
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        origin = f"http://127.0.0.1:{self.server.server_address[1]}"
        return {"magnet": magnet, "url": f"{origin}/fixture.html"}

    def __exit__(self, _type, _value, _traceback):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=10)


def bencode(value):
    if isinstance(value, bool):
        raise TypeError("booleans are not bencode integers")
    if isinstance(value, int):
        return f"i{value}e".encode("ascii")
    if isinstance(value, str):
        value = value.encode("utf-8")
    if isinstance(value, bytes):
        return str(len(value)).encode("ascii") + b":" + value
    if isinstance(value, (list, tuple)):
        return b"l" + b"".join(bencode(item) for item in value) + b"e"
    if isinstance(value, dict):
        encoded = []
        for key, item in value.items():
            encoded_key = key.encode("utf-8") if isinstance(key, str) else key
            if not isinstance(encoded_key, bytes):
                raise TypeError("bencode dictionary keys must be bytes or strings")
            encoded.append((encoded_key, item))
        encoded.sort(key=lambda item: item[0])
        return (
            b"d"
            + b"".join(bencode(key) + bencode(item) for key, item in encoded)
            + b"e"
        )
    raise TypeError(f"unsupported bencode value: {type(value).__name__}")


def torrent_fixture_info(payload=TORRENT_FIXTURE_PAYLOAD):
    pieces = b"".join(
        hashlib.sha1(payload[offset : offset + TORRENT_FIXTURE_PIECE_LENGTH]).digest()
        for offset in range(0, len(payload), TORRENT_FIXTURE_PIECE_LENGTH)
    )
    return {
        b"length": len(payload),
        b"name": TORRENT_FIXTURE_NAME.encode("utf-8"),
        b"piece length": TORRENT_FIXTURE_PIECE_LENGTH,
        b"pieces": pieces,
        b"private": 1,
    }


def read_exact(stream, length):
    chunks = []
    remaining = length
    while remaining:
        chunk = stream.recv(remaining)
        if not chunk:
            raise EOFError("peer closed the connection")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def peer_message(message_id, payload=b""):
    body = bytes([message_id]) + payload
    return struct.pack(">I", len(body)) + body


class TorrentFixture:
    peer_id = b"-WB0001-LOCALFIXTURE"

    def __init__(self, payload=TORRENT_FIXTURE_PAYLOAD):
        self.payload = payload
        self.info = torrent_fixture_info(payload)
        self.info_hash = hashlib.sha1(bencode(self.info)).digest()
        self.info_hash_hex = self.info_hash.hex()
        self.announces = 0
        self.requests = 0
        self.served_bytes = 0
        self.lock = threading.Lock()

    def __enter__(self):
        fixture = self

        class PeerHandler(socketserver.BaseRequestHandler):
            def handle(self):
                self.request.settimeout(20)
                try:
                    handshake = read_exact(self.request, 68)
                    if (
                        handshake[:20] != b"\x13BitTorrent protocol"
                        or handshake[28:48] != fixture.info_hash
                    ):
                        return
                    response = (
                        b"\x13BitTorrent protocol"
                        + (b"\0" * 8)
                        + fixture.info_hash
                        + fixture.peer_id
                    )
                    piece_count = (
                        len(fixture.payload) + TORRENT_FIXTURE_PIECE_LENGTH - 1
                    ) // TORRENT_FIXTURE_PIECE_LENGTH
                    bitfield = bytearray((piece_count + 7) // 8)
                    for index in range(piece_count):
                        bitfield[index // 8] |= 1 << (7 - (index % 8))
                    self.request.sendall(
                        response + peer_message(5, bytes(bitfield)) + peer_message(1)
                    )
                    while True:
                        length = struct.unpack(">I", read_exact(self.request, 4))[0]
                        if length == 0:
                            continue
                        if length > 1024 * 1024:
                            return
                        message = read_exact(self.request, length)
                        if message[0] != 6 or len(message) != 13:
                            continue
                        index, begin, requested = struct.unpack(">III", message[1:])
                        absolute = index * TORRENT_FIXTURE_PIECE_LENGTH + begin
                        piece_end = min(
                            (index + 1) * TORRENT_FIXTURE_PIECE_LENGTH,
                            len(fixture.payload),
                        )
                        if (
                            requested == 0
                            or requested > 128 * 1024
                            or absolute >= piece_end
                            or absolute + requested > piece_end
                        ):
                            return
                        block = fixture.payload[absolute : absolute + requested]
                        self.request.sendall(
                            peer_message(7, struct.pack(">II", index, begin) + block)
                        )
                        with fixture.lock:
                            fixture.requests += 1
                            fixture.served_bytes += len(block)
                except (EOFError, OSError, socket.timeout, struct.error):
                    return

        class PeerServer(socketserver.ThreadingTCPServer):
            allow_reuse_address = True
            daemon_threads = True

        self.peer_server = PeerServer(("127.0.0.1", 0), PeerHandler)
        self.peer_thread = threading.Thread(
            target=self.peer_server.serve_forever, daemon=True
        )
        self.peer_thread.start()
        peer_port = self.peer_server.server_address[1]
        tracker_body = bencode({
            b"complete": 1,
            b"incomplete": 0,
            b"interval": 1,
            b"min interval": 1,
            b"peers": socket.inet_aton("127.0.0.1") + struct.pack(">H", peer_port),
        })

        class TrackerHandler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                if urllib.parse.urlsplit(self.path).path != "/announce":
                    self.send_error(404)
                    return
                with fixture.lock:
                    fixture.announces += 1
                self.send_response(200)
                self.send_header("Content-Type", "text/plain")
                self.send_header("Content-Length", str(len(tracker_body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(tracker_body)

            def log_message(self, _format, *_arguments):
                pass

        self.tracker_server = http.server.ThreadingHTTPServer(
            ("127.0.0.1", 0), TrackerHandler
        )
        self.tracker_thread = threading.Thread(
            target=self.tracker_server.serve_forever, daemon=True
        )
        self.tracker_thread.start()
        tracker_port = self.tracker_server.server_address[1]
        self.announce_url = f"http://127.0.0.1:{tracker_port}/announce"
        self.torrent = bencode({
            b"announce": self.announce_url,
            b"created by": "WildBuzzard release validation",
            b"creation date": 0,
            b"info": self.info,
        })
        return self

    def __exit__(self, _type, _value, _traceback):
        for server, thread in (
            (self.tracker_server, self.tracker_thread),
            (self.peer_server, self.peer_thread),
        ):
            server.shutdown()
            server.server_close()
            thread.join(timeout=10)

    def statistics(self):
        with self.lock:
            return {
                "announces": self.announces,
                "requests": self.requests,
                "servedBytes": self.served_bytes,
            }


def os_release():
    values = {}
    for line in (
        pathlib.Path("/etc/os-release").read_text(encoding="utf-8").splitlines()
    ):
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key] = value.strip().strip('"')
    return values


def find_gui_session():
    candidates = []
    for process in pathlib.Path("/proc").iterdir():
        if not process.name.isdigit():
            continue
        try:
            if (process / "comm").read_text(encoding="utf-8").strip() != "gnome-shell":
                continue
            status = (process / "status").read_text(encoding="utf-8")
            uid_line = next(
                line for line in status.splitlines() if line.startswith("Uid:")
            )
            uid = int(uid_line.split()[1])
            if uid < 1000:
                continue
            source = (process / "environ").read_bytes().split(b"\0")
            environment = {}
            for entry in source:
                if b"=" in entry:
                    key, value = entry.split(b"=", 1)
                    environment[key.decode(errors="ignore")] = value.decode(
                        errors="ignore"
                    )
            candidates.append((int(process.name), uid, environment))
        except (OSError, StopIteration, ValueError):
            continue
    if not candidates:
        raise RuntimeError("no logged-in GNOME session was found")
    _, uid, source = max(candidates)
    account = pwd.getpwuid(uid)
    runtime = pathlib.Path(source.get("XDG_RUNTIME_DIR", f"/run/user/{uid}"))
    if not runtime.is_dir() or not (runtime / "bus").exists():
        raise RuntimeError("the logged-in GNOME session has no active user bus")
    x_displays = sorted(
        path.name[1:] for path in pathlib.Path("/tmp/.X11-unix").glob("X[0-9]*")
    )
    display = source.get("DISPLAY", f":{x_displays[0]}" if x_displays else ":0")
    wayland_sockets = sorted(
        path.name
        for path in runtime.glob("wayland-*")
        if path.is_socket() and not path.name.endswith(".lock")
    )
    wayland_display = source.get("WAYLAND_DISPLAY")
    if not wayland_display and wayland_sockets:
        wayland_display = wayland_sockets[0]
    authorities = sorted(runtime.glob(".mutter-Xwaylandauth.*"))
    xauthority = source.get("XAUTHORITY")
    if not xauthority and authorities:
        xauthority = str(authorities[0])
    environment = {
        "DBUS_SESSION_BUS_ADDRESS": source.get(
            "DBUS_SESSION_BUS_ADDRESS", f"unix:path={runtime}/bus"
        ),
        "DISPLAY": display,
        "HOME": account.pw_dir,
        "LANG": source.get("LANG", "C.UTF-8"),
        "LOGNAME": account.pw_name,
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "USER": account.pw_name,
        "XDG_RUNTIME_DIR": str(runtime),
        "XDG_SESSION_TYPE": source.get("XDG_SESSION_TYPE", "wayland"),
    }
    if wayland_display:
        environment["MOZ_ENABLE_WAYLAND"] = "1"
        environment["WAYLAND_DISPLAY"] = wayland_display
    if xauthority:
        environment["XAUTHORITY"] = xauthority
    for name in (
        "DESKTOP_SESSION",
        "XDG_CONFIG_HOME",
        "XDG_CURRENT_DESKTOP",
        "XDG_SESSION_DESKTOP",
    ):
        if source.get(name):
            environment[name] = source[name]
    return account, environment


def as_user(account, environment, command):
    return [
        "/usr/sbin/runuser",
        "-u",
        account.pw_name,
        "--",
        "/usr/bin/env",
        "-i",
        *[f"{key}={value}" for key, value in sorted(environment.items())],
        *command,
    ]


def install_atspi_helper(result_dir, account):
    helper = result_dir / "atspi-driver.py"
    helper.write_text(ATSPI_HELPER, encoding="utf-8")
    helper.chmod(0o700)
    os.chown(helper, account.pw_uid, account.pw_gid)
    return helper


def atspi_json(
    runner,
    result_dir,
    account,
    environment,
    helper,
    label,
    operation,
    name,
    *,
    role="",
    ancestor="",
    contains=False,
    value="",
    timeout=30,
):
    command = [
        "/usr/bin/python3",
        str(helper),
        operation,
        "--application",
        "WildBuzzard",
        "--name",
        name,
        "--timeout",
        str(timeout),
    ]
    if role:
        command.extend(("--role", role))
    if ancestor:
        command.extend(("--ancestor", ancestor))
    if contains:
        command.append("--contains")
    if value:
        command.extend(("--value", value))
    result = runner.run(
        as_user(account, environment, command),
        timeout=timeout + 15,
    )
    output = parse_json_output(result, label)
    write_json(result_dir / "atspi" / f"{label}.json", output)
    return output


def minijtt_fixture_stub(magnet):
    fixture = {
        "magnet": magnet,
        "name": TORRENT_FIXTURE_NAME,
        "resultId": "R" * 32,
        "sourceId": "release.fixture",
        "sourceName": "Offline release fixture",
    }
    encoded = json.dumps(fixture, sort_keys=True)
    return f"""#!/usr/bin/python3
import json
import sys

FIXTURE = json.loads({encoded!r})


def emit(value):
    print(json.dumps(value, separators=(",", ":"), sort_keys=True))


arguments = sys.argv[1:]
if arguments == ["version"]:
    emit({{
        "package": "buzzard-minijtt",
        "protocolVersion": 1,
        "schemaVersion": 1,
        "version": "0.0.0-test",
    }})
    raise SystemExit(0)
if len(arguments) != 3 or arguments[0] != "call" or arguments[2] != "-":
    raise SystemExit(2)
request = json.load(sys.stdin)
if arguments[1] == "torrent_sources" and request == {{"schemaVersion": 1}}:
    emit({{
        "ok": True,
        "schemaVersion": 1,
        "sources": [{{"id": FIXTURE["sourceId"], "name": FIXTURE["sourceName"]}}],
    }})
elif arguments[1] == "torrent_search":
    emit({{
        "ok": True,
        "query": request.get("query"),
        "results": [{{
            "leechers": 0,
            "publishedAt": None,
            "resultId": FIXTURE["resultId"],
            "seeders": 1,
            "sizeBytes": {len(TORRENT_FIXTURE_PAYLOAD)},
            "sourceId": FIXTURE["sourceId"],
            "sourceName": FIXTURE["sourceName"],
            "title": FIXTURE["name"],
        }}],
        "schemaVersion": 1,
        "truncated": False,
    }})
elif (
    arguments[1] == "torrent_resolve"
    and request == {{"schemaVersion": 1, "resultId": FIXTURE["resultId"]}}
):
    emit({{
        "name": FIXTURE["name"],
        "ok": True,
        "payload": {{"kind": "magnet", "value": FIXTURE["magnet"]}},
        "schemaVersion": 1,
        "sizeBytes": {len(TORRENT_FIXTURE_PAYLOAD)},
        "sourceName": FIXTURE["sourceName"],
    }})
else:
    emit({{
        "error": {{"code": "INVALID_REQUEST", "message": "invalid fixture request"}},
        "ok": False,
        "schemaVersion": 1,
    }})
    raise SystemExit(2)
"""


@contextlib.contextmanager
def mounted_minijtt_fixture(runner, result_dir, magnet):
    installed = pathlib.Path("/usr/bin/buzzard-minijtt")
    before = {
        "gid": installed.stat().st_gid,
        "mode": installed.stat().st_mode & 0o7777,
        "sha256": sha256(installed),
        "size": installed.stat().st_size,
        "uid": installed.stat().st_uid,
    }
    if runner.run(["mountpoint", "-q", installed], check=False).returncode == 0:
        raise RuntimeError("buzzard-minijtt already has a mounted test override")
    runtime = result_dir / "runtime"
    runtime.mkdir(mode=0o700, exist_ok=True)
    stub = runtime / "buzzard-minijtt-fixture"
    stub.write_text(minijtt_fixture_stub(magnet), encoding="utf-8")
    stub.chmod(0o555)
    evidence = {
        "installedBefore": before,
        "stubSha256": sha256(stub),
        "temporaryBindMount": True,
    }
    mounted = False
    try:
        runner.run(["mount", "--bind", stub, installed], timeout=30)
        mounted = True
        if sha256(installed) != evidence["stubSha256"]:
            raise RuntimeError("buzzard-minijtt fixture bind mount differs")
        yield evidence
    finally:
        if mounted:
            runner.run(["umount", installed], timeout=30)
        after_stat = installed.stat()
        after = {
            "gid": after_stat.st_gid,
            "mode": after_stat.st_mode & 0o7777,
            "sha256": sha256(installed),
            "size": after_stat.st_size,
            "uid": after_stat.st_uid,
        }
        evidence["installedAfter"] = after
        evidence["restored"] = after == before
        write_json(result_dir / "minijtt-test-override.json", evidence)
        if after != before:
            raise RuntimeError("installed buzzard-minijtt was not restored exactly")


def prepare_gui_session(runner, account, environment):
    runner.run(["/usr/bin/loginctl", "unlock-sessions"], timeout=30)
    for schema, key, value in (
        ("org.gnome.desktop.session", "idle-delay", "uint32 0"),
        ("org.gnome.desktop.screensaver", "idle-activation-enabled", "false"),
        ("org.gnome.desktop.screensaver", "lock-enabled", "false"),
    ):
        runner.run(
            as_user(
                account,
                environment,
                ["/usr/bin/gsettings", "set", schema, key, value],
            ),
            timeout=30,
        )
    runner.run(
        as_user(
            account,
            environment,
            [
                "/usr/bin/gdbus",
                "call",
                "--session",
                "--dest",
                "org.gnome.ScreenSaver",
                "--object-path",
                "/org/gnome/ScreenSaver",
                "--method",
                "org.gnome.ScreenSaver.SetActive",
                "false",
            ],
        ),
        timeout=30,
    )


def package_field(runner, path, field):
    return runner.run(["dpkg-deb", "-f", path, field]).stdout.strip()


def manifest_entries(manifest):
    entries = manifest.get("artifacts")
    if (
        manifest.get("schemaVersion") != 1
        or not isinstance(entries, list)
        or len(entries) != len(PACKAGES)
        or not all(isinstance(entry, dict) for entry in entries)
    ):
        raise RuntimeError("artifact manifest does not contain the exact package set")
    packages = [entry.get("package") for entry in entries]
    filenames = [entry.get("filename") for entry in entries]
    if (
        not all(isinstance(package, str) for package in packages)
        or set(packages) != set(PACKAGES)
        or len(set(packages)) != len(PACKAGES)
    ):
        raise RuntimeError("artifact manifest does not contain the exact package set")
    if not all(isinstance(filename, str) for filename in filenames):
        raise RuntimeError("artifact manifest contains an invalid filename")
    if len(set(filenames)) != len(PACKAGES):
        raise RuntimeError("artifact manifest contains duplicate filenames")
    for entry in entries:
        filename = entry.get("filename")
        if (
            not isinstance(filename, str)
            or not SAFE_NAME.fullmatch(filename)
            or pathlib.Path(filename).name != filename
            or entry.get("architecture") != "amd64"
        ):
            raise RuntimeError("artifact manifest contains an invalid artifact")
    return entries


def verify_artifacts(runner, manifest, staging):
    verified = []
    entries = manifest_entries(manifest)
    for entry in entries:
        filename = entry.get("filename")
        path = staging / filename
        actual = {
            "filename": filename,
            "package": package_field(runner, path, "Package"),
            "version": package_field(runner, path, "Version"),
            "architecture": package_field(runner, path, "Architecture"),
            "sha256": sha256(path),
            "size": path.stat().st_size,
        }
        if actual != entry:
            raise RuntimeError(f"guest artifact verification failed for {filename}")
        verified.append(actual)
    return sorted(verified, key=lambda item: item["package"])


def download_artifacts(manifest, staging, base_url):
    entries = manifest_entries(manifest)
    staging.mkdir(mode=0o700, parents=True, exist_ok=True)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for entry in entries:
        filename = entry.get("filename")
        size = entry.get("size")
        if (
            not isinstance(filename, str)
            or pathlib.Path(filename).name != filename
            or not isinstance(size, int)
            or isinstance(size, bool)
            or size <= 0
        ):
            raise RuntimeError("artifact manifest contains an invalid download")
        target = staging / filename
        temporary = staging / f".{filename}.download"
        request = urllib.request.Request(
            f"{base_url.rstrip('/')}/{urllib.parse.quote(filename)}",
            headers={"Accept": "application/vnd.debian.binary-package"},
        )
        total = 0
        try:
            with opener.open(request, timeout=120) as response, temporary.open(
                "wb"
            ) as output:
                length = response.headers.get("Content-Length")
                if length is not None and int(length) != size:
                    raise RuntimeError(f"artifact server length differs for {filename}")
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > size:
                        raise RuntimeError(
                            f"artifact server sent too much data for {filename}"
                        )
                    output.write(chunk)
                output.flush()
                os.fsync(output.fileno())
        except Exception:
            temporary.unlink(missing_ok=True)
            raise
        if total != size:
            temporary.unlink(missing_ok=True)
            raise RuntimeError(
                f"artifact server sent {total} of {size} bytes for {filename}"
            )
        temporary.chmod(0o600)
        temporary.replace(target)


def installed_packages(runner):
    installed = {}
    for package in PACKAGES:
        result = runner.run(
            ["dpkg-query", "-W", "-f", "${Status}\t${Version}\n", package],
            check=False,
        )
        if result.returncode == 0 and result.stdout.startswith(
            "install ok installed\t"
        ):
            installed[package] = result.stdout.split("\t", 1)[1].strip()
    return installed


def install_packages(runner, artifacts, staging, allow_installed):
    existing = installed_packages(runner)
    if existing and not allow_installed:
        raise RuntimeError(
            f"custom packages were already installed: {sorted(existing)}"
        )
    environment = dict(os.environ)
    environment["DEBIAN_FRONTEND"] = "noninteractive"
    runner.run(["apt-get", "update"], env=environment, timeout=900)
    paths = [staging / entry["filename"] for entry in artifacts]
    runner.run(
        [
            "apt-get",
            "install",
            "-y",
            "--no-install-recommends",
            *TEST_DEPENDENCIES,
            *paths,
        ],
        env=environment,
        timeout=1200,
    )
    expected = {entry["package"]: entry["version"] for entry in artifacts}
    actual = installed_packages(runner)
    if actual != expected:
        raise RuntimeError(
            f"installed package versions differ: expected {expected}, got {actual}"
        )
    for executable in PACKAGES:
        path = pathlib.Path("/usr/bin") / executable
        if not path.is_file() or not os.access(path, os.X_OK):
            raise RuntimeError(f"missing installed executable: {path}")
    return actual


def parse_json_output(result, label):
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"{label} did not return one JSON document") from error


def run_json(
    runner,
    result_dir,
    account,
    environment,
    label,
    command,
    *,
    input_text=None,
    timeout=120,
):
    result = runner.run(
        as_user(account, environment, command),
        input_text=input_text,
        timeout=timeout,
    )
    value = parse_json_output(result, label)
    write_json(result_dir / "cli" / f"{label}.json", value)
    return value


def run_wildbuzzard_torrent_json(
    runner,
    result_dir,
    account,
    environment,
    label,
    arguments,
    *,
    timeout=120,
):
    value = run_json(
        runner,
        result_dir,
        account,
        environment,
        label,
        ["/usr/bin/wildbuzzard", "--json", *arguments],
        timeout=timeout,
    )
    details = value.get("details")
    if value.get("ok") is not True or not isinstance(details, dict):
        raise RuntimeError(f"{label} did not return WildBuzzard torrent details")
    return details


def assert_version(value, package):
    if value.get("package") != package or value.get("protocolVersion") != 1:
        raise RuntimeError(f"{package} version contract is invalid")


def validate_local_torrent_download(
    runner, result_dir, account, environment, *, timeout=180
):
    download_dir = result_dir / "torrent-download"
    download_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    download_dir.chmod(0o700)
    os.chown(download_dir, account.pw_uid, account.pw_gid)
    target = download_dir / TORRENT_FIXTURE_NAME
    if target.exists():
        raise RuntimeError("local torrent validation target already exists")
    torrent_environment = dict(environment)
    torrent_environment["BUZZARD_TORRENT_DOWNLOADS"] = str(download_dir)
    added = False
    removed = False
    fixture = TorrentFixture()
    with fixture:
        torrent_path = result_dir / "torrent-release-validation.torrent"
        torrent_path.write_bytes(fixture.torrent)
        initial = run_wildbuzzard_torrent_json(
            runner,
            result_dir,
            account,
            torrent_environment,
            "wildbuzzard-torrent-list-initial",
            ["torrent-list"],
            timeout=120,
        )
        if initial.get("torrents") != [] or initial.get("limit") != 50:
            raise RuntimeError("fresh VM torrent list is not empty")
        try:
            added_result = run_wildbuzzard_torrent_json(
                runner,
                result_dir,
                account,
                torrent_environment,
                "wildbuzzard-torrent-add-local-fixture",
                [
                    "torrent-add",
                    "--file",
                    str(torrent_path),
                    "--download-path",
                    str(download_dir),
                ],
                timeout=120,
            )
            if added_result.get("added") is not True:
                raise RuntimeError("WildBuzzard torrent_add contract is invalid")
            added = True
            completed = None
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                current = run_wildbuzzard_torrent_json(
                    runner,
                    result_dir,
                    account,
                    torrent_environment,
                    "wildbuzzard-torrent-list-download",
                    ["torrent-list", "--limit", "100"],
                    timeout=45,
                )
                matches = [
                    item
                    for item in current.get("torrents", [])
                    if isinstance(item, dict)
                    and item.get("id") == fixture.info_hash_hex
                ]
                if len(matches) > 1:
                    raise RuntimeError("local torrent appears more than once")
                if matches:
                    candidate = matches[0]
                    if (
                        candidate.get("progress") == 1
                        and candidate.get("sizeBytes") == len(fixture.payload)
                        and candidate.get("downloadedBytes", 0) >= len(fixture.payload)
                        and target.is_file()
                        and target.read_bytes() == fixture.payload
                    ):
                        completed = candidate
                        break
                time.sleep(0.5)
            if completed is None:
                raise RuntimeError(
                    "local BitTorrent fixture did not finish downloading"
                )
            if (
                completed.get("name") != TORRENT_FIXTURE_NAME
                or pathlib.Path(completed.get("savePath", "")).resolve()
                != download_dir.resolve()
            ):
                raise RuntimeError("downloaded torrent identity or save path differs")
            overview = run_wildbuzzard_torrent_json(
                runner,
                result_dir,
                account,
                torrent_environment,
                "wildbuzzard-torrent-details-overview",
                ["torrent-details", fixture.info_hash_hex],
                timeout=120,
            )
            if (
                overview.get("id") != fixture.info_hash_hex
                or overview.get("infohashV1") != fixture.info_hash_hex
                or overview.get("name") != TORRENT_FIXTURE_NAME
                or overview.get("totalSizeBytes") != len(fixture.payload)
                or overview.get("downloadedBytes", 0) < len(fixture.payload)
                or overview.get("private") is not True
            ):
                raise RuntimeError("WildBuzzard torrent overview details are invalid")
            files = run_wildbuzzard_torrent_json(
                runner,
                result_dir,
                account,
                torrent_environment,
                "wildbuzzard-torrent-details-files",
                ["torrent-details", fixture.info_hash_hex, "files"],
                timeout=120,
            )
            if (
                files.get("id") != fixture.info_hash_hex
                or files.get("section") != "files"
                or files.get("total") != 1
                or len(files.get("items", [])) != 1
                or files["items"][0].get("name") != TORRENT_FIXTURE_NAME
                or files["items"][0].get("sizeBytes") != len(fixture.payload)
                or files["items"][0].get("progress") != 1
            ):
                raise RuntimeError("WildBuzzard torrent file details are invalid")
            control = run_wildbuzzard_torrent_json(
                runner,
                result_dir,
                account,
                torrent_environment,
                "wildbuzzard-torrent-control-delete",
                [
                    "torrent-control",
                    "delete",
                    fixture.info_hash_hex,
                    "--no-delete-data",
                ],
                timeout=120,
            )
            if control != {
                "action": "delete",
                "applied": True,
                "ids": [fixture.info_hash_hex],
            }:
                raise RuntimeError(
                    "WildBuzzard torrent_control contract is invalid"
                )
            removed = True
            after_delete = run_wildbuzzard_torrent_json(
                runner,
                result_dir,
                account,
                torrent_environment,
                "wildbuzzard-torrent-list-after-delete",
                ["torrent-list"],
                timeout=120,
            )
            if any(
                item.get("id") == fixture.info_hash_hex
                for item in after_delete.get("torrents", [])
                if isinstance(item, dict)
            ):
                raise RuntimeError("local torrent remained after removal")
            if not target.is_file() or target.read_bytes() != fixture.payload:
                raise RuntimeError(
                    "deleteData=false did not preserve downloaded evidence"
                )
        finally:
            if added and not removed:
                with contextlib.suppress(Exception):
                    run_wildbuzzard_torrent_json(
                        runner,
                        result_dir,
                        account,
                        torrent_environment,
                        "wildbuzzard-torrent-control-cleanup",
                        [
                            "torrent-control",
                            "delete",
                            fixture.info_hash_hex,
                            "--no-delete-data",
                        ],
                        timeout=120,
                    )
    statistics = fixture.statistics()
    if (
        statistics["announces"] < 1
        or statistics["requests"] < 1
        or statistics["servedBytes"] < len(fixture.payload)
    ):
        raise RuntimeError("local tracker and peer did not serve the torrent payload")
    evidence = {
        "announceHost": "127.0.0.1",
        "downloadedFile": str(target),
        "downloadedSha256": sha256(target),
        "downloadedSize": target.stat().st_size,
        "fileName": TORRENT_FIXTURE_NAME,
        "infoHashV1": fixture.info_hash_hex,
        "networkScope": "loopback-only",
        "payloadSha256": hashlib.sha256(fixture.payload).hexdigest(),
        "payloadSize": len(fixture.payload),
        "privateTorrent": True,
        "source": "local-tracker-and-peer",
        "torrentFile": str(torrent_path),
        "torrentFileSha256": sha256(torrent_path),
        **statistics,
    }
    if evidence["downloadedSha256"] != evidence["payloadSha256"]:
        raise RuntimeError("downloaded torrent SHA-256 differs from the fixture")
    write_json(result_dir / "torrent-download-validation.json", evidence)
    return evidence


def validate_clis(runner, result_dir, account, environment, search_query):
    versions = {}
    for package in ("buzzard-search", "buzzard-minijtt"):
        value = run_json(
            runner,
            result_dir,
            account,
            environment,
            f"{package}-version",
            [f"/usr/bin/{package}", "version"],
        )
        assert_version(value, package)
        versions[package] = value

    search_request = {
        "schemaVersion": 1,
        "query": search_query,
        "provider": "ddgs",
        "maxResults": 3,
        "timeoutSeconds": 45,
        "page": 1,
        "safeSearch": 1,
    }
    search = run_json(
        runner,
        result_dir,
        account,
        environment,
        "buzzard-search-web-search",
        ["/usr/bin/buzzard-search", "call", "web_search", "-"],
        input_text=json.dumps(search_request),
        timeout=75,
    )
    if (
        search.get("schemaVersion") != 1
        or search.get("ok") is not True
        or search.get("provider") != "ddgs"
        or search.get("query") != search_query
        or not isinstance(search.get("results"), list)
        or len(search["results"]) > 3
    ):
        raise RuntimeError("buzzard-search web_search contract is invalid")

    sources = run_json(
        runner,
        result_dir,
        account,
        environment,
        "buzzard-minijtt-torrent-sources",
        ["/usr/bin/buzzard-minijtt", "call", "torrent_sources", "-"],
        input_text='{"schemaVersion":1}',
        timeout=120,
    )
    if (
        sources.get("schemaVersion") != 1
        or sources.get("ok") is not True
        or not isinstance(sources.get("sources"), list)
        or len(sources["sources"]) > 64
    ):
        raise RuntimeError("buzzard-minijtt torrent_sources contract is invalid")
    mini_search = run_json(
        runner,
        result_dir,
        account,
        environment,
        "buzzard-minijtt-torrent-search",
        ["/usr/bin/buzzard-minijtt", "call", "torrent_search", "-"],
        input_text='{"schemaVersion":1,"query":"debian","limit":5}',
        timeout=120,
    )
    if (
        mini_search.get("schemaVersion") != 1
        or mini_search.get("ok") is not True
        or mini_search.get("query") != "debian"
        or not isinstance(mini_search.get("results"), list)
        or len(mini_search["results"]) > 5
    ):
        raise RuntimeError("buzzard-minijtt torrent_search contract is invalid")

    torrent_download = validate_local_torrent_download(
        runner, result_dir, account, environment
    )
    return versions, torrent_download


def archive_entries():
    archives = sorted(pathlib.Path("/opt/wildbuzzard").rglob("*.ja"))
    if not archives:
        raise RuntimeError("WildBuzzard omni archives were not installed")
    entries = {}
    for archive in archives:
        if not zipfile.is_zipfile(archive):
            continue
        with zipfile.ZipFile(archive) as source:
            for name in source.namelist():
                entries.setdefault(name, (archive, name))
    return archives, entries


def read_archive_json(entries, suffix):
    matches = [value for name, value in entries.items() if name.endswith(suffix)]
    if len(matches) != 1:
        raise RuntimeError(
            f"expected one archive entry ending with {suffix}, got {len(matches)}"
        )
    archive, name = matches[0]
    with zipfile.ZipFile(archive) as source:
        return json.loads(source.read(name)), str(archive), name


def inspect_builtin_addons(result_dir):
    archives, entries = archive_entries()
    listing, listing_archive, listing_path = read_archive_json(
        entries, "built_in_addons.json"
    )
    by_id = {entry.get("addon_id"): entry for entry in listing.get("builtins", [])}
    if set(by_id) != set(EXPECTED_BUILTIN_ADDONS):
        raise RuntimeError(
            "unexpected built-in add-on registry: "
            + ", ".join(sorted(set(by_id) ^ set(EXPECTED_BUILTIN_ADDONS)))
        )
    for addon_id, slug in EXPECTED_BUILTIN_ADDONS.items():
        registered = by_id[addon_id]
        if registered.get("res_url") != f"resource://builtin-addons/{slug}/":
            raise RuntimeError(f"built-in add-on resource differs: {addon_id}")
        if (
            not isinstance(registered.get("addon_version"), str)
            or not registered["addon_version"]
        ):
            raise RuntimeError(f"built-in add-on has no version: {addon_id}")
    inspected = {}
    for slug, addon_id in ADDONS.items():
        registered = by_id.get(addon_id)
        if not registered or registered.get("addon_version") != "0.1.0":
            raise RuntimeError(f"built-in add-on is not registered: {addon_id}")
        manifest, archive, path = read_archive_json(
            entries, f"builtin-addons/{slug}/manifest.json"
        )
        gecko = manifest.get("browser_specific_settings", {}).get("gecko", {})
        csp = manifest.get("content_security_policy", "")
        if (
            gecko.get("id") != addon_id
            or manifest.get("incognito") != "not_allowed"
            or manifest.get("permissions") != ["storage"]
            or "connect-src 'none'" not in csp
        ):
            raise RuntimeError(f"built-in add-on manifest is unsafe: {addon_id}")
        inspected[addon_id] = {
            "archive": archive,
            "manifestPath": path,
            "registration": registered,
        }
    value = {
        "archives": [str(path) for path in archives],
        "listingArchive": listing_archive,
        "listingPath": listing_path,
        "coreAddons": {addon_id: by_id[addon_id] for addon_id in CORE_BUILTIN_ADDONS},
        "addons": inspected,
    }
    write_json(result_dir / "builtin-extension-inspection.json", value)
    return value


def browser_json(
    runner, result_dir, account, environment, label, arguments, timeout=120
):
    return run_json(
        runner,
        result_dir,
        account,
        environment,
        label,
        [
            "/usr/bin/wildbuzzard",
            "--json",
            "--cwd",
            str(result_dir),
            *arguments,
        ],
        timeout=timeout,
    )


def verify_png(path, label):
    if not path.is_file() or path.stat().st_size < 45:
        raise RuntimeError(f"{label} screenshot is missing or empty")
    with path.open("rb") as source:
        header = source.read(24)
        source.seek(-12, os.SEEK_END)
        trailer = source.read(12)
    if (
        header[:8] != b"\x89PNG\r\n\x1a\n"
        or header[8:12] != b"\x00\x00\x00\x0d"
        or header[12:16] != b"IHDR"
        or trailer != b"\x00\x00\x00\x00IEND\xaeB`\x82"
    ):
        raise RuntimeError(f"{label} screenshot is not a PNG image")
    if (
        int.from_bytes(header[16:20], "big") == 0
        or int.from_bytes(header[20:24], "big") == 0
    ):
        raise RuntimeError(f"{label} screenshot has invalid dimensions")


def parse_extension_uuids(preferences):
    for line in reversed(preferences.splitlines()):
        match = UUID_PREF.fullmatch(line.strip())
        if not match:
            continue
        value = json.loads(json.loads(match.group(1)))
        if isinstance(value, dict):
            return value
    raise RuntimeError("the browser profile does not contain extension UUIDs")


def extension_profile_roots(account, environment):
    home = pathlib.Path(account.pw_dir)
    config = pathlib.Path(environment.get("XDG_CONFIG_HOME", home / ".config"))
    values = [home / "WildBuzzard", home / ".wildbuzzard", config]
    roots = []
    for value in values:
        if value.is_absolute() and value not in roots:
            roots.append(value)
    return roots


def find_extension_profile(account, result_dir, environment, timeout=60):
    profile_roots = extension_profile_roots(account, environment)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        candidates = []
        extension_files = set()
        for profile_root in profile_roots:
            try:
                extension_files.update(profile_root.rglob("extensions.json"))
            except OSError:
                continue
        for extensions_path in sorted(extension_files):
            preferences_path = extensions_path.with_name("prefs.js")
            try:
                extensions = json.loads(extensions_path.read_text(encoding="utf-8"))
                mappings = parse_extension_uuids(
                    preferences_path.read_text(encoding="utf-8")
                )
                extension_items = [
                    item
                    for item in extensions.get("addons", [])
                    if item.get("type") == "extension"
                ]
                by_id = {item.get("id"): item for item in extension_items}
                if len(by_id) != len(extension_items) or set(by_id) != set(
                    EXPECTED_BUILTIN_ADDONS
                ):
                    raise RuntimeError(
                        "profile factory extension inventory is not exact"
                    )
                records = {}
                system_records = {}
                for addon_id, slug in EXPECTED_BUILTIN_ADDONS.items():
                    item = by_id[addon_id]
                    if (
                        item.get("active") is not True
                        or item.get("visible") is not True
                        or item.get("location") != "app-builtin-addons"
                        or item.get("rootURI") != f"resource://builtin-addons/{slug}/"
                    ):
                        raise RuntimeError(f"profile add-on is not active: {addon_id}")
                    if addon_id in CORE_BUILTIN_ADDONS:
                        system_records[addon_id] = {
                            "active": True,
                            "rootURI": item["rootURI"],
                            "version": item.get("version"),
                        }
                        continue
                    if item.get("version") != "0.1.0":
                        raise RuntimeError(
                            f"profile add-on has unexpected version: {addon_id}"
                        )
                    extension_uuid = mappings.get(addon_id)
                    if (
                        not isinstance(extension_uuid, str)
                        or str(uuid.UUID(extension_uuid)) != extension_uuid.lower()
                    ):
                        raise RuntimeError(f"profile has no valid UUID for {addon_id}")
                    records[addon_id] = {
                        "active": True,
                        "rootURI": item["rootURI"],
                        "uuid": extension_uuid,
                        "version": item.get("version"),
                    }
                candidates.append({
                    "profile": extensions_path.parent,
                    "extensionsPath": extensions_path,
                    "preferencesPath": preferences_path,
                    "records": records,
                    "systemRecords": system_records,
                })
            except (OSError, ValueError, RuntimeError):
                continue
        if len(candidates) == 1:
            candidate = candidates[0]
            settings_path = candidate["profile"] / "extension-settings.json"
            evidence = {
                "profile": str(candidate["profile"]),
                "profileFiles": {
                    "extensions": str(candidate["extensionsPath"]),
                    "extensionSettings": str(settings_path)
                    if settings_path.is_file()
                    else None,
                    "preferences": str(candidate["preferencesPath"]),
                },
                "extensions": candidate["records"],
                "factoryExtensionIds": sorted(EXPECTED_BUILTIN_ADDONS),
                "systemExtensions": candidate["systemRecords"],
            }
            write_json(result_dir / "browser-extension-profile.json", evidence)
            return evidence
        if len(candidates) > 1:
            raise RuntimeError(
                "multiple active WildBuzzard profiles contain the built-in add-ons"
            )
        time.sleep(0.25)
    raise RuntimeError("could not discover the launched WildBuzzard extension profile")


def snapshot_ref(snapshot, name, roles=()):
    refs = snapshot.get("details", {}).get("refs", [])
    matches = [
        item
        for item in refs
        if isinstance(item, dict)
        and item.get("name") == name
        and (not roles or item.get("role") in roles)
        and isinstance(item.get("ref"), str)
    ]
    if len(matches) != 1:
        raise RuntimeError(
            f"expected one native browser target named {name}, got {len(matches)}"
        )
    return f"@{matches[0]['ref']}"


def opened_page(result, label):
    page = result.get("details", {}).get("page")
    if isinstance(page, bool) or not isinstance(page, int) or page < 1:
        raise RuntimeError(f"{label} did not return a valid page ID")
    return page


def wait_for_selector(
    runner,
    result_dir,
    account,
    environment,
    label,
    session,
    page,
    selector,
    *,
    attempts=1,
):
    for attempt in range(1, attempts + 1):
        result = browser_json(
            runner,
            result_dir,
            account,
            environment,
            f"{label}-{attempt}",
            [
                "--session",
                session,
                "wait",
                "--page",
                str(page),
                "--for",
                "selector",
                "--value",
                selector,
                "--timeout",
                "30000",
            ],
            timeout=45,
        )
        if result.get("details", {}).get("matched") is True:
            return
    raise RuntimeError(f"WildBuzzard timed out waiting for {label}")


def evaluate_page(
    runner,
    result_dir,
    account,
    environment,
    label,
    session,
    page,
    code,
    *,
    timeout=120,
):
    result = browser_json(
        runner,
        result_dir,
        account,
        environment,
        label,
        [
            "--session",
            session,
            "evaluate",
            "--page",
            str(page),
            "--code",
            code,
        ],
        timeout=timeout,
    )
    details = result.get("details", {})
    if "value" not in details:
        raise RuntimeError(f"{label} did not return a serializable value")
    return details["value"]


def screenshot_page(
    runner,
    result_dir,
    account,
    environment,
    label,
    session,
    page,
    filename,
):
    screenshot = result_dir / "screenshots" / filename
    browser_json(
        runner,
        result_dir,
        account,
        environment,
        label,
        [
            "--session",
            session,
            "screenshot",
            "--page",
            str(page),
            "--format",
            "png",
            "--output",
            str(screenshot),
        ],
    )
    verify_png(screenshot, label)
    return screenshot


def validate_addons_manager(runner, result_dir, account, environment):
    session = "release-addons-manager"
    opened = browser_json(
        runner,
        result_dir,
        account,
        environment,
        "wildbuzzard-open-addons-manager",
        ["--session", session, "open", "about:addons"],
    )
    page = opened_page(opened, "about:addons")
    wait_for_selector(
        runner,
        result_dir,
        account,
        environment,
        "wildbuzzard-wait-addons-manager",
        session,
        page,
        'addon-card[addon-id="web-search@extensions.wildbuzzard"]',
        attempts=3,
    )
    inventory = evaluate_page(
        runner,
        result_dir,
        account,
        environment,
        "wildbuzzard-evaluate-addons-manager",
        session,
        page,
        """
const cards = Array.from(document.querySelectorAll("addon-card"));
return cards
  .filter(card => card.getClientRects().length)
  .map(card => ({
    id: card.getAttribute("addon-id"),
    name: card.addon?.name || card.textContent.trim().split("\\n")[0],
  }))
  .sort((left, right) => left.id.localeCompare(right.id));
""",
    )
    expected = sorted(ADDONS.values())
    if (
        not isinstance(inventory, list)
        or [item.get("id") for item in inventory if isinstance(item, dict)] != expected
    ):
        raise RuntimeError(
            "about:addons does not show exactly the two WildBuzzard extensions"
        )
    names = {item.get("name") for item in inventory}
    if names != {"Buzzard Web Search", "Torrent Search"}:
        raise RuntimeError("about:addons extension names differ from the release set")
    screenshot = screenshot_page(
        runner,
        result_dir,
        account,
        environment,
        "wildbuzzard-screenshot-addons-manager",
        session,
        page,
        "extensions.png",
    )
    return {"extensions": inventory, "pageId": page, "screenshot": str(screenshot)}


def validate_search_settings(runner, result_dir, account, environment):
    session = "release-search-settings"
    opened = browser_json(
        runner,
        result_dir,
        account,
        environment,
        "wildbuzzard-open-search-settings",
        ["--session", session, "open", "about:preferences#search"],
    )
    page = opened_page(opened, "search settings")
    wait_for_selector(
        runner,
        result_dir,
        account,
        environment,
        "wildbuzzard-wait-search-settings",
        session,
        page,
        "#defaultEngineNormal",
        attempts=3,
    )
    defaults = evaluate_page(
        runner,
        result_dir,
        account,
        environment,
        "wildbuzzard-evaluate-search-settings",
        session,
        page,
        """
const result = {};
for (const [key, id] of [
  ["normal", "defaultEngineNormal"],
  ["private", "defaultPrivateEngine"],
]) {
  const control = document.getElementById(id);
  if (!control) {
    throw new Error(`missing ${id}`);
  }
  await control.updateComplete;
  result[key] = {
    id: control.value,
    label: control.selectedOption?.label || "",
    optionCount: control.options.length,
  };
}
return result;
""",
    )
    if not isinstance(defaults, dict):
        raise RuntimeError("search settings did not expose browser defaults")
    for context in ("normal", "private"):
        selected = defaults.get(context, {})
        if (
            selected.get("label") != "DuckDuckGo"
            or not isinstance(selected.get("id"), str)
            or not selected["id"]
            or not isinstance(selected.get("optionCount"), int)
            or selected["optionCount"] < 1
        ):
            raise RuntimeError(f"DuckDuckGo is not the {context} default search engine")
    if defaults["normal"]["id"] != defaults["private"]["id"]:
        raise RuntimeError("normal and private DuckDuckGo engine IDs differ")
    screenshot = screenshot_page(
        runner,
        result_dir,
        account,
        environment,
        "wildbuzzard-screenshot-search-settings",
        session,
        page,
        "search-settings.png",
    )
    return {"defaults": defaults, "pageId": page, "screenshot": str(screenshot)}


def validate_tor_egress(runner, result_dir, account, environment):
    check_code = """
const data = JSON.parse(document.body.innerText.trim());
const ip = String(data.IP || "");
if (!ip) {
  throw new Error("Tor check returned no IP address");
}
const digest = await crypto.subtle.digest(
  "SHA-256",
  new TextEncoder().encode(ip)
);
return {
  isTor: data.IsTor === true,
  ipSha256: Array.from(new Uint8Array(digest), byte =>
    byte.toString(16).padStart(2, "0")
  ).join(""),
};
"""
    sanitize_code = """
document.body.replaceChildren();
const heading = document.createElement("h1");
heading.textContent = "WildBuzzard routing verification";
const result = document.createElement("p");
result.textContent = "The Tor Project check completed successfully. IP addresses were removed before this screenshot.";
document.body.append(heading, result);
return { sanitized: true };
"""
    direct_session = "release-direct-egress"
    direct_opened = browser_json(
        runner,
        result_dir,
        account,
        environment,
        "wildbuzzard-open-direct-tor-check",
        ["--session", direct_session, "open", TOR_CHECK_URL],
        timeout=180,
    )
    if direct_opened.get("details", {}).get("tor") is not False:
        raise RuntimeError("direct Tor check unexpectedly used a Tor tab")
    direct_page = opened_page(direct_opened, "direct Tor check")
    direct = evaluate_page(
        runner,
        result_dir,
        account,
        environment,
        "wildbuzzard-evaluate-direct-tor-check",
        direct_session,
        direct_page,
        check_code,
    )
    tor_session = "release-tor-egress"
    tor_opened = browser_json(
        runner,
        result_dir,
        account,
        environment,
        "wildbuzzard-open-tor-check",
        ["--session", tor_session, "open", "--tor", TOR_CHECK_URL],
        timeout=300,
    )
    if tor_opened.get("details", {}).get("tor") is not True:
        raise RuntimeError("Tor check was not opened in a Tor tab")
    tor_page = opened_page(tor_opened, "Tor check")
    tor = evaluate_page(
        runner,
        result_dir,
        account,
        environment,
        "wildbuzzard-evaluate-tor-check",
        tor_session,
        tor_page,
        check_code,
    )
    if (
        not isinstance(direct, dict)
        or direct.get("isTor") is not False
        or not re.fullmatch(r"[0-9a-f]{64}", str(direct.get("ipSha256", "")))
    ):
        raise RuntimeError("direct browser egress did not pass the Tor check")
    evaluate_page(
        runner,
        result_dir,
        account,
        environment,
        "wildbuzzard-sanitize-direct-tor-check",
        direct_session,
        direct_page,
        sanitize_code,
    )
    direct_screenshot = screenshot_page(
        runner,
        result_dir,
        account,
        environment,
        "wildbuzzard-screenshot-direct-tor-check",
        direct_session,
        direct_page,
        "tor-direct.png",
    )
    if (
        not isinstance(tor, dict)
        or tor.get("isTor") is not True
        or not re.fullmatch(r"[0-9a-f]{64}", str(tor.get("ipSha256", "")))
        or tor["ipSha256"] == direct["ipSha256"]
    ):
        raise RuntimeError("Tor browser egress did not pass the Tor check")
    evaluate_page(
        runner,
        result_dir,
        account,
        environment,
        "wildbuzzard-sanitize-tor-check",
        tor_session,
        tor_page,
        sanitize_code,
    )
    check_screenshot = screenshot_page(
        runner,
        result_dir,
        account,
        environment,
        "wildbuzzard-screenshot-tor-check",
        tor_session,
        tor_page,
        "tor-routed.png",
    )
    onion_opened = browser_json(
        runner,
        result_dir,
        account,
        environment,
        "wildbuzzard-open-tor-onion",
        ["--session", tor_session, "open", "--tor", TOR_ONION_URL],
        timeout=300,
    )
    if onion_opened.get("details", {}).get("tor") is not True:
        raise RuntimeError("onion service was not opened in a Tor tab")
    onion_page = opened_page(onion_opened, "Tor onion service")
    onion = evaluate_page(
        runner,
        result_dir,
        account,
        environment,
        "wildbuzzard-evaluate-tor-onion",
        tor_session,
        onion_page,
        """
return {
  host: location.hostname,
  protocol: location.protocol,
  textLength: document.body.innerText.trim().length,
};
""",
    )
    if (
        not isinstance(onion, dict)
        or onion.get("host") != TOR_ONION_HOST
        or onion.get("protocol") != "http:"
        or not isinstance(onion.get("textLength"), int)
        or onion["textLength"] < 1
    ):
        raise RuntimeError("live v3 onion service validation failed")
    onion_screenshot = screenshot_page(
        runner,
        result_dir,
        account,
        environment,
        "wildbuzzard-screenshot-tor-onion",
        tor_session,
        onion_page,
        "tor-onion.png",
    )
    return {
        "checkPageId": tor_page,
        "checkScreenshot": str(check_screenshot),
        "directIsTor": False,
        "directPageId": direct_page,
        "directScreenshot": str(direct_screenshot),
        "egressChanged": True,
        "onion": onion,
        "onionPageId": onion_page,
        "onionScreenshot": str(onion_screenshot),
        "torIsTor": True,
    }


def validate_extension_ui(
    runner,
    result_dir,
    account,
    environment,
    extension_profile,
    *,
    slug,
    page,
    query,
    query_name,
    screenshot_name,
):
    addon_id = ADDONS[slug]
    extension_uuid = extension_profile["extensions"][addon_id]["uuid"]
    url = f"moz-extension://{extension_uuid}/{page}"
    session = f"release-{slug}-ui"
    opened = browser_json(
        runner,
        result_dir,
        account,
        environment,
        f"wildbuzzard-open-{slug}-ui",
        ["--session", session, "open", url],
    )
    if opened.get("ok") is not True:
        raise RuntimeError(f"WildBuzzard did not open the {addon_id} page")
    page_id = opened_page(opened, addon_id)
    wait_for_selector(
        runner,
        result_dir,
        account,
        environment,
        f"wildbuzzard-wait-{slug}-ready",
        session,
        page_id,
        "#search-button:not([disabled])",
    )
    snapshot = browser_json(
        runner,
        result_dir,
        account,
        environment,
        f"wildbuzzard-snapshot-{slug}-ready",
        ["--session", session, "snapshot", "--page", str(page_id)],
    )
    query_ref = snapshot_ref(snapshot, query_name)
    search_ref = snapshot_ref(snapshot, "Search", ("button",))
    browser_json(
        runner,
        result_dir,
        account,
        environment,
        f"wildbuzzard-fill-{slug}-query",
        [
            "--session",
            session,
            "fill",
            "--page",
            str(page_id),
            "--",
            query_ref,
            query,
        ],
    )
    browser_json(
        runner,
        result_dir,
        account,
        environment,
        f"wildbuzzard-click-{slug}-search",
        [
            "--session",
            session,
            "click",
            "--page",
            str(page_id),
            search_ref,
        ],
    )
    wait_for_selector(
        runner,
        result_dir,
        account,
        environment,
        f"wildbuzzard-wait-{slug}-results",
        session,
        page_id,
        "#results-section:not([hidden])",
        attempts=3,
    )
    results = browser_json(
        runner,
        result_dir,
        account,
        environment,
        f"wildbuzzard-read-{slug}-results",
        ["--session", session, "read", "--page", str(page_id), "text"],
    )
    rendered_text = "\n".join(
        item["text"]
        for item in results.get("content", [])
        if isinstance(item, dict) and isinstance(item.get("text"), str)
    )
    if not re.search(r"\b\d+ results\b|No results found\.", rendered_text):
        raise RuntimeError(f"{addon_id} did not render a CLI-backed search response")
    browser_json(
        runner,
        result_dir,
        account,
        environment,
        f"wildbuzzard-snapshot-{slug}-results",
        ["--session", session, "snapshot", "--page", str(page_id)],
    )
    screenshot = result_dir / "screenshots" / screenshot_name
    browser_json(
        runner,
        result_dir,
        account,
        environment,
        f"wildbuzzard-screenshot-{slug}-ui",
        [
            "--session",
            session,
            "screenshot",
            "--page",
            str(page_id),
            "--format",
            "png",
            "--output",
            str(screenshot),
        ],
    )
    verify_png(screenshot, addon_id)
    return {
        "addonId": addon_id,
        "pageId": page_id,
        "page": url,
        "query": query,
        "screenshot": str(screenshot),
    }


def validate_torrent_extension_tab_rejection(
    runner, result_dir, account, environment, extension_profile
):
    addon_id = ADDONS["torrent-search"]
    extension_uuid = extension_profile["extensions"][addon_id]["uuid"]
    url = f"moz-extension://{extension_uuid}/src/popup.html"
    session = "release-torrent-search-tab-negative"
    opened = browser_json(
        runner,
        result_dir,
        account,
        environment,
        "wildbuzzard-open-torrent-search-tab-negative",
        ["--session", session, "open", url],
    )
    page = opened_page(opened, "torrent-search extension tab")
    wait_for_selector(
        runner,
        result_dir,
        account,
        environment,
        "wildbuzzard-wait-torrent-search-tab-ready",
        session,
        page,
        "#search-button:not([disabled])",
    )
    snapshot = browser_json(
        runner,
        result_dir,
        account,
        environment,
        "wildbuzzard-snapshot-torrent-search-tab-ready",
        ["--session", session, "snapshot", "--page", str(page)],
    )
    browser_json(
        runner,
        result_dir,
        account,
        environment,
        "wildbuzzard-fill-torrent-search-tab-query",
        [
            "--session",
            session,
            "fill",
            "--page",
            str(page),
            "--",
            snapshot_ref(snapshot, "Search torrents"),
            "release fixture",
        ],
    )
    browser_json(
        runner,
        result_dir,
        account,
        environment,
        "wildbuzzard-click-torrent-search-tab-search",
        [
            "--session",
            session,
            "click",
            "--page",
            str(page),
            snapshot_ref(snapshot, "Search", ("button",)),
        ],
    )
    wait_for_selector(
        runner,
        result_dir,
        account,
        environment,
        "wildbuzzard-wait-torrent-search-tab-results",
        session,
        page,
        ".review-button",
    )
    results_snapshot = browser_json(
        runner,
        result_dir,
        account,
        environment,
        "wildbuzzard-snapshot-torrent-search-tab-results",
        ["--session", session, "snapshot", "--page", str(page)],
    )
    browser_json(
        runner,
        result_dir,
        account,
        environment,
        "wildbuzzard-click-torrent-search-tab-review",
        [
            "--session",
            session,
            "click",
            "--page",
            str(page),
            snapshot_ref(results_snapshot, "Review download", ("button",)),
        ],
    )
    wait_for_selector(
        runner,
        result_dir,
        account,
        environment,
        "wildbuzzard-wait-torrent-search-tab-confirmation",
        session,
        page,
        "#confirmation[open]",
    )
    confirmation_snapshot = browser_json(
        runner,
        result_dir,
        account,
        environment,
        "wildbuzzard-snapshot-torrent-search-tab-confirmation",
        ["--session", session, "snapshot", "--page", str(page)],
    )
    clicked = browser_json(
        runner,
        result_dir,
        account,
        environment,
        "wildbuzzard-click-torrent-search-tab-add",
        [
            "--session",
            session,
            "click",
            "--page",
            str(page),
            snapshot_ref(confirmation_snapshot, "Add torrent", ("button",)),
        ],
    )
    if clicked.get("details", {}).get("dialog") is not None:
        raise RuntimeError("directly opened extension tab reached a native prompt")
    rejected = browser_json(
        runner,
        result_dir,
        account,
        environment,
        "wildbuzzard-wait-torrent-search-tab-rejected",
        [
            "--session",
            session,
            "wait",
            "--page",
            str(page),
            "--for",
            "text",
            "--value",
            "not authorized",
            "--timeout",
            "20000",
        ],
    )
    if rejected.get("details", {}).get("matched") is not True:
        raise RuntimeError("direct extension tab import did not fail closed")
    screenshot = screenshot_page(
        runner,
        result_dir,
        account,
        environment,
        "wildbuzzard-screenshot-torrent-search-tab-rejected",
        session,
        page,
        "torrent-search-extension.png",
    )
    browser_json(
        runner,
        result_dir,
        account,
        environment,
        "wildbuzzard-close-torrent-search-tab-rejected",
        ["--session", session, "tabs", "close", str(page)],
    )
    return {
        "addonId": addon_id,
        "closed": True,
        "page": url,
        "pageId": page,
        "rejected": True,
        "screenshot": str(screenshot),
    }


def validate_torrent_action_popup(
    runner,
    result_dir,
    account,
    environment,
    helper,
    fixture,
    list_torrents,
    *,
    timeout=60,
):
    actions = []

    def perform(label, operation, name, **options):
        result = atspi_json(
            runner,
            result_dir,
            account,
            environment,
            helper,
            label,
            operation,
            name,
            **options,
        )
        actions.append(result)
        return result

    perform(
        "torrent-popup-open-extensions",
        "activate",
        "Extensions",
        role="button",
    )
    perform(
        "torrent-popup-open-action",
        "activate",
        "Search torrents",
        role="button",
    )
    perform(
        "torrent-popup-wait-query",
        "wait",
        "Search torrents",
        role="entry|text",
    )
    perform(
        "torrent-popup-fill-query",
        "set-text",
        "Search torrents",
        role="entry|text",
        value="release fixture",
    )
    perform("torrent-popup-search", "activate", "Search", role="button")
    perform(
        "torrent-popup-wait-review",
        "wait",
        "Review download",
        role="button",
        timeout=45,
    )
    perform(
        "torrent-popup-review",
        "activate",
        "Review download",
        role="button",
    )
    perform(
        "torrent-popup-wait-add",
        "wait",
        "Add torrent",
        role="button",
    )
    perform(
        "torrent-popup-add",
        "activate",
        "Add torrent",
        role="button",
    )
    perform(
        "torrent-popup-native-confirm",
        "accept-dialog",
        TORRENT_FIXTURE_NAME,
        contains=True,
        timeout=45,
    )

    matched = None
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        current = list_torrents("browser-torrent-list-extension-popup")
        matches = [
            item
            for item in current.get("torrents", [])
            if isinstance(item, dict) and item.get("id") == fixture.info_hash_hex
        ]
        if len(matches) > 1:
            raise RuntimeError("extension-popup torrent appears more than once")
        if matches:
            matched = matches[0]
            break
        time.sleep(0.25)
    if matched is None:
        raise RuntimeError("extension popup did not add the exact fixture info hash")
    return {
        "actions": actions,
        "addonId": ADDONS["torrent-search"],
        "infoHashV1": fixture.info_hash_hex,
        "nativeConfirmation": True,
        "networkScope": "loopback-only",
        "trustedDesktopActivation": "AT-SPI",
    }


def validate_browser_torrent_ingress(
    runner,
    result_dir,
    account,
    environment,
    extension_profile,
    *,
    timeout=180,
):
    download_dir = pathlib.Path(environment["BUZZARD_TORRENT_DOWNLOADS"])
    target = download_dir / TORRENT_FIXTURE_NAME
    if target.exists():
        raise RuntimeError("browser torrent validation target already exists")
    session = "release-native-torrent"
    fixture = TorrentFixture()
    active_ids = set()

    def list_torrents(label):
        return run_wildbuzzard_torrent_json(
            runner,
            result_dir,
            account,
            environment,
            label,
            ["torrent-list", "--limit", "100"],
            timeout=45,
        )

    def remove_torrent(label, *, delete_data=False):
        result = run_wildbuzzard_torrent_json(
            runner,
            result_dir,
            account,
            environment,
            label,
            [
                "torrent-control",
                "delete",
                fixture.info_hash_hex,
                "--delete-data" if delete_data else "--no-delete-data",
            ],
            timeout=120,
        )
        if result.get("applied") is not True:
            raise RuntimeError("browser-imported torrent could not be removed")
        active_ids.discard(fixture.info_hash_hex)

    def click_and_accept(page, name, label):
        snapshot = browser_json(
            runner,
            result_dir,
            account,
            environment,
            f"wildbuzzard-snapshot-{label}",
            ["--session", session, "snapshot", "--page", str(page)],
        )
        link = snapshot_ref(snapshot, name, ("link",))
        clicked = browser_json(
            runner,
            result_dir,
            account,
            environment,
            f"wildbuzzard-click-{label}",
            ["--session", session, "click", "--page", str(page), link],
        )
        dialog = clicked.get("details", {}).get("dialog")
        if (
            not isinstance(dialog, dict)
            or dialog.get("kind") != "confirm"
            or "torrent" not in dialog.get("message", "").lower()
        ):
            raise RuntimeError(f"{label} did not show native confirmation")
        accepted = browser_json(
            runner,
            result_dir,
            account,
            environment,
            f"wildbuzzard-accept-{label}",
            ["--session", session, "dialog-accept", "--page", str(page)],
            timeout=180,
        )
        if accepted.get("ok") is not True:
            raise RuntimeError(f"{label} confirmation was not accepted")
        return {
            "dialogKind": dialog["kind"],
            "pageId": page,
            "trigger": name,
        }

    try:
        with fixture, BrowserTorrentFixtureServer(fixture) as source:
            helper = install_atspi_helper(result_dir, account)
            with mounted_minijtt_fixture(
                runner, result_dir, source["magnet"]
            ) as minijtt_override:
                direct_tab_rejection = validate_torrent_extension_tab_rejection(
                    runner,
                    result_dir,
                    account,
                    environment,
                    extension_profile,
                )
                if any(
                    item.get("id") == fixture.info_hash_hex
                    for item in list_torrents(
                        "browser-torrent-list-after-extension-tab-rejection"
                    ).get("torrents", [])
                    if isinstance(item, dict)
                ):
                    raise RuntimeError("rejected extension tab added a torrent")
                extension_popup = validate_torrent_action_popup(
                    runner,
                    result_dir,
                    account,
                    environment,
                    helper,
                    fixture,
                    list_torrents,
                )
                active_ids.add(fixture.info_hash_hex)
                remove_torrent(
                    "browser-torrent-delete-extension-popup-import",
                    delete_data=True,
                )
                deadline = time.monotonic() + 30
                while target.exists() and time.monotonic() < deadline:
                    time.sleep(0.25)
                if target.exists():
                    raise RuntimeError(
                        "extension-popup fixture data remained after safe cleanup"
                    )

            opened = browser_json(
                runner,
                result_dir,
                account,
                environment,
                "wildbuzzard-open-torrent-fixture",
                ["--session", session, "open", source["url"]],
            )
            torrent_page = opened_page(opened, "native torrent fixture")
            file_confirmation = click_and_accept(
                torrent_page, "Download torrent file", "torrent-file"
            )
            file_confirmation["contentDisposition"] = "attachment"
            active_ids.add(fixture.info_hash_hex)
            completed = None
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                current = list_torrents("browser-torrent-list-download")
                matches = [
                    item
                    for item in current.get("torrents", [])
                    if isinstance(item, dict)
                    and item.get("id") == fixture.info_hash_hex
                ]
                if len(matches) > 1:
                    raise RuntimeError(
                        "browser-imported torrent appears more than once"
                    )
                if (
                    matches
                    and matches[0].get("progress") == 1
                    and matches[0].get("downloadedBytes", 0) >= len(fixture.payload)
                    and target.is_file()
                    and target.read_bytes() == fixture.payload
                ):
                    completed = matches[0]
                    break
                time.sleep(0.5)
            if completed is None:
                raise RuntimeError("browser-imported torrent did not finish")

            manager_opened = browser_json(
                runner,
                result_dir,
                account,
                environment,
                "wildbuzzard-open-torrent-manager-evidence",
                ["--session", session, "open", "about:torrents"],
            )
            manager_page = opened_page(manager_opened, "about:torrents")
            manager_wait = browser_json(
                runner,
                result_dir,
                account,
                environment,
                "wildbuzzard-wait-torrent-manager-evidence",
                [
                    "--session",
                    session,
                    "wait",
                    "--page",
                    str(manager_page),
                    "--for",
                    "text",
                    "--value",
                    TORRENT_FIXTURE_NAME,
                    "--timeout",
                    "30000",
                ],
            )
            if manager_wait.get("details", {}).get("matched") is not True:
                raise RuntimeError("about:torrents did not show the completed download")
            manager_screenshot = screenshot_page(
                runner,
                result_dir,
                account,
                environment,
                "wildbuzzard-screenshot-torrent-manager",
                session,
                manager_page,
                "torrent-manager.png",
            )
            remove_torrent("browser-torrent-delete-file-import")

            magnet_opened = browser_json(
                runner,
                result_dir,
                account,
                environment,
                "wildbuzzard-open-magnet-fixture",
                ["--session", session, "open", source["url"]],
            )
            magnet_page = opened_page(magnet_opened, "native magnet fixture")
            magnet_confirmation = click_and_accept(
                magnet_page, "Open magnet link", "magnet-link"
            )
            active_ids.add(fixture.info_hash_hex)
            magnet_seen = False
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                current = list_torrents("browser-torrent-list-magnet")
                if any(
                    item.get("id") == fixture.info_hash_hex
                    for item in current.get("torrents", [])
                    if isinstance(item, dict)
                ):
                    magnet_seen = True
                    break
                time.sleep(0.25)
            if not magnet_seen:
                raise RuntimeError("confirmed magnet was not added to qBittorrent")
            remove_torrent("browser-torrent-delete-magnet-import")

        statistics = fixture.statistics()
        if (
            statistics["announces"] < 1
            or statistics["requests"] < 1
            or statistics["servedBytes"] < len(fixture.payload)
        ):
            raise RuntimeError("browser torrent ingress did not transfer the payload")
        evidence = {
            "downloadedFile": str(target),
            "downloadedSha256": sha256(target),
            "downloadedSize": target.stat().st_size,
            "directExtensionTab": direct_tab_rejection,
            "extensionPopup": extension_popup,
            "fileConfirmation": file_confirmation,
            "infoHashV1": fixture.info_hash_hex,
            "magnetConfirmation": magnet_confirmation,
            "managerPageId": manager_page,
            "managerScreenshot": str(manager_screenshot),
            "minijttTestOverride": minijtt_override,
            "networkScope": "loopback-only",
            "payloadSha256": hashlib.sha256(fixture.payload).hexdigest(),
            **statistics,
        }
        if evidence["downloadedSha256"] != evidence["payloadSha256"]:
            raise RuntimeError("browser torrent payload SHA-256 differs")
        write_json(result_dir / "browser-torrent-validation.json", evidence)
        return evidence
    finally:
        for torrent_id in list(active_ids):
            with contextlib.suppress(Exception):
                run_wildbuzzard_torrent_json(
                    runner,
                    result_dir,
                    account,
                    environment,
                    "browser-torrent-cleanup",
                    [
                        "torrent-control",
                        "delete",
                        torrent_id,
                        "--no-delete-data",
                    ],
                    timeout=120,
                )


def validate_browser(runner, result_dir, account, environment):
    screenshots = result_dir / "screenshots"
    screenshots.mkdir(parents=True, exist_ok=True)
    screenshots.chmod(0o700)
    os.chown(screenshots, account.pw_uid, account.pw_gid)
    fixture = result_dir / "fixture.html"
    fixture.write_text(
        "<!doctype html><meta charset=utf-8><title>WildBuzzard Release Validation</title>"
        "<main><h1>WildBuzzard Release Validation</h1><p id=probe>Release probe ready</p>"
        "<button id=action onclick=\"probe.textContent='Native browser control worked'\">Run probe</button></main>",
        encoding="utf-8",
    )
    os.chown(fixture, account.pw_uid, account.pw_gid)
    session = "release-validation"
    version = browser_json(
        runner, result_dir, account, environment, "wildbuzzard-version", ["version"]
    )
    assert_version(version, "wildbuzzard")
    extension_profile = find_extension_profile(account, result_dir, environment)
    with FixtureServer(fixture.read_bytes()) as fixture_url:
        opened = browser_json(
            runner,
            result_dir,
            account,
            environment,
            "wildbuzzard-open-fixture",
            ["--session", session, "open", fixture_url],
        )
        if opened.get("ok") is not True:
            raise RuntimeError("WildBuzzard did not open the validation fixture")
        fixture_page = opened_page(opened, "validation fixture")
        fixture_wait = browser_json(
            runner,
            result_dir,
            account,
            environment,
            "wildbuzzard-wait-fixture",
            [
                "--session",
                session,
                "wait",
                "--page",
                str(fixture_page),
                "--for",
                "text",
                "--value",
                "Release probe ready",
                "--timeout",
                "20000",
            ],
        )
        if fixture_wait.get("details", {}).get("matched") is not True:
            raise RuntimeError(
                "WildBuzzard did not finish loading the validation fixture"
            )
    browser_json(
        runner,
        result_dir,
        account,
        environment,
        "wildbuzzard-tabs",
        ["--session", session, "tabs"],
    )
    snapshot = browser_json(
        runner,
        result_dir,
        account,
        environment,
        "wildbuzzard-snapshot",
        ["--session", session, "snapshot", "--page", str(fixture_page)],
    )
    if "WildBuzzard Release Validation" not in json.dumps(snapshot):
        raise RuntimeError("WildBuzzard snapshot did not expose the fixture")
    action_ref = snapshot_ref(snapshot, "Run probe", ("button",))
    browser_json(
        runner,
        result_dir,
        account,
        environment,
        "wildbuzzard-click-fixture",
        [
            "--session",
            session,
            "click",
            "--page",
            str(fixture_page),
            action_ref,
        ],
    )
    action_wait = browser_json(
        runner,
        result_dir,
        account,
        environment,
        "wildbuzzard-wait-fixture-action",
        [
            "--session",
            session,
            "wait",
            "--page",
            str(fixture_page),
            "--for",
            "text",
            "--value",
            "Native browser control worked",
            "--timeout",
            "20000",
        ],
    )
    if action_wait.get("details", {}).get("matched") is not True:
        raise RuntimeError("WildBuzzard native click did not activate the fixture")
    read = browser_json(
        runner,
        result_dir,
        account,
        environment,
        "wildbuzzard-read",
        ["--session", session, "read", "--page", str(fixture_page), "text"],
    )
    if "Native browser control worked" not in json.dumps(read):
        raise RuntimeError("WildBuzzard read did not observe the controlled page")
    browser_json(
        runner,
        result_dir,
        account,
        environment,
        "wildbuzzard-screenshot-fixture",
        [
            "--session",
            session,
            "screenshot",
            "--page",
            str(fixture_page),
            "--format",
            "png",
            "--output",
            str(screenshots / "fixture-page.png"),
        ],
    )
    verify_png(screenshots / "fixture-page.png", "fixture page")

    support_session = "release-addons"
    support_opened = browser_json(
        runner,
        result_dir,
        account,
        environment,
        "wildbuzzard-open-support",
        ["--session", support_session, "open", "about:support"],
    )
    support_page = opened_page(support_opened, "about:support")
    support_wait = browser_json(
        runner,
        result_dir,
        account,
        environment,
        "wildbuzzard-wait-support",
        [
            "--session",
            support_session,
            "wait",
            "--page",
            str(support_page),
            "--for",
            "text",
            "--value",
            "Buzzard Web Search",
            "--timeout",
            "20000",
        ],
    )
    if support_wait.get("details", {}).get("matched") is not True:
        raise RuntimeError("about:support did not expose the built-in extensions")
    browser_json(
        runner,
        result_dir,
        account,
        environment,
        "wildbuzzard-read-support",
        [
            "--session",
            support_session,
            "read",
            "--page",
            str(support_page),
            "text",
        ],
    )
    for name in ("Buzzard Web Search", "Torrent Search"):
        matches = browser_json(
            runner,
            result_dir,
            account,
            environment,
            f"wildbuzzard-grep-support-{name.lower().replace(' ', '-')}",
            [
                "--session",
                support_session,
                "grep",
                "--page",
                str(support_page),
                name,
            ],
        )
        if name not in json.dumps(matches):
            raise RuntimeError(
                f"about:support does not list built-in extension: {name}"
            )
    browser_json(
        runner,
        result_dir,
        account,
        environment,
        "wildbuzzard-screenshot-support",
        [
            "--session",
            support_session,
            "screenshot",
            "--page",
            str(support_page),
            "--format",
            "png",
            "--output",
            str(screenshots / "about-support.png"),
        ],
    )
    verify_png(screenshots / "about-support.png", "about:support")
    addons_manager = validate_addons_manager(runner, result_dir, account, environment)
    search_settings = validate_search_settings(runner, result_dir, account, environment)
    extension_uis = {
        "webSearch": validate_extension_ui(
            runner,
            result_dir,
            account,
            environment,
            extension_profile,
            slug="web-search",
            page="search/search.html",
            query="Debian Linux release",
            query_name="Search query",
            screenshot_name="web-search-extension.png",
        )
    }
    native_torrent = validate_browser_torrent_ingress(
        runner, result_dir, account, environment, extension_profile
    )
    extension_uis["torrentSearch"] = {
        "directTabRejection": native_torrent["directExtensionTab"],
        "popup": native_torrent["extensionPopup"],
    }
    tor = validate_tor_egress(runner, result_dir, account, environment)
    status = browser_json(
        runner, result_dir, account, environment, "wildbuzzard-status", ["status"]
    )
    if status.get("running") is not True or status.get("runtime") != "gecko":
        raise RuntimeError("WildBuzzard native control status is invalid")
    return {
        "addonsManager": addons_manager,
        "browserPid": status.get("browserPid"),
        "extensionProfile": extension_profile,
        "extensionUIs": extension_uis,
        "guiUser": account.pw_name,
        "fixtureScreenshot": str(screenshots / "fixture-page.png"),
        "nativeTorrent": native_torrent,
        "searchSettings": search_settings,
        "supportScreenshot": str(screenshots / "about-support.png"),
        "tor": tor,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, type=pathlib.Path)
    parser.add_argument("--staging", required=True, type=pathlib.Path)
    parser.add_argument("--results", required=True, type=pathlib.Path)
    parser.add_argument("--artifact-base-url", required=True)
    parser.add_argument("--expected-id", required=True)
    parser.add_argument("--expected-version", required=True)
    parser.add_argument("--search-query", default="Debian Linux")
    parser.add_argument("--allow-installed", action="store_true")
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise RuntimeError("guest validation must run through QGA as root")
    args.results.mkdir(parents=True, exist_ok=True)
    runner = Runner(args.results / "validation.log")
    release = os_release()
    if (
        release.get("ID") != args.expected_id
        or release.get("VERSION_ID") != args.expected_version
    ):
        raise RuntimeError(
            f"unexpected guest OS: {release.get('ID')} {release.get('VERSION_ID')}"
        )
    architecture = runner.run(["dpkg", "--print-architecture"]).stdout.strip()
    if architecture != "amd64":
        raise RuntimeError(f"unexpected guest architecture: {architecture}")
    account, environment = find_gui_session()
    prepare_gui_session(runner, account, environment)
    args.results.chmod(0o700)
    os.chown(args.results, account.pw_uid, account.pw_gid)
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    download_artifacts(manifest, args.staging, args.artifact_base_url)
    artifacts = verify_artifacts(runner, manifest, args.staging)
    write_json(args.results / "artifact-verification.json", artifacts)
    packages = install_packages(runner, artifacts, args.staging, args.allow_installed)
    versions, torrent_download = validate_clis(
        runner, args.results, account, environment, args.search_query
    )
    builtins = inspect_builtin_addons(args.results)
    browser_downloads = args.results / "browser-torrent-download"
    browser_downloads.mkdir(mode=0o700)
    browser_downloads.chmod(0o700)
    os.chown(browser_downloads, account.pw_uid, account.pw_gid)
    environment["BUZZARD_TORRENT_DOWNLOADS"] = str(browser_downloads)
    prepare_gui_session(runner, account, environment)
    browser = validate_browser(runner, args.results, account, environment)
    report = {
        "schemaVersion": 1,
        "ok": True,
        "completedAt": int(time.time()),
        "os": {
            "id": release["ID"],
            "version": release["VERSION_ID"],
            "architecture": architecture,
        },
        "guiUser": account.pw_name,
        "packages": packages,
        "cliVersions": versions,
        "torrentDownload": torrent_download,
        "builtins": builtins,
        "browser": browser,
    }
    write_json(args.results / "report.json", report)
    print(json.dumps(report, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}), file=sys.stderr)
        raise
