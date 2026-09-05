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
checksum-verified. Existing component builders additionally verify their Tor,
qBittorrent, libtorrent, Qt, Jackett, Python, and provider-policy pins.

`build-release.sh` runs the external extension policy check before compiling
anything. It confirms that both bundled copies exactly match the two subprojects
in `wildbuzzard-extensions`, runs each extension's offline/security checks and
tests, packages both installable XPIs, and requires their full SHA-256 digests
to match the browser's two-entry trust policy. It then builds the two separately
installable discovery CLI Debian packages and the self-contained browser. The browser build invokes the
product Python, xpcshell, browser, blocker, package, Debian, and AppImage steps
through `build-linux-external.sh`.

The uploaded Actions artifact contains:

- `wildbuzzard`, `buzzard-search`, and `buzzard-minijtt` amd64 Debian packages
- the browser archive and AppImage
- both installable search-extension XPIs
- pinned Tor runtime, provenance, and exact upstream source archive; and
  the native MiniJTT source/license artifact plus qBittorrent runtime,
  provenance, patched qBittorrent/libtorrent core source, Boost, Qt Base, and
  Ubuntu system corresponding-source artifacts
- component build manifests, `release-manifest.json`, and `SHA256SUMS`

The browser archive, Debian package, and AppImage are rejected unless they
carry the repository licenses, CLI upstream notice and MIT license, and the
corresponding-source pointer. The browser Debian package contains its native qBittorrent/libtorrent
runtime and advertises buzzard-search and buzzard-minijtt as optional suggestions.
It also carries the Tor dependency inventory and exact upstream license and
copyright bytes. Tor's exact source archive remains outside the installed
browser payload and is hash-bound into its provenance.
`release-manifest.json` records every repository commit, package identity,
artifact size, and SHA-256 digest. `SHA256SUMS` is verified before upload.

The application version follows the Firefox ESR major and minor numbers, with
an optional final number for WildBuzzard-only releases. Version consistency is
checked before compilation and when the release manifest is produced. See
[`../UPDATING-FIREFOX.md`](../UPDATING-FIREFOX.md) for checking upstream releases,
preparing an ESR merge, and incrementing the WildBuzzard release number.

All participating repositories must be readable with the workflow's standard
read-only `GITHUB_TOKEN`; the workflow does not require signing keys, package
registry credentials, or other repository secrets. Signing and publishing to
an APT repository are intentionally separate release-authority steps.

The `WildBuzzard Ubuntu 24.04 artifact` workflow is the GitHub-hosted build path.
The first parallel wave builds pinned Tor, the native qBittorrent runtime,
corresponding-source bundles, and gkrust compiler-cache entries. The Firefox job
then consumes that shared compiler cache, and the final job assembles the
self-contained amd64 WildBuzzard Debian package and uploads it with component
manifests, checksums, and corresponding-source archives. It never checks out or builds the optional
`buzzard-search`, `buzzard-minijtt`, or independent extension repositories; the
two built-in extension snapshots come from the selected WildBuzzard commit.

The hosted workflow performs compilation, assembly, and artifact upload only.
It does not run product tests or post-assembly package, runtime, provenance, or
license validators. Those checks run locally against the exact downloaded DEB
before the unchanged package set is installed in Debian 13 and Ubuntu 24.04
validation VMs. The workflow does not sign, publish, create a GitHub release,
or push repository changes.
