<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# WildBuzzard source layout

WildBuzzard is built from Mozilla's current Firefox ESR 153 security branch,
not from the Waterfox product branch. Waterfox is retained as an immutable
donor history so its browser UI and privacy work can be reviewed and ported
without inheriting Waterfox branding, services, partners, or release machinery.

## Branches

| Ref | Purpose | Mutation policy |
| --- | --- | --- |
| `base/firefox-153.0esr` | Exact Mozilla Firefox 153.0 ESR release | Immutable |
| `mozilla/esr153` | Current Mozilla ESR 153 security-update head | Upstream tracking |
| `waterfox` | Exact fetched Waterfox donor snapshot | Immutable |
| `integration/waterfox-port` | Staging area for reviewed ports | Rebuildable |
| `wildbuzzard/esr153` | WildBuzzard product history | Release candidate |
| `main` | Pre-existing Mozilla Nightly fork history | Unchanged for now |

The immutable refs are also tagged as `upstream/firefox-153.0esr` and
`donor/waterfox-current-20260730`. The exact Mozilla security-head commit,
donor object IDs, and dependency provenance are in
[`upstreams.toml`](upstreams.toml). Port decisions are tracked in
[`ports.toml`](ports.toml), and the rules for accepting them are in
[`PORTING.md`](PORTING.md).

WildBuzzard is distributed as an AGPL-3.0-or-later combined work. Inherited
file-level licenses and notices remain in force; see
[`LICENSE-POLICY.md`](LICENSE-POLICY.md).

Linux builds and blocker tests run from a clean external checkout; see
[`BUILDING-LINUX.md`](BUILDING-LINUX.md).

Wild Buzzard is intentionally agent-independent. Component ownership, the
standalone Agent and search repositories, bundled offline extension UIs with
separately packageable release-pinned XPIs, and the
browser security boundary are documented in
[`COMPONENT-PACKAGE-ARCHITECTURE.md`](COMPONENT-PACKAGE-ARCHITECTURE.md) and
enforced by [`FEATURE-OWNERSHIP.toml`](FEATURE-OWNERSHIP.toml).
The Git reconstruction and retained-feature decisions are recorded in
[`AGENT-EXTRACTION.md`](AGENT-EXTRACTION.md).
