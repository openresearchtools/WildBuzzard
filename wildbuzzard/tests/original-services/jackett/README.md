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

Run the bounded XML canonicalizer tests with:

```sh
python3 -m unittest discover -s wildbuzzard/tests/original-services/jackett -p 'test_*.py'
```
