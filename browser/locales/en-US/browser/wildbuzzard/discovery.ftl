# SPDX-License-Identifier: AGPL-3.0-or-later

wildbuzzard-torrent-extension-confirm-title = Add torrent?
# $name is the torrent name, $source is its origin, $kind is the input type, and $size is the metadata size.
wildbuzzard-torrent-extension-confirm-message =
    Add “{ $name }” to the native torrent downloader?
    Source: { $source }
    Content: { $kind ->
        [magnet] Magnet link
       *[torrent] Torrent metadata
    }
    Size: { $size ->
        [unknown] Unknown
       *[other] { $size } bytes
    }

wildbuzzard-torrent-webui-confirm-title = Add torrent?
wildbuzzard-torrent-webui-confirm-message =
    Allow the torrent manager to add the selected torrent?
