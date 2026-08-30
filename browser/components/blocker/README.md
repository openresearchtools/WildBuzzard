# WildBuzzard blocker component

This component is derived from the Waterfox blocker commits recorded in
`wildbuzzard/ports.toml`. The engine is Brave's `adblock-rs` v0.12.1
(MPL-2.0), and the inherited Waterfox integration remains MPL-2.0.

## Request and response flow

### Network requests

`WildBuzzardBlockerService` observes `http-on-modify-request`, normalises the request context, and calls `checkRequestDetailed(...)` on `nsIWildBuzzardBlockerEngine`. XPCOM forwards through the C++ `ContentClassifierEngine` into the Rust FFI and `adblock-rs`.

If the request matches and there is no exception, resources that are not documents are cancelled and documents loaded at the top level are redirected to `blockedPage.xhtml`. Clicking "Load anyway" goes through the `WildBuzzardBlockedPage` actor, records a permission for the session in `nsIPermissionManager`, and navigates to the original URL.

Normal windows use `wildbuzzard-blocker`, private windows use
`wildbuzzard-blocker-pb`, and the private permission type is cleared when the
last private context exits. Permanent user exceptions remain normal
`wildbuzzard-blocker` permissions: a site permanently allowed in normal
browsing is still blocked in private windows, where it can be allowed again
from the panel for that session.

### CSP rules

The service also observes `http-on-examine-response` (plus the cached and merged variants). For `document` and `subdocument` loads it calls `getCspDirectives(...)`, and if directives come back it sets `Content-Security-Policy` on the response.

### Cosmetic filters and scriptlets

The child actor asks the parent for cosmetic resources for the current URL, the parent queries the service, and the child applies hide selectors, procedural cosmetic filters, and generic hide updates. Scriptlets are injected into the page's main world when present.

## Filter sources and My Filters

The engine is built from three sources.

Catalog lists are resolved from `assets/list_catalog.json`. Bundled fallback files under `assets/filters/` are used when the profile cache and a network refresh are both unavailable.

Custom filter list URLs come from the Custom Filter Lists dialog and live in `wildbuzzard.blocker.filterListUrls`, which must use HTTPS. They are fetched into the profile list cache and refresh through the same path as catalog lists.

My Filters reads from profile text at
`ProfD/wildbuzzard-blocker/custom-filters.txt`, using standard uBlock Origin
static filter syntax. It supports the same engine features as list filters:
network rules, exceptions, cosmetic filters, procedural cosmetics, scriptlets,
and CSP rules where `adblock-rs` supports them.

My Filters is deliberately separate from uBlock Origin's dynamic "My rules". Dynamic allow/block/noop rules are not parsed by `adblock-rs` and are out of scope here.

## Scriptlet bundling

uBO scriptlets now ship as ESM. The inherited integration follows Brave's
Node.js packaging flow because the older `adblock-rs` assembler does not handle
that format well.

`scripts/update-bundled-assets.js` reads uBO's redirect resource mapping and
merges those resources into `assets/resources/resources.json` alongside
Brave's supplementary resources.

The same script writes `assets/resources/ubo-scriptlets.json`. Runtime code
loads only these bundled copies; it has no WildBuzzard or Waterfox resource
update endpoint.

`assets/SOURCES.lock.json` pins the exact Brave and uBlock commits, upstream
archive and input hashes, generator Node version, and output hashes. The
generator refuses a different revision, runtime, or output. Release builds use
`wildbuzzard/scripts/blocker_asset_provenance.py` to reproduce the outputs and
publish `wildbuzzard-blocker-assets-source.tar.xz` with both complete upstream
source archives, licences, generators, lock, and generated data.

## Licensing

| Item | Source | Licence or notice | Notes |
| --- | --- | --- | --- |
| `adblock-rs` (v0.12.1) | Brave | MPL-2.0 | Core blocking engine |
| Brave entries in `resources/resources.json` | Brave (`adblock-resources`) | MPL-2.0 | Redirect and script resources |
| uBO redirect entries in `resources/resources.json` | `gorhill/uBlock` | GPL-3.0-only | Generated offline and bundled as data |
| Generated `resources/ubo-scriptlets.json` | `gorhill/uBlock` | GPL-3.0-only | Generated offline and bundled as data |
| uBO fallback filter files | `uBlockOrigin/uAssets` | GPL-3.0 | Files named `ublock-*.txt` in `assets/filters/` |
| AdGuard tracking parameter fallback list | `AdguardTeam/AdGuardFilters` | GPL-3.0 | `assets/filters/adguard-tracking-protection.txt` |
| EasyList and EasyPrivacy fallback lists | EasyList authors | GPL-3.0-or-later or CC BY-SA-3.0-or-later | WildBuzzard uses the GPL-3.0 option in `about:license` |
| EasyList Cookie fallback list | EasyList authors | CC BY 3.0 | `assets/filters/easylist-cookie.txt` |
| Peter Lowe's Ad and Tracking Server fallback list | Peter Lowe | Credit and policy notice | The bundled file has upstream credit and policy URLs, but no standard licence header |
| Filter catalog and inherited integration | Waterfox | MPL-2.0 | Rust/C++/JS integration, UI, and catalog metadata; Waterfox attribution retained |
