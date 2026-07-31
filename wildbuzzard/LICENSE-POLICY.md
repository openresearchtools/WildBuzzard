<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# WildBuzzard licensing policy

WildBuzzard is distributed as a combined work under
`AGPL-3.0-only`. This choice applies strong copyleft to WildBuzzard-original
browser, agent, automation, service, and user-interface work, including the
source-availability requirement for modified AGPL software used over a network.

It does not erase or replace inherited licenses.

## License layers

| Material | Governing treatment |
| --- | --- |
| WildBuzzard-original source | `AGPL-3.0-only` |
| Mozilla and Waterfox MPL files | Preserve MPL-2.0 notices; additionally distribute under AGPL-3.0-only only where MPL-2.0 section 3.3 permits |
| MPL files marked incompatible with Secondary Licenses | MPL only; exclude from any claim of AGPL secondary licensing |
| `adblock-rs` | MPL-2.0 notice retained |
| uBlock Origin code, scriptlets, resources, and lists | Retain the applicable GPL-3.0 notice and exact source revision |
| Other filter lists and data | Retain each asset's GPL, Creative Commons, attribution, or other terms |
| Third-party libraries | Their existing licenses |

AGPL is not a mechanism for converting third-party assets to AGPL. An asset
with unclear redistribution permission remains excluded until permission or a
clear upstream license is documented.

## Porting requirements

- Preserve every legal notice and the original Git author where history is
  available.
- Record the exact upstream repository and full commit for copied or generated
  code and data.
- Add an SPDX identifier to new WildBuzzard-original files.
- Do not add an AGPL identifier to an inherited file if doing so would
  contradict its existing notice or the rights actually granted.
- Keep source-generation scripts and the preferred form for modification of
  generated assets.
- Make the complete corresponding source for every distributed build
  available from the release that provides that build.
- If a WildBuzzard AGPL component is modified and used through a network, keep
  an accessible source link in that component as required by AGPL section 13.

## Branding is not attribution

Product names, logos, promotional UI, partner configuration, service URLs,
telemetry, and updater endpoints may be removed or replaced. Copyright lines,
license headers, source notices, author credits, and license entries must not
be removed with them.
