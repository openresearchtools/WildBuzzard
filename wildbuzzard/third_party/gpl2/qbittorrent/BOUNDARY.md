<!-- SPDX-License-Identifier: GPL-2.0-or-later -->

# Integration boundary

The complete upstream source is immutable under `upstream/`. Reproducible downstream changes live in `patches/` and are applied only in an external host-native build directory.

The Firefox parent process communicates with the headless qBittorrent process through an authenticated private Unix-domain socket. qBittorrent never opens a WebUI TCP listener in WildBuzzard mode. Firefox does not load or link qBittorrent or libtorrent code into its process.

Jackett Mini is the only built-in search provider. Search-provider installation, removal, update, and Python execution are disabled in WildBuzzard mode. Search results remain qBittorrent results and the main torrent UI does not expose per-tracker failure rows.

