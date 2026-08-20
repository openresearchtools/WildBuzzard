<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Buzzard Quick Search

`buzzard-quick-search` is an independent CLI and stdio MCP server. It is not a
Wild Buzzard browser extension and has no Pi-agent dependency. Any application
that can execute a program or connect to an MCP stdio server can use it.

The model-visible behavior is ported from Unsloth Studio's `web_search` tool at
commit `bfcaea46574d63ec470ce9c7d7221471a38ea7e4`:

- `search` calls `ddgs==9.14.4`, returns five results by default, collapses
  whitespace in titles/snippets, separates results with Markdown rules, and
  appends Unsloth's exact instruction to fetch a selected URL;
- `fetch` applies Unsloth's public-address/redirect checks, reads at most 512
  KiB of HTML or 10 MiB of PDF, converts HTML to Markdown, and caps readable
  inline page output at 16,000 characters;
- GitHub repository, tree, and blob URLs use a bounded shallow Git-object
  inspection in a private temporary checkout and save the resulting complete
  repository Markdown through the same artifact contract;
- optional allow/block domain policy uses the same upstream normalization and
  post-search filtering behavior.

Search:

```sh
buzzard-quick-search search "recent compiler research"
buzzard-quick-search fetch https://example.com/article
buzzard-quick-search fetch --json https://example.com/article
```

Fetch output preserves Unsloth's model-visible text as its prefix and adds a
`BUZZARD_FULL_MARKDOWN_PATH=<absolute-path>` marker. JSON adds the backward-
compatible `fullMarkdownPath`, `contentLength`, and `truncated` fields while
retaining `content` and `provenance`. The full fetched Markdown is stored in a
private per-user runtime directory with mode `0600`; its containing directory
is mode `0700`.

MCP configuration:

```json
{
  "mcpServers": {
    "buzzard-quick-search": {
      "command": "buzzard-quick-search-mcp"
    }
  }
}
```

The MCP surface intentionally has one Unsloth-compatible `web_search` tool. It
supports current stateless MCP `2026-07-28` discovery as well as the four
initialize-based protocol revisions through `2025-11-25`.
Call it with `query` for discovery, then with `url` to read one result. The
human CLI additionally exposes result-count and website-policy controls.

## Build and package

Use an Ubuntu 24.04 x86-64 builder so the bundled executable has the oldest
supported glibc baseline:

```sh
sudo apt-get install binutils dpkg-dev libpython3.12 python3
./scripts/build-deb.sh
```

The script uses the host's `python3` without downloading a different interpreter,
uses the checked-in `uv.lock`, builds a PyInstaller directory with
its Python interpreter and Python dependencies, and emits
`dist/buzzard-quick-search_0.1.0_amd64.deb`. The installed package therefore
does not rely on a distro-specific `python3-ddgs` package. Packaging fails if
any bundled ELF requires newer than Ubuntu 24.04's glibc 2.39.

Run deterministic tests without network access:

```sh
PYTHONPATH=src python3 -m unittest discover -s tests -v
```

The combined port is distributed under AGPL-3.0-only because the copied Unsloth
Studio implementation is AGPL-3.0-only. Exact provenance and source hashes are under
`../../third_party/agpl/unsloth-quick-search/`.
