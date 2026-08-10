<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Pristine Jackett comparison

This suite verifies and extracts the official unmodified Jackett v0.24.2360 Linux release for use as a pristine parity oracle. Shipping Jackett Mini is built directly on the host; no shipping build or runtime depends on a container. The adversarial lane also runs Mini directly on the host. The comparison runner overlays an equivalent local Cardigann fixture on pristine Jackett and on the already eligible `showrss` entry in a test-only Mini catalog. Those overlays are stored with the run evidence and are never shipped.

Prepare pristine Jackett from the pinned official release archive:

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
`crun-no-new-keyring.sh` as the pristine oracle's OCI runtime. It adds crun's
`--no-new-keyring` option only to container creation, preserving the caller's
existing keys instead of deleting them or changing the system-wide quota:

```sh
export JACKETT_ORACLE_OCI_RUNTIME="$PWD/wildbuzzard/tests/original-services/jackett/crun-no-new-keyring.sh"
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

## Adversarial side-by-side comparison

The adversarial lane runs its Python comparator, deterministic fixture server, separately built catalog-bound Mini fixtures, and production Mini process directly on the host. Only the pinned official pristine Jackett release runs in a named disposable rootless OCI container. It never rewrites the shipping runtime. A second fixture process exercises simultaneous Firefox-profile isolation, while a production Mini process proves the exact active source set and rejects every excluded catalog ID. Jackett remains disposable test infrastructure, not a product dependency. Every `/v1` entry in `request-mapping.json` records a request executed during the run.

Create and build the deterministic fixture package after the production runtime:

```sh
python3 wildbuzzard/tests/original-services/jackett/prepare-mini-fixture-package.py \
  --shipping-catalog wildbuzzard/third_party/gpl2/jackett/provider-policy/catalog.json \
  --template wildbuzzard/tests/original-services/jackett/fixtures/adversarial-indexer.yml.in \
  --output /absolute/artifact/path/mini-fixture-package
wildbuzzard/scripts/build-jackett-mini.sh \
  --output /absolute/artifact/path/jackett-mini-fixture-runtime \
  --test-fixture-package /absolute/artifact/path/mini-fixture-package \
  --production-manifest /absolute/artifact/path/jackett-mini-runtime/jackett-mini-runtime.json
```

Use already-built pristine and Mini runtimes plus the matching extracted pristine source tree. This command performs no build:

```sh
wildbuzzard/tests/original-services/jackett/run-pristine-adversarial-rootless.sh \
  --oracle-image mcr.microsoft.com/dotnet/sdk@sha256:6e6542a43b6bf3c5ecfa80dd33c79c9fd09d58f95f4ebacd14fa056275b25164 \
  --pristine-runtime /absolute/artifact/path/pristine-runtime \
  --pristine-build-record /absolute/artifact/path/pristine-build-logs/pristine-runtime-build-record.json \
  --pristine-source /absolute/artifact/path/Jackett-0cd8622b735922a909a128d8d6943bb8565a640f \
  --mini-runtime /absolute/artifact/path/jackett-mini-runtime \
  --mini-manifest /absolute/artifact/path/jackett-mini-runtime/jackett-mini-runtime.json \
  --mini-fixture-runtime /absolute/artifact/path/jackett-mini-fixture-runtime \
  --mini-fixture-manifest /absolute/artifact/path/jackett-mini-fixture-runtime/jackett-mini-runtime.json \
  --artifact-root /absolute/artifact/path
```

The host comparator controls the pristine container through rootless Podman with host networking, a read-only root filesystem, read-only official runtime/source and fixture-overlay mounts, and one writable disposable data mount. The fixed `127.0.0.1:18080` fixture endpoint is compiled only into the test Mini runtime; the shipping runtime retains its loopback/private-address rejection. The runner records host PID, executable hash, and namespace evidence for every Mini process, records the pristine container/image/process identity, and fails if the named container, a listener, or a disposable data root survives cleanup. The runtime-backed manager test in `managed-services/jackett-mini/test/process.test.mjs` launches through the real manager, exits that launcher, reconnects from a fresh launcher, and requires the same PID, Linux process start time, instance ID, data-root ID, and executable digest.

The pin-specific snapshot covers `apikey` and `passkey`, Torznab codes 100, 201, 203, and 900, HTTP 400/429 shapes and `Retry-After`, plus the source-level code-200 branch. At this pin, the public route requires `{indexerId}`, so omitting it returns HTTP 404 before the code-200 filter branch; the runner proves both the live route behavior and the exact pinned source contract. It also records the pinned unknown-indexer HTTP 500 behavior rather than silently normalizing it away.

The fault corpus includes malformed, deep, entity-bearing, and over-limit XML; a hanging provider and caller timeout; invalid TLS; a redirect and redirect loop; partial aggregate success; stale completion order; cache hit, bypass, and expiry; absent and contradictory peer-count handling; duplicate infohashes across providers; malicious text, category, and acquisition URL fields; all categories 6000, 6010 through 6090 including 6045; mixed and missing categories; an adult-provider result labelled only as 8000; and per-indexer custom categories above 100000.

Each run retains paired redacted raw API transcripts, fixture request and response hashes, exact Torznab-to-`/v1` request mappings, canonical pristine and Mini observations, normalized semantic/error diffs, the empty pinned-pristine snapshot diff, two-profile capability/result/data isolation, source-backed opaque-ID expiry, removed-route statuses, process identity, loopback listener evidence, service logs, exit status, kernel-key/no-orphan/closed-port/data-root cleanup proof, and separate secret/path leak scans. API keys, passkeys, cookies, capabilities, raw acquisition paths, input paths, and synthetic secret sentinels are never retained in the evidence.

Run the bounded XML canonicalizer tests with:

```sh
python3 -m unittest discover -s wildbuzzard/tests/original-services/jackett -p 'test_*.py'
```
