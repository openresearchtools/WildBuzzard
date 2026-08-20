# qBittorrent backend handoff

Date: 2026-08-17

## Authoritative resume point

- Repository: `https://github.com/openresearchtools/WildBuzzard.git`
- Branch: `integration/web-search-torrent-final`
- Worktree used during development: `/home/user/Downloads/WildBuzzard-worktrees/torrent-client-repair`
- Branch base: `c54e09f9f16b` (`Fix Agent identity for empty startup URL bars`)
- Existing branch commits:
  - `4e6c484daa26` vendors the pinned qBittorrent 5.2.3 source.
  - `ea2696f958cb` vendors the pinned libtorrent 2.0.14 source.
  - `790083f08df9` adds the first private-runtime downstream patch.
- The branch base already contains the accepted Pi, Agent, SearXNG, Gecko crawl, Jackett Mini, torrent, Tor/Arti, packaging and browser integration work. The commits above add the qBittorrent replacement on top of that complete browser history.
- `codex/qbittorrent-backend` is a backup pointer to the same checkpoint. It is not an additional branch to merge.
- Historical `agent/*`, `codex/searx-*` and `integration/waterfox-port` branches are development evidence. Do not merge or cherry-pick them when reconstructing the product.

Do not resume from the dirty shared checkout at `/home/user/Downloads/WildBuzzard`. Clone or fetch the repository and switch directly to `integration/web-search-torrent-final`. No other branch is required.

## Intended product architecture

The independent `buzzard-torrent` Debian package provides the mature headless qBittorrent/libtorrent client instead of Wild Buzzard maintaining a separate WebTorrent client. qBittorrent keeps responsibility for torrent persistence, magnet metadata resolution, TCP, UDP, uTP, DHT, trackers, peers, queueing, file priorities, recheck, reannounce, pause/resume and removal.

The browser calls `/usr/bin/buzzard-torrent`, whose package starts qBittorrent with a private Unix-domain socket and a mode-0600 bearer-key file. The patched qBittorrent WebUI and WebAPI do not listen on a product TCP port. Firefox exposes the UI at `about:torrents`, backed by the restricted `moz-torrent://local/` protocol and a parent actor that owns UDS requests. The UI is generically titled **Torrents**, has qBittorrent product promotion removed, and follows system light/dark colours and fonts. Legal source and licence attribution remains in the component package.

Jackett Mini remains the credential-free public search source. `QBittorrentSearchBridge.sys.mjs` presents it through qBittorrent's normal search API, starts one request per enabled public source, appends results as each source completes, hides source failures from the main results table, sorts initially by seeders, and uses opaque result handles so tracker URLs are not exposed. Torrent and magnet additions go to qBittorrent; metadata continues resolving after an item is added.

Agents use the installed `buzzard-torrent-mcp` server or the browser-control connection rather than opening another service port. The model-facing tools cover search, resolve, add, list, details, status, files, trackers, peers and typed controls.

## Key source layout

- `wildbuzzard/third_party/gpl2/qbittorrent/`: pristine pinned qBittorrent source, provenance and the downstream patch.
- `wildbuzzard/third_party/bsd3/libtorrent/`: pristine pinned libtorrent source and Boost source lock.
- `wildbuzzard/scripts/build-qbittorrent-runtime.sh`: pinned Ubuntu runtime builder used by the product build pipeline.
- `wildbuzzard/components/buzzard-torrent/`: standalone CLI, MCP, Debian metadata and package-owned lifecycle.
- `wildbuzzard/browser/components/torrent/QBittorrentRuntime.sys.mjs`: thin `/usr/bin/buzzard-torrent` lifecycle client and connection validation.
- `wildbuzzard/browser/components/torrent/QBittorrentUDSTransport.sys.mjs`: bounded HTTP-over-AF_UNIX client.
- `wildbuzzard/browser/components/torrent/QBittorrentWebBridge.sys.mjs`: restricted WebUI request bridge.
- `wildbuzzard/browser/components/torrent/QBittorrentProtocolHandler.sys.mjs`: `moz-torrent://local/` protocol.
- `wildbuzzard/browser/components/torrent/QBittorrentSearchBridge.sys.mjs`: progressive Jackett-to-qBittorrent search adapter.
- `wildbuzzard/browser/components/torrent/TorrentManager.sys.mjs`: qBittorrent WebAPI adapter used by browser and agent tools.
- `remote/wildbuzzard/TorrentAgentTools.sys.mjs`: browser-control torrent tools.
- `wildbuzzard/components/buzzard-torrent/src/`: reusable CLI and stdio MCP contracts.

## Completed in this checkpoint

- Pinned full qBittorrent 5.2.3 and libtorrent 2.0.14 source trees are committed with their licences and provenance.
- The downstream qBittorrent patch builds successfully as `qbittorrent-nox` with the full libtorrent backend.
- qBittorrent uses a private UDS plus bearer key in WildBuzzard mode and leaves torrent-protocol TCP/UDP/uTP behavior intact.
- The real qBittorrent WebUI is debranded and restyled, and its fetch/XHR path is bridged through `moz-torrent`.
- `about:torrents` redirects to the qBittorrent UI.
- Browser-side runtime, UDS, WebUI, protocol, search and torrent-manager adapters are implemented.
- Jackett searches are concurrent and progressive; failed sources are ignored in the main result stream.
- Browser-control and standalone MCP contracts include list, detail, peer/tracker/file and advanced control operations.
- The real WebUI runs as normal browser content in `about:torrents`; browser agents can inspect its DOM/accessibility tree, click controls, type queries, read rows and operate the qBittorrent add-torrent dialog.
- The browser-side ZIP inventory/hash validator and its obsolete locks were removed. The browser does not contain, download, unpack, inventory or hash the qBittorrent payload. Provenance, SBOM and reproducibility validation belong to the independent Debian package's Ubuntu build pipeline.
- Relative URL, native event, unavailable local-storage and iframe resource behavior are adapted in the downstream WebUI patch without replacing qBittorrent's UI.
- Search result caches are bounded and expire, uploaded-torrent file priorities are applied after add, and sequential/first-last controls require exactly one torrent ID.
- The obsolete custom torrent page, tests and locale were removed after the real qBittorrent UI browser test passed.
- A clean Ubuntu 24.04 container build completed from snapshot `c500f3d8d59b` at `/workspace/qbittorrent-runtime-builds/runs/20260817T195507Z-c500f3d8d59b-353106`.

## Known unfinished release gates

The standalone `buzzard-torrent` package is reproducible and passes the supported distribution smoke matrix. Remaining full-product release gates are:

1. Extend xpcshell coverage for runtime ownership/modes/PID validation, protocol-principal rejection, cancellation, process restart and cleanup. UDS framing, search bridging and torrent-manager coverage now exist.
2. Build and package Wild Buzzard on Ubuntu CI, then run the torrent manifests and a real public Linux-distribution torrent end to end: magnet metadata, `.torrent` upload, file selection, restart/resume, peers, TCP/UDP/uTP, pause/start/force-start/reannounce/recheck and remove-with/without-data.
3. Run the generic MCP tools against that same packaged browser and verify that tool actions and UI state stay identical.

## Verification already performed

- The downstream patch applies with zero fuzz to pristine qBittorrent 5.2.3 source, and the clean Ubuntu 24.04 qBittorrent/libtorrent build completes.
- The integrated Ubuntu Firefox build was relinked after the component changes.
- `agent/extensions/web-access` TypeScript typecheck passes and its complete Node suite passes 76/76, including the qBittorrent agent contracts and SearXNG date sorting.
- Focused qBittorrent/SearXNG xpcshell tests pass 4/4.
- The real qBittorrent browser test passes 7/7: transfer view, debranding restrictions, browser-backed search result rendering and magnet add dialog.
- `./mach format` and `git diff --check` pass.
- Two independent Ubuntu 24.04 builds produced byte-identical qBittorrent runtimes and byte-identical `buzzard-torrent` packages.
- The exact package passes rootless service and WebUI smokes on Ubuntu 24.04, Ubuntu 26.04 and Debian 13.
- A packaged full-browser real-network torrent smoke remains a release gate.

## Ubuntu builder resume commands

```bash
git clone https://github.com/openresearchtools/WildBuzzard.git
cd WildBuzzard
git switch integration/web-search-torrent-final

curl -fL -o /path/to/boost_1_88_0.tar.bz2 \
  https://archives.boost.io/release/1.88.0/source/boost_1_88_0.tar.bz2
sha256sum /path/to/boost_1_88_0.tar.bz2

./wildbuzzard/scripts/build-qbittorrent-runtime.sh \
  --boost-archive /path/to/boost_1_88_0.tar.bz2 \
  --build-root /path/outside/the/repository/qbittorrent-build-a \
  --lrelease "$(command -v lrelease)" \
  --ref HEAD
```

The Boost digest must be `46d9d2c06637b219270877c9e16155cbd015b6dc84349af064c088e9b5b12f7b`. The builder currently requires Qt `lrelease` 6.10.2 exactly. Use the pinned Ubuntu build image or deliberately update and re-pin the Qt toolchain; do not silently accept a different toolchain.

Build the qBittorrent artifact with this builder, then build `wildbuzzard/components/buzzard-torrent` as an independent Debian package. The `wildbuzzard` package declares `buzzard-torrent` as a normal dependency and never copies its files into the browser package. Keep all object directories and generated artifacts outside the source checkout.
