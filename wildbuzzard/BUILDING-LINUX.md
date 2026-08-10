<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Isolated Linux builds

`scripts/build-linux-external.sh` simulates a clean self-hosted runner on the
same machine. It clones a committed revision into an external run directory and
puts the object directory, Mozilla build state, ccache, logs, and packages
outside the developer checkout.

The default layout is a sibling of the repository:

```text
wildbuzzard-builds/
├── ccache/                  shared safely across ESR updates
├── state/                   shared mach/bootstrap state
└── runs/
    └── <UTC>-<commit>-<pid>/
        ├── source/          clean detached checkout
        ├── obj/             build objects and dist packages
        ├── artifacts/       installable WildBuzzard .deb and AppImage
        ├── logs/
        └── build-manifest.txt
```

From the WildBuzzard repository:

```bash
./wildbuzzard/scripts/build-linux-external.sh --action all
```

Useful variants:

```bash
# Use all 24 cores explicitly.
./wildbuzzard/scripts/build-linux-external.sh --action build --jobs 24

# Build an exact committed revision.
./wildbuzzard/scripts/build-linux-external.sh --action package --ref <commit>

# Build the current working tree with a committed Pi Web runtime bundle.
./wildbuzzard/scripts/build-linux-external.sh \
  --working-tree \
  --pi-web-runtime /absolute/path/to/wildbuzzard-pi-web-runtime-linux-x64.zip \
  --searxng-runtime /absolute/path/to/wildbuzzard-searxng-2026.8.6+b023a28ba-linux-x86_64.zip \
  --searxng-source /absolute/path/to/wildbuzzard-searxng-2026.8.6+b023a28ba-source.tar.xz \
  --arti-binary /absolute/path/to/arti-2.5.1-linux-x86_64 \
  --action appimage

# Bootstrap a new build host, then build.
./wildbuzzard/scripts/build-linux-external.sh --bootstrap --action build

# Put all runner state on a larger disk.
./wildbuzzard/scripts/build-linux-external.sh \
  --build-root /absolute/path/wildbuzzard-builds \
  --action all
```

The script ignores uncommitted files unless `--working-tree` is supplied.
Every run records the base commit and whether it included that snapshot in
`build-manifest.txt`. Pi Web runtime builds require a clean, committed local
Pi Web fork and always record its exact commit separately.

Build the Pi Web runtime separately from the browser checkout. The Git and
yt-dlp helper archives must be source-built runtime ZIPs and their SHA-256
values are mandatory:

```bash
./wildbuzzard/scripts/build-pi-web-runtime.sh \
  --fork /absolute/path/to/WildBuzzard-pi-web \
  --build-root /absolute/path/to/pi-web-builds \
  --git-runtime /absolute/path/to/git-runtime.zip \
  --git-runtime-sha256 <sha256> \
  --ytdlp-runtime /absolute/path/to/ytdlp-runtime.zip \
  --ytdlp-runtime-sha256 <sha256>
```

The committed runtime lock pins the Pi Web commit and tree, package lock,
Node archive, npm version, and Pi packages. Builds use isolated npm and Cargo
state, fresh per-run Rust targets, production npm and RustSec audits, and emit
CycloneDX and SPDX inventories covering Pi Web, web-access, and the native
browser runner. `--offline` fails if a pinned input, package, or advisory
database is absent. To verify reproducibility, run two clean builds and pass
the first run's `build-record.json` to the second with `--compare-to`; the
comparator checks archive bytes, members, modes, timestamps, per-member hashes,
inputs, and build environment.

Build the SearXNG runtime directly from the pinned sources and host-native
toolchains. Its shipping path never invokes an OCI runtime:

```bash
./wildbuzzard/scripts/build-searxng-runtime.sh \
  --output /absolute/path/to/searxng-output \
  --cache /absolute/path/to/searxng-cache
```

The output includes the runtime ZIP, its build record, and the complete
corresponding-source archive. Pass the pair through `--searxng-runtime` and
`--searxng-source`; either option without the other is rejected. Every browser
tarball and derived package keeps the source archive at
`notices/source/wildbuzzard-searxng-2026.8.6+b023a28ba-source.tar.xz` and its
release SBOM at `notices/source/searxng-release.cdx.json`. The browser verifies
the runtime's exact manifest and file inventory before extracting it into
versioned per-profile XDG state. The AppImage and Debian packaging gates
rehash the runtime, source archive, and release SBOM before producing output.

After extracting a built runtime, run its lifecycle gate before packaging:

```bash
./wildbuzzard/scripts/test-pi-web-runtime-lifecycle.mjs \
  --runtime /absolute/path/to/extracted-runtime
```

The gate starts the runtime's bundled Node, web service, and session daemon;
creates a real project and Pi session; rotates the private service identity as
a cold browser restart does; reconnects with a fresh challenge; and verifies
that the authenticated web and session-daemon PIDs and the session remain
unchanged. It terminates only the two processes it created and removes its
temporary state when complete.

The `appimage` action builds the browser, creates Mozilla's Linux tar archive,
and packages it as a self-contained AppImage. Supplied Pi Web and SearXNG
runtime ZIPs, including their native dependencies and license inventories, are
included in that image. The `all` action also runs the native blocker tests and
every WildBuzzard component test, and creates both an `amd64` Debian package
and an AppImage. Packaging runs entirely in the external run directory and
does not use `sudo`.

Build the pinned, unmodified Tor Project Arti subtree into the external Arti
build directory before packaging:

```bash
./wildbuzzard/scripts/build-arti-runtime.sh
```

The script verifies that `third_party/arti` exactly matches the commit pinned
in `wildbuzzard/third_party/arti.toml`, builds with Arti's locked dependencies,
and prints the executable path to pass through `--arti-binary`. The resulting
AppImage starts Arti only when a tab first enables Tor routing. See
`wildbuzzard/TOR.md` for the routing model, update procedure, and anonymity
scope.

Run the AppImage normally on a system with FUSE support. On build or test hosts
without FUSE, use:

```bash
APPIMAGE_EXTRACT_AND_RUN=1 ./WildBuzzard-*.AppImage
```

`ccache` is useful across Firefox ESR updates because unchanged C/C++ translation
units and headers still produce cache hits. The cache lives outside individual
runs, while each run gets a fresh source and object directory. Rust and final
linking work are not covered by ordinary ccache.

On Ubuntu 26.04, Firefox configure currently requires the PulseAudio development
package:

```bash
sudo apt install libpulse-dev
```
