# Per-tab Tor routing and onion authorizations

WildBuzzard routes Tor tabs through the bundled C Tor client.
DNS stays in Tor and requests have no direct-network fallback. Each tab supplies
separate SOCKS credentials for stream isolation. Other tabs retain their own
network configuration.

Tor sites use private storage by default. The authorization dialog and manager
have a **Private mode for this onion site** switch. Turning it off lets that
onion domain (including its subdomains) keep ordinary login cookies, site data,
and browsing history, while all traffic still uses Tor. Other domains remain
private unless separately configured. Switching storage replaces the tab's
storage context and preserves its agent page ID and ownership. The private-mode
icon has a “Private mode” tooltip; tab titles and outlines use their normal style.

V3 onion services that require client authorization open a private-key prompt.
Accept a 52-character base32 or 44-character base64 X25519 private key from the
service operator. A rejected key prompts again with an explanation. Subframes
cannot open this authorization prompt.

Private-mode keys are session-only unless the user chooses to remember them.
Turning off Private mode for a trusted site also remembers its key, so reopening
the browser does not require entering it again.
Tools > Onion authorizations lists, replaces, and removes saved or session keys.
An optional identity name labels the authorization for that onion service.
One key is active per service in the profile's Tor instance, shared by its windows.

Shell agents can use `wildbuzzard onion-auth list`, `onion-auth remove ADDRESS`,
and `wildbuzzard --input - onion-auth set`. The set command reads a JSON object
with `address`, `key`, optional `name`, and optional `remember` from standard input.
Private keys are not accepted as command-line flags. Listing returns addresses,
names, and persistence status without private keys. Setting a key also completes
an open authorization prompt for that service and retries the page.
The same JSON can include `privateMode: false` for a trusted domain. Use
`wildbuzzard onion-auth privacy ADDRESS --private-mode false` to change the
domain setting without supplying its key; `true` restores private mode.
The trusted domain and its key are saved together in encrypted storage. Restoring
Private mode retains the saved key; removing the authorization forgets both.

Saved addresses, names, and keys are encrypted together through Mozilla's NSS
Secret Decoder Ring, using the same credential encryption and Primary Password
as the password manager. They are not bookmarks, preferences, synced logins, or
plaintext `.auth_private` files. The running Tor client receives unlocked keys
through its cookie-authenticated local control connection, without the Permanent
flag, and keeps them in memory. A Primary Password protects access when configured;
profile encryption alone does not protect against another process running as the
same user with access to an unlocked profile.

The main browser process owns Tor using TAKEOWNERSHIP. Closing one tab/window or
crashing a content process does not terminate it. Browser quit or loss of the
owning control connection terminates the Tor process. The startup owner PID
covers the interval before the control connection is established.

Tor routing does not reproduce Tor Browser's complete fingerprinting defenses,
security levels, or anonymity model.

## Upstream and build

`third_party/tor` contains the unmodified Tor 0.4.9.11 release commit. The exact
tag, tag object, commit, tree, archive checksum, and license checksum are pinned
in `wildbuzzard/third_party/tor.toml`. Update that pin and the vendored tree from
an official stable release together; do not substitute a distribution binary.

Build with `wildbuzzard/scripts/build-tor-runtime.sh --build-root DIR` in the
configured Ubuntu 24.04 builder, using a Data-drive directory. The script verifies
every vendored source file against the pinned commit and builds with static
OpenSSL, libevent, and zlib dependencies. Their exact versions and license texts
are recorded in `wildbuzzard/third_party/tor-notices/THIRD-PARTY.json`.

The output includes a runtime directory, the exact upstream source archive, and
a provenance ZIP binding the binary, pin and licenses. Debian assembly accepts
that runtime directory with `--tor-dir`; AppImage packaging and configured Gecko
builds validate the same provenance. Arti and its Cargo dependencies are removed.
