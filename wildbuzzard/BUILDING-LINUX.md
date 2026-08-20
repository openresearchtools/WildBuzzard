<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Isolated Linux builds

All release binaries are built on pinned Ubuntu runners. The supported runtime
matrix is Ubuntu 24.04, Ubuntu 26.04 and Debian 13 or newer.

## Browser build

`scripts/build-linux-external.sh` clones a committed revision into an external
run directory and keeps the object directory, Mozilla state, ccache, logs and
packages outside the checkout. The default layout is:

```text
wildbuzzard-builds/
├── ccache/
├── state/
└── runs/<UTC>-<commit>-<pid>/
    ├── source/
    ├── obj/
    ├── artifacts/
    ├── logs/
    └── build-manifest.txt
```

Build a committed revision:

```bash
./wildbuzzard/scripts/build-linux-external.sh --action build
```

Useful variants:

```bash
./wildbuzzard/scripts/build-linux-external.sh --action build --jobs 24
./wildbuzzard/scripts/build-linux-external.sh --action package --ref <commit>
./wildbuzzard/scripts/build-linux-external.sh --bootstrap --action build
./wildbuzzard/scripts/build-linux-external.sh \
  --build-root /absolute/path/wildbuzzard-builds \
  --action all
```

The script ignores uncommitted files unless `--working-tree` is supplied. Every
run records the base commit and whether it included a working-tree snapshot.

The browser package does not embed SearXNG, qBittorrent, Jackett Mini, Buzzard
Agent or Buzzard Agent Web payloads. Those capabilities are ordinary Debian
package dependencies. The browser packaging gate accepts only the pinned Arti
binary and its provenance archive:

```bash
./wildbuzzard/scripts/build-arti-runtime.sh

./wildbuzzard/scripts/build-linux-external.sh \
  --working-tree \
  --arti-binary /absolute/path/to/arti-2.5.1-linux-x86_64 \
  --arti-provenance /absolute/path/to/wildbuzzard-arti-2.5.1-provenance.zip \
  --action all
```

The Arti builder verifies the pristine pinned subtree, uses locked dependencies
and emits corresponding source, SBOM, runtime manifest and upstream licences.

## Component packages

First-party package definitions are under `wildbuzzard/components`. Third-party
source and exact provenance are under `wildbuzzard/third_party`. Build these as
separate packages in dependency order:

1. `buzzard-search`
2. `buzzard-torrent-search`
3. `buzzard-torrent`
4. `buzzard-quick-search`
5. `buzzard-agent`
6. `buzzard-agent-web`
7. `wildbuzzard`

The runtime-bearing package builders receive their own pinned build output:

```bash
BUZZARD_SEARCH_RUNTIME=/absolute/path/to/searxng.AppImage \
  ./wildbuzzard/components/buzzard-search/scripts/build-deb.sh /absolute/path/out

BUZZARD_TORRENT_SEARCH_RUNTIME=/absolute/path/to/jackett-mini-runtime \
BUZZARD_NODE_ROOT=/opt/node \
  ./wildbuzzard/components/buzzard-torrent-search/scripts/build-deb.sh /absolute/path/out

BUZZARD_TORRENT_RUNTIME=/absolute/path/to/qbittorrent-runtime \
  ./wildbuzzard/components/buzzard-torrent/scripts/build-deb.sh /absolute/path/out

./wildbuzzard/components/buzzard-quick-search/scripts/build-deb.sh
BUZZARD_NODE_ROOT=/opt/node \
  ./wildbuzzard/components/buzzard-agent/build-deb.sh /absolute/path/out
./wildbuzzard/components/buzzard-agent-web/scripts/build-deb.sh
```

Each package owns its runtime, lifecycle, state, CLI and stdio MCP server. No
consumer reads another package's private `/usr/lib` directory. Build twice from
independent roots and require byte-identical `.deb` output before publishing.

Install and smoke-test the exact final package set on all three supported base
images. The combined test must exercise CLI discovery, MCP initialization/tool
catalogues, private per-user services and the browser-to-package integrations.

## AppImage and host notes

The AppImage contains the browser core, not the independently packaged
capabilities. Run it normally with FUSE or use this on build hosts:

```bash
APPIMAGE_EXTRACT_AND_RUN=1 ./WildBuzzard-*.AppImage
```

`ccache` is useful across Firefox ESR updates. Rust and final linking are not
covered by ordinary ccache. Ubuntu 26.04 Firefox configure currently also needs:

```bash
sudo apt install libpulse-dev
```
