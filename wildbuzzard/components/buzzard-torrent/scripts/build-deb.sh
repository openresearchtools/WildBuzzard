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
python3 -I -B "${component_root}/scripts/verify-runtime.py" --runtime "${runtime}"
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
python3 -I -B "${component_root}/scripts/verify-runtime.py" \
  --runtime "${root}/usr/lib/buzzard-torrent/runtime"
install -m 0644 "${component_root}/README.md" "${root}/usr/share/doc/buzzard-torrent/README.md"
install -m 0644 "${component_root}/LICENSE" "${root}/usr/share/doc/buzzard-torrent/LICENSE.packaging"
install -m 0644 "${component_root}/debian/copyright" "${root}/usr/share/doc/buzzard-torrent/copyright"
gzip -n -9 -c "${component_root}/debian/changelog" >"${root}/usr/share/doc/buzzard-torrent/changelog.Debian.gz"
installed_kib="$(du --apparent-size --block-size=1024 --summarize "${root}/usr" | awk '{print $1}')"
if ((installed_kib > 131072)); then
  echo "buzzard-torrent installed payload exceeds 128 MiB" >&2
  exit 1
fi
if grep -q '^Installed-Size:' "${root}/DEBIAN/control"; then
  echo "Static control file must not set Installed-Size" >&2
  exit 1
fi
printf 'Installed-Size: %s\n' "${installed_kib}" >>"${root}/DEBIAN/control"
find "${root}" -exec touch --no-dereference --date="@${SOURCE_DATE_EPOCH}" {} +
mkdir -p -- "${output}"
package="${output}/buzzard-torrent_0.1.0-1_amd64.deb"
dpkg-deb --root-owner-group --uniform-compression -Zzstd -z10 --build \
  "${root}" "${package}"
if (( $(stat -c %s "${package}") > 100663296 )); then
  echo "buzzard-torrent Debian package exceeds 96 MiB" >&2
  exit 1
fi
