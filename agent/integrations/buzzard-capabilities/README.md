# Buzzard capability adapter

This is the thin Buzzard Agent client for the independently installed Buzzard
MCP packages. It contains no search, fetching, torrent-search, or
torrent implementation.

The adapter loads the SearXNG, quick-search, torrent-search, and torrent MCP
catalogs and registers them with Buzzard Agent. Wild Buzzard browser control is
used directly through the `wildbuzzard` CLI and is not loaded through this
adapter. SearXNG is
the primary `web_search`; the independent Unsloth-compatible implementation is
exposed as `quick_web_search`.

Set `BUZZARD_AGENT_CAPABILITIES` to a comma-separated subset of `searx`,
`quick-search`, `torrent-search`, and `torrent`. Passing
`--no-extensions` to Buzzard Agent disables the adapter entirely.
