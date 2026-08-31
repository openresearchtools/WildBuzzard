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
./wildbuzzard/scripts/build-linux-external.sh --action archive --ref <commit>
./wildbuzzard/scripts/build-linux-external.sh --bootstrap --action build
```

The script ignores uncommitted files unless `--working-tree` is supplied. Each
run records its source commit and whether a working-tree snapshot was applied.

The reusable browser archive is built without external runtimes. Arti and the
native qBittorrent runtime are built as separate pinned component artifacts and
are added only when the final Debian package is assembled. This lets packaging
be retried without rebuilding Firefox and gkrust.

```bash
./wildbuzzard/scripts/build-arti-runtime.sh

./wildbuzzard/scripts/build-linux-external.sh \
  --working-tree \
  --arti-binary /absolute/path/to/arti-2.5.1-linux-x86_64 \
  --arti-config /absolute/path/to/arti-2.5.1-linux-x86_64.toml \
  --arti-provenance /absolute/path/to/wildbuzzard-arti-2.5.1-provenance.zip \
  --qbittorrent-runtime /absolute/path/to/qbittorrent/runtime \
  --action deb
```

The final Debian package bundles Arti and the native qBittorrent/libtorrent
runtime and suggests `buzzard-search` and `buzzard-minijtt`. It does not include
a Python or Node runtime. The browser archive must not contain Pi, Pi Web,
provider, torrent-discovery, Jackett, or SearXNG runtime trees.

## Independent repositories

Build the optional components from their own repositories:

1. `buzzard-search` for `/usr/bin/buzzard-search`;
2. `buzzard-minijtt` for `/usr/bin/buzzard-minijtt`;
3. `wildbuzzard-extensions` for both synchronized built-in UIs and standalone XPIs;
4. `buzzard-agent` for the optional Pi-compatible agent and Pi Web UI.

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

The AppImage path is separate from the hosted Debian artifact workflow. It does
not contain independently packaged search, torrent-discovery, or Agent
capabilities. Run it as a browser or invoke the same control contract directly:

```bash
APPIMAGE_EXTRACT_AND_RUN=1 ./WildBuzzard-*.AppImage
APPIMAGE_EXTRACT_AND_RUN=1 ./WildBuzzard-*.AppImage snapshot
```

Ubuntu 26.04 Firefox configure currently also needs:

```bash
sudo apt install libpulse-dev
```
