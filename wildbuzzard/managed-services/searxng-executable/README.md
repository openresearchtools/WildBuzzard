# WildBuzzard SearXNG executable

The packaged artifact contains the exact pinned SearXNG application, its
host-built CPython runtime, native dependencies, locks, notices, and CycloneDX
SBOM in one AppImage/SquashFS executable. It opens no TCP listener. Granian
serves SearXNG only on a caller-selected Unix-domain socket inside a mode-0700
directory; the socket, generated settings, and connection record are mode 0600.

`start` verifies and atomically copies the embedded payload to a persistent
private install directory before starting a detached process from that copy.
The service therefore has no dependency on the AppImage mount or temporary
`APPIMAGE_EXTRACT_AND_RUN` directory after startup. In extract-and-run mode the
launcher verifies the AppImage digest, empties its own extraction directory,
and re-executes from the installed copy; the AppImage runtime then removes the
empty directory. This also avoids stale-extraction output on later launches.
`stop` verifies the recorded PID, process start time, executable, install root,
and owner before signalling it. Foreground `run` installs first and then
replaces the temporary interpreter with the verified installed interpreter.

The compiled catalog contains all 343 named upstream configurations. Exactly
332 names across 211 modules are credential-free and enter `keep_only`; the 11
credential-required names are never configured. Upstream `inactive` state and
runtime setup checks remain intact, so the number of loaded engines can be
lower and is reported by integration tests rather than claimed as 332.
