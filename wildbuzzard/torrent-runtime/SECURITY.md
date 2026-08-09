# Torrent runtime security notes

The runtime is built from the pinned WebTorrent source in
`third_party/webtorrent`. Optional native accelerators are omitted. The
`utp-native` npm archive contains prebuilt native modules; the build removes
all of them and compiles the Linux N-API module from the included C/C++ and
libutp source. It also removes every transitive `prebuilds` directory and fails
if any native artifact remains besides that locally built µTP module.

The Node WebRTC polyfill depends on an opaque `node-datachannel` prebuild and is
not needed for native BitTorrent swarms. A source-only compatibility shim makes
WebRTC capability detection return false. TCP, µTP, HTTP/UDP trackers, DHT,
PEX, LSD, and web seeds remain enabled.

`npm audit` currently propagates GHSA-2p57-rm9w-gvfp from the `ip` package
through `bittorrent-tracker`, `torrent-discovery`, and WebTorrent. WebTorrent
uses the tracker package as a client. The affected `ip.isPublic()` function is
only imported by the tracker server's UDP request parser and is not reachable
from the embedded client. The build records the complete audit result and
fails if any critical advisory or any different high-severity advisory enters
the production dependency graph.
