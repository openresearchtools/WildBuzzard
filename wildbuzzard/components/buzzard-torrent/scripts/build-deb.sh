#!/usr/bin/env bash

set -Eeuo pipefail
umask 022

component_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
runtime="${BUZZARD_TORRENT_RUNTIME:-}"
output="${1:-${component_root}/dist}"
if [[ -z "${runtime}" || ! -d "${runtime}" || ! -x "${runtime}/bin/qbittorrent-nox" ]]; then
  echo "Set BUZZARD_TORRENT_RUNTIME to the pinned unpacked qBittorrent runtime" >&2
  exit 2
fi
if [[ -z "${SOURCE_DATE_EPOCH:-}" ]]; then
  SOURCE_DATE_EPOCH="$(stat -c %Y "${runtime}/bin/qbittorrent-nox")"
fi
if [[ ! "${SOURCE_DATE_EPOCH}" =~ ^[0-9]+$ ]]; then
  echo "SOURCE_DATE_EPOCH must be an integer" >&2
  exit 2
fi
export SOURCE_DATE_EPOCH TZ=UTC LC_ALL=C
stage="$(mktemp -d)"
trap 'rm -r -- "${stage}"' EXIT
root="${stage}/buzzard-torrent_0.1.0-1_amd64"
install -d -m 0755 "${root}/DEBIAN" "${root}/usr/bin" "${root}/usr/lib/buzzard-torrent/runtime" "${root}/usr/share/doc/buzzard-torrent"
install -m 0644 "${component_root}/packaging/control" "${root}/DEBIAN/control"
install -m 0755 "${component_root}/packaging/buzzard-torrent" "${root}/usr/bin/buzzard-torrent"
install -m 0755 "${component_root}/packaging/buzzard-torrent-mcp" "${root}/usr/bin/buzzard-torrent-mcp"
install -m 0644 "${component_root}/src/buzzard_torrent.py" "${root}/usr/lib/buzzard-torrent/buzzard_torrent.py"
install -m 0644 "${component_root}/src/buzzard_torrent_mcp.py" "${root}/usr/lib/buzzard-torrent/buzzard_torrent_mcp.py"
cp -a -- "${runtime}/." "${root}/usr/lib/buzzard-torrent/runtime/"
chmod 0755 "${root}/usr/lib/buzzard-torrent/runtime"
install -m 0644 "${component_root}/README.md" "${root}/usr/share/doc/buzzard-torrent/README.md"
install -m 0644 "${component_root}/LICENSE" "${root}/usr/share/doc/buzzard-torrent/LICENSE.packaging"
install -m 0644 "${component_root}/debian/copyright" "${root}/usr/share/doc/buzzard-torrent/copyright"
gzip -n -9 -c "${component_root}/debian/changelog" >"${root}/usr/share/doc/buzzard-torrent/changelog.Debian.gz"
find "${root}" -exec touch --no-dereference --date="@${SOURCE_DATE_EPOCH}" {} +
mkdir -p -- "${output}"
dpkg-deb --root-owner-group --uniform-compression -Zzstd -z10 --build \
  "${root}" "${output}/buzzard-torrent_0.1.0-1_amd64.deb"
