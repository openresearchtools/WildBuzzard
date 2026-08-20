<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Third-party notices

The search, fetch, HTML-to-Markdown, website-policy, and PDF extraction behavior
is derived from Unsloth Studio, copyright 2026-present the Unsloth AI Inc. team,
licensed AGPL-3.0-only. Downstream extracted files carry a prominent
modification notice. The complete license is distributed as `LICENSE` and the
pristine selected source files are retained under
`wildbuzzard/third_party/agpl/unsloth-quick-search/upstream/`.

Runtime Python distributions and their versions/hashes are fixed by `uv.lock`.
Their original metadata and license files are collected into the standalone
executable directory by PyInstaller and distributed with the Debian package.

The GitHub repository inspector reimplements the bounded extraction design in
`agent/extensions/web-access/github.ts`, which is derived from pi-web-access,
copyright (c) 2025 Nico Bailon and licensed AGPL-3.0-or-later. Wild Buzzard's
Python implementation does not copy or distribute Git; it invokes an installed
Git executable with credential helpers and interactive authentication disabled.
