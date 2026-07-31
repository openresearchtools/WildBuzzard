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
        ├── artifacts/       installable WildBuzzard .deb
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

# Bootstrap a new build host, then build.
./wildbuzzard/scripts/build-linux-external.sh --bootstrap --action build

# Put all runner state on a larger disk.
./wildbuzzard/scripts/build-linux-external.sh \
  --build-root /absolute/path/wildbuzzard-builds \
  --action all
```

The script deliberately ignores uncommitted files. Commit the intended port
before invoking it. Every run records the exact full commit ID in
`build-manifest.txt`.

The `all` action builds the browser, runs the native blocker tests and every
WildBuzzard component test, creates Mozilla's Linux tar archive, and then
packages that archive as an `amd64` Debian package. Packaging runs entirely in
the external run directory and does not use `sudo`.

`ccache` is useful across Firefox ESR updates because unchanged C/C++ translation
units and headers still produce cache hits. The cache lives outside individual
runs, while each run gets a fresh source and object directory. Rust and final
linking work are not covered by ordinary ccache.

On Ubuntu 26.04, Firefox configure currently requires the PulseAudio development
package:

```bash
sudo apt install libpulse-dev
```
