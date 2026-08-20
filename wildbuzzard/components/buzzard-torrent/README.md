# Buzzard Torrent

This package owns the pinned qBittorrent 5.2.3/libtorrent 2.0.14 runtime,
private per-user UDS service, profile and capability. It exposes a JSON CLI
and stdio MCP. Wild Buzzard supplies the integrated `about:torrents` UI, but
the torrent service is independently usable by other local applications.

```bash
buzzard-torrent start
buzzard-torrent call torrent_list '{}'
buzzard-torrent-mcp
```
