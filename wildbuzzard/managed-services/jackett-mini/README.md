<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Jackett Mini process helper

`process.mjs` is an independent WildBuzzard-side launcher helper. It verifies the immutable runtime manifest and executable digest, owns a mode-0700 runtime-state directory, writes mode-0600 capability and connection records, binds a random high loopback port, and reconnects only after process-start-time, executable, digest, data-root, owner-instance, and authenticated-health checks all agree.

The helper never discovers or kills a process by name. Stop signals are sent only to the PID whose Linux start time, canonical executable path, and digest still match the connection record. A bind or health failure retries the complete spawn. The capability is stored in a private file and is never passed on the command line.

The browser supervisor in `browser/components/torrent/JackettMiniRuntime.sys.mjs` enforces the same identity checks while verifying and atomically activating the bundled archive. The product client validates the response contract independently and never exposes the connection record or capability to content.
