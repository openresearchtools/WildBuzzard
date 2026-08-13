# qBittorrent backend handoff

Date: 2026-08-13

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

WildBuzzard embeds the mature headless qBittorrent/libtorrent client instead of maintaining a separate WebTorrent client. qBittorrent keeps responsibility for torrent persistence, magnet metadata resolution, TCP, UDP, uTP, DHT, trackers, peers, queueing, file priorities, recheck, reannounce, pause/resume and removal.

The browser starts qBittorrent with a private Unix-domain socket and a mode-0600 bearer-key file. The patched qBittorrent WebUI and WebAPI do not listen on a product TCP port. Firefox exposes the UI at `about:torrents`, backed by the parent-process `moz-torrent://local/` protocol and a restricted UDS transport. The UI is generically titled **Torrents**, has qBittorrent product promotion removed, and follows system light/dark colours and fonts. Legal source and licence attribution remains in the bundled runtime.

Jackett Mini remains the credential-free public search source. `QBittorrentSearchBridge.sys.mjs` presents it through qBittorrent's normal search API, starts one request per enabled public source, appends results as each source completes, hides source failures from the main results table, sorts initially by seeders, and uses opaque result handles so tracker URLs are not exposed. Torrent and magnet additions go to qBittorrent; metadata continues resolving after an item is added.

Pi/Agent uses the existing browser-control connection rather than opening another service port. The simple model-facing tools are `torrent_search`, `torrent_resolve`, `torrent_add`, `torrent_status`, `torrent_action`, `torrent_files`, `torrent_trackers`, `torrent_peers`, plus the new typed `torrent_list`, `torrent_details` and `torrent_control` operations.

## Key source layout

- `wildbuzzard/third_party/gpl2/qbittorrent/`: pristine pinned qBittorrent source, provenance and the downstream patch.
- `wildbuzzard/third_party/bsd3/libtorrent/`: pristine pinned libtorrent source and Boost source lock.
- `wildbuzzard/scripts/build-qbittorrent-runtime.sh`: host-native runtime builder. Product builds must not use containers.
- `wildbuzzard/browser/components/torrent/QBittorrentRuntime.sys.mjs`: extraction, private state and persistent process lifecycle.
- `wildbuzzard/browser/components/torrent/QBittorrentUDSTransport.sys.mjs`: bounded HTTP-over-AF_UNIX client.
- `wildbuzzard/browser/components/torrent/QBittorrentWebBridge.sys.mjs`: restricted WebUI request bridge.
- `wildbuzzard/browser/components/torrent/QBittorrentProtocolHandler.sys.mjs`: `moz-torrent://local/` protocol.
- `wildbuzzard/browser/components/torrent/QBittorrentSearchBridge.sys.mjs`: progressive Jackett-to-qBittorrent search adapter.
- `wildbuzzard/browser/components/torrent/TorrentManager.sys.mjs`: qBittorrent WebAPI adapter used by browser and agent tools.
- `remote/wildbuzzard/TorrentAgentTools.sys.mjs`: browser-control torrent tools.
- `agent/extensions/web-access/torrent-contracts.ts` and `torrent.ts`: Pi tool contracts and registrations.

## Completed in this checkpoint

- Pinned full qBittorrent 5.2.3 and libtorrent 2.0.14 source trees are committed with their licences and provenance.
- The downstream qBittorrent patch builds successfully as `qbittorrent-nox` with the full libtorrent backend.
- qBittorrent uses a private UDS plus bearer key in WildBuzzard mode and leaves torrent-protocol TCP/UDP/uTP behavior intact.
- The real qBittorrent WebUI is debranded and restyled, and its fetch/XHR path is bridged through `moz-torrent`.
- `about:torrents` redirects to the qBittorrent UI.
- Browser-side runtime, UDS, WebUI, protocol, search and torrent-manager adapters are implemented.
- Jackett searches are concurrent and progressive; failed sources are ignored in the main result stream.
- Browser-control and Pi contracts include list, detail, peer/tracker/file and advanced control operations.
- A direct host build completed at `/home/user/Downloads/wildbuzzard-qbt-build/qbittorrent-clean/qbittorrent-nox` with SHA-256 `0f2f5d48d518c0cb6d3cf2a6c0465525fbe42ed744243e1b89b03792058388ea`. This Ubuntu-linked binary is test evidence only and should be rebuilt on Debian.
- The last smoke daemon was stopped before this handoff.

## Known unfinished release gates

This is a source checkpoint, not a release-ready torrent package.

1. Replace the old WebTorrent assumptions in `validate-host-native-runtime-archive.py`, `torrent-runtime-lock.json` and the torrent runtime-manifest test with the qBittorrent manifest/source/SBOM contract.
2. Finish SBOM and pinned Qt runtime inventory generation in `build-qbittorrent-runtime.sh`.
3. Commit first, then run the builder twice from two different external roots and require byte-identical ZIP files. Update `torrent-runtime-lock.json` only from that final artifact.
4. Rebuild the Jackett Mini runtime because its patch now keeps result handles for 24 hours and permits larger progressive result sets. Update its lock after the reproducibility check.
5. Apply file priorities after a resolved `.torrent` upload. The magnet path already carries priorities; the uploaded-torrent path still needs the post-add `filePrio` call.
6. Bound/expire the opaque resolved-result map even when no new search endpoint is called.
7. Require exactly one torrent ID for sequential and first/last-piece agent controls.
8. Replace the asynchronous predicate in `test_qbittorrent_search_bridge.js` with explicit polling compatible with `TestUtils.waitForCondition`.
9. Add and run xpcshell coverage for the UDS parser, runtime ownership/modes/PID validation, protocol principal restrictions, cancellation, process restart and cleanup.
10. Remove the no-longer-used custom torrent UI resources after the real qBittorrent UI passes browser tests.
11. Build WildBuzzard externally, run the torrent xpcshell/browser manifests, open `about:torrents`, and verify a real public Linux-distribution torrent end to end: magnet metadata, `.torrent` upload, file selection, restart/resume, peers, TCP/UDP/uTP, pause/start/force-start/reannounce/recheck and remove-with/without-data.
12. Run the Pi tools against that same packaged browser and verify that tool actions and UI state stay identical.

## Verification already performed

- The downstream patch applied with `patch --fuzz=0` to pristine qBittorrent source.
- The patched qBittorrent host build completed successfully.
- `agent/extensions/web-access` TypeScript typecheck passed.
- The focused torrent contract test passed 2/2.
- The full Node suite reached 65 passing tests but its existing direct Node loader cannot import the Firefox `resource://` module used by `torrent-agent-tools.test.sys.mjs`; run that test in xpcshell or with the repository's Firefox module loader rather than claiming the full suite green.
- No integrated Firefox build, xpcshell run, browser test or packaged end-to-end run has completed for this checkpoint.

## Debian resume commands

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

The Boost digest must be `46d9d2c06637b219270877c9e16155cbd015b6dc84349af064c088e9b5b12f7b`. The builder currently requires Qt `lrelease` 6.10.2 exactly. Install the matching Debian build dependencies or deliberately update and re-pin the Qt toolchain before rebuilding; do not silently accept a different toolchain.

After the runtime validator and lock migration is complete, use the normal external WildBuzzard build driver with the new qBittorrent runtime ZIP, Pi runtime, Jackett Mini runtime, SearXNG executable and Arti inputs. Keep all object directories and generated artifacts outside the source checkout.
