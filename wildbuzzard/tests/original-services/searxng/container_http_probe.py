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


def process_identity(pid: int) -> dict[str, object]:
    stat_text = pathlib.Path(f"/proc/{pid}/stat").read_text(encoding="ascii")
    fields = stat_text[stat_text.rfind(")") + 2 :].split()
    return {
        "executablePath": os.path.realpath(f"/proc/{pid}/exe"),
        "fdCount": len(list(pathlib.Path(f"/proc/{pid}/fd").iterdir())),
        "processStartTime": fields[19],
        "threadCount": len(list(pathlib.Path(f"/proc/{pid}/task").iterdir())),
    }


def process_snapshot() -> dict[str, object]:
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
    return {
        "fdCount": sum(int(item["fdCount"]) for item in processes),
        "processes": processes,
        "threadCount": sum(int(item["threadCount"]) for item in processes),
    }


def has_ipv4_default_route() -> bool:
    lines = pathlib.Path("/proc/net/route").read_text(encoding="ascii").splitlines()
    return any(
        len(fields := line.split()) > 1 and fields[1] == "00000000"
        for line in lines[1:]
    )


def has_ipv6_default_route() -> bool:
    lines = (
        pathlib.Path("/proc/net/ipv6_route").read_text(encoding="ascii").splitlines()
    )
    return any(
        len(fields := line.split()) > 1
        and fields[0] == "0" * 32
        and fields[1] == "00"
        and fields[-1] != "lo"
        for line in lines
    )


def network_identity() -> dict[str, object]:
    external_connected = False
    external_error = None
    client = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    client.settimeout(0.5)
    try:
        client.connect(("192.0.2.1", 9))
        external_connected = True
    except OSError as error:
        external_error = {
            "errno": error.errno,
            "type": type(error).__name__,
        }
    finally:
        client.close()
    return {
        "externalConnectBlocked": not external_connected,
        "externalConnectError": external_error,
        "interfaces": sorted(name for _, name in socket.if_nameindex()),
        "ipv4DefaultRoute": has_ipv4_default_route(),
        "ipv6DefaultRoute": has_ipv6_default_route(),
    }


def request(value: dict[str, object]) -> dict[str, object]:
    body = base64.b64decode(str(value.get("body", "")), validate=True)
    headers = value.get("headers")
    if not isinstance(headers, dict) or not all(
        isinstance(name, str) and isinstance(item, str)
        for name, item in headers.items()
    ):
        raise ValueError("invalid request headers")
    connection = http.client.HTTPConnection("127.0.0.1", int(value["port"]), timeout=10)
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
    client = socket.create_connection(("127.0.0.1", int(value["port"])), timeout=5)
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
    elif mode == "network":
        result = network_identity()
    elif mode == "process":
        result = process_identity(int(value["pid"]))
    elif mode == "snapshot":
        result = process_snapshot()
    else:
        raise ValueError("unknown probe mode")
    sys.stdout.write(json.dumps(result, sort_keys=True, separators=(",", ":")) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
