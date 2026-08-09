# Per-tab Tor routing

WildBuzzard can reopen the selected tab in a private `Tor` container and route
that container through its bundled Arti SOCKS proxy. DNS is resolved by Arti,
requests cannot fail over to a direct connection, and each browser gets unique
SOCKS credentials for Arti stream isolation. Tabs outside the `Tor` container
keep their existing network configuration.

This feature provides `.onion` connectivity and per-tab Tor routing. It does
not reproduce Tor Browser's fingerprinting defenses, security slider, update
policy, or complete anonymity model. Use Tor Browser when anonymity is the
primary requirement.

## Upstream source

The unmodified Arti repository is stored at `third_party/arti` as a Git
subtree. `wildbuzzard/third_party/arti.toml` records the upstream repository,
tag object, exact commit, Rust version, and license. The subtree import keeps
the upstream commit graph rather than squashing it.

To update it:

```bash
git fetch https://gitlab.torproject.org/tpo/core/arti.git refs/tags/arti-vNEW
git subtree pull --prefix=third_party/arti FETCH_HEAD
```

Verify the tag and update every pinned field in
`wildbuzzard/third_party/arti.toml`. Then build the runtime outside the source
tree:

```bash
./wildbuzzard/scripts/build-arti-runtime.sh
```

Pass the printed executable to `build-linux-external.sh --arti-binary` when
creating the browser package or AppImage.
