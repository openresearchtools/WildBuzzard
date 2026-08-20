<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Packaged SearXNG service

The `buzzard-search` package launches the source-built CPython and Granian. The
upstream application listens only on a mode-0600 Unix socket. A small
Buzzard gateway selects an ephemeral `127.0.0.1` port and enforces the
local trust boundary.

JSON searches, `/config`, `/stats`, `/metrics`, `/v1/health`, and
`/v1/identity` require `Authorization: Bearer <token>`. HTML navigation is
allowed without placing the capability in a URL, but rejects a mismatched Host,
cross-origin Origin, or cross-site Fetch Metadata request. The gateway emits no
CORS headers and does not log requests.

The package starts or reconnects to the detached service internally with:

```text
<runtime>/python/bin/python3 -I <runtime>/libexec/searxng_service.py \
  --runtime-root <immutable-runtime> \
  start \
  --data-root <xdg-data>/buzzard/search/searxng \
  --cache-root <xdg-cache>/buzzard/search/searxng \
  --runtime-dir <xdg-runtime>/buzzard/search \
  --connection-file <xdg-runtime>/buzzard/search/connection.json \
  --owner-instance-id <opaque-owner-id>
```

`/usr/bin/buzzard-search` owns that lifecycle interface and the package-private
AppImage. Wild Buzzard, Buzzard Agent and other applications use its JSON CLI
or stdio MCP server; they do not inspect `/usr/lib/buzzard-search`. Normal
navigation receives only the live loopback search URL. Callers never receive
the service capability or connection record.

The Ubuntu builder emits the exact corresponding-source archive and CycloneDX
inventory beside `buzzard-search.deb`. Publish all three artifacts together.

The same launcher supports `status`, `stop`, `restart`, and the foreground
`serve` operation. `start` returns only after an authenticated health check.
The service is placed in a detached session with closed standard streams and
file descriptors, so browser shutdown does not terminate it. Stop and restart
validate the private connection record, process start time, executable digest,
owner identity, and authenticated `/v1/identity` response before signaling the
recorded PID. On supported Linux kernels the controller opens a pidfd after
validation, revalidates `/proc` identity, and signals only that pinned process.
The fallback path revalidates the complete process identity immediately before
each PID signal.

The runtime directory and data directory are mode 0700. The connection record,
launch lock, generated settings, installation secret, and capability are mode
0600. The backend socket is mode 0600 inside an atomically allocated mode-0700
directory under `/tmp`. Its short ASCII name is bound to the user, data-root,
and owner identities, so long or non-ASCII profile paths cannot exceed the Unix
socket path limit. The service verifies the directory's device, inode,
ownership, and mode before use and cleanup; it never follows a replacement or
recursively removes the directory. A nonblocking file lock prevents two owners
from starting the component. Reconnects must authenticate `/v1/identity` and
compare every recorded process, executable, data-root, owner, protocol, and
runtime field before reuse or termination.

Accepted sockets have a five-second read timeout. If all 16 request workers are
occupied, the accept thread waits at most 250 milliseconds for a slot and then
closes the new connection. Partial headers or bodies therefore cannot pin the
gateway indefinitely.

The launcher and backend receive a minimal deterministic environment with
`TZ=UTC`, `PYTHONHASHSEED=0`, and the `C.UTF-8` locale. Optional SearXNG plugins
are excluded from the generated settings: searches use only the reviewed
engine policy, and startup never downloads mutable plugin data. If a client
disconnects after submitting a request, the gateway closes the Unix backend
connection, releases the request worker, and does not attempt a second response
on the closed client socket.

The canonical record is single-line UTF-8 JSON with keys sorted lexically, no
insignificant whitespace, and one trailing newline. It contains exactly the
fields below. `createdAt` and `lastHealthAt` are JSON integers containing Unix
epoch milliseconds; booleans, fractional values, and non-finite values are
invalid. Both values are positive and no greater than
`8,640,000,000,000,000`, and `lastHealthAt` is greater than or equal to
`createdAt`.

Expanded for readability, the schema is:

```json
{
  "address": "127.0.0.1",
  "createdAt": 1786320000000,
  "dataRootId": "opaque",
  "executablePath": "/immutable/runtime/python/bin/python3.14",
  "executableSha256": "0000000000000000000000000000000000000000000000000000000000000000",
  "lastHealthAt": 1786320001000,
  "ownerInstanceId": "opaque",
  "pid": 1234,
  "port": 49152,
  "processStartTime": "12345678",
  "protocolVersion": 1,
  "runtimeVersion": "2026.8.6+b023a28ba",
  "token": "opaque-base64url-capability-at-least-32-bytes",
  "version": 1
}
```

Normal browser searches use the gateway HTML surface. Privileged tools use
form-encoded `POST /search` with the bearer header and `format=json`. The
gateway never forwards its Authorization header to SearXNG or an upstream
engine.
