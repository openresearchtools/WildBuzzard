<!-- SPDX-License-Identifier: GPL-2.0-or-later -->

# qBittorrent source module

This directory contains the complete, unmodified qBittorrent 5.2.3 source tree at commit `0b63c3d17373f6132ea211c9dcd4241284ccdfaf`. The signed `release-5.2.3` tag and its signing key are recorded in `UPSTREAM.toml`.

WildBuzzard changes are maintained as an ordered patch series outside `upstream/`. The product builds qBittorrent headlessly and exposes its WebUI and WebAPI only through a private mode-0600 Unix-domain socket. The downstream binary omits qBittorrent's search manager, Python launcher and resources, search WebAPI, search WebUI, search-specific downloader hooks, and the pre-add URL/magnet metadata downloader. `POST /api/v2/torrents/add` accepts only 8192-byte, 16-parameter canonical BTIH magnets in its URL-string field, with optional keys limited to `dn`, `tr`, `xl`, and `so`, or locally parsed, request-bounded `.torrent` uploads. It rejects remote torrent URLs, exact-source/webseed magnet parameters, unknown magnet keys, and other URI schemes without calling a native downloader. Parsed upload cache identifiers use a separate form field. Optional torrent discovery belongs to the separately installed `buzzard-minijtt` CLI and trusted release extension.

The pristine source tree and corresponding source package retain qBittorrent's original search sources, license files, and notices for provenance and license compliance; those sources are not compiled or embedded in the WildBuzzard runtime. Source files are GPL-2.0-or-later; the assembled qBittorrent binary is GPL-3.0-or-later under upstream's documented combined-work terms. `UPSTREAM.toml` records the SHA-256 of the patch payloads concatenated in `patches/series` order.
