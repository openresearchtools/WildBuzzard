<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Pre-fix `.torrent` picker reproduction

The retained predecessor AppImage reproduced the original file-picker failure
in a fresh profile on 2026-08-10. The test was headed under X11 and controlled
through geckodriver 0.37.0 with privileged system access.

## Tested build

- AppImage: `WildBuzzard-153.1.0-x86_64.AppImage`
- AppImage SHA-256: `4ed86d499b945adc542aac0a82559a31ac14eb0ee4de96b64749f568da1abccc`
- Browser version: `153.1.0`
- Browser build ID: `20260809211417`
- Headless capability: `false`

## Exact reproduction

1. Start the AppImage with a new browser profile and isolated XDG data,
   configuration, cache, and runtime directories.
2. Open `about:torrents`.
3. Activate **Choose .torrent file** with a real WebDriver element click.
4. Observe that no native chooser opens and the page reports
   `Could not convert JavaScript argument arg 0 [nsIFilePicker.init]`.

The page caught the rejection and displayed it as a toast, so it did not leave
an uncaught browser-console entry. Invoking the same privileged manager method
from the chrome debugging context preserved the underlying stack:

```text
NS_ERROR_XPC_BAD_CONVERT_JS: Could not convert JavaScript argument arg 0 [nsIFilePicker.init]
chooseTorrentFile@resource:///modules/TorrentManager.sys.mjs:441:12
```

The predecessor passed a `navigator:browser` window to `nsIFilePicker.init`.
That browser-side picker was removed with the agent UI. The retained torrent UI
uses qBittorrent's file input, and externally served `.torrent` responses use
Firefox's normal download flow before an explicit import.

## Evidence

Compact evidence is retained outside the source checkout at
`/home/user/Downloads/WildBuzzard-control-artifacts/torrent-picker-pre-fix-20260810`.
The extracted predecessor, temporary profiles, XDG state, and persistent test
torrent sidecar were removed after capture.

| File | SHA-256 |
| --- | --- |
| `headed-session.json` | `225ec3b7ace1832cd6a8a2407db8a48f9c027a13ca9545dcd9be8ad26e0d2382` |
| `headed-before-click.png` | `249ca1bc114b3dfa96573d5768061dccaf63c83e5f54bc76161135b7400668ff` |
| `headed-after-click.png` | `e52858e7ccf85ebe8ee8d47d81980c17272cfa2b81c2cbf956cd848ef31fd17d` |
| `headed-ui-after-click.json` | `4a9721ab517d142d355c46d31e1cf09dc936a9011912604ab149b3e207bebb00` |
| `headed-direct-stack.json` | `2b542db05ddbcc5cfd1744e6e533f98376e165ee011370d371912641df2fd39d` |
