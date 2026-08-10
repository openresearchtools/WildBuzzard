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

Tor mode uses authenticated SOCKS5 hostname resolution for HTTP(S)/WebSocket
trackers and every outgoing TCP peer. It disables µTP, UDP trackers, DHT, LSD,
web seeds, NAT traversal, and incoming listeners so a failed Tor proxy stalls
the torrent instead of falling back to the direct network. Magnet drafts and
downloads remove `as`, `ws`, and `xs` alternate-source parameters before they
reach WebTorrent in Tor mode, and all accepted metadata is size and structure
bounded before it can become a download.

The loopback API requires a random bearer, rejects browser origins and
misdirected Host headers, compares credentials in constant time, and bounds
request rate and concurrency. Connection records are accepted only when the
PID start time, executable path and digest, data root, runtime root, owner
instance, and live health identity all agree. Launch and service-owner locks
prevent concurrent starters from replacing one another's records.

Runtime archives contain a complete size and SHA-256 manifest. Extraction
rejects duplicate, extra, traversal, symbolic-link, non-regular, and unexpected
executable entries, verifies every installed file, and activates a staged tree
with an extraction lock and atomic rename. The source builder uses a pinned
Node archive checksum, the bundled Node/npm for every npm operation, normalized
timestamps and permissions, sorted ZIP input, and an in-build byte-for-byte
archive reproducibility check.

`npm audit` currently propagates GHSA-2p57-rm9w-gvfp from the `ip` package
through `bittorrent-tracker`, `torrent-discovery`, and WebTorrent. WebTorrent
uses the tracker package as a client. The affected `ip.isPublic()` function is
only imported by the tracker server's UDP request parser and is not reachable
from the embedded client. The build records the complete audit result and
fails if any critical advisory or any different high-severity advisory enters
the production dependency graph.
