---
name: buzzard-web-search
description: Search the web for bounded SearXNG snippets and fetch a selected web page, GitHub repository, or YouTube transcript into a private complete Markdown artifact. Use for web research, source discovery, repository inspection, transcript reading, current information, or any task that needs URLs and readable source content through the buzzard-search CLI.
---

# Buzzard Web Search

Use one CLI capability for discovery and reading. Inspect `buzzard-search search --help` before using unfamiliar options.

## Workflow

1. Search for small result snippets:

   ```sh
   buzzard-search search --json "precise research query"
   ```

2. Select relevant result URLs. Do not treat snippets as complete sources.

3. Read each selected URL:

   ```sh
   buzzard-search search --json --url "https://example.com/page"
   ```

4. Use `content` for the bounded inline Markdown. Read the absolute `fullMarkdownPath` with ordinary file tools when the page was truncated or more context is needed.

GitHub repository URLs and common YouTube URL forms use the same `--url` command and are recognized automatically.

For plain-text output, parse the final `BUZZARD_FULL_MARKDOWN_PATH=` line. Prefer `--json` for automation. Use `buzzard-search status` only to diagnose the local search service; URL reading does not require a separate agent tool.
