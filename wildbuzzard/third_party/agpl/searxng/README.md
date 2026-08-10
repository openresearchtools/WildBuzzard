<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# SearXNG corresponding source

`upstream/` is the complete GitHub source archive for the immutable commit in
`UPSTREAM.toml`. The archive digest, Git tree, license digest, Python source,
runtime source distributions, build-tool wheels and sources, native-library
sources, Zig and Rust distributions and sources, and Granian's Cargo graph are
pinned independently.

`runtime-requirements.lock` contains every installed production distribution
observed in the exact-digest upstream image. The selected source commit has
byte-identical upstream requirement files. Runtime distributions are built
from the locked source archives; build wheels are used only in isolated build
environments and are not shipped.

The runtime build runs directly in an external host directory. It compiles
CPython and every non-system native dependency with the pinned Zig glibc 2.28
target, and builds Granian from its locked Cargo graph with the pinned Rust
toolchain. It does not use Podman, Docker, or another container builder. No
host installation is modified, and no host compiler, host development header,
or host shared library is copied into the runtime. Runtime ELF files are
checked so that only bundled libraries and the Linux glibc ABI remain as
dynamic dependencies.

The Cargo vendor archive is not checked into Git. During the online preparation
step, Cargo 1.96.0 reconstructs it in the external cache from Granian's locked
`Cargo.lock`; registry packages are checksum-verified and Git dependencies are
fixed to commits. The generated archive must match `granian-cargo-vendor.lock`.
Cargo 1.96.0 does not support `cargo vendor --filter-platform`. Although
`cargo metadata --filter-platform x86_64-unknown-linux-gnu` filters its output,
Cargo must load target-conditional package manifests before applying that
filter. Removing those checksum-bound package directories makes offline
resolution fail, so the build does not alter or partially delete vendored
crates.

An exhaustive signature scan of all 13,150 files in the exact locked vendor
archive found no ELF, PE/MS-DOS executable, or Mach-O file. It found 2,789 ar
archives (157,702,104 uncompressed bytes), primarily target-conditional Windows
import libraries; 17 COFF objects (497,035 bytes) in `ring`'s pregenerated
Windows inputs; and three WebAssembly modules (26,098 bytes) in `wit-bindgen`.
None is installed in the Linux runtime. They remain only in the external,
checksum-verified Cargo cache and the separately produced corresponding-source
archive.

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
intermediate wheel archives.
