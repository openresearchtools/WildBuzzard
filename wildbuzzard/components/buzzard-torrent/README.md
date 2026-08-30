# Buzzard Torrent

This package owns the pinned qBittorrent 5.2.3/libtorrent 2.0.14 runtime,
private per-user UDS service, profile and capability. It exposes a JSON CLI
and stdio MCP. Wild Buzzard supplies the integrated `about:torrents` UI, but
the torrent service is independently usable by other local applications.
Every copied runtime library is mapped to its exact binary and source package,
copyright file and source archive. Patched qBittorrent/libtorrent, pinned Boost
and Qt, and exact Ubuntu source archives are published beside the package and
bound by SHA-256 in its source offer. Source and build inputs are never installed
with the runtime package.

```bash
buzzard-torrent start
buzzard-torrent call torrent_list '{}'
buzzard-torrent-mcp
```
