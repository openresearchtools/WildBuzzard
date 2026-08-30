# WildBuzzard release CI

The `WildBuzzard Ubuntu 24.04 release` workflow builds one release set from
four exact commits:

- `openresearchtools/wildbuzzard`
- `openresearchtools/buzzard-search`
- `openresearchtools/buzzard-minijtt`
- `openresearchtools/wildbuzzard-extensions`

The three component commits are mandatory workflow-dispatch inputs. The
WildBuzzard commit is the exact commit selected when the workflow is started.
Branch names, tags, abbreviated SHAs, and dirty checkouts are rejected.

The release job requires a self-hosted Ubuntu 24.04 runner carrying the
`wildbuzzard-ubuntu-24.04` label, Docker, and at least 80 GiB free in its
Actions work directory. Install the Actions runner and its `_work` directory
on the data volume so the checkout, temporary files, compiler caches, object
directories, and release artifacts never use the system disk. Configure
Docker's `data-root` on that same volume so image layers also stay off the
system disk. The workflow resolves `/run/media/user/Data`, rejects it if it is
on the system-root device, and requires `GITHUB_WORKSPACE`, `RUNNER_TEMP`, and
Docker's reported `DockerRootDir` to be below that root on the same mounted
device. The storage preflight rejects incorrectly provisioned runners before
checkout.

The workflow builds its toolchain image from a digest-pinned Ubuntu 24.04 base.
Downloaded Node.js, .NET, Rust bootstrap, Boost, and AppImageKit inputs are
checksum-verified. Existing component builders additionally verify their Arti,
qBittorrent, libtorrent, Qt, Jackett, Python, and provider-policy pins.

`build-release.sh` runs the external extension policy check before compiling
anything. It confirms that both bundled copies exactly match the two subprojects
in `wildbuzzard-extensions`, runs each extension's offline/security checks and
tests, packages both installable XPIs, and requires their full SHA-256 digests
to match the browser's two-entry trust policy. It then builds and tests the three separately
installable CLI Debian packages and the browser. The browser build invokes the
product Python, xpcshell, browser, blocker, package, Debian, and AppImage steps
through `build-linux-external.sh`.

The uploaded Actions artifact contains:

- `wildbuzzard`, `buzzard-search`, `buzzard-minijtt`, and `buzzard-torrent`
  amd64 Debian packages
- the browser archive and AppImage
- both installable search-extension XPIs
- pinned Arti runtime, provenance, workspace source, and deterministic Cargo
  vendor source artifacts; the
  browser-control client's checksum-pinned Rust crate source bundle; and
  the native MiniJTT source/license artifact plus qBittorrent runtime,
  provenance, patched qBittorrent/libtorrent core source, Boost, Qt Base, and
  Ubuntu system corresponding-source artifacts
- component build manifests, `release-manifest.json`, and `SHA256SUMS`

The browser archive, Debian package, and AppImage are rejected unless they
carry the repository licenses, CLI upstream notice and MIT license, and the
corresponding-source pointer. They also carry an exact Cargo.lock inventory
and the upstream license bytes for every statically linked browser-control
crate. The browser Debian package requires buzzard-torrent and advertises
buzzard-search and buzzard-minijtt as optional suggestions.
It also carries an exact all-package Arti Cargo.lock inventory and the exact
upstream license, copying, notice, and copyright bytes referenced by that
inventory. Arti's workspace and 70 MiB Cargo vendor source archives remain
outside the installed browser payload and are hash-bound into its provenance.
`release-manifest.json` records every repository commit, package identity,
artifact size, and SHA-256 digest. `SHA256SUMS` is verified before upload.

All participating repositories must be readable with the workflow's standard
read-only `GITHUB_TOKEN`; the workflow does not require signing keys, package
registry credentials, or other repository secrets. Signing and publishing to
an APT repository are intentionally separate release-authority steps.

The `WildBuzzard Ubuntu 24.04 hosted artifact` workflow is the artifact-only
GitHub-hosted trial path. It reclaims host disk, checks out only WildBuzzard at
depth one, installs the browser toolchain, and builds directly on the Ubuntu
24.04 runner. It never checks out or builds the optional `buzzard-search` or
`buzzard-minijtt` packages or the independent extension repository. The two
built-in extension snapshots come from the WildBuzzard commit being built.
`build-browser-artifact.sh` builds the pinned in-tree Arti runtime, runs the
browser tests, and packages only the amd64 WildBuzzard Debian artifact. The
workflow uploads that package, build manifests, checksums, and logs. It does not
sign, publish, create a GitHub release, or push repository changes.

If the GitHub-hosted runner's hard disk or time limit proves insufficient, the
fallback is to build independently owned Rust and external components on
separate runners and consume verified artifacts. That multi-runner fallback is
documented architecture only and is not implemented by this workflow.
