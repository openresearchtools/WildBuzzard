<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Unsloth Studio quick-search source

`upstream/` contains the exact files needed to establish and maintain the
`buzzard-quick-search` behavioral port. Every copied byte comes from immutable
Unsloth commit `bfcaea46574d63ec470ce9c7d7221471a38ea7e4`; hashes are recorded
in `SOURCE-MANIFEST.sha256`.

The upstream search implementation is not a standalone module. It is located
inside the 12,921-line Studio `tools.py`, alongside unrelated terminal, Python,
RAG, and MCP code. The complete pristine file is retained because extracting
only Python line ranges would no longer be an unmodified upstream source file.
Only its web-search/fetch range is ported into the independently packaged
component. The supporting HTML converter, website policy, PDF parser/config,
requirements file, and license are the only other upstream files retained.

Unsloth's repository root is Apache-2.0, but its license explicitly assigns
`studio/*` to AGPLv3. These copied Studio files carry `AGPL-3.0-only` headers,
so the port preserves that license and copyright notice. The root license is
also retained because it records the repository's license boundary.

The downstream port is under
`wildbuzzard/components/buzzard-quick-search/`. Its extracted runtime file is
prominently marked as modified and preserves the original headers. No Unsloth
branding or artwork is shipped by the executable; the name is used only for
required source attribution and behavior provenance.
