# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import base64
import http.client
import json
import os
import pathlib
import socket
import sys
import time


class UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, path: str, timeout: float):
        super().__init__("localhost", timeout=timeout)
        self.path = path

    def connect(self) -> None:
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.path)


def process_identity(pid: int) -> dict[str, object]:
    stat_text = pathlib.Path(f"/proc/{pid}/stat").read_text(encoding="ascii")
    fields = stat_text[stat_text.rfind(")") + 2 :].split()
    return {
        "executablePath": os.path.realpath(f"/proc/{pid}/exe"),
        "fdCount": len(list(pathlib.Path(f"/proc/{pid}/fd").iterdir())),
        "parentPid": int(fields[1]),
        "processStartTime": fields[19],
        "threadCount": len(list(pathlib.Path(f"/proc/{pid}/task").iterdir())),
    }


def process_snapshot(root_pid: int | None = None) -> dict[str, object]:
    current = os.getpid()
    processes = []
    for path in sorted(
        pathlib.Path("/proc").iterdir(),
        key=lambda item: int(item.name) if item.name.isdecimal() else -1,
    ):
        if not path.name.isdecimal() or int(path.name) == current:
            continue
        pid = int(path.name)
        try:
            identity = process_identity(pid)
            command = (path / "comm").read_text(encoding="utf-8").strip()
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            continue
        processes.append({"command": command, "pid": pid, **identity})
    if root_pid is not None:
        selected = {root_pid}
        while True:
            descendants = {
                int(process["pid"])
                for process in processes
                if int(process["parentPid"]) in selected
            }
            updated = selected | descendants
            if updated == selected:
                break
            selected = updated
        processes = [
            process for process in processes if int(process["pid"]) in selected
        ]
    return {
        "fdCount": sum(int(item["fdCount"]) for item in processes),
        "processes": processes,
        "threadCount": sum(int(item["threadCount"]) for item in processes),
    }


def request(value: dict[str, object]) -> dict[str, object]:
    body = base64.b64decode(str(value.get("body", "")), validate=True)
    headers = value.get("headers")
    if not isinstance(headers, dict) or not all(
        isinstance(name, str) and isinstance(item, str)
        for name, item in headers.items()
    ):
        raise ValueError("invalid request headers")
    unix_socket = value.get("unixSocket")
    connection = (
        UnixHTTPConnection(str(unix_socket), timeout=10)
        if unix_socket is not None
        else http.client.HTTPConnection("127.0.0.1", int(value["port"]), timeout=10)
    )
    started = time.monotonic()
    try:
        connection.request(
            str(value["method"]),
            str(value["path"]),
            body=body or None,
            headers=headers,
        )
        response = connection.getresponse()
        payload = response.read()
        return {
            "body": base64.b64encode(payload).decode("ascii"),
            "durationMilliseconds": round((time.monotonic() - started) * 1000),
            "headers": list(response.getheaders()),
            "reason": response.reason,
            "status": response.status,
        }
    finally:
        connection.close()


def cancel(value: dict[str, object]) -> dict[str, object]:
    payload = base64.b64decode(str(value["request"]), validate=True)
    started = time.monotonic()
    unix_socket = value.get("unixSocket")
    if unix_socket is None:
        client = socket.create_connection(("127.0.0.1", int(value["port"])), timeout=5)
    else:
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.settimeout(5)
        client.connect(str(unix_socket))
    try:
        client.sendall(payload)
    finally:
        client.close()
    return {
        "cancelledAfter": "request-body-sent",
        "elapsedMilliseconds": round((time.monotonic() - started) * 1000),
    }


def main() -> int:
    value = json.loads(sys.stdin.buffer.read(256 * 1024))
    if not isinstance(value, dict):
        raise ValueError("probe input must be an object")
    mode = value.get("mode")
    if mode == "request":
        result = request(value)
    elif mode == "cancel":
        result = cancel(value)
    elif mode == "process":
        result = process_identity(int(value["pid"]))
    elif mode == "snapshot":
        root_pid = value.get("rootPid")
        result = process_snapshot(int(root_pid) if root_pid is not None else None)
    else:
        raise ValueError("unknown probe mode")
    sys.stdout.write(json.dumps(result, sort_keys=True, separators=(",", ":")) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
