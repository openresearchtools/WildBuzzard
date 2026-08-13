<!-- SPDX-License-Identifier: BSD-3-Clause -->

# libtorrent source module

This directory contains the complete pinned libtorrent 2.0.14 source tree plus the two exact source submodules required by its host-native build. It supplies the BitTorrent protocol engine for the bundled headless qBittorrent process; users do not need to install libtorrent or another torrent application.

The build produces a private static library in an external object directory. Python bindings, examples, tests, and the simulator submodule are not part of the shipping build.

