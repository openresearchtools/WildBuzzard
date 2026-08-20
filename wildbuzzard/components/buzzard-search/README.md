# Buzzard Search

`buzzard-search` is the independently installable SearXNG-based search
module. It owns its runtime, per-user lifecycle, XDG state, Unix socket, JSON
and plain-text CLI, complete Markdown artifacts, and compatibility stdio MCP
server. Wild Buzzard and Buzzard Agent are clients.

The Debian build receives the pinned SearXNG AppImage produced by the existing
reproducible Ubuntu builder and installs it at
`/usr/lib/buzzard-search/buzzard-searxng.AppImage`.
The builder's complete corresponding-source archive and standalone CycloneDX
SBOM are release assets and must be published beside the Debian package.

```bash
buzzard-search start
buzzard-search search --json "example"
buzzard-search search --json --url https://example.com/page
buzzard-search-mcp
```

Search mode returns only bounded result snippets. URL mode returns readable
Markdown inline at the Unsloth-compatible 16,000-character boundary and an
absolute `fullMarkdownPath` to the complete fetched Markdown. Plain-text URL
output ends with `BUZZARD_FULL_MARKDOWN_PATH=<absolute-path>`.

Artifacts are written beneath the private per-user runtime directory. The
directory is mode `0700`, each Markdown file is mode `0600`, and filenames use
a bounded readable page title plus a collision-resistant suffix. The packaged
`buzzard-web-search` skill under `/usr/share/buzzard-search/skills/` describes
the query, select, and read workflow while leaving option discovery to
`buzzard-search search --help`.
