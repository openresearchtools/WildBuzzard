<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Wild Buzzard component package architecture

## Status

This document supersedes the monolithic runtime-embedding assumptions in
`WEB-SEARCH-TORRENT-PORT-SPEC.md`. The security, parity, provenance and
reproducibility requirements in that specification still apply, but the
shipping capabilities are independent Debian packages instead of private
payloads embedded in the browser or agent harness.

## Package ownership

Each package owns its executable code, dependencies, service lifecycle,
connection records, CLI and MCP server. Wild Buzzard and Buzzard Agent are
consumers. They must not unpack, hash, supervise or privately reimplement a
dependency's runtime.

| Binary package | Owns | Public commands | Dependencies |
| --- | --- | --- | --- |
| `wildbuzzard` | Firefox ESR product, browser UI and native browser control | `wildbuzzard` | `buzzard-search`, `buzzard-torrent-search`, `buzzard-torrent`; recommends `buzzard-agent-web` |
| `buzzard-search` | Pinned SearXNG runtime and private per-user service | `buzzard-search`, `buzzard-search-mcp` | Runtime dependencies declared by this package only |
| `buzzard-torrent-search` | Pinned Jackett Mini discovery runtime | `buzzard-torrent-search`, `buzzard-torrent-search-mcp` | Runtime dependencies declared by this package only |
| `buzzard-torrent` | Pinned qBittorrent/libtorrent application runtime and WebUI | `buzzard-torrent`, `buzzard-torrent-mcp` | Runtime dependencies declared by this package only |
| `buzzard-agent` | Debranded pinned Pi-compatible coding-agent harness | `buzzard-agent` | `buzzard-search`, `buzzard-torrent-search`, `buzzard-torrent`, `buzzard-quick-search`; recommends `wildbuzzard` |
| `buzzard-agent-web` | Debranded Pi Web UI, server and session daemon | `buzzard-agent-web` | `buzzard-agent`; recommends `wildbuzzard` |
| `buzzard-quick-search` | Pinned Unsloth-compatible quick web-search implementation | `buzzard-quick-search`, `buzzard-quick-search-mcp` | Runtime dependencies declared by this package only |

Package dependencies are ordinary Debian dependencies. No package may reach
into another package's private library directory. Cross-package calls use a
versioned CLI, MCP or local service protocol.

## Capability interfaces

Every reusable non-browser service capability provides:

1. a human- and script-usable CLI with JSON input/output modes;
2. a local stdio MCP server exposing the same operations and schemas;
3. a version command reporting protocol, package and upstream identities; and
4. deterministic error objects and exit codes.

For those services, MCP is an agent-facing discovery and invocation surface.
CLI commands remain
available for shell automation, debugging, package health checks and clients
that do not implement MCP. Both surfaces call one implementation; neither is
an adapter around the other package's private files.

Wild Buzzard is the exception: its BrowserOS-parity and native Gecko controls
are direct subcommands of `/usr/bin/wildbuzzard`. The browser owns the private
local connection and lifecycle; no browser MCP server or agent adapter is
installed. Any human or agent with shell access uses the same CLI.

## Runtime and authentication

Services use per-user state beneath XDG directories:

```text
$XDG_RUNTIME_DIR/buzzard/<component>/connection.json
$XDG_DATA_HOME/buzzard/<component>/
$XDG_CACHE_HOME/buzzard/<component>/
```

Runtime directories are mode 0700 and connection records are mode 0600.
Service sockets are Unix-domain sockets unless an upstream process requires an
owned loopback endpoint. A package owns and validates its process identity,
start time, executable path and protocol version before reuse or termination.

MCP and CLI processes read the connection record and attach the local
capability internally. Models do not receive or repeat bearer keys. Browser
content never receives a socket path, token or raw upstream service endpoint.

## Activation

Extension activation means connecting or disconnecting a package integration.
It does not determine whether an agent is allowed to discover a tool.

- Agent capabilities are always listed by their MCP server.
- Skills provide workflow guidance only and never gate tool availability.
- Dangerous calls use host approval or explicit tool semantics at execution
  time.
- Wild Buzzard extensions may check package/service availability and expose
  product UI, but do not own dependency installation or runtime extraction.
- Prompt keyword regular expressions must not add or remove capabilities.

## Third-party source and branding

Pristine upstream snapshots live below `wildbuzzard/third_party` in their own
component directories with an exact commit, source digest, upstream URL,
license and unmodified notices. First-party packaging and integration code
lives below `wildbuzzard/components`.

User-facing binaries, package descriptions and service identities use Buzzard
names. Upstream attribution, copyright statements, license texts and source
provenance retain their original names. Debrand patches must never rewrite
legal notices or imply that Wild Buzzard authored upstream work.

## Debian composition

All packages support Ubuntu 24.04, Ubuntu 26.04 and Debian 13 or newer. Builds
run on pinned Ubuntu runners and tests run across the complete distribution
matrix. Packages install only immutable program files under `/usr`; mutable
state remains per-user under XDG paths.

The canonical browser package and executable are both `wildbuzzard`. It
declares `Replaces`, `Breaks` and `Provides` for the former `wild-buzzard`
package name and does not embed independently packaged runtime archives.

Every package can be built, installed, upgraded, removed and tested without a
Wild Buzzard checkout or Buzzard Agent process. The combined product test
installs the packages through APT/dpkg and verifies their published CLI and,
where applicable, MCP contracts.
