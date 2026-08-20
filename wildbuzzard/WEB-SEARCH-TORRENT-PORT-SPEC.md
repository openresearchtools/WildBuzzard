<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Native web search, Gecko extraction, and torrent discovery port specification

## Status

This document is the implementation source of truth for the WildBuzzard web
search, web extraction, crawl, and torrent-discovery port. It recovers the
completed upstream and repository audits performed on 2026-08-10 and replaces
chat transcripts as the durable engineering specification.

The compact Codex goal that invokes this specification is in
[`WEB-SEARCH-TORRENT-GOAL.md`](WEB-SEARCH-TORRENT-GOAL.md).

The implementation is not complete until every mandatory acceptance gate in
this document passes in the externally built WildBuzzard browser and AppImage.

### Superseding self-contained-search architecture correction

The shipping SearXNG implementation is a self-contained compressed executable
built directly from the exact pinned Python application and dependency lock.
It preserves the original eligible engine implementations and contains its own
CPython runtime and native libraries, so the installed product requires no
system Python, pip, virtual environment, container, or first-run dependency
resolution. The abandoned partial Rust engine rewrite is not a shipping
component. Any later wording in this recovered document that requires a linked
Rust rewrite is obsolete.

The executable is built host-native outside the Firefox checkout, is packaged
as an immutable digest-verified runtime, and listens only on an owned mode-0600
Unix-domain socket under a mode-0700 runtime directory. It exposes no TCP
listener. The browser owns lifecycle and authenticated access; Pi calls the
browser's privileged search operation and never receives the socket path or
service capability. Every configured engine that requires no credential must
be enabled and covered by parity evidence against the pinned pristine SearXNG
oracle. The AppImage contains the executable runtime, notices, manifest, and
SBOM; complete corresponding source is published as a separate release asset
so it does not inflate the executable AppImage.

The latest torrent-content policy is provider-only exclusion. Adult/vulgar-only
providers remain permanently excluded. Every eligible credential-free public
general or mixed/general provider is included, and its returned results and
categories pass through unchanged apart from ordinary malformed or oversized
data rejection. Later recovered wording that filters individual results by
category or keyword is obsolete.

## Product outcome

WildBuzzard will provide:

- SearXNG as a source-built, locally managed default search backend;
- DuckDuckGo as the only other advertised product search engine;
- a port of the useful, deterministic parts of `pi-web-access`, without
  proprietary search, extraction, model, or hosted-provider integrations;
- native Gecko page rendering, extraction, and bounded crawling for agents;
- local GitHub repository reading and YouTube caption extraction;
- a constrained GPL-2.0-only "Jackett Mini" discovery service containing an
  immutable catalog of every public tracker that needs no login, cookie,
  passkey, API key, or other credential, except adult-only trackers;
- native torrent search, sorting, metadata inspection, file selection, and
  download handoff;
- the same capabilities through concise Pi tools and skills; and
- a self-contained Linux AppImage whose managed services require no system
  Node.js, Python, .NET, yt-dlp, Playwright, Jackett, or torrent client.

## Non-goals

The first implementation does not provide:

- hosted OpenAI, Exa, Brave API, Gemini, Perplexity, Tavily, Jina, Kagi, xAI,
  Bright Data, SerpBase, or similar provider integrations;
- hidden provider-specific model or curator calls;
- Chromium, Chrome DevTools Protocol, or a bundled Playwright browser;
- raw Playwright API compatibility or Chromium fingerprint parity;
- Firecrawl's complete API, worker, queue, database, billing, telemetry, or
  hosted feature stack;
- private, semi-private, login-based, cookie-based, passkey-based, API-keyed,
  or otherwise credentialed torrent trackers;
- a user- or agent-editable Jackett provider/configuration API or Jackett
  administration dashboard;
- a guarantee that a tracker cannot misclassify adult content; or
- transparent exposure of local sidecars through LAN or Tailscale interfaces.

## Existing WildBuzzard integration points

The port extends existing code rather than creating a second browser-control
or torrent stack:

| Concern | Existing integration |
| --- | --- |
| Native browser CLI | `wildbuzzard/components/wildbuzzard-cli/` |
| Browser-control parent | `remote/wildbuzzard/BrowserControl.sys.mjs` |
| Browser-control actors | `remote/wildbuzzard/BrowserControlChild.sys.mjs`, `BrowserControlParent.sys.mjs` |
| Pi Web supervisor | `wildbuzzard/browser/extensions/agent-sidebar/experiment-apis/wildbuzzardAgent.js` |
| Agent packages | `wildbuzzard/components/buzzard-agent/`, `wildbuzzard/components/buzzard-agent-web/` |
| Torrent parent manager | `wildbuzzard/browser/components/torrent/TorrentManager.sys.mjs` |
| Torrent service | `wildbuzzard/torrent-runtime/service.mjs` |
| Torrent UI | `wildbuzzard/browser/components/torrent/content/torrents.xhtml`, `torrents.js`, `torrents.css` |
| Tor routing | `wildbuzzard/browser/components/tor/TorRouting.sys.mjs` |
| Product search data | `services/settings/dumps/main/search-config-v2.json` |
| Search settings | `wildbuzzard/browser/components/settings/wildbuzzardSearch.mjs` |
| Runtime packaging | `wildbuzzard/moz.build` and `wildbuzzard/scripts/package-appimage.sh` |
| Upstream pins | `wildbuzzard/upstreams.toml` |

The `wildbuzzard` CLI ships its browser workflow skill through its
`resources_discover` result. The web-search and torrent-discovery skills must
use that mechanism rather than being injected into every system prompt.

## Audited upstream baseline

All revisions are candidate pins observed on 2026-08-10. The implementation
must verify the full revision, release metadata, source digest, dependency lock,
and license before import. No build or runtime path may resolve `main`, `master`,
or `latest`.

| Component | Audited revision | License and treatment |
| --- | --- | --- |
| `pi-web-access` | `692483ae782e41978fb2eba0eec70fd4056608c8`, package 0.19.0 | MIT, copyright notice retained |
| `pi-web-access` 0.19.0 release baseline | `73d7205b6ff5c1201de7fde27302e0124915ce50` | Alternative base only if every later selected fix is recorded |
| SearXNG source | `b023a28bab8839dba9eac96e9a51cc91bbd0a267` | AGPL-3.0-or-later |
| SearXNG published 2026.8.4 image reference | commit `c63835bd2a5133b30b3752a20eac6b443a918f41`, digest `sha256:f4c8e59de166ed71f6380c0847c312ca51f0d41996e31d0559163b6b09ecde52` | Pristine test reference only; shipping runtime is source-built |
| Firecrawl | tag `v2.11.193`, `448ef4bf815d8df798d1a676f0303285e54cabdb` | Treat server and renderer material as AGPL-3.0-or-later unless a file-level audit proves otherwise |
| Jackett release | `v0.24.2360`, `0cd8622b735922a909a128d8d6943bb8565a640f` | GPL-2.0-only, separate process and source package |
| Jackett audited master | `be1f04dc66c0c2e934059f84ecb8e0c1729d7d19` | Research reference, not the shipping pin |
| yt-dlp | release `2026.07.04`, `fdec00e0bf530dc6c3cc7b1dd780e95d9ae460e9` | Unlicense |
| Playwright baseline | Firecrawl's pinned `^1.58.1` | Pristine test reference only, never shipped |

The observed Jackett Linux x86-64 release asset was
`Jackett.Binaries.LinuxAMDx64.tar.gz`, 50,877,536 bytes, SHA-256
`f3cd7eafa5a478f8c21208d0ab65980e9c935c2861767d1c448a38126305f116`.
The shipping build must be reproducibly built from the matching source rather
than importing that binary, but the digest is retained as an upstream parity
reference. The corresponding musl asset digest was
`fb70cd4b12acbd416bc1024a7c4335081359d173da612350ec29f023447ae25f`.

### `pi-web-access` dependency inventory

The audited direct runtime dependencies were:

| Dependency | Version | License |
| --- | --- | --- |
| `@mozilla/readability` | 0.6.0 | Apache-2.0 |
| `linkedom` | 0.16.11 | ISC |
| `p-limit` | 6.2.0 | MIT |
| `promise.try` | 2.0.1 | MIT |
| `turndown` | 7.2.4 | MIT |
| `typebox` | 1.3.11 | MIT |
| `unpdf` | 1.8.0 | MIT |

Its observed production transitive license set was MIT, ISC, BSD-2-Clause,
and Apache-2.0. The final lockfile and SBOM, not this summary, govern the
shipping inventory.

### Firecrawl licensing and dependency finding

Firecrawl's root project describes the principal server as AGPL. Some package
manifests under `apps/api` and `apps/playwright-service-ts` declare ISC without
carrying an adjacent ISC license text. Until upstream clarifies that mismatch,
WildBuzzard must not assume those directories are permissively licensed.

The default self-hosted stack includes the API and workers, Playwright, Redis,
RabbitMQ, NuQ PostgreSQL, and optional FoundationDB. Its API package also pulls
in hosted model, billing, telemetry, queue, and database dependencies that are
irrelevant to the browser product. The default product therefore uses
Firecrawl as a pinned behavior and fixture reference. A selected algorithm may be
ported only after a per-file license audit and must retain exact path, revision,
license, copyright, and modification records.

## License and source boundaries

### WildBuzzard, SearXNG, and Firecrawl-derived work

New WildBuzzard integration, browser, agent, and UI files are
AGPL-3.0-or-later. SearXNG remains an independently supervised AGPL service
with its exact corresponding source. Any clearly licensed Firecrawl material
that is actually copied must retain its notices and source mapping.

### Jackett

Jackett's root license is GNU GPL version 2 without an observed "or later"
grant. It must be treated conservatively as GPL-2.0-only. GPL-2.0-only code
must not be combined into WildBuzzard's AGPL browser process.

The required boundary is:

```text
WildBuzzard browser process
  independent AGPL managers, JSON client/DTOs, UI, and agent tools
                         |
              authenticated local protocol
                         |
GPL-2.0-only package and process boundary
  Jackett Mini fork/bridge, pinned tracker engine, private service state
                         |
                    tracker network
```

Boundary rules:

- keep separate source roots, build projects, executables, dependency graphs,
  notices, SBOM entries, and source archives;
- never reference a `Jackett.*` assembly from WildBuzzard;
- never copy Jackett C# types, serializers, JavaScript, CSS, HTML, assets, or
  dashboard code into browser code;
- never host the CLR, statically link, dynamically link, or share an address
  space with Jackett;
- remove or make unreachable the Jackett dashboard and every provider/config
  mutation surface in the Jackett Mini runtime;
- specify independent, versioned browser DTOs instead of adopting Jackett
  configuration objects;
- keep the Jackett Mini fork and any bridge that imports or derives from
  Jackett inside the GPL package;
- add a CI boundary scan for Jackett namespaces, linked assemblies, copied
  snippets, and forbidden package paths; and
- distribute exact complete corresponding source, downstream patches, build
  scripts, dependency locks, license text, and third-party notices.

Packaging independent GPL-2.0-only and AGPL programs in one AppImage is
intended to be aggregate distribution, but that conclusion requires legal
review before a public release. This requirement is not legal advice.

### Torznab clarification

Torznab is a publicly documented HTTP/RSS/XML interoperability protocol, not
a program that WildBuzzard needs to bundle. Its public specification
repository has no declared license. WildBuzzard must copy no specification
source or prose. It will independently implement the observable wire contract
and license that client implementation under AGPL-3.0-or-later.

## Process architecture

```text
WildBuzzard persistent service supervisor
├── SearXNG runtime                         eager/default-search service
├── yt-dlp caption helper                   on demand
├── Jackett Mini runtime                    lazy/torrent-search service
└── isolated headless WildBuzzard workers   on-demand Gecko rendering

WildBuzzard browser parent
├── WebSearchManager
├── Gecko render RPC
├── independent Jackett Mini JSON client
├── TorrentManager
└── BrowserControl RPC
          ↕
Bundled Pi extensions and on-demand skills
```

The existing Pi Web supervisor is the preferred persistent owner because Pi
Web remains available after a browser window closes. A Pi session must never
own a service process. If service ownership is factored into a dedicated
WildBuzzard supervisor, the same identity, persistence, and authentication
contract applies.

SearXNG starts eagerly because it is the default browser engine. Jackett Mini
starts only when torrent search or read-only source status is used. Gecko
render workers start on demand, have bounded concurrency, and exit after an
idle timeout.

### Runtime extraction and AppImage lifetime

A detached process cannot depend on files from an AppImage mount that vanishes
when the main AppImage process exits. Every persistent sidecar runtime must be
extracted before execution into an immutable, versioned WildBuzzard XDG data
cache. Runtime data and executable trees must remain separate.

The manifest for each runtime records:

- component name and semantic version;
- full upstream commit and source digest;
- platform and architecture;
- dependency-lock digest;
- archive and per-file digests;
- browser integration protocol version;
- provider-policy digest where applicable; and
- license and corresponding-source location.

Extraction must reject absolute paths, traversal, symlinks, hardlinks,
duplicate paths, unexpected executables, and digest mismatches. An upgrade is
staged into a new immutable directory and activated atomically after health
checks. Persistent user data is never stored inside the runtime directory.

### Process ownership record

Every managed service uses a per-user launch lock and a mode-0600 connection
record under `XDG_RUNTIME_DIR`. The record includes:

- protocol and runtime versions;
- a private socket path for SearXNG or an owned loopback address for Jackett
  Mini;
- bearer/capability token where applicable;
- PID and Linux process start time;
- expected executable canonical path and digest;
- data-root identity;
- owner instance ID; and
- creation and last-health timestamps.

Reconnection requires successful health and identity verification. PID
existence is never sufficient. A stale PID, a reused PID, or an occupied port
must not cause WildBuzzard to attach to or terminate another process. No code
may discover or kill a service by process name.

Jackett Mini port allocation uses a high loopback port selected under the
launch lock and retries the complete spawn on bind failure. SearXNG exposes no
shipping TCP listener: its backend and authenticated browser/agent gateway use
mode-0600 Unix sockets inside a mode-0700 per-profile runtime directory. A
port-zero patch may be carried inside the applicable third-party license
boundary only for a service that intentionally retains loopback TCP.

### Shutdown and restart policy

Persistent SearXNG and Jackett Mini processes survive normal browser-window close
and reconnect on reopen. The product exposes explicit status, Stop, Restart,
and repair actions. An upgrade or explicit stop first requests graceful
shutdown, then sends `SIGTERM` after a bounded deadline, and finally performs a
PID-and-identity-scoped `SIGKILL` only if necessary.

Gecko render workers do not persist indefinitely. Abort, timeout, parent crash,
or idle expiry must destroy their browsing contexts and processes. Pi Web may
launch a headless WildBuzzard worker through the original AppImage/AppDir when
the primary browser is closed; a worker-mode flag must prevent recursive
startup of Pi Web, SearXNG, Jackett Mini, or normal browser UI.

## SearXNG managed runtime

### Build

SearXNG and its exact locked Python dependencies are built from source in an
external build directory. The shipping AppImage contains the resulting
self-contained executable, runtime manifest, notices, and SBOM; complete
corresponding source is published as a separate release asset. The product does
not install Docker, pull an image, invoke the system Python, or resolve packages
on first run.

The audited requirements included Python 3.10 or later, Flask 3.1.3, Jinja2
3.1.6, lxml 6.1.1, httpx 0.28.1, Valkey client 6.1.1, msgspec 0.21.1, and
Granian 2.7.9. The implementation must use the upstream lock rather than
re-resolving those observed versions.

Single-user local mode does not use Redis or Valkey when the public limiter is
disabled.

### Configuration

The generated configuration must:

- bind the SearXNG backend only to its owned private Unix socket and expose no
  raw TCP listener;
- set `debug: false`;
- set `enable_metrics: false` and expose no metrics password or endpoint;
- set `public_instance: false` and `limiter: false`;
- use a random per-installation `secret_key`;
- disable autocomplete and external favicon resolution;
- disable image proxy unless an explicit product requirement and privacy test
  justify it;
- enable HTML for normal browser result pages and JSON for trusted tools;
- keep query text out of titles and logs;
- use safe search level 1 initially; and
- keep only an explicit reviewed, no-key engine allowlist.

No configured engine may require an API key. SearXNG is self-hosted, but it
forwards queries to its configured upstream engines. Product copy and privacy
documentation must state that fact. "No proprietary API dependency" means no
hosted search SDK, account, key, or paid API requirement; it does not mean all
queries remain on the local machine.

Agent search sends `POST /search` with form-encoded `q`, `format=json`, and a
supported `time_range` through the authenticated private gateway socket.
Normal browser HTML search uses the internal `moz-searxng://local/search`
route; only the browser parent owns the gateway token and Unix-socket access.
Domain constraints use both query-side `site:` hints and strict hostname
post-filtering because upstream engines do not implement syntax uniformly.

The current JSON response contains `query`, typed `results`, typed `answers`,
`corrections`, `infoboxes`, `suggestions`, and `unresponsive_engines`.
WildBuzzard must not retain the old `pi-web-access` assumption that `answers`
is `string[]`; known answer fields are sanitized for display and unknown typed
fields remain structured.

### Browser search integration

New profiles advertise exactly two product engines:

1. SearXNG, default in normal and private browsing.
2. DuckDuckGo, available as an explicit alternative.

Migrated profiles remove or hide obsolete application-provided engines but do
not delete user-installed custom engines. SearchService uses the stable exact
template `moz-searxng://local/search`; service restarts and socket replacement
must not mutate the engine template or expose a port, socket path, or token in
history.

If SearXNG is unavailable, show a local-service error, retry/repair actions,
and an explicit "Search DuckDuckGo" action. Never silently forward the query
to DuckDuckGo or another service.

## Pi `web-access` extension

Create a separate bundled extension at `agent/extensions/web-access/`. It may
reuse audited MIT `pi-web-access` code, but its provider/router layer is
rewritten around WildBuzzard's authenticated local services and current Pi
tool-registration API.

### Code retained and hardened

- activity and cancellation tracking;
- one-hour result lifetime;
- 30,000-character result paging and passage search;
- Readability, linkedom, and Turndown extraction;
- local `unpdf` extraction;
- React Server Component extraction;
- declared-web-link and parameter utilities;
- research-artifact and source-passage structures;
- GitHub URL parsing, tree/blob formatting, and clone/read behavior; and
- timestamp utilities needed by caption results.

### Code removed

Delete provider modules, credentials, routing, configuration, documentation,
tests, and dependencies for:

- OpenAI/Codex hosted web search;
- Exa and Exa MCP;
- Brave Search API;
- Parallel;
- TinyFish;
- Search1API;
- Searchinfinity;
- Querit;
- Tavily;
- Jina;
- SERPdive;
- Kagi;
- AnySearch;
- xAI/Grok;
- Bright Data;
- SerpBase;
- Perplexity;
- Gemini API and Gemini Web;
- DataLab; and
- other remote hosted fetch, search, video, or model fallbacks.

Ollama is local/open but is unnecessary for the deterministic search baseline
and is removed from the provider router. No tool may silently invoke an LLM.
Optional answer synthesis uses the caller's already-selected Pi model as an
explicit second stage grounded in returned sources.

### Tool contracts

#### `web_search`

Inputs:

- exactly one of `query: string` or `queries: string[]`;
- at most four batched queries;
- `numResults`, integer 1 through 20, default 5;
- `includeContent`, boolean;
- `recencyFilter: day | week | month | year`;
- `domainFilter`, supporting included domains and `-domain` exclusions;
- transitional `provider: auto | searxng`; and
- `workflow: none` in the initial deterministic implementation.

The result contains a `responseId`, provider, query, typed answer objects,
corrections, suggestions, unresponsive engines, and bounded result entries
with title, URL, snippet, engines, score, date, and optional content preview.
Concatenated snippets must never be labelled as an AI-synthesized answer.

#### `source_check`

Retain claim-oriented evidence gathering with no truth-verdict model call:

- at most eight queries;
- 1 through 20 results;
- at most five fetched pages; and
- `assessment: unassessed | evidence-found | insufficient-evidence`.

#### `fetch_content`

Retain `url` or `urls`, `forceClone`, `mode: readable | raw | answer`, prompt,
optional current-Pi `answerModel`, timestamp, and 1 through 12 frames if local
frame support is later retained. Remove the Gemini-specific model field.
`raw` cannot combine with clone, prompt, frame, or model operations.

Default fetching is isolated. An explicit current-session mode may operate on
the selected logged-in user tab, but its output is privacy-sensitive and is
not cached by default.

#### `get_search_content`

Retain `responseId`, query or URL selection, offset, a maximum 30,000-character
limit, and at most ten `findText` values with exact, case-insensitive, and
fuzzy matching.

#### `crawl_content`

Add:

- `url`;
- `includePaths` and `excludePaths`;
- `maxDepth`, `limit`, `timeoutMs`, `maxBytes`, and `maxConcurrency`;
- `allowSubdomains`, false by default;
- `allowExternalLinks`, false by default;
- `robots: respect | ignore`, default `respect`;
- `sitemap: include | skip | only`;
- `ignoreQueryParameters`, false by default;
- `render: auto | never | always`; and
- bounded readable-extraction options.

Defaults must be desktop-sized and far below Firecrawl's large service
defaults. Cancellation stops queued and active work and returns bounded
partial results.

### Context and prompt-injection policy

Initial tool output remains deliberately small. Full normalized content is
stored behind `responseId` handles and retrieved by range or passage. Every
search result, page, transcript, and repository file carries source and final
URL provenance and is explicitly marked as untrusted content. Skills instruct
Pi to use the content as evidence and never as commands.

## GitHub repository extraction

Public GitHub URLs are read locally, not through a hosted extraction service.
The implementation must:

- validate owner, repository, ref, and path before path or command creation;
- use mode-0700 random session directories from a safe temporary root;
- verify path containment before every cleanup operation;
- use shallow and partial clone, sparse checkout for a requested path, and
  bounded detached fetch for a full SHA;
- correctly resolve branch names containing `/`;
- percent-encode API path and ref values if public metadata HTTP is used;
- stream and truncate large files rather than loading them completely;
- cap wall time, disk bytes, object count, tree count, file count, and file
  size;
- disable prompts, hooks, submodules, filters, LFS smudge, system/global Git
  configuration, and credential helpers;
- never execute repository code;
- keep public reads from probing user credentials;
- make private access an explicit future opt-in rather than a default;
- clean cache entries with a TTL janitor after normal and crash exits; and
- work on a clean AppImage host without a system Git installation, either by
  bundling a source-built Git executable under its own license boundary or an
  audited local open-source implementation.

## YouTube caption extraction

The upstream `youtube-extract.ts` does not provide a local transcript path; it
tries Gemini Web, Gemini API, and Perplexity. WildBuzzard replaces that path.

Use pinned yt-dlp only for metadata and captions with behavior equivalent to:

```text
--ignore-config
--no-plugin-dirs
--no-remote-components
--no-update
--no-playlist
--skip-download
--write-subs
--write-auto-subs
--sub-langs <ordered-languages>
--sub-format json3/vtt/best
--write-info-json
```

Run it asynchronously in a unique mode-0700 directory with an ID-only output
template, sanitized environment, bounded stdout/stderr, file/time limits,
cancellation, and process-tree termination. Point its JavaScript support at
WildBuzzard's bundled Node runtime and keep remote component downloads off.

Caption language order is exact requested locale, base language, configured
fallback languages, then automatic captions. Prefer JSON3, preserve
timestamps, and deduplicate overlapping rolling-caption cues. Return title,
channel, duration, selected language, manual/automatic kind, transcript, and
explicit availability/error metadata.

Never silently inspect Firefox or Chromium profiles or use their cookies.
Private, member-only, age-restricted, geo-blocked, live, unavailable,
rate-limited, or no-caption videos return an explicit bounded error. Caption
extraction is not visual scene understanding. FFmpeg and frame extraction are
not required for the first transcript implementation.

## Native Gecko renderer

### Boundary

Firecrawl's relevant open renderer call is a small HTTP contract containing
URL, load delay, timeout, and headers and returning content, status, optional
error, and content type. WildBuzzard implements the capability on its existing
authenticated BrowserControl transport rather than hosting Playwright.

The native contract returns:

```json
{
  "content": "<html>...</html>",
  "pageStatusCode": 200,
  "pageError": null,
  "contentType": "text/html",
  "finalUrl": "https://example.test/final"
}
```

### Rendering behavior

For every job:

1. create a fresh ephemeral/private browsing context or isolated headless
   WildBuzzard worker;
2. expose no user cookies, history, cache, service workers, extensions, local
   storage, or session storage;
3. apply channel-level network policy before the first request;
4. navigate and record the main-document status, content type, and final URL;
5. wait for load and an optional bounded delay or selector;
6. serialize the final DOM for HTML, or return the bounded original body for
   JSON and plain text;
7. close the context and release every concurrency permit on success, failure,
   abort, or timeout; and
8. leave zero tabs, contexts, storage, service workers, caches, downloads, or
   worker processes after cleanup.

Do not expose skip-TLS-verification. Allowed custom headers use a strict
allowlist. Reject `Host`, `Connection`, `Cookie`, `Authorization`,
`Proxy-Authorization`, hop-by-hop, and other sensitive headers by default and
strip allowed sensitive values on a cross-origin redirect.

Optional request blocking uses exact hostname or suffix matching, never
`hostname.includes(domain)`. Do not copy Firecrawl's approximate last-two-label
cookie seeding because it is incorrect for public suffixes such as `co.uk`.

Readability and Markdown conversion remain in the Pi extension so the
privileged Gecko surface only renders and reports bounded page data.

### Supported parity

The required parity is:

- isolated browsing-context lifecycle;
- Gecko navigation and JavaScript execution;
- load, bounded delay, and selector waits;
- DOM serialization;
- status, content type, final URL, and normalized error;
- bounded headers and request blocking;
- cancellation and concurrency control; and
- deterministic extraction and crawl consumers.

The following are explicit non-parity items:

- raw Playwright API or locator semantics;
- Chrome DevTools Protocol;
- Chromium fingerprints and anti-bot behavior;
- byte-identical serialized HTML;
- arbitrary downloads, PDF generation, proxy emulation, mobile/location
  emulation, audio/video extraction, stealth, or hosted Fire Engine features;
- closed hosted caches or indexes; and
- Firecrawl billing, telemetry, queue, or webhook infrastructure.

## Crawl coordinator

Implement bounded breadth-first crawling rather than importing Firecrawl's
queue stack:

- same origin and current path subtree by default;
- fetch and honor `robots.txt` by default for the selected user agent;
- support ordinary, gzip, and indexed sitemaps with hard limits;
- canonicalize scheme, host, default port, path, fragment, and optional query
  treatment before deduplication;
- apply include/exclude rules to normalized full URLs;
- extract links after Gecko rendering where rendering was needed;
- reject cross-origin redirects unless the destination was explicitly placed
  in scope;
- enforce page, depth, response byte, decompressed byte, total byte, time,
  redirect, concurrency, DOM node, serialized output, and per-host delay
  budgets globally;
- emit progress and bounded partial results; and
- cancel queued and active work promptly.

## Web-search storage

Use a dedicated, versioned `web-search.sqlite` owned by the WildBuzzard
profile or service data root. Never add product tables to `places.sqlite`,
cookies, form history, permissions, or another Mozilla database.

The schema stores opaque response IDs, normalized source metadata, bounded
previews, full extracted documents, passage indexes, crawl membership, content
hashes, creation/expiry times, and storage policy. Apply TTL and LRU cleanup.
Do not store request headers, credentials, cookies, sidecar tokens, or raw
authenticated pages. Explicit current-session fetches default to `store=false`.

## Jackett Mini source package and runtime

Jackett Mini is a constrained downstream GPL-2.0-only fork, not a renamed
upstream dashboard. Its only product purpose is credential-free, read-only
torrent discovery. The fork must enforce these properties in its server and
packaged provider catalog rather than relying on browser UI hiding:

- expose only health, version, immutable source status, search, and opaque
  result resolution;
- include and enable every pinned public tracker that operates without a
  login, registration, cookie, passkey, API key, token, OTP, or other tracker
  credential, except trackers classified as adult-only;
- reject private, semi-private, credentialed, adult-only, and external-solver
  providers even when a caller knows an upstream identifier;
- provide no provider add, edit, enable, disable, test, update, or credential
  operation;
- provide no adult-policy switch, custom Cardigann import path, dashboard,
  updater, or arbitrary upstream API pass-through; and
- make the generated eligible-provider catalog immutable until the next
  reviewed WildBuzzard release.

The local capability token used to authenticate WildBuzzard to Jackett Mini is
service authentication, not a tracker credential. It never changes which
trackers are eligible and is never exposed to content or agents.

### Source layout

Vendor the exact Jackett release source beneath a visibly separate path such
as:

```text
wildbuzzard/third_party/gpl2/jackett/
├── upstream/          exact preferred source for the pinned release
├── patches/           downstream GPL-2.0-only Jackett Mini patch series
├── packaging/         reproducible source-build and runtime manifest input
├── provider-policy/   generated immutable catalog and classifications
├── BOUNDARY.md        prohibited and permitted integration paths
├── LICENSE
└── UPSTREAM.toml
```

The snapshot must contain every source and root build file required to
reproduce the distributed executable, not only `src/`. Imported history is
represented by the full upstream commit, source archive hash, update script,
and downstream patch series. Do not use a moving submodule or download source
during the browser build.

Upstream Jackett is an ASP.NET Core server. The audited project targets
`net9.0` and `net471`; the Linux build uses the .NET 9 target and upstream's
pipeline uses `dotnet publish --self-contained`. Upstream output is a directory
containing the executable, updater, `Content`, `Definitions`, and
managed/native dependencies rather than one static executable. Jackett Mini
uses the same pinned engine source but its runtime manifest must omit the
updater, dashboard assets, credential/configuration UI, unapproved external
definition paths, and provider definitions that cannot pass the generated
eligibility gate. The complete corresponding source still contains all
upstream source plus every downstream patch and build input.

Build in an external object directory with a pinned .NET SDK or source-build
environment. Generate and enforce a complete NuGet dependency lock and SBOM,
because upstream did not provide a complete transitive `packages.lock.json` at
the audited revision. Never ship a floating NuGet resolution.

The first supported target is Linux glibc x86-64. The audited upstream
runtime was approximately 48.5 MiB compressed and 116 MiB unpacked. Musl and
other architectures require separately built, tested, and manifested
runtimes; the browser must fail clearly rather than choosing a mismatched
payload.

### Launch contract

Launch behavior is equivalent to:

```text
<runtime>/jackett-mini
  --ListenPrivate
  --Port <owned-loopback-port>
  --PIDFile <owned-runtime-state>/jackett.pid
  --NoUpdates
  --NoRestart
  --DataFolder <isolated-persistent-data>
```

Verify the packaged executable's actual name and option spelling at the pin;
if the fork retains the upstream executable name, record that intentional
difference in the runtime manifest.
Always pass `--ListenPrivate`; the audited Unix defaults could otherwise permit
wildcard listening. Socket inspection is a release gate: no `0.0.0.0` or `::`
listener is permitted.

Upstream Jackett's updater checks GitHub after an initial delay and can download a
replacement, invoke its updater, overwrite its runtime, and kill/restart the
process. Jackett Mini must remove updater routes and omit the updater from its
runtime. `--NoUpdates` remains mandatory defense in depth, and `--NoRestart`
prevents autonomous restart. Every modification belongs inside the GPL source
package and must be documented and reproducibly buildable.

Browser/AppImage releases own all upgrades. Before a new runtime reads an old
data directory, create an atomic version-labelled backup. A failed health or
migration check rolls the runtime and data back together; never run an older
binary blindly against data migrated by a newer version.

### Jackett Mini data and service authentication

Upstream Jackett can store global configuration, an API key, admin-password
hash, proxy settings, mutable indexer JSON, cookies, passkeys, OTP fields, and
ASP.NET Data Protection keys. Jackett Mini must not expose or persist tracker
credentials or mutable provider configuration. Its state is restricted to the
random WildBuzzard-to-service capability, pinned catalog identity, bounded
cache/status data, process state, and any framework key material that the
reduced server still requires.

Treat the entire data root and its backups as secret:

- root mode 0700 and files mode 0600 under `umask 077`;
- never place it inside the browser profile, AppImage, download tree, sync,
  telemetry, crash annotations, or diagnostic bundle;
- never log the internal capability, result-resolution URLs, query URLs, or
  tracker announce data;
- never expose service keys, raw configuration objects, or framework state to
  a content process; and
- generate one random internal capability without placing it on a command
  line.

There is no tracker credential editor, provider editor, admin secret, or
provider mutation API in this product. Adding any of them is outside this
specification and requires a new architecture, threat-model, and product
decision rather than a dormant flag.

## Provider policy

### Audited catalog facts

At the audited Jackett master revision, the Cardigann YAML corpus contained
550 definitions:

- 86 public;
- 60 semi-private; and
- 404 private.

Native C# indexers add more definitions and can override a YAML ID, so these
numbers are not the complete effective catalog. In Jackett terminology,
`public` means no registration is normally needed; it does not establish
legality, content safety, privacy, reliability, jurisdiction, or absence of
adult material.

The audited YAML corpus had 195 definitions with at least one XXX category
mapping, including mixed/general trackers. Jackett has no trustworthy
machine-readable `adult-only` provider flag.

### Immutable eligibility catalog

Create a build-time policy artifact covering every effective YAML and native
provider at the exact Jackett pin. Entries are equivalent to:

```json
{
  "jackettCommit": "0cd8622b735922a909a128d8d6943bb8565a640f",
  "indexerId": "example",
  "definitionSha256": "...",
  "access": "public",
  "requiresCredentials": false,
  "requiresExternalSolver": false,
  "contentClass": "general",
  "eligibility": "enabled-public",
  "reasons": ["public, credential-free, and not adult-only"]
}
```

`contentClass` is exactly `general`, `mixed-general`, `adult-only`, or
`not-applicable`. Eligibility is computed independently from content class.
When multiple exclusion rules apply, record every reason in a deterministic
array while eligibility remains excluded. Neither content class nor
eligibility may have an unclassified state in a shipping catalog.

The only allowed release classifications are `enabled-public`,
`excluded-adult-only`, `excluded-credentialed`, `excluded-non-public`, and
`excluded-external-runtime`. The release build must classify every definition;
it cannot ship `unknown`, unreviewed, or silently disabled public entries. A
new, renamed, or hash-changed definition fails CI and blocks the pin update
until classified. Once classified, every `enabled-public` provider is enabled
automatically and immutably for that release.

Eligibility is mechanical and product-specific:

- include every public provider that needs no account, registration, login,
  cookie, passkey, API key, token, OTP, client certificate, or other tracker
  credential;
- include general and mixed/general public providers and preserve their
  returned results and categories without content-level filtering;
- exclude a provider whose primary catalog is adult-only;
- exclude every private or semi-private provider, even when registration is
  currently open;
- exclude every provider that requires FlareSolverr, another anti-bot solver,
  a user-supplied endpoint, or another separately configured runtime; and
- reject custom/user-supplied Cardigann definitions and definition search
  paths.

There is no per-provider legal-approval flag, default-off holding set, or
runtime enable/disable preference. The immutable catalog is the release
decision. A read-only status view may report availability, latency, and the
classification reason. A search may optionally target a subset of eligible
sources for performance, but neither a user nor an agent can alter catalog
membership. "All" always means every `enabled-public` source in the pinned
catalog.

### Provider-level adult-content exclusion

Adult/vulgar-only providers are permanently absent from the eligible catalog.
General and mixed/general providers remain eligible, and their individual
results, categories, titles, and metadata are not censored by keyword or
category. The product still rejects malformed, unsafe, or oversized protocol
data and treats all provider fields as untrusted. There is no user, agent,
environment, or hidden override that can enable an excluded adult-only
provider. Deterministic CI proves provider exclusion and result preservation;
quarantined live monitoring verifies eligible sources without making release
tests depend on tracker uptime.

### Query disclosure and reliability

Searching all eligible public providers sends the query and user network
address to many unrelated sites, increases anti-bot and rate-limit failures,
and makes latency nondeterministic. The UI must disclose that behavior and
show per-source partial failures. It may let the caller narrow one search to a
read-only subset, but it must not present provider management or imply that
excluded definitions can be configured. "All" means the entire immutable
`enabled-public` catalog for the current WildBuzzard release.

## Independent Jackett Mini client and retained upstream behavior

### Read-only product API

The browser-facing Jackett Mini protocol is versioned independently from
upstream Torznab and exposes only:

```text
GET  /v1/health
GET  /v1/version
GET  /v1/sources
POST /v1/search
POST /v1/results/:opaque-result-id/resolve
```

`/v1/sources` is status-only. There is no configuration, add, edit, remove,
enable, disable, credential, dashboard, updater, arbitrary proxy, or raw
Torznab route. Unsupported paths and mutation attempts fail closed and are
covered by contract tests. The API uses the random internal capability token
in an `Authorization` header; that service token is not a provider API key and
cannot unlock a credentialed tracker. Ordinary content, the About page, and Pi
never receive either the token or direct access to Jackett's internal engine.

Result resolution may return bounded validated torrent metadata or a public
magnet to privileged browser code, but it never adds or starts a download.
Only the separate native TorrentManager draft/commit flow performs that user
side effect.

### Original Jackett test API, not a product route

The pristine original Jackett test service exposes this Torznab shape:

```text
GET /api/v2.0/indexers/<indexer-id>/results/torznab/api
    ?apikey=<secret>
    &t=<caps|search|tvsearch|movie|music|book|indexers>
    &q=<query>
    &cat=<comma-separated-categories>
    &limit=<count>
    &offset=<offset>
```

The audited upstream request model also accepts `imdbid`, `ep`, `extended`,
`cache`, `season`, `rid`, `tvdbid`, `tmdbid`, `tvmazeid`, `traktid`,
`doubanid`, `album`, `artist`, `label`, `track`, `year`, `genre`, `title`,
`author`, `publisher`, and meta-indexer `configured`. The pinned code appeared
to assign `publisher` into `Author`; do not rely on publisher behavior without
a pinned regression test. These routes and parameters exist only in the
pristine original-service suite and retained engine-level fixtures. Jackett Mini must
not expose or internally call an HTTP `/api/v2.0` route and must not expose
`apikey` or `passkey` compatibility. Its only network API is `/v1/*`; retained
indexer logic is invoked behind that product boundary.

Jackett Mini loads and caches capabilities for every eligible provider and
issues only modes, parameters, and categories supported by that provider. It
queries eligible indexers individually rather than using upstream `/all`,
because `/all` flattens capability and custom-category behavior, lets slow
providers delay the aggregate, obscures partial failures, cannot use
indexer-specific categories at or above 100000, and caps aggregate results.

Initial scheduling policy:

- four provider requests concurrently;
- 15-second per-provider soft deadline;
- 30-second whole-search deadline;
- one active search generation per UI surface;
- bounded queue and circuit breaker;
- cancellation or discard of stale generations; and
- partial results with per-provider state.

Upstream Jackett's cache default was observed at 2,100 seconds and 1,000
results per indexer, and `cache=false` requests fresh results. Jackett Mini
must make cache behavior intentional and test it; it must not expose that raw
switch or generate uncontrolled tracker load.

### Upstream response parity and product errors

Upstream success is RSS 2.0 with a Torznab namespace. Items can carry title,
GUID, indexer ID/name, tracker type, link/enclosure, comments, details, date,
size, file/grab counts, categories, identifiers, media metadata, seeders,
peers, cover URL, infohash, magnet URL, ratio/time requirements, and transfer
factors. Most fields are optional.

HTTP status alone is not success in the pristine API. Upstream Jackett can
return HTTP 200 with an XML `<error>` root. Observed semantics include:

- invalid API key: error code 100, often HTTP 200;
- missing or unsupported indexer: codes 200 or 201;
- bad parameters: code 201;
- unavailable function: code 203;
- tracker/rate/unexpected failure: code 900;
- rate limiting: HTTP 429 with `Retry-After` when known; and
- in-action validation: commonly HTTP 400 XML.

The rootless original-service comparator must inspect the XML root before interpreting an
empty result, disable DTDs and external entities, and enforce compressed byte,
decompressed byte, element count, depth, text, attribute, and result limits.
Parity covers malformed XML, stalled bodies, redirects, redirect loops, TLS
failure, 429, and inconsistent optional attributes. Jackett Mini maps the
equivalent retained-engine outcomes into bounded `/v1` JSON and never forwards
raw XML or raw upstream errors to the browser.

The internal capability is the only product wire secret. It is never placed in
a query string and must be redacted from logs, error reporting, telemetry,
history, and crash capture.

### Normalized result contract

Browser and Pi consumers receive independent sanitized data:

```json
{
  "searchId": "opaque",
  "partial": true,
  "providers": [
    {
      "id": "linuxtracker",
      "state": "ok",
      "elapsedMs": 812
    }
  ],
  "results": [
    {
      "resultId": "opaque",
      "providerId": "linuxtracker",
      "providerName": "LinuxTracker",
      "name": "Example",
      "sizeBytes": 123456,
      "seeders": 10,
      "leechers": 2,
      "publishedAt": "2026-08-10T12:00:00Z",
      "categoryIds": [2000],
      "access": "public",
      "acquisition": "magnet"
    }
  ]
}
```

Raw public result/download URLs, GUIDs, and engine-internal identifiers remain
only in a bounded, short-lived Jackett Mini result cache keyed by profile,
search ID, and result ID. No tracker credential, cookie, passkey, or provider
API key may exist in that cache.

Do not label `peers` blindly as leechers. Some Jackett paths use total peers.
Determine semantics through pinned endpoint fixtures and, when peers is total,
derive `max(0, peers - seeders)`. Preserve unavailable values as `null`.

Deduplicate public results by normalized BTIH/infohash, then canonical magnet,
then provider plus GUID while preserving alternate provider sources.

## Existing `.torrent` file-picker regression

The current `about:torrents` Add Torrent/File action throws a JavaScript
exception instead of opening the native file chooser. Reproduce and fix it as
the first implementation and release gate, before Jackett Mini, torrent
search, or new torrent UI work. No later feature may mask, defer, or route
around it.

Required behavior:

- reproduce the failure in the externally built WildBuzzard browser and
  preserve the browser-console stack and exact user steps as a regression
  artifact;
- make the Add Torrent button and empty-state action open a trusted native
  file chooser accepting `.torrent` and `application/x-bittorrent` through the
  established privileged parent boundary;
- do not expose a selected local path to ordinary content, Pi, Jackett Mini,
  or the torrent sidecar; privileged code reads bounded bytes and hands only
  validated torrent data to the existing manager;
- pass a valid selection into the same metadata-draft and file-selection
  dialog used by magnets and search results;
- treat chooser cancellation as a silent no-op, restore focus to the invoking
  control, and produce no rejected promise or console exception;
- show an accessible error for an invalid, unreadable, or over-12-MiB file and
  permit another selection immediately;
- support repeated selections in one browser session, selection after closing
  the dialog, and selection after browser restart; and
- if drag-and-drop is retained, route it through exactly the same bounded read,
  validation, draft, and error path.

The operating-system `.torrent` chooser is distinct from the later metadata
dialog that lists files inside a torrent. Both must work: choosing the torrent
creates a draft, then the metadata dialog defaults every contained file to
selected and waits for explicit commit.

## Torrent discovery UI

Add a Search region or tab to `about:torrents` containing:

- search field;
- an "All sources" default covering the complete immutable eligible catalog;
- an optional per-search source subset selector and read-only source/status
  list, with no provider-management affordance;
- progress, cancellation, partial-result, and provider-error status;
- a semantic results table/data grid with Title, Size, Seeders, Leechers,
  Source, Category, Published/Age, and Download columns;
- working Add Torrent/File and drag-and-drop entry points for local `.torrent`
  files;
- metadata/file-selection flow.

Use semantic Firefox markup, Fluent strings, product design tokens, logical
CSS, visible focus, forced-colors support, and keyboard/screen-reader behavior.
Use an actual semantic table rather than a collection of visually aligned
generic elements. Sortable Title, Size, Seeders, and Leechers headers use
buttons and maintain `aria-sort`. A new surface and its first query sort by
Seeders descending; null seed counts sort last. That remains the active order
until the user selects another sortable header. A header click selects that
field and subsequent clicks toggle direction, and the chosen order remains for
later results in that surface. Null numeric values always sort last. Stable
ties use provider ID, normalized title, and result ID.

Each row's Download button resolves the opaque result and opens the metadata
file-selection dialog. Every file is checked by default, so the primary action
is Download all; after the user changes the selection it becomes Download
selected. Resolution alone never begins payload transfer.

Titles and provider data are untrusted. Strip control characters, cap length,
and render with `textContent`; never insert result-supplied HTML or executable
links.

### URLbar integration

Add a native Torrent search mode and `@torrent` alias. Selecting it routes the
query to `about:torrents?search=<encoded-query>`. It is a native URLbar provider
or mode, not a third SearchService engine, so Search settings continue to
advertise only SearXNG and DuckDuckGo.

## Metadata drafts and file selection

The existing runtime begins a torrent and selects content when metadata is
ready. Split that lifecycle into draft and committed states.

Proposed internal runtime API:

```text
POST   /v1/torrent-drafts
GET    /v1/torrent-drafts/:draftId
POST   /v1/torrent-drafts/:draftId/commit
DELETE /v1/torrent-drafts/:draftId
```

Rules:

- accept only a validated typed magnet or validated torrent bytes supplied by
  privileged code;
- parse `.torrent` metadata immediately where possible;
- for a magnet, join only enough to retrieve metadata and deselect every
  payload piece before content requests can begin;
- return torrent name, total size, and files with stable numeric indexes;
- open the dialog with every file checked;
- omitted selection means all files;
- an explicit index list means exactly that subset;
- commit selects the requested files and begins payload transfer;
- cancel destroys the swarm/draft and removes temporary metadata, partial
  store state, and resume entries;
- show a "Still fetching metadata" state after 20 seconds with Keep Waiting
  and Cancel;
- hard-timeout and clean up after 120 seconds; and
- instrument and assert that no payload piece is requested or written before
  commit.

Before displaying metadata, enforce limits on torrent bytes, decoded total
size, bencode nesting, file count, path length, path collisions, absolute
paths, parent traversal, NULs, and platform-reserved paths. Preserve the
existing 12 MiB `.torrent` input cap unless a reviewed change justifies a new
bound.

For a Jackett Mini result, privileged code calls
`/v1/results/:opaque-result-id/resolve`. Mini may return a validated public
magnet or bounded validated `.torrent` bytes. Its internal public download
fetch follows at most five redirects, restricts schemes, rejects unexpected
private/link-local destinations, caps bytes, and validates bencode or BTIH. No
raw upstream URL or tracker credential crosses the product boundary, and the
About page and torrent runtime never fetch a result-supplied arbitrary URL.

Any manually supplied `.torrent` file marked private must preserve its private
flag and announce URLs. Jackett Mini never discovers credentialed private
trackers. Never synthesize a public magnet from a private infohash, and prove
DHT and PEX remain disabled for a manually added private torrent.

## Torrent agent contract

Use the same manager, provider policy, result cache, and draft state as the UI.
The implementation may preserve an existing aggregate torrent tool or expose
the following concise operations, but it must not duplicate backend behavior:

```text
torrent_providers()
torrent_search({ query, providers?, sort?, direction?, limit?, timeoutMs? })
torrent_prepare({ searchId, resultId })
torrent_draft({ draftId })
torrent_commit({ draftId, files? })
torrent_cancel({ draftId })
```

Omitted providers means all eligible providers in the immutable catalog.
Omitted `sort` means `seeders`, and omitted `direction` means descending;
unknown seed counts remain last. `torrent_providers()` is read-only status,
not configuration. Omitted files means all files. Search returns bounded
sanitized results and per-provider status. Prepare, commit, draft, and cancel
accept opaque IDs scoped to the current profile and session. Agents cannot
supply arbitrary acquisition URLs, filesystem paths, Jackett identifiers,
credentials, provider definitions, or adult-policy overrides, and cannot
enable, disable, add, edit, or test a provider.

Committing a torrent is a side effect and follows the product confirmation
policy unless the user explicitly authorized the download. Titles are marked
as untrusted external data before entering agent context. Never return the
internal capability, raw result URL, engine identifier, private announce URL,
or framework state.

## Tor routing

Existing torrent TCP, UDP, uTP, and Tor behavior must remain intact. If torrent
search is configured to use Tor, Jackett Mini's tracker requests must use the
managed SOCKS path and fail closed when Tor is unavailable. It must never silently
retry directly. Torrent payload Tor routing remains an explicit manager
setting and is tested independently from search routing.

Private-window torrent search is privacy-sensitive. The initial behavior must
be explicitly disabled or assigned a tested isolated/Tor-routed policy; it may
not silently reuse ordinary Jackett state.

## Security requirements

### Local services

- bind exclusively to intended loopback addresses or private Unix sockets;
- verify actual listeners in integration tests;
- use random per-start capability tokens where a service supports a gateway;
- use strict Host and Origin checks, no permissive CORS, constant-time token
  comparison, and POST for mutations;
- never provide service credentials to a content process;
- redact queries, URLs, headers, page bodies, API keys, passkeys, cookies,
  tracker announces, and credentials from logs and diagnostics;
- rate-limit search, result resolution, render, and crawl requests;
- keep third-party data roots away from the browser profile and download tree;
- apply Landlock, bubblewrap, seccomp, or another available sandbox where
  supportable and document reduced isolation otherwise; and
- never expose services through Tailscale merely because browser UI is
  remotely accessible. Remote access terminates at an authenticated
  WildBuzzard/Pi Web gateway.

### Web SSRF and resource limits

Enforce URL policy at the actual network channel, not only through DNS
preflight. Validate every redirect and subresource and defend against DNS
rebinding. Block:

- non-HTTP(S) schemes and URL userinfo;
- loopback and RFC1918;
- link-local and cloud metadata endpoints;
- CGNAT, multicast, unspecified, documentation, benchmark, and other reserved
  IPv4/IPv6 ranges;
- IPv4-mapped IPv6 bypasses; and
- redirects or subresources that leave the explicitly allowed scope.

Apply response, decompression-ratio, DOM-node, serialized-output, page, depth,
time, disk, and concurrency limits. Do not forward credentials or custom
headers across origins. Invalid TLS fails; no skip-verification escape is
provided to an agent.

### XML, bencode, and untrusted UI

- disable DTD and external entity processing;
- cap XML bytes, nodes, depth, attributes, text, and results;
- cap bencode bytes, depth, aggregate sizes, file count, and path length;
- validate every filesystem output path after normalization;
- render external strings as text only; and
- use opaque IDs rather than passing acquisition URLs across privilege
  boundaries.

## Implementation sequence

### Phase 0: contracts, pins, and feasibility spikes

1. Reproduce the current Add Torrent/File JavaScript exception in the built
   browser, capture its stack, fix the trusted native chooser path, and prove a
   local `.torrent` reaches the metadata dialog without a console error.
2. Freeze tool schemas, service protocols, upstream revisions, source hashes,
   licenses, dependency locks, SBOM format, and recorded fixtures.
3. Provision exact pinned pristine SearXNG and Jackett services in rootless
   Podman or an equivalent OCI runtime and save the initial raw parity corpus.
4. Prove stable internal SearXNG SearchService registration and normal/private
   default behavior across service and private-socket restarts.
5. Prove isolated Gecko rendering and complete cleanup.
6. Prove metadata-only magnet behavior with zero payload before commit.
7. Prove Jackett Mini private bind, isolated data, random-port retry, health,
   no-update behavior, stale PID safety, and separation from system Jackett.
8. Resolve any failed spike at the architecture or transport layer before
   broad UI work.

### Phase 1: source and runtime foundation

1. Add exact source snapshots, licenses, notices, update scripts, manifests,
   boundary documents, and build locks.
2. Add external reproducible build scripts for SearXNG, yt-dlp support, and
   the GPL-2.0-only Jackett Mini fork.
3. Extend the persistent supervisor and runtime extraction/identity logic.
4. Add health, restart, explicit stop, upgrade, rollback, and socket checks.

### Phase 2: default search and Pi deterministic tools

1. Start managed SearXNG and integrate product SearchService configuration.
2. Reduce advertised product engines to SearXNG and DuckDuckGo.
3. Port the deterministic Pi tools, result storage, GitHub extraction, PDF,
   static extraction, and YouTube captions.
4. Add on-demand Pi skills and tool-contract tests.

### Phase 3: Gecko render and crawl

1. Add restricted render RPC and isolated contexts/workers.
2. Add channel-level SSRF and resource enforcement.
3. Use Gecko as the dynamic-page fallback for `fetch_content`.
4. Add bounded crawl, robots, sitemap, canonicalization, cancellation, and
   partial results.
5. Compare normalized behavior against the pinned Firecrawl reference.

### Phase 4: Jackett discovery and torrent drafts

1. Build and supervise pinned Jackett Mini behind the process boundary.
2. Generate the exhaustive immutable eligibility catalog, enable every
   credential-free non-adult-only public source, and fail the build for every
   unclassified or hash-changed definition.
3. Remove or make unreachable dashboard, updater, credential, provider-edit,
   custom-definition, adult-switch, and raw upstream API surfaces.
4. Implement caps-driven per-provider Torznab search and normalized opaque
   results.
5. Add metadata draft, validation, all-file default, subset commit, and
   cancellation APIs.
6. Prove no payload before commit and preserve existing torrent transports.

### Phase 5: browser and agent product surfaces

1. Add accessible native torrent search, keep the Phase 0 local `.torrent`
   chooser regression tests green, and add file-selection UI.
2. Add Torrent URLbar mode and `@torrent` alias.
3. Add concise agent discovery/draft/commit operations.
4. Add read-only source/service status, repair, stop, and restart UI where
   appropriate; do not add provider management.

### Phase 6: independent parity, security, and release

1. Rebuild or pull the exact-digest pristine SearXNG and Jackett rootless
   reference containers from recorded pins.
2. Run pristine and ported APIs through identically mapped deterministic user
   scenarios and retain request mappings, both raw transcripts, normalized
   diffs, logs, and runtime identities.
3. Run the quarantined live no-key engine/provider comparison and record every
   source outcome.
4. Run security, fuzz, crash, lifecycle, accessibility, and migration tests.
5. Build the browser and AppImage entirely outside the source checkout.
6. Run real UI and agent flows in the built WildBuzzard browser.
7. Review the final diff, commit stack, source inventory, license package, and
   complete original-service comparison evidence.
8. Push normally and open the built product only after mandatory gates pass.

## Multi-agent execution model

The root agent owns architecture, shared contracts, integration, review,
cherry-picking, final testing, commits, push, and product launch. Use no more
than three child agents concurrently.

Use `gpt-5.6-sol` with `ultra` reasoning for:

- source licensing, provenance, and reproducibility;
- SearchService and managed-runtime architecture;
- Gecko rendering, networking, SSRF, and process isolation;
- Jackett boundary, lifecycle, and Torznab hardening; and
- independent parity/security review.

Use `gpt-5.6-sol` with `high` reasoning for:

- Pi TypeScript port and skills;
- torrent runtime draft APIs;
- Firefox frontend and URLbar work;
- test fixtures and ordinary contract tests; and
- external build/AppImage integration.

Every child receives a self-contained bounded task, an isolated external Git
worktree, exclusive file ownership, explicit acceptance tests, and no
authority to push or rewrite shared history. Each child commits its work and
reports the commit, changed files, commands, unfiltered test-log paths, and
known failures. Root reviews the complete diff and reruns relevant tests before
cherry-picking. Reports are evidence, not acceptance.

## Pristine original-service API comparison harness

Original-service comparison is mandatory for SearXNG and Jackett Mini. The
root orchestrator or delegated test agents must provision pristine services in
a rootless Podman-compatible OCI runtime. The ported SearXNG and Jackett Mini
services and the comparator itself run directly on the host from pinned
host-built runtimes. Merely testing browser mocks or the normalized
WildBuzzard API does not satisfy parity.

Reference-service provisioning rules:

- never pull `latest` or an unpinned tag;
- for SearXNG, use the authoritative image at the exact recorded manifest
  digest only after verifying it corresponds to the selected source pin;
- for Jackett, verify and safely extract the exact official commit-matched
  release archive, then execute only that pristine release in the pinned
  reference container;
- never build or execute the ported SearXNG or Jackett Mini service in a
  container, and never use a container as an AppImage build stage;
- record the source/release identity, OCI manifest and platform digest,
  redacted configuration hash, random host ports, and container-runtime
  version;
- run rootless, bind only random loopback host ports, use fresh per-run data
  directories, and never attach to or modify a system SearXNG or Jackett;
- configure the pristine and ported services with equivalent deterministic
  local fixtures and no tracker or search-provider credentials;
- start both implementations concurrently and run the same ordered user
  scenarios and fixture inputs through each service's actual API;
- for SearXNG, send the same original HTTP method, path, query, form body,
  headers, timeout, and cancellation point to pristine and ported services;
- for Jackett, map each raw Torznab request sent to pristine Jackett to the
  corresponding `/v1` request sent to Jackett Mini, then compare the normalized
  semantic result or error contract;
- preserve the explicit original-to-ported request mapping and both raw
  transcripts;
- retain raw request/response bodies, status and headers, canonicalized diffs,
  service logs, exit status, timing, and cleanup evidence under the external
  test-artifact directory; and
- treat every unexplained difference as a blocking failure. Only documented
  product transformations, volatile fields, and deliberately removed Jackett
  mutation/dashboard surfaces may be normalized or excluded.

The deterministic gating run uses local fixture engines and trackers. A second
quarantined run exercises live no-key SearXNG engines and the immutable
credential-free Jackett Mini public catalog; network drift and third-party
outages may make that second run non-gating, but it must still produce a
per-source report before release. The root agent reviews the raw evidence and
canonical diff rather than accepting a child-agent summary alone.

Podman or an equivalent rootless OCI runtime is disposable pristine-oracle
test infrastructure only. It is never a shipping build tool and is never
installed, invoked, or required by the shipping browser or AppImage.

## Objective parity and test matrix

### SearXNG and Pi tools

Against the pristine original SearXNG service, exercise both `GET` and `POST` search
forms and HTML and JSON responses for query, categories, engine selection,
language, page, time range, safe-search level, and supported output formats.
Compare status, content type, typed response fields, error semantics, and
canonicalized result data. Also compare health and the product-relevant
configuration surface while redacting secrets and volatile runtime values.

- schema snapshots and tool registration;
- Pi session start, cancellation, shutdown, and result cleanup;
- query and four-query batches;
- result counts, recency, domain inclusion/exclusion, Unicode, empty results,
  and provider errors;
- typed answers, corrections, suggestions, and unresponsive engines;
- malformed/empty JSON and 403 when JSON is disabled;
- 30,000-character paging, offsets, TTL, and exact/case-insensitive/fuzzy
  passage lookup;
- `includeContent` preview limits and full-content retrieval;
- engine allowlist, version pin, authenticated private health, configuration
  verification, crash/restart/backoff, concurrent clients, stale PID, and
  socket identity/tamper/collision handling;
- new and migrated profile engine lists and normal/private defaults; and
- network observation proving no removed hosted-provider module or credential
  is contacted or read.

### Gecko render parity

Use local deterministic fixtures for:

- static HTML and JavaScript-mutated DOM;
- delayed elements and selector wait;
- redirect chains and final URL;
- 204, 404, JSON, plain text, and encoding variants;
- timeout, cancellation, oversized body/DOM, and decompression bomb;
- CSP, iframe, service worker, cache, cookies, local/session storage;
- allowed headers on same-origin requests and no cross-origin leakage;
- private-IP main navigation, redirect, iframe, image, script, and fetch;
- mapped IPv6 and deterministic DNS rebinding;
- invalid TLS; and
- concurrent jobs releasing contexts and permits after every outcome.

Compare with pristine Firecrawl `v2.11.193` on the same fixtures. Normalize
engine-specific serialization; do not compare byte-for-byte HTML. Require
exact status, content type, and final URL plus at least 95 percent visible-text
token recall and matching title, headings, and link targets. After every job,
assert zero leftover tabs, contexts, cookies, storage, service workers, cache,
downloads, or renderer processes.

### Crawl

Use a local graph containing cycles, fragments, query variants, relative and
base URLs, canonicals, subdomains, external redirects, robots allow/deny and
crawl delay, ordinary/gzip sitemap indexes, slow pages, and oversized pages.
Assert the exact in-scope visited set, no fetch of a disallowed URL, correct
depth and path rules, global budgets, measurable host delay/concurrency,
prompt cancellation, and single output per canonical URL.

### GitHub

- repository root, tree, blob, tag, full SHA, and branch containing `/`;
- shallow/partial and sparse behavior;
- oversized repository with and without an optional external helper;
- clone timeout and process-tree termination;
- huge, binary, symlinked, and deeply nested files;
- traversal and predictable-path race attempts;
- proof that prompts, hooks, filters, submodules, LFS, and credential helpers
  did not execute; and
- normal cleanup and crash janitor.

### YouTube

Use recorded yt-dlp JSON3 and VTT fixtures for manual, automatic,
multilingual, overlapping rolling, malformed, and huge captions. Test no
captions, private/unavailable, and live errors, stable timestamps,
deduplication, cancellation, process cleanup, and proof that no browser-profile
cookie path was read. Live YouTube checks are quarantined and non-gating.

### Pristine Jackett and Jackett Mini comparison

Build Jackett Mini directly on the host from the exact source pin and pinned
host toolchain. Verify and extract the matching official pristine release,
running only that upstream reference in rootless OCI. Use separate clean data
roots and deterministic local fixture trackers. The upstream instance is the
reference for retained tracker parsing and Torznab behavior, not for the
deliberately removed dashboard or mutation APIs. Compare canonicalized
`t=caps`, `t=indexers`, `t=search`, provider IDs/titles, size, seeders,
peer/leech normalization, categories, infohash/magnet, authenticated
`.torrent` bytes, and private flags for eligible providers. Normalize only
ports, timestamps, ordering, and intentionally opaque IDs, and document every
intentional Jackett Mini difference.

Catalog and product-API gates include:

- enumerate every effective YAML and native provider at the pin and prove each
  has exactly one release classification;
- prove the active set exactly equals all public, credential-free,
  non-adult-only, non-external-runtime providers, with no missing eligible
  entry and no extra entry;
- prove general and mixed/general public sources remain active while
  adult-only sources are absent;
- prove private, semi-private, login, registration, cookie, passkey, API-key,
  token, OTP, client-certificate, FlareSolverr, and custom-definition sources
  cannot be activated or queried by ID;
- mutate, add, rename, or hash-change a fixture definition and require catalog
  generation to fail until it receives a release classification;
- prove the runtime contains no dashboard/updater assets or credential store
  and exposes no provider/configuration mutation route;
- try every removed upstream dashboard, add, edit, remove, enable, disable,
  test, update, configuration, and raw Torznab route and require a closed
  failure; and
- prove the internal capability authenticates health/status/search/resolve but
  cannot change catalog membership or unlock a credentialed source.

Product-boundary authentication cases include a valid internal capability,
missing and invalid capabilities, a capability supplied through a forbidden
query parameter, cross-profile capability reuse, and proof that no `apikey`,
`passkey`, raw Torznab, or upstream dashboard route exists.

Pristine original-Jackett-only contract cases include:

- valid `apikey` and alias `passkey`;
- missing/invalid key returning HTTP 200 error code 100;
- unsupported modes/parameters returning 201 or 203;
- HTTP 400 and code 900;
- HTTP 429 and `Retry-After`;
- timeout, hanging provider, TLS failure, malformed/oversized/deep/entity XML,
  and redirect loop;
- partial success and stale search generation;
- absent and contradictory peer counts;
- duplicate infohashes and alternate providers;
- malicious titles, categories, and acquisition URLs;
- expired and cross-profile result IDs;
- every 6000/6010-6090 adult category, mixed safe/adult categories, missing
  categories, and adult providers returning generic category 8000; and
- custom categories at or above 100000 through per-indexer requests.

### Torrent runtime and UI

- reproduce the existing Add Torrent/File JavaScript exception before the fix
  and retain its stack as the regression fixture;
- trusted mouse and keyboard activation opening the native `.torrent` chooser
  in the externally built browser;
- chooser cancel as a no-op with restored focus, no rejected promise, and no
  browser-console exception;
- valid single-file selection reaching the metadata dialog, every contained
  file initially selected, and no path disclosed outside privileged code;
- invalid, unreadable, wrong-type, and over-12-MiB input showing an accessible
  error without breaking the next selection;
- repeated choose/cancel/choose flows, dialog close/reopen, browser restart,
  and drag-and-drop through the same validation path;
- a browser-chrome regression around the privileged picker boundary covering
  trusted activation, valid selection, cancel, invalid/oversized input,
  rejected-promise and console-error assertions, repeated reopen, and focus
  restoration with a deterministic picker fixture;
- a headed E2E using the real OS chooser in the externally built WildBuzzard
  browser and clean-host AppImage, retaining browser-console output and
  screenshots or video as release-gating evidence;
- "All sources" exactly matching the immutable eligible catalog and optional
  per-search subsets never mutating that catalog;
- semantic table/grid roles and column names, a Download action for every row,
  initial Seeders-descending order with nulls last, user header overrides, and
  omitted-sort agent parity independent of transient UI state;
- every sort direction, stability, null-last behavior, and default order;
- keyboard navigation, focus, `aria-sort`, live-region announcements,
  accessible modal focus, forced colors, and localization;
- cancellation and stale-result suppression;
- partial-provider display;
- magnet and `.torrent` preparation;
- delayed metadata state;
- every file initially selected;
- exact subset commit;
- cancel and hard-timeout cleanup;
- zero payload request/write before commit;
- private torrent DHT/PEX protection;
- malicious bencode and output paths;
- no orphan swarm, temporary file, or resume record after failure; and
- browser restart, partial-download resume, remove, and remove-and-delete.

Existing TCP, UDP tracker, uTP, DHT, magnet, `.torrent`, pause/resume,
reannounce, force-start, connection-list, restart persistence, and Tor tests
remain mandatory. A regression in an existing transport blocks release.

### Service lifecycle and security

- clean start and health readiness rather than PID-only readiness;
- simultaneous browser windows produce one owned service;
- browser close/reopen reuses only an identity-verified service;
- stale PID and deliberately reused unrelated PID are never killed;
- occupied default/system ports do not affect system services;
- only intended private Unix or loopback sockets exist and LAN/Tailscale
  connections fail;
- no updater request or autonomous runtime change occurs;
- crash loops use bounded backoff and actionable status;
- explicit stop/restart affects only the owned process;
- tokens and data use 0600/0700 permissions;
- ordinary pages cannot read or mutate local service APIs;
- secrets are absent from logs, history, telemetry, crash reports, copied
  URLs, and renderer state; and
- Tor-configured operations fail closed rather than using direct transport.

### AppImage

The initial release target is Linux glibc x86-64. Test:

- clean supported distributions under X11 and Wayland;
- no host Node.js, Python, .NET, yt-dlp, Git, Playwright, Jackett, or torrent
  client;
- no runtime Docker or Podman and no Chromium/Playwright payload;
- exact runtime manifests, per-file checksums, source, SBOM, and licenses;
- read-only launch media and paths containing spaces/non-ASCII characters;
- `APPIMAGE_EXTRACT_AND_RUN=1` without FUSE;
- offline first launch without self-update or installation attempts;
- writable files only in documented XDG data/cache/runtime locations;
- simultaneous sessions and port/PID/temp-directory races;
- browser close while Pi Web remains available, SearX search continuity, and
  headless Gecko worker behavior;
- parent/child crash and reconnect;
- version upgrade, failed health rollback, and data preservation;
- service termination leaving a separately installed SearXNG or Jackett
  untouched; and
- accessible notices and durable exact corresponding-source delivery.

Rootless Podman or an equivalent OCI runtime is required for pristine API
comparisons only. Clean-host product/AppImage tests must use the actual
host-native bundle. OCI is not a shipping builder or runtime.

## Commit and review stack

Use a coherent, independently reviewable stack similar to:

1. fix the native `.torrent` chooser regression with automated and headed E2E
   coverage;
2. vendor and pin web-search sources, licenses, and manifests;
3. add the rootless pristine SearXNG/Jackett API comparison harness;
4. add managed SearXNG build and service lifecycle;
5. make SearXNG the product default and reduce built-in engines;
6. port deterministic Pi web-access tools and skills;
7. add native Gecko render and SSRF enforcement;
8. add bounded crawl and web-search storage;
9. vendor and source-build the isolated GPL-2.0-only Jackett Mini fork;
10. add its immutable eligible-source catalog, read-only lifecycle, and
    independent browser JSON client;
11. add torrent metadata drafts and file-selection runtime;
12. add torrent search UI, URLbar mode, and agent operations;
13. add independent parity, security, accessibility, and AppImage tests; and
14. finalize source delivery, SBOM, packaging, and release documentation.

Every commit must build and run its relevant tests. Tests should land with the
feature they protect where practical; the final hardening commit does not
substitute for feature-local coverage.

## Definition of done

The work is complete only when:

- every required source revision and license is present and reproducible;
- the GPL-2.0-only boundary passes source, binary, and package scans;
- SearXNG is the working normal/private default and DuckDuckGo is the only
  other advertised product engine;
- all removed proprietary-provider modules and outbound calls are absent;
- Pi search, content retrieval, GitHub, captions, Gecko rendering, and crawl
  work through the actual bundled Pi instance;
- the Add Torrent/File action opens the native chooser, handles cancel and bad
  input without a JavaScript exception, and sends a valid `.torrent` through
  the metadata/file-selection dialog in the externally built browser;
- Jackett Mini exposes only capability-authenticated read-only discovery; its
  immutable pinned catalog enables exactly every credential-free,
  non-adult-only, non-external-solver public source, including mixed/general
  sources; it preserves results and categories from every eligible source and
  exposes no raw upstream, dashboard, credential, provider, or configuration
  mutation API;
- exact pinned pristine SearXNG and Jackett services run under disposable
  rootless containers while both ported services run directly on the host, and
  their original APIs pass the side-by-side corpus with raw evidence and no
  unexplained normalized difference;
- torrent results render as the specified semantic table with a per-row
  Download action and default Seeders-descending order until the user chooses
  another sort;
- an agent torrent search that omits sort and direction uses Seeders descending
  with nulls last and never inherits transient UI sort state;
- torrent discovery, sorting, metadata, all/subset file selection, and agent
  operations work through the native manager;
- pristine-versus-port parity evidence and all security/lifecycle gates pass;
- existing browser-control, torrent transport, Tor, Agent, and AppImage
  behavior remains green;
- the externally built AppImage passes clean-host end-to-end testing;
- the source tree is clean apart from the reviewed commit stack;
- commits are pushed normally to the configured WildBuzzard remote; and
- the final externally built WildBuzzard product is opened and the critical UI
  flows are verified.

## Primary upstream references

- `pi-web-access`: <https://github.com/nicobailon/pi-web-access/tree/692483ae782e41978fb2eba0eec70fd4056608c8>
- `pi-web-access` license: <https://github.com/nicobailon/pi-web-access/blob/692483ae782e41978fb2eba0eec70fd4056608c8/LICENSE>
- `pi-web-access` SearXNG adapter: <https://github.com/nicobailon/pi-web-access/blob/692483ae782e41978fb2eba0eec70fd4056608c8/searxng.ts>
- `pi-web-access` Firecrawl adapter: <https://github.com/nicobailon/pi-web-access/blob/692483ae782e41978fb2eba0eec70fd4056608c8/firecrawl.ts>
- `pi-web-access` GitHub extractor: <https://github.com/nicobailon/pi-web-access/blob/692483ae782e41978fb2eba0eec70fd4056608c8/github-extract.ts>
- `pi-web-access` YouTube extractor: <https://github.com/nicobailon/pi-web-access/blob/692483ae782e41978fb2eba0eec70fd4056608c8/youtube-extract.ts>
- `pi-web-access` SSRF implementation: <https://github.com/nicobailon/pi-web-access/blob/692483ae782e41978fb2eba0eec70fd4056608c8/ssrf-protection.ts>
- SearXNG Search API: <https://docs.searxng.org/dev/search_api.html>
- SearXNG installation: <https://docs.searxng.org/admin/installation-searxng.html>
- SearXNG license: <https://github.com/searxng/searxng/blob/b023a28bab8839dba9eac96e9a51cc91bbd0a267/LICENSE>
- Firecrawl self-host baseline: <https://github.com/firecrawl/firecrawl/blob/v2.11.193/SELF_HOST.md>
- Firecrawl Compose stack: <https://github.com/firecrawl/firecrawl/blob/v2.11.193/docker-compose.yaml>
- Firecrawl Playwright caller: <https://github.com/firecrawl/firecrawl/blob/v2.11.193/apps/api/src/scraper/scrapeURL/engines/playwright/index.ts>
- Firecrawl Playwright service: <https://github.com/firecrawl/firecrawl/blob/v2.11.193/apps/playwright-service-ts/api.ts>
- Firecrawl license: <https://github.com/firecrawl/firecrawl/blob/v2.11.193/LICENSE>
- Jackett release: <https://github.com/Jackett/Jackett/releases/tag/v0.24.2360>
- Jackett license: <https://github.com/Jackett/Jackett/blob/0cd8622b735922a909a128d8d6943bb8565a640f/LICENSE>
- Jackett API documentation: <https://github.com/Jackett/Jackett/wiki/Jackett-API>
- Jackett API usage: <https://github.com/Jackett/Jackett#api-usage>
- Jackett definition format: <https://github.com/Jackett/Jackett/wiki/Definition-format>
- Jackett categories: <https://github.com/Jackett/Jackett/wiki/Jackett-Categories>
- Torznab published specification: <https://torznab.github.io/spec-1.3-draft/>
- Torznab public repository: <https://github.com/torznab/torznab.github.io>
- yt-dlp release: <https://github.com/yt-dlp/yt-dlp/releases/tag/2026.07.04>
- Playwright browser limitations: <https://playwright.dev/docs/browsers>
- Playwright CDP limitation: <https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp>
- Firefox Remote Agent security model: <https://firefox-source-docs.mozilla.org/remote/Security.html>
