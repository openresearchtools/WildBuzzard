<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Pristine Jackett comparison

This suite builds unmodified Jackett v0.24.2360 from the vendored source archive and runs it beside Jackett Mini in rootless Podman. Both executables remain unchanged. The comparison runner overlays an equivalent local Cardigann fixture on pristine Jackett and on the already eligible `showrss` entry in a test-only Mini catalog. Those overlays are stored with the run evidence and are never shipped.

Build pristine Jackett:

```sh
wildbuzzard/tests/original-services/jackett/build-pristine-jackett.sh \
  --output /absolute/artifact/path/pristine-runtime \
  --object-dir /absolute/artifact/path/pristine-object \
  --log-dir /absolute/artifact/path/pristine-build-logs
```

Run the side-by-side comparison after building Jackett Mini:

```sh
python3 wildbuzzard/tests/original-services/jackett/run-comparison.py \
  --pristine-runtime /absolute/artifact/path/pristine-runtime \
  --mini-runtime /absolute/artifact/path/jackett-mini-runtime \
  --mini-manifest /absolute/artifact/path/jackett-mini-runtime/jackett-mini-runtime.json \
  --artifact-root /absolute/artifact/path
```

The preferred deterministic run uses a fresh rootless user and network
namespace. The fixture receives a non-reserved test address inside that private
namespace so Jackett Mini's production loopback/private-address rejection stays
enabled:

```sh
wildbuzzard/tests/original-services/jackett/run-comparison-rootless.sh \
  --pristine-runtime /absolute/artifact/path/pristine-runtime \
  --mini-runtime /absolute/artifact/path/jackett-mini-runtime \
  --mini-manifest /absolute/artifact/path/jackett-mini-runtime/jackett-mini-runtime.json \
  --artifact-root /absolute/artifact/path
```

`--oci-runtime PATH` selects a rootless OCI runtime implementation when the host default cannot create a container. The runner records the runtime and image inspection, random ports, executable digests, redacted configuration hash, exact request mapping, redacted raw request/response transcripts, canonical semantic diff, listener evidence, service logs, exit status, and cleanup evidence. The only redactions are the original API key and Mini capability.

If the invoking user's kernel key quota is already exhausted, use the bundled
`crun-no-new-keyring.sh` wrapper as `PATH`. It adds crun's
`--no-new-keyring` option only to container creation, preserving the caller's
existing keys instead of deleting them or changing the system-wide quota:

```sh
export JACKETT_MINI_OCI_RUNTIME="$PWD/wildbuzzard/tests/original-services/jackett/crun-no-new-keyring.sh"
export JACKETT_COMPARISON_OCI_RUNTIME="$JACKETT_MINI_OCI_RUNTIME"
```

Audit the pinned catalog against the complete extracted source and built
runtime:

```sh
python3 wildbuzzard/tests/original-services/jackett/audit-catalog.py \
  --catalog wildbuzzard/third_party/gpl2/jackett/provider-policy/catalog.json \
  --source /absolute/artifact/path/pristine-object/Jackett-0cd8622b735922a909a128d8d6943bb8565a640f \
  --runtime /absolute/artifact/path/jackett-mini-runtime \
  --output /absolute/artifact/path/catalog-audit.json
```

The quarantined live run queries every immutable eligible source with the
fixed non-sensitive query `ubuntu`. It records all per-source outcomes but does
not make tracker availability a deterministic gate:

```sh
python3 wildbuzzard/tests/original-services/jackett/run-live-source-report.py \
  --mini-runtime /absolute/artifact/path/jackett-mini-runtime \
  --mini-manifest /absolute/artifact/path/jackett-mini-runtime/jackett-mini-runtime.json \
  --artifact-root /absolute/artifact/path \
  --oci-runtime "$JACKETT_MINI_OCI_RUNTIME"
```

The gating deterministic scenarios cover health, caps/source status, indexer enumeration, Unicode search, adult-category filtering, peer-to-leecher conversion, duplicate BTIH collapse, public and private torrent resolution, upstream `apikey`/`passkey` behavior, product capability authentication, excluded sources, and removed dashboard/configuration/update/raw-Torznab routes. Live public-provider drift is intentionally outside this deterministic suite.

## Pristine-only adversarial oracle

The adversarial lane starts only the pinned, unmodified pristine Jackett executable and deterministic local fixture servers. It never starts or contacts Jackett Mini, the browser runtime, or the torrent runtime. Jackett is disposable test infrastructure here, not a product dependency. `/v1` entries in `request-mapping.json` are declarative mappings for a later side-by-side port run, not network requests made by this lane.

Use an already-built pristine runtime and its matching extracted source tree. This command performs no build:

```sh
wildbuzzard/tests/original-services/jackett/run-pristine-adversarial-rootless.sh \
  --pristine-runtime /absolute/artifact/path/pristine-runtime \
  --pristine-source /absolute/artifact/path/Jackett-0cd8622b735922a909a128d8d6943bb8565a640f \
  --artifact-root /absolute/artifact/path
```

The pin-specific snapshot covers `apikey` and `passkey`, Torznab codes 100, 201, 203, and 900, HTTP 400/429 shapes and `Retry-After`, plus the source-level code-200 branch. At this pin, the public route requires `{indexerId}`, so omitting it returns HTTP 404 before the code-200 filter branch; the runner proves both the live route behavior and the exact pinned source contract. It also records the pinned unknown-indexer HTTP 500 behavior rather than silently normalizing it away.

The fault corpus includes malformed, deep, entity-bearing, and over-limit XML; a hanging provider and caller timeout; invalid TLS; a redirect and redirect loop; partial aggregate success; stale completion order; cache hit, bypass, and expiry; absent and contradictory peer-count handling; duplicate infohashes across providers; malicious text, category, and acquisition URL fields; all categories 6000, 6010 through 6090 including 6045; mixed and missing categories; an adult-provider result labelled only as 8000; and per-indexer custom categories above 100000.

Each run retains redacted raw API transcripts, fixture request and response hashes, the original-to-port request map, full canonical observed and expected JSON, an empty canonical diff on success, process identity, loopback listener evidence, service logs, exit status, closed-port/data-root cleanup proof, and a zero-leak scan. API keys, passkeys, cookies, capabilities, raw acquisition paths, and synthetic secret sentinels are never retained in the evidence.

Run the bounded XML canonicalizer tests with:

```sh
python3 -m unittest discover -s wildbuzzard/tests/original-services/jackett -p 'test_*.py'
```
