# WildBuzzard development instructions

This repository is WildBuzzard, a Firefox ESR fork. Work on the WildBuzzard
product and its local changes. Mozilla contributor workflows are upstream
reference material, not this project's operating instructions.

## Workflow
- Complete authorized implementation, builds, packaging, and relevant tests without asking for redundant approval.
- Run focused tests appropriate to the change. When GUI validation is requested, exercise the visible browser and keep the desktop and virtual machine running.
- Use the configured Ubuntu build container and Data-drive build directories. Keep compiler caches and large artifacts on the Data drive.
- Save long build and test output to log files and inspect those files without rerunning commands just to recover output.
- Preserve existing user changes. Do not commit unrelated work or overwrite local modifications.
- Do not publish releases, push commits, or submit upstream patches unless requested.

## Product architecture
- The browser executable owns the shell command entry point and browser control implementation. Do not introduce a separate launcher or client executable for agent control.
- External agents use the documented shell commands. Do not restore a bundled agent, provider runtime, or MCP server.
- Keep Firefox's exact ESR tag, commit, and engine version separate from the WildBuzzard product version. Follow wildbuzzard/UPDATING-FIREFOX.md for updates and release numbering.

## Tools and style
- Search the local fork with rg, restricting searches to relevant directories. Use upstream tools only when useful for upstream code; their availability is not a prerequisite for local work.
- Use ./mach for Gecko builds and tests, and the WildBuzzard scripts for product packaging and validation.
- Keep code comments minimal. Preserve existing comments unless they are directly related to the change.
- Follow the surrounding code style. Do not add emoji to source or documentation.
