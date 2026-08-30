<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Isolated Linux builds

Release binaries are built on pinned Ubuntu runners and target Ubuntu 24.04,
Ubuntu 26.04, and Debian 13 or newer.

## Browser build

`scripts/build-linux-external.sh` clones a committed revision into a separate
run directory. Mozilla state, object files, caches, logs, and packages never
enter the developer checkout.

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

```bash
./wildbuzzard/scripts/build-linux-external.sh --action build
./wildbuzzard/scripts/build-linux-external.sh --action build --jobs 24
./wildbuzzard/scripts/build-linux-external.sh --action package --ref <commit>
./wildbuzzard/scripts/build-linux-external.sh --bootstrap --action build
```

The script ignores uncommitted files unless `--working-tree` is supplied. Each
run records its source commit and whether a working-tree snapshot was applied.

The browser contains Arti because per-tab Tor routing is a core browser
feature. Supply its verified binary and provenance for release packaging:

```bash
./wildbuzzard/scripts/build-arti-runtime.sh

./wildbuzzard/scripts/build-linux-external.sh \
  --working-tree \
  --arti-binary /absolute/path/to/arti-2.5.1-linux-x86_64 \
  --arti-provenance /absolute/path/to/wildbuzzard-arti-2.5.1-provenance.zip \
  --action all
```

The browser package depends on the separately built `buzzard-torrent` package
and suggests `buzzard-search` and `buzzard-minijtt`. It must not contain Pi, Pi
Web, Node, provider, torrent-discovery, Jackett, or SearXNG runtime trees. The
reviewed offline UI files from both extension subprojects are synchronized into
the built-in add-on tree. Debian and AppImage packaging fail if external
runtime paths appear in the browser archive.

## Independent repositories

Build and publish the native torrent package from
`wildbuzzard/components/buzzard-torrent`, then build the other components from
their own repositories:

1. `buzzard-torrent` for the qBittorrent/libtorrent runtime;
2. `buzzard-search` for `/usr/bin/buzzard-search`;
3. `buzzard-minijtt` for `/usr/bin/buzzard-minijtt`;
4. `wildbuzzard-extensions` for both synchronized built-in UIs and standalone XPIs;
5. `buzzard-agent` for the optional Pi-compatible agent and Pi Web UI.

Each repository owns its dependencies, tests, license bundle, source archive,
SBOM, and Debian or XPI release. Build twice from independent roots and require
reproducible output before publishing. The browser integration accepts only
the documented, versioned CLI and WebExtension contracts.

Release XPIs use normal signature enforcement or the exact canonical SHA-256
pins compiled into the matching WildBuzzard release. Temporary loading can
validate XPI UI only; restricted browser APIs remain unavailable until the
release ID is normally signed or exactly pinned and installed non-temporarily.
Development never weakens release signature or experiment preferences.

## AppImage and host notes

The AppImage contains browser core, Arti, and the agent-neutral native control
client, but not independently packaged search, torrent-discovery, or Agent
capabilities. Run it as a browser or invoke the same control contract directly:

```bash
APPIMAGE_EXTRACT_AND_RUN=1 ./WildBuzzard-*.AppImage
APPIMAGE_EXTRACT_AND_RUN=1 ./WildBuzzard-*.AppImage snapshot
```

Ubuntu 26.04 Firefox configure currently also needs:

```bash
sudo apt install libpulse-dev
```
