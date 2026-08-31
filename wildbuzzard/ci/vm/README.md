# WildBuzzard release VM validation

This harness installs one unchanged set of three `amd64` Debian packages in fresh Ubuntu 24.04 and Debian 13 GNOME virtual machines. It validates the command-line contracts, the installed browser, the two built-in extensions, and both browser-page and full GNOME display evidence.

The tracked scripts in this directory are canonical. The copies used from `.local/oci-builder` must be byte-for-byte identical before a release run:

```sh
cmp wildbuzzard/ci/vm/release-vm-validate.py .local/oci-builder/release-vm-validate.py
cmp wildbuzzard/ci/vm/release-vm-guest-validate.py .local/oci-builder/release-vm-guest-validate.py
```

## Storage and VM identities

Use `qemu:///session`. Release packages, immutable backing images, disposable overlays, saved domain XML, and validation results must remain below `/run/media/user/Data`. The host preflight rejects artifact, output, writable disk, or backing paths outside that tree. It also rejects a writable disk that is not a qcow2 overlay with a backing image.

The current release domains and required harness labels are:

| Label | Guest | Libvirt domain |
| --- | --- | --- |
| `ubuntu2404` | Ubuntu 24.04 amd64 | `wildbuzzard-release-ubuntu2404-20260830t134806z` |
| `debian13` | Debian 13 amd64 | `wildbuzzard-release-debian13-20260830T134816Z` |

Each domain needs:

- a QEMU user-network interface, which exposes the host artifact server to the guest as `10.0.2.2`;
- a connected `org.qemu.guest_agent.0` virtio channel and a running `qemu-guest-agent` service;
- one logged-in normal GNOME user with a working user D-Bus and Wayland or X11 display;
- its writable system disk at the exact Data-backed overlay path documented below.

The normal GNOME accounts are `ubuntu` on Ubuntu and `debian` on Debian. The disposable local lab credential is the password `debian`. It is not a production credential, and neither validator accepts or automates it; guest automation uses the already configured QEMU guest agent. The guest validator disables idle locking for the disposable validation session and asks logind to keep it unlocked so the final display capture contains the browser.

Check QGA without changing the guest:

```sh
virsh -c qemu:///session qemu-agent-command \
  wildbuzzard-release-ubuntu2404-20260830t134806z \
  '{"execute":"guest-ping"}'
virsh -c qemu:///session qemu-agent-command \
  wildbuzzard-release-debian13-20260830T134816Z \
  '{"execute":"guest-ping"}'
```

## Recreate fresh overlays

The immutable backing images are:

- Ubuntu: `/run/media/user/Data/VirtualMachines/gnozzard-ubuntu2404-final-clean/gnozzard-ubuntu2404-final-clean-pristine-noble-gnome.raw`
- Debian: `/run/media/user/Data/VirtualMachines/gnozzard-debian13-final-clean/gnozzard-debian13-final-clean-pristine-debian13.6-gnome.raw`

The defined domains point to these disposable overlays:

- Ubuntu: `/run/media/user/Data/VirtualMachines/wildbuzzard-release-validation/20260830T134806Z/ubuntu2404/wildbuzzard-release-ubuntu2404.qcow2`
- Debian: `/run/media/user/Data/VirtualMachines/wildbuzzard-release-validation/20260830T134816Z-debian13/debian13-release-overlay.qcow2`

Before the final run, shut down both domains cleanly and verify `virsh -c qemu:///session domstate DOMAIN` reports `shut off`. Move each used overlay to a timestamped name in the same Data directory so it remains recoverable, then recreate the original path from its immutable raw backing image:

```sh
virsh -c qemu:///session shutdown wildbuzzard-release-ubuntu2404-20260830t134806z
virsh -c qemu:///session shutdown wildbuzzard-release-debian13-20260830T134816Z
virsh -c qemu:///session domstate wildbuzzard-release-ubuntu2404-20260830t134806z
virsh -c qemu:///session domstate wildbuzzard-release-debian13-20260830T134816Z
virsh -c qemu:///session dumpxml --inactive \
  wildbuzzard-release-ubuntu2404-20260830t134806z \
  > /run/media/user/Data/VirtualMachines/wildbuzzard-release-validation/20260830T134806Z/ubuntu2404/domain.xml
virsh -c qemu:///session dumpxml --inactive \
  wildbuzzard-release-debian13-20260830T134816Z \
  > /run/media/user/Data/VirtualMachines/wildbuzzard-release-validation/20260830T134816Z-debian13/domain.xml

mv --no-clobber /run/media/user/Data/VirtualMachines/wildbuzzard-release-validation/20260830T134806Z/ubuntu2404/wildbuzzard-release-ubuntu2404.qcow2 \
  /run/media/user/Data/VirtualMachines/wildbuzzard-release-validation/20260830T134806Z/ubuntu2404/wildbuzzard-release-ubuntu2404.used.qcow2
qemu-img create -f qcow2 -F raw \
  -b /run/media/user/Data/VirtualMachines/gnozzard-ubuntu2404-final-clean/gnozzard-ubuntu2404-final-clean-pristine-noble-gnome.raw \
  /run/media/user/Data/VirtualMachines/wildbuzzard-release-validation/20260830T134806Z/ubuntu2404/wildbuzzard-release-ubuntu2404.qcow2

mv --no-clobber /run/media/user/Data/VirtualMachines/wildbuzzard-release-validation/20260830T134816Z-debian13/debian13-release-overlay.qcow2 \
  /run/media/user/Data/VirtualMachines/wildbuzzard-release-validation/20260830T134816Z-debian13/debian13-release-overlay.used.qcow2
qemu-img create -f qcow2 -F raw \
  -b /run/media/user/Data/VirtualMachines/gnozzard-debian13-final-clean/gnozzard-debian13-final-clean-pristine-debian13.6-gnome.raw \
  /run/media/user/Data/VirtualMachines/wildbuzzard-release-validation/20260830T134816Z-debian13/debian13-release-overlay.qcow2

virsh -c qemu:///session start wildbuzzard-release-ubuntu2404-20260830t134806z
virsh -c qemu:///session start wildbuzzard-release-debian13-20260830T134816Z
```

Do not overwrite an existing `.used.qcow2`; choose another explicit Data-backed name when preserving more than one prior overlay. Start each domain, log its normal user into GNOME if the pristine baseline does not auto-login, wait for QGA, and run the preflight below. Do not delete or modify either raw backing image.

## Artifact set

Use this single directory for the final set:

`/run/media/user/Data/Repositories/wildbuzzard/.local/oci-builder/workspace/releases/20260830T132743Z-refactor/vm-debs`

It must contain exactly three top-level regular, non-symlink `.deb` files and no other `.deb`:

```text
vm-debs/
├── buzzard-minijtt_<version>_amd64.deb
├── buzzard-search_<version>_amd64.deb
└── wildbuzzard_<version>_amd64.deb
```

The host records size and SHA-256 for each file and checks package identity and architecture with `dpkg-deb`. `wildbuzzard` contains the native qBittorrent/libtorrent runtime and lists the two optional discovery CLIs as suggestions. `buzzard-search` and `buzzard-minijtt` are independently usable JSON CLIs; neither package depends on the browser or contains a web UI. The guest downloads the same three bytestrings from the temporary host server, verifies every manifest field before installation, and passes all three local paths together to `apt-get install --no-install-recommends`. APT may retrieve ordinary repository dependencies, but installed versions of the three release packages must exactly match the supplied files. The default freshness guard aborts if any release package is already installed.

Do not use `--allow-installed` for release evidence. Do not run beyond preflight until all three final files, including the final browser package, are present.

## Test and run

Run the focused non-installing tests:

```sh
python3 -m unittest -v wildbuzzard/ci/vm/test_release_vm_validate.py
```

Run the exact non-installing preflight after assembling all three files:

```sh
python3 wildbuzzard/ci/vm/release-vm-validate.py \
  --artifact-dir /run/media/user/Data/Repositories/wildbuzzard/.local/oci-builder/workspace/releases/20260830T132743Z-refactor/vm-debs \
  --connect qemu:///session \
  --vm ubuntu2404=wildbuzzard-release-ubuntu2404-20260830t134806z \
  --vm debian13=wildbuzzard-release-debian13-20260830T134816Z \
  --output-root /run/media/user/Data/VirtualMachines/wildbuzzard-release-validation/results \
  --preflight-only
```

After that passes and installation is authorized, run the exact same command without `--preflight-only`:

```sh
python3 wildbuzzard/ci/vm/release-vm-validate.py \
  --artifact-dir /run/media/user/Data/Repositories/wildbuzzard/.local/oci-builder/workspace/releases/20260830T132743Z-refactor/vm-debs \
  --connect qemu:///session \
  --vm ubuntu2404=wildbuzzard-release-ubuntu2404-20260830t134806z \
  --vm debian13=wildbuzzard-release-debian13-20260830T134816Z \
  --output-root /run/media/user/Data/VirtualMachines/wildbuzzard-release-validation/results
```

The host validates both VMs concurrently. Before launching the browser, the guest calls and validates every standalone CLI contract, including license inventory output. The browser fixture is served only on guest loopback because native browser control intentionally rejects `file:` navigation. The harness uses native accessibility snapshots and `click`, verifies that `about:addons` exposes exactly the two WildBuzzard extensions, and confirms that normal and private search defaults are DuckDuckGo. It then opens the web-search and torrent-search built-in pages by the UUIDs from the launched WildBuzzard profile, in separate control sessions, and uses native `fill` and `click`. Each page must expose a real CLI-backed search response before its screenshot is accepted.

Torrent validation also creates a deterministic private torrent and a loopback-only tracker and peer. It imports the metadata through the native `wildbuzzard` browser-control CLI, downloads the complete 96,768-byte payload through the bundled qBittorrent/libtorrent runtime, verifies its SHA-256, info hash, requested save path, list and detail contracts, and then removes the transfer with `deleteData=false`. The browser is then driven like a user to click a `.torrent` link and a magnet link, accept each native confirmation, complete and hash-check the file transfer, and inspect it in `about:torrents`. No public tracker, peer, or copyrighted payload is used. The same run verifies a direct non-Tor request, a Tor-routed request with a different egress address, and a live v3 onion page without recording either public IP address.

## Evidence layout

Each full run creates one UTC-and-PID directory:

```text
results/<YYYYmmddTHHMMSSZ-PID>/
├── artifacts.json
├── summary.json
├── debian13/
│   ├── artifact-verification.json
│   ├── browser-torrent-validation.json
│   ├── browser-torrent-download/
│   │   └── wildbuzzard-release-validation.bin
│   ├── browser-extension-profile.json
│   ├── builtin-extension-inspection.json
│   ├── cli/*.json
│   ├── fixture.html
│   ├── gnome-browser.png
│   ├── guest-command.stderr
│   ├── guest-command.stdout
│   ├── report.json
│   ├── torrent-download-validation.json
│   ├── torrent-download/
│   │   └── wildbuzzard-release-validation.bin
│   ├── torrent-release-validation.torrent
│   ├── screenshots/
│   │   ├── about-support.png
│   │   ├── extensions.png
│   │   ├── fixture-page.png
│   │   ├── search-settings.png
│   │   ├── tor-direct.png
│   │   ├── tor-onion.png
│   │   ├── tor-routed.png
│   │   ├── torrent-manager.png
│   │   ├── torrent-search-extension.png
│   │   └── web-search-extension.png
│   └── validation.log
└── ubuntu2404/
    └── same files as debian13/
```

The page screenshots and `gnome-browser.png` libvirt display capture are checked for nonzero dimensions and valid PNG framing. The host sends a harmless wake key before GUI work and again before capture. An implausibly small full-display image is rejected so QEMU's inactive-output placeholder cannot pass as evidence. The full display captures the final live v3 onion page in the Tor-routed tab. On failure, the harness preserves any guest results it can retrieve plus `failure.txt`, `failure-screen.png`, and separate pull or screenshot errors when applicable.
