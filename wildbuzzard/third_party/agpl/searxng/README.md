<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# SearXNG corresponding source

`upstream/` is the complete GitHub source archive for the immutable commit in
`UPSTREAM.toml`. The archive digest, Git tree, license digest, Python source,
runtime source distributions, and build-tool wheels are pinned independently.

`runtime-requirements.lock` contains every installed production distribution
observed in the exact-digest upstream image. The selected source commit has
byte-identical upstream requirement files. Runtime distributions are built
from the locked source archives; build wheels are used only in isolated build
environments and are not shipped.

The published 2026.8.4 image predates the selected 2026.8.6 source commit. It
is therefore only a pinned dependency and base-image reference. The pristine
comparison replaces its application tree with the complete selected source and
records both identities rather than claiming that the image itself matches.

Run `wildbuzzard/scripts/import-searxng-source.sh --check` to verify this copy.
Run `wildbuzzard/scripts/build-searxng-runtime.sh` outside the source checkout
to create the native runtime and complete corresponding-source archives.
