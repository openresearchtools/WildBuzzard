# SearXNG original-service comparison

`compare_searxng.py` builds a disposable pristine service from the complete
pinned SearXNG snapshot. Its dependency base is the recorded upstream image's
exact Linux amd64 manifest because that image contains the byte-identical
upstream requirement set. The harness replaces the image's older application
tree with the unmodified selected source and records both image revisions.

The deterministic suite uses upstream's `demo_offline` engine with no optional
plugins. It starts the pristine application and bundled native managed service
in separate rootless containers with `--network none`, fixed UTC/hash/locale
inputs, and loopback-only clients executed inside each network namespace. It
sends the same ordered GET and POST requests to both original APIs, compares
raw responses in memory, and writes redacted transcripts and canonical diffs
below a required external artifact directory. No system service, host port,
provider credential, or shipping configuration is reused.

Run from the checkout with an extracted runtime produced by
`build-searxng-runtime.sh`:

```sh
python3 wildbuzzard/tests/original-services/searxng/compare_searxng.py \
  --runtime-root /absolute/path/to/extracted-runtime \
  --artifacts /absolute/path/to/artifacts/searxng-comparison
```

The harness requires rootless Podman 5 or later and `/usr/bin/crun`. To remain
usable when the caller's kernel key quota is already full, it invokes crun with
`--no-new-keyring` and applies a derived copy of the checksum-pinned system
seccomp profile that denies `add_key`, `keyctl`, and `request_key` inside the
container. It does not delete or alter the caller's keys. The exact crun
version, wrapper, source profile, effective profile, and hashes are preserved
in the artifacts. Success requires both namespaces to expose only `lo`, contain
no default route, and reject a numeric external connection probe. Startup logs
must contain no tracker-rule updater attempt.

The final `summary.json` records source and OCI identities, redacted
configuration hashes, container-loopback ports, commands, scenario results,
process exits, cleanup evidence, and the effective rootless-runtime security
controls. The cancellation scenario must be followed by authenticated health,
an unchanged process set, no extra native thread or file descriptor, and no
traceback or broken-pipe output before teardown. The harness then requires the
container, image, and Podman storage inventories to match their pre-run state.
Every retained file is rewritten and scanned after cleanup; bearer
capabilities, authentication and cookie headers, configuration secrets,
non-fixture queries, and checkout, runtime, artifact, data, and home paths are
redacted before the summary can report success.
