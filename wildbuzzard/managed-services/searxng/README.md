<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Managed SearXNG service

The native runtime launches the source-built bundled CPython and Granian. The
upstream application listens only on a mode-0600 Unix socket. A small
WildBuzzard gateway selects an ephemeral `127.0.0.1` port and enforces the
local trust boundary.

JSON searches, `/config`, `/stats`, `/metrics`, `/v1/health`, and
`/v1/identity` require `Authorization: Bearer <token>`. HTML navigation is
allowed without placing the capability in a URL, but rejects a mismatched Host,
cross-origin Origin, or cross-site Fetch Metadata request. The gateway emits no
CORS headers and does not log requests.

The supervisor starts:

```text
<runtime>/python/bin/python3 -I <runtime>/libexec/searxng_service.py \
  --runtime-root <immutable-runtime> \
  --data-root <xdg-data>/wildbuzzard/search/searxng \
  --cache-root <xdg-cache>/wildbuzzard/search/searxng \
  --runtime-dir <xdg-runtime>/wildbuzzard-search \
  --connection-file <xdg-runtime>/wildbuzzard-search/connection.json \
  --owner-instance-id <opaque-owner-id>
```

The runtime directory and data directory are mode 0700. The connection record,
launch lock, generated settings, installation secret, and capability are mode
0600. A nonblocking file lock prevents two owners from starting the component.
Reconnects must authenticate `/v1/identity` and compare every recorded process,
executable, data-root, owner, protocol, and runtime field before reuse or
termination.

The record schema is:

```json
{
  "version": 1,
  "protocolVersion": 1,
  "runtimeVersion": "2026.8.6+b023a28ba",
  "address": "127.0.0.1",
  "port": 49152,
  "token": "opaque",
  "pid": 1234,
  "processStartTime": "12345678",
  "executablePath": "/immutable/runtime/python/bin/python3.14",
  "executableSha256": "...",
  "dataRootId": "opaque",
  "ownerInstanceId": "opaque",
  "createdAt": "2026-08-10T00:00:00Z",
  "lastHealthAt": "2026-08-10T00:00:01Z"
}
```

Normal browser searches use the gateway HTML surface. Privileged tools use
form-encoded `POST /search` with the bearer header and `format=json`. The
gateway never forwards its Authorization header to SearXNG or an upstream
engine.
