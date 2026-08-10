# SearXNG original-service comparison

`compare_searxng.py` runs the exact recorded upstream image's Linux amd64
manifest as the disposable pristine service. It never builds a container
image. The selected unmodified source snapshot is mounted read-only over the
image's application directory so the reference API and the host-native port
exercise the same source pin; both identities are recorded.

The deterministic suite uses upstream's `demo_offline` engine with no optional
plugins. It starts only the pristine application in a rootless container with
`--network none`. The bundled native managed service runs directly from the
shipping runtime as a host process with a sanitized UTC/hash/locale environment
and an ephemeral loopback listener. Both HTTP clients are direct host processes
running with the pinned native runtime's Python: one reaches the pristine
service through a private Unix socket, and the other reaches the native service
through loopback. They send the same ordered GET and POST requests to both
original APIs, compare raw responses in memory, and write redacted transcripts
and canonical diffs below a required external artifact directory. No system
service, provider credential, or shipping configuration is reused, and the
native execution path and both comparison clients have no OCI dependency.

Run from the checkout with an extracted runtime produced by
`build-searxng-runtime.sh`:

```sh
python3 wildbuzzard/tests/original-services/searxng/compare_searxng.py \
  --runtime-root /absolute/path/to/extracted-runtime \
  --artifacts /absolute/path/to/artifacts/searxng-comparison
```

The harness requires rootless Podman 5 or later and `/usr/bin/crun` only to run
the pristine upstream reference. To remain
usable when the caller's kernel key quota is already full, it invokes crun with
`--no-new-keyring` and applies a derived copy of the checksum-pinned system
seccomp profile that denies `add_key`, `keyctl`, and `request_key` inside the
container. It does not delete or alter the caller's keys. The exact crun
version, wrapper, source profile, effective profile, and hashes are preserved
in the artifacts. The host harness verifies from `/proc` that the pristine
service has a separate network namespace exposing only `lo` and no IPv4 or IPv6
default route. It never executes the comparison client inside that namespace.
Startup logs from both processes must contain no tracker-rule updater attempt.

The final `summary.json` records source and official pristine OCI identities,
native host
execution, redacted configuration hashes, loopback ports, commands, scenario
results, process exits, cleanup evidence, and the effective rootless-runtime
security controls. The cancellation scenario must be followed by authenticated
health, an unchanged native process tree, no extra native thread or file
descriptor, and no traceback or broken-pipe output before teardown. The harness
then requires the pristine container, image, and Podman storage inventories to
match their pre-run state.
Every retained file is rewritten and scanned after cleanup; bearer
capabilities, authentication and cookie headers, configuration secrets,
non-fixture queries, and checkout, runtime, artifact, data, and home paths are
redacted before the summary can report success.
