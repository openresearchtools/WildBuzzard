# Firecrawl renderer comparison

`compare_firecrawl.py` builds the unmodified Firecrawl `v2.11.193` API and
Playwright service from commit
`448ef4bf815d8df798d1a676f0303285e54cabdb`. It calls Firecrawl's actual
`POST /v2/scrape` endpoint, not an engine helper or browser mock.

The reference API, Playwright renderer, Redis, and deterministic fixture run
as disposable rootless Podman containers on a fresh per-run network. Only
random loopback host ports are published. The harness records the annotated
tag object, source tree, Dockerfile and lockfile hashes, pulled base-image
digests, built-image identities, commands, redacted HTTP transcripts, service
logs, process and page cleanup checks, timings, mappings, normalized results,
and teardown evidence in a required directory outside the checkout.
The private fixture uses the reserved `fixture.test` and
`other-fixture.test` network aliases so Firecrawl's production URL validator
accepts deterministic targets without exposing the oracle network.
The harness gives Podman a per-run graph root beneath its temporary work
directory and a private per-run run root beneath the user's runtime directory,
so literal upstream base tags cannot overwrite the user's image store and all
pulled layers disappear with the recorded cleanup. Rootless networking requires
the run root to reside on the user runtime filesystem.
The isolated engine configuration uses a hashed, mode-0700 wrapper beneath the
ephemeral work directory to pass crun's `--no-new-keyring` flag after its
`create` or `run` subcommand. This retains the harness session keyring and avoids
kernel key allocation when unrelated browser processes have exhausted the
per-user quota. The harness records the key quota before and after and rejects
any increase.
Container, network, image, isolated-store, work-directory, and published-port
cleanup are mandatory gates; a parity-success result cannot mask leftovers.

The Node, Go, and Redis bases are fixed to `linux/amd64` OCI index, platform
manifest, and image-config digests. Before building, the harness inspects each
immutable index, verifies its platform descriptor, pulls only the immutable
platform reference, verifies the local config and platform identity, and tags
that content for the pristine Dockerfiles' literal `FROM` names. Those names
are checked again after both `--pull=never` builds. The upstream Dockerfiles
are never rewritten.
The pinned upstream Compose contract sets the Playwright service to port 3000;
the pristine Dockerfile requires that value as its `PORT` build argument for
its `EXPOSE` instruction. The harness verifies both upstream files and supplies
the same pinned value without modifying either file.
The harness also verifies that the pinned package's `start` script is exactly
`node dist/api.js` and invokes that built target directly. This avoids Corepack
attempting a network-backed cache bootstrap as the non-root runtime user while
preserving the upstream program and read-only oracle sandbox.

Run the Firecrawl half while a fresh WildBuzzard build is unavailable:

```sh
python3 wildbuzzard/tests/original-services/firecrawl/compare_firecrawl.py \
  --artifacts /absolute/external/path/firecrawl-reference
```

A successful reference-only run exits 2 and records
`reference-passed-gecko-gated`. This is intentionally not a parity pass.

For the release side-by-side gate, start a fresh externally built WildBuzzard
under `MOZ_AUTOMATION=1` with an ephemeral profile, wait for its mode-0600
`browser-control.json`, and pass it to the same command:

```sh
python3 wildbuzzard/tests/original-services/firecrawl/compare_firecrawl.py \
  --gecko-connection /absolute/path/to/browser-control.json \
  --artifacts /absolute/external/path/firecrawl-gecko-comparison
```

The automation-only browser-control arguments accept only canonical HTTP
loopback origins with explicit ports. They are serialized, restored after
success, error, timeout, and cancellation, and are rejected outside Firefox
automation. Cleanup evidence contains only counts and failure flags.

The corpus covers static and JavaScript-mutated HTML, delayed content,
redirects, status and content-type variants, encoding, CSP, iframe behavior,
headers, isolated browser state, oversized bodies and DOMs, compressed output,
timeout, cancellation, and concurrency. HTML comparison requires exact status,
content type, and logical final URL, matching title, ordered headings and link
targets, and at least 95 percent multiset visible-text token recall.
The full gate also requires bounded Gecko failures for the stress corpus and
cancels a live Gecko fixture request through the browser-control protocol
before checking cleanup diagnostics and lock reuse.
Both Firecrawl and Gecko cancellation probes use a five-second fixture but
pass only when renderer and fixture activity clear in less than the fixed
three-second prompt bound. Eventual cleanup is recorded separately and cannot
turn a missed prompt bound into a pass.

The cross-origin redirect case records Firecrawl's actual custom-header
behavior while requiring WildBuzzard to strip the caller-supplied header at
the origin boundary. That intentional security difference is explicit in the
normalized evidence instead of being treated as raw-output equivalence.
The corpus also records two exact upstream limitations as intentional
differences: Firecrawl returns `SCRAPE_ALL_ENGINES_FAILED` for a 204 target, and
disconnecting its API client does not cancel the active Playwright request.
The reference gate requires those exact observed contracts and eventual clean
renderer state; the Gecko side still requires a preserved 204 response and
prompt caller-abort propagation within the three-second bound.

Chromium, Playwright, Redis, Podman, and Firecrawl remain test infrastructure;
the harness does not add them to any browser, agent, packaging, or runtime
path.
