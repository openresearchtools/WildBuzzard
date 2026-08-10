# SearXNG original-service comparison

`compare_searxng.py` builds a disposable pristine service from the complete
pinned SearXNG snapshot. Its dependency base is the recorded upstream image's
exact Linux amd64 manifest because that image contains the byte-identical
upstream requirement set. The harness replaces the image's older application
tree with the unmodified selected source and records both image revisions.

The deterministic suite uses upstream's `demo_offline` engine. It starts the
pristine container and the bundled native managed service concurrently, sends
the same ordered GET and POST requests to both original APIs, and writes raw
transcripts and canonical diffs below a required external artifact directory.
No system service, fixed port, container volume, provider credential, or
shipping configuration is reused.

Run from the checkout with an extracted runtime produced by
`build-searxng-runtime.sh`:

```sh
python3 wildbuzzard/tests/original-services/searxng/compare_searxng.py \
  --runtime-root /absolute/path/to/extracted-runtime \
  --artifacts /absolute/path/to/artifacts/searxng-comparison
```

The harness requires rootless Podman 5 or later. Its final `summary.json`
records source and OCI identities, redacted configuration hashes, random
ports, commands, scenario results, process exits, and cleanup evidence.
