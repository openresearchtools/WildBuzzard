<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Agent extraction record

This refactor reconstructs an agent-independent browser from Git history
without discarding browser features added after the Agent appeared.

## History anchors

| Commit | Meaning | Treatment |
| --- | --- | --- |
| `b2cf9cd353ed9e3a64a1c55ef584b0685f28eb67` | Last browser state before the generic control and Pi integration series | Reference for restoring browser UI/search modules modified only for Pi |
| `b531dd7f6108` | Native browser-control implementation | Retained and renamed as agent-neutral control |
| `ddbfc8b2ce75` | Persistent Pi Web browser experience begins | Pi-specific UI, runtime, and ownership changes removed |
| `2dba2a19c96a` | Complete Waterfox-derived browser integration | Retained |
| `35c82d73c1d3` | ESR 153 adaptation of the Waterfox integration | Retained |
| `06fc020e461d` | Complete native content-blocker integration | Retained |

Later Widevine, Tor/Arti, qBittorrent/libtorrent, blocker, and Waterfox-derived
browser changes are retained by feature ownership, not reverted as a range.
The original integration branch remains an immutable recovery source.

## Restored browser behavior

The normal new-tab/home configuration, sidebar lifecycle, SearchService,
search-detection API, URL bar providers/tokenizer/UI, search settings, toolbar
layout, and browser strings were restored from the pre-Pi browser state where
they had only been changed to make Agent Web the primary surface or to embed
search discovery.

The following remain browser-owned:

- reviewed Waterfox UI and privacy components;
- native content blocking;
- Tor/Arti routing and toolbar controls;
- Widevine acquisition with a user-disable preference;
- native qBittorrent downloads and transfer management;
- generic authenticated browser control and CLI;
- two constrained parent-process bridges for optional normally signed or exact
  release-pinned, non-temporary search XPIs.

## External ownership

Pi, Pi Web, Node packaging, and agent skills moved to the sibling
`buzzard-agent` repository. Web search uses `buzzard-search`, torrent discovery
uses `buzzard-minijtt`, and both UIs live in `wildbuzzard-extensions`.

`FEATURE-OWNERSHIP.toml` lists forbidden external source roots. Its test fails
if one is reintroduced into the browser. Browser package builders also fail if
an Agent or discovery runtime appears in a release archive.

## Torrent ingress boundary

User-clicked top-level `magnet:` links and exact BitTorrent MIME responses enter
a native confirmation flow. Frames, scripted navigation without a live user
gesture, background tabs, URL fragments, duplicate pending sources, and private
browsing are rejected. Extension imports use separate one-use parent-process
tokens and the same explicit native confirmation requirement.

After confirmation, `.torrent` metadata is re-fetched with the originating
page principal, cookie jar, and referrer under Firefox's save-download policy.
Only HTTP, HTTPS, and local-file sources with an exact BitTorrent MIME type and
a bounded payload are accepted. Neither sites nor extensions receive a more
privileged network principal, and magnet or torrent bytes never pass through a
result-site script. `about:torrents` and `moz-torrent` remain unavailable in
private browsing because the native backend is not profile-isolated.
