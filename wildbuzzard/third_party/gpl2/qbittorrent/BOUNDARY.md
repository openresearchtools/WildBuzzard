<!-- SPDX-License-Identifier: GPL-2.0-or-later -->

# Integration boundary

The complete upstream source is immutable under `upstream/`. Reproducible downstream changes live in `patches/` and are applied only in an external host-native build directory.

The Firefox parent process communicates with the headless qBittorrent process through an authenticated private Unix-domain socket. qBittorrent never opens a WebUI TCP listener in WildBuzzard mode. Firefox does not load or link qBittorrent or libtorrent code into its process.

The WildBuzzard qBittorrent binary does not compile or embed qBittorrent's search manager, Python search launcher and resources, search API controller, search WebUI, or downloader hooks in ordinary torrent endpoints. Its pre-add `fetchMetadata` URL/magnet downloader, associated caches and callbacks, and unreachable `saveMetadata` path are also compiled out.

`POST /api/v2/torrents/add` accepts URL-string input only when it is an exact `magnet:?xt=urn:btih:` link containing a 40-character hexadecimal or 32-character Base32 info hash. The complete UTF-8 input is capped at 8192 bytes and at 16 optional parameters. Optional parameters are limited to display name (`dn`), tracker (`tr`), exact length (`xl`), and file selection (`so`); a second `xt`, exact-source (`xs`/`as`), webseed (`ws`), manifest (`mt`), keyword (`kt`), peer (`x.pe`), and unknown keys are rejected. Accepted `tr` entries can contact their encoded trackers as an inherent consequence of the explicitly confirmed magnet action. HTTP, HTTPS, file, bare-hash, whitespace-padded, oversized, malformed, and other source strings are rejected before torrent parsing; the endpoint never passes URL input to qBittorrent's native downloader. Uploaded `.torrent` multipart bodies remain capped by the 64 MiB HTTP parser limit and are parsed locally. The WebUI carries a parsed upload through a separate cache identifier rather than placing its hash in the URL field. Torrent-derived, file-derived, and pasted dialog titles are escaped before Mocha's HTML title sink, and later title updates use `textContent`.

The browser bridge rejects search routes as a second boundary, and the privileged WebUI cannot issue ordinary network requests. Search engines, result resolution, and provider processes live only in the optional `buzzard-minijtt` package; the browser retains qBittorrent solely for explicit magnet/torrent-file addition and transfer management.
