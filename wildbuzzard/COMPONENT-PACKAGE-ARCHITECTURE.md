<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Wild Buzzard component boundaries

Wild Buzzard is a browser, not an agent distribution. The browser remains a
normal Firefox ESR fork with the reviewed Waterfox-derived UI and privacy
ports, native content blocking, Tor/Arti tabs, Widevine support, native
qBittorrent downloads, and a general browser-control CLI.

Pi, Pi Web, their Node runtime, web-search implementations, and torrent
discovery implementations are not browser source or browser payloads.
`FEATURE-OWNERSHIP.toml` is the machine-readable boundary.

## Repositories and packages

| Repository | Package or artifact | Responsibility |
| --- | --- | --- |
| `wildbuzzard` | `wildbuzzard` | Browser core, native downloads, Tor, blocker, and `/usr/bin/wildbuzzard` browser control |
| `buzzard-agent` | `buzzard-agent` | Pi-compatible agent, Pi Web UI, Node dependencies, and agent skills |
| `buzzard-search` | `buzzard-search` | Universal bounded JSON search CLI at `/usr/bin/buzzard-search` |
| `buzzard-minijtt` | `buzzard-minijtt` | Universal bounded JSON torrent-discovery CLI at `/usr/bin/buzzard-minijtt` |
| `wildbuzzard-extensions` | two built-in copies and release-pinned XPIs | Canonical offline web and torrent discovery UIs using the constrained browser APIs |
| `wildbuzzard` native-torrent package source | `buzzard-torrent` | qBittorrent/libtorrent runtime used by native browser downloads |

The browser Debian package depends on `buzzard-torrent`. It suggests the
optional `buzzard-search` and `buzzard-minijtt` apt packages; either extension
shows its exact `sudo apt install` command when its CLI is absent. The extension
monorepo remains canonical, while its two subprojects stay independently
packageable and exact allowlisted runtime copies are built into the browser.
The agent can be installed, removed, upgraded, or replaced without changing
the browser.

## Browser extension boundary

The two search UIs are ordinary WebExtensions without experiment APIs. Their
allowlisted offline runtime is staged byte-for-byte from separate monorepo subdirectories
and registered as app-provided built-in add-ons. Independently distributed XPI
builds remain supported. Browser core exposes two parent-process-only
namespaces to the exact built-in IDs or normally signed or exact release-pinned,
non-temporary XPI IDs:

- `browser.buzzardSearch` for `web-search@extensions.wildbuzzard`;
- `browser.torrentSearch` for `torrent-search@extensions.wildbuzzard`.

Both release manifests declare `incognito: not_allowed`, and browser core
requires that invariant before exposing either namespace. A spanning
background page therefore cannot use a non-private context to reach discovery
on behalf of a private window.

The browser invokes fixed absolute CLI paths without a shell, supplies a
minimal environment, bounds runtime and output, validates every field, and
returns normalized data. Packaged extension HTML, CSS, and JavaScript render
text and links only. Search-engine or result-site JavaScript is never loaded
inside an extension page. Opened results are ordinary untrusted sites and keep
Firefox process isolation, content blocking, permissions, and origin policy.

Torrent result identifiers remain in the parent process behind expiring opaque
tokens. Magnets and `.torrent` bytes are never returned to extension code.
Import consumes a one-use token and requires explicit user confirmation before
calling the native torrent manager. Torrent discovery is disabled in private
windows.

## Browser-control boundary

`/usr/bin/wildbuzzard` is the stable control surface for humans and any agent.
It owns tabs, navigation, snapshots, actions, downloads, screenshots, Tor-tab
controls, and other browser-generic operations. It contains no Pi adapter and
does not expose web or torrent discovery. Agents use the search CLIs directly;
their repository skills explain the small JSON contracts.

The browser owns its permission-restricted, per-profile local transport.
Ordinary web content cannot access it. Agent-specific policy, prompts, sessions, model
providers, and web UI remain in `buzzard-agent`.

## Packaging rules

Browser packages must fail if they contain Agent, Pi Web, search-provider, or
torrent-discovery runtimes. They contain only the reviewed offline extension
files and their source hashes. Arti is the only browser-bundled service
runtime; qBittorrent and both discovery CLIs are independently apt-installed.
Standalone release XPIs must be normally signed or match the complete SHA-256
digest pinned by that browser release. Temporary, modified, unpinned unsigned,
missing-signature, and preliminary-signature installs never receive either
restricted namespace, even if they claim an exact release ID.

Every standalone package owns its dependencies, lifecycle, XDG state,
provenance, license bundle, and versioned CLI. Cross-repository calls use only
documented CLI or WebExtension contracts; no consumer reads another package's
private library directory.
