<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# WildBuzzard source layout

WildBuzzard is built from an official Firefox ESR release, not from the
Waterfox product branch. Waterfox is retained as an immutable donor history so
selected privacy and content-blocking work can be reviewed and ported without
also inheriting Waterfox branding, services, partners, or release machinery.

## Branches

| Ref | Purpose | Mutation policy |
| --- | --- | --- |
| `base/firefox-153.0esr` | Exact Mozilla Firefox 153.0 ESR release | Immutable |
| `waterfox` | Exact fetched Waterfox donor snapshot | Immutable |
| `integration/waterfox-port` | Staging area for reviewed ports | Rebuildable |
| `wildbuzzard/esr153` | WildBuzzard product history | Release candidate |
| `main` | Pre-existing Mozilla Nightly fork history | Unchanged for now |

The immutable refs are also tagged as `upstream/firefox-153.0esr` and
`donor/waterfox-current-20260730`. Exact object IDs and dependency provenance
are in [`upstreams.toml`](upstreams.toml).

No Waterfox code has been placed on the product branch merely by creating these
refs. Candidate ports are tracked in [`ports.toml`](ports.toml), and the rules
for accepting them are in [`PORTING.md`](PORTING.md).

WildBuzzard is distributed as an AGPL-3.0-only combined work. Inherited
file-level licenses and notices remain in force; see
[`LICENSE-POLICY.md`](LICENSE-POLICY.md).

Linux builds and blocker tests run from a clean external checkout; see
[`BUILDING-LINUX.md`](BUILDING-LINUX.md).
