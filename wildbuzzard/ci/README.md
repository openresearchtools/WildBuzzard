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
- pinned Arti runtime, provenance, and corresponding-source artifacts, plus
  Jackett Mini and qBittorrent runtime/provenance artifacts
- component build manifests, `release-manifest.json`, and `SHA256SUMS`

The browser archive, Debian package, and AppImage are rejected unless they
carry the repository licenses, CLI upstream notice and MIT license, and the
corresponding-source pointer. The browser Debian package is also rejected
unless it declares all three CLI packages as dependencies.
`release-manifest.json` records every repository commit, package identity,
artifact size, and SHA-256 digest. `SHA256SUMS` is verified before upload.

All participating repositories must be readable with the workflow's standard
read-only `GITHUB_TOKEN`; the workflow does not require signing keys, package
registry credentials, or other repository secrets. Signing and publishing to
an APT repository are intentionally separate release-authority steps.
