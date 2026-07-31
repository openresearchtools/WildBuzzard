<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Porting policy

## Source model

1. Start every WildBuzzard generation from Mozilla's current Firefox ESR
   security branch. Record the immutable release base and the exact security
   head commit in `upstreams.toml`.
2. Treat `base/*` and `waterfox` as immutable evidence. Never develop on them.
3. Recreate `integration/waterfox-port` from the current ESR base, then port
   narrowly scoped donor commits into it.
4. Move reviewed changes to `wildbuzzard/esr153` as small, independently
   auditable commits. Record the full donor commit in the commit message with a
   `Source-Waterfox-Commit:` trailer.
5. Rebase the integration branch onto each ESR security head and rebuild it
   again for the next ESR generation. Do not merge a Waterfox product branch
   into the product history.

## License and provenance

- Keep every existing copyright, SPDX, MPL, GPL, Creative Commons, attribution,
  and source notice in a donor file or asset.
- Modifications to MPL-covered files retain their MPL-2.0 notices. They may
  additionally be distributed under AGPL-3.0-or-later as part of the WildBuzzard
  Larger Work where MPL-2.0 section 3.3 permits.
- New WildBuzzard-original files use `SPDX-License-Identifier:
  AGPL-3.0-or-later`, except when a port or dependency requires another compatible
  notice.
- Do not relabel Waterfox-authored work as Mozilla- or WildBuzzard-authored.
- Review code and data separately. Filter lists, scriptlets, resources, and
  fallback data may have different licenses from the Rust engine or Firefox
  integration.
- Record the origin, exact revision, license, and redistribution terms of every
  imported list or generated asset. Do not ship an asset whose redistribution
  basis is unclear.
- Prefer Firefox's vendored Rust dependency workflow and locked crates. Do not
  add floating Git dependencies, downloaded build-time binaries, or a second
  copy of `adblock-rs`.

Firefox ESR 153 already vendors the same `adblock-rs` 0.12.1 tree used by the
Waterfox donor snapshot. WildBuzzard therefore ports bindings and product
integration against that existing tree.

## Product exclusions

The following must not be copied from Firefox, Waterfox, Brave, or another
vendor into a shipping WildBuzzard configuration:

- vendor branding, logos, trademarks, theme identity, or promotional UI;
- sponsored or partner search configuration and paid placement;
- telemetry, studies, experiments, health reports, crash-upload clients, or
  usage pings;
- vendor account, proxy, relay, AI, search, OHTTP, suggestion, advertising, or
  affiliate services;
- Firefox, Waterfox, or Brave application-update endpoints and release signing
  infrastructure;
- vendor-specific onboarding, feedback, upgrade, and marketing pages.

The endpoint inventory must be tested from a clean profile. A shipping build
must make no undeclared background request. Security data that would normally
come from a vendor service must either be reproducibly bundled or use a
separately documented, auditable, non-vendor source; silently disabling a
security control is not an acceptable substitute.

## Acceptance checks

Each port must pass:

- license and provenance review;
- a diff review showing no unrelated donor product code;
- a source-tree search for added URLs, hosts, API keys, partner identifiers,
  telemetry probes, and update configuration;
- relevant Firefox build and test targets;
- clean-profile network observation;
- functional content-blocking tests with first-party breakage controls;
- a reproducible Linux build with generated-file changes committed.
