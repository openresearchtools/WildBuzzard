<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# SearXNG corresponding source

`upstream/` is the complete GitHub source archive for the immutable commit in
`UPSTREAM.toml`. The archive digest, Git tree, license digest, Python source,
runtime source distributions, build-tool wheels and sources, native-library
sources, Zig and Rust distributions and sources, and Granian Cargo vendor tree
are pinned independently.

`runtime-requirements.lock` contains every installed production distribution
observed in the exact-digest upstream image. The selected source commit has
byte-identical upstream requirement files. Runtime distributions are built
from the locked source archives; build wheels are used only in isolated build
environments and are not shipped.

The runtime build compiles CPython and every non-system native dependency with
the pinned Zig glibc 2.28 target. Granian is built from its locked, vendored
Cargo graph with the pinned Rust toolchain. No host compiler, host development
header, or host shared library is copied into the runtime. Runtime ELF files
are checked so that only bundled libraries and the Linux glibc ABI remain as
dynamic dependencies.

The published 2026.8.4 image predates the selected 2026.8.6 source commit. It
is therefore only a pinned dependency and base-image reference. The pristine
comparison replaces its application tree with the complete selected source and
records both identities rather than claiming that the image itself matches.

Run `wildbuzzard/scripts/import-searxng-source.sh --check` to verify this copy.
Populate and verify an external cache once with:

```sh
wildbuzzard/scripts/build-searxng-runtime.sh \
  --output /absolute/path/to/prepare \
  --cache /absolute/path/to/cache \
  --prepare-only
```

Then create the native runtime and complete corresponding-source archives
without network access:

```sh
wildbuzzard/scripts/build-searxng-runtime.sh \
  --output /absolute/path/to/output \
  --cache /absolute/path/to/cache \
  --offline
```

The runtime manifest records the complete archive as `correspondingSource` and
binds it with `correspondingSourceSha256`. The separately pinned upstream
SearXNG codeload digest is `upstreamSourceArchiveSha256`.

The build verifies that every PEP 610 `direct_url.json` record describes a
local wheel under the canonical build path, then removes those records before
regenerating each installed distribution's `RECORD`. Source locks, the runtime
manifest, and the SBOM retain release provenance without depending on hashes of
intermediate wheel containers.
