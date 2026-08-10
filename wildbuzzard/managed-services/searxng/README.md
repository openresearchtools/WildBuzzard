<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Managed SearXNG service

The native runtime launches the source-built bundled CPython and Granian. The
upstream application listens only on a mode-0600 Unix socket. A small
WildBuzzard gateway exposes token-free HTML navigation on an ephemeral
`127.0.0.1` port. It rejects Authorization and private-nonce headers, JSON
formats, `/config`, `/stats`, `/metrics`, and `/v1` on that public listener, as
well as mismatched Host, cross-origin Origin, and cross-site Fetch Metadata
requests.

Privileged health, identity, configuration, and search requests use a separate
mode-0600 Unix socket. They carry a unique nonce and an HMAC-SHA256 request
signature instead of the capability itself. The service admits only the same
UID with `SO_PEERCRED`, rejects nonce replay, and signs the status, content type,
and complete response body. A replaced socket therefore receives no reusable
secret and cannot forge a response. Metrics and stats remain unavailable. Both
gateways emit no CORS headers and do not log requests.

The browser starts or reconnects to the detached service with:

```text
<runtime>/python/bin/python3 -I <runtime>/libexec/searxng_service.py \
  --runtime-root <immutable-runtime> \
  start \
  --data-root <xdg-data>/wildbuzzard/search/searxng \
  --cache-root <xdg-cache>/wildbuzzard/search/searxng \
  --runtime-dir <xdg-runtime>/wildbuzzard-search \
  --connection-file <xdg-runtime>/wildbuzzard-search/connection.json \
  --owner-instance-id <opaque-owner-id>
```

`browser/components/websearch/SearXNGRuntime.sys.mjs` verifies and atomically
extracts the bundled ZIP into versioned per-profile XDG state before invoking
that lifecycle interface. It verifies the exact corresponding-source digest
before any service start. A corrupt retained archive, source archive, or
immutable extraction is moved to a recoverable quarantine name and rebuilt
only from the verified packaged bytes. Extraction-lock creation, stale-lock
claim, and release use atomic directory renames and process-start identities so
one browser cannot remove a peer's lock. The AppImage packager also streams and
verifies the complete manifest inventory and every payload digest before
producing an image.

The owner ID is a domain-separated digest of the canonical browser profile
path. Normal navigation receives only the live loopback HTML URL. The browser
controller and bundled Pi web-access extension receive the private
connection-record path and use its Unix socket with authenticated requests;
neither sends the record capability to the loopback port or on the wire.

Every browser package carries the exact complete corresponding source at
`notices/source/wildbuzzard-searxng-2026.8.6+b023a28ba-source.tar.xz` and the
cross-referencing CycloneDX inventory at
`notices/source/searxng-release.cdx.json`. In an installed AppImage the paths
are below `/usr/lib/wildbuzzard`; in the Debian package they are below
`/opt/wildbuzzard`. Privileged browser code can obtain the installation path
from `SearXNGRuntime.correspondingSourcePath`.

The same launcher supports `status`, `stop`, `restart`, and the foreground
`serve` operation. `start` returns only after an authenticated health check.
The service is placed in a detached session with closed standard streams and
file descriptors, so browser shutdown does not terminate it. Stop and restart
validate the private connection record, process start time, executable digest,
owner identity, and authenticated `/v1/identity` response before signaling the
recorded PID. On supported Linux kernels the controller opens a pidfd after
validation, revalidates `/proc` identity, and signals only that pinned process.
If pidfds are unavailable, stop and restart fail closed without issuing a
PID-only signal.

The browser keeps mode-0600 active and staged activation records beside the
retained runtime and source archives. An upgrade validates the active runtime,
its archive, corresponding source, data-root identity, process, and private
health response before stopping it. It stages the candidate, starts it against
the same persistent data root, and commits activation only after health and
engine synchronization succeed. Failure stops only an authenticated candidate
and restarts the verified retained runtime. Interrupted handoffs are resolved
conservatively on the next launch. The public runtime API exposes read-only
authenticated `status()`, `retry()`, and data-preserving `repair()`; repair
refuses to act while a live connection record cannot be verified.

The runtime directory and data directory are mode 0700. The connection record,
launch lock, generated settings, installation secret, and capability are mode
0600. The backend and privileged gateway sockets are mode 0600 inside
independently allocated mode-0700 directories under `/tmp`. Their short ASCII
names are bound to their purpose, user, data-root, and owner identities, so long
or non-ASCII profile paths cannot exceed the Unix socket path limit. The
service verifies each directory and socket's device, inode, ownership, and mode
before use and cleanup; it never follows a replacement or recursively removes
the directory. A nonblocking file lock prevents two owners from starting the
component. Reconnects authenticate `/v1/identity` and compare every recorded
process, executable, socket, data-root, owner, protocol, and runtime field
before reuse or termination.

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
  "privateSocket": "/tmp/wb-sx-g-1000-0123456789abcdef01234567-0123456789abcdef0123456789abcdef/s",
  "privateSocketDevice": 42,
  "privateSocketInode": 123456,
  "processStartTime": "12345678",
  "protocolVersion": 1,
  "runtimeVersion": "2026.8.6+b023a28ba",
  "token": "opaque-base64url-capability-at-least-32-bytes",
  "version": 1
}
```

Normal browser searches use the public gateway HTML surface. Privileged tools
use form-encoded `POST /search` with `format=json` over the authenticated Unix
socket. The gateway never forwards its authentication headers to SearXNG or an
upstream engine.
