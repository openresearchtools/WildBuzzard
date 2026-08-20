# Buzzard Torrent Search

This independent package owns the pinned Jackett Mini public-source runtime,
its private per-user lifecycle, JSON CLI and stdio MCP surface. Search results
use opaque handles; callers resolve a selected handle without receiving the
upstream tracker URL.

```bash
buzzard-torrent-search start
buzzard-torrent-search search '{"query":"debian","limit":50}'
buzzard-torrent-search-mcp
```
