<!-- SPDX-License-Identifier: GPL-2.0-or-later -->

# qBittorrent source module

This directory contains the complete, unmodified qBittorrent 5.2.3 source tree at commit `0b63c3d17373f6132ea211c9dcd4241284ccdfaf`. The signed `release-5.2.3` tag and its signing key are recorded in `UPSTREAM.toml`.

WildBuzzard changes are maintained as an ordered patch series outside `upstream/`. The product builds qBittorrent headlessly, exposes its WebUI and WebAPI only through a private mode-0600 Unix-domain socket, and uses the bundled Jackett Mini service as its immutable torrent-search provider. The product does not ship qBittorrent's Python search-plugin runtime.

The pristine source tree retains qBittorrent's original license files and notices. Source files are GPL-2.0-or-later; the assembled qBittorrent binary is GPL-3.0-or-later under upstream's documented combined-work terms.

