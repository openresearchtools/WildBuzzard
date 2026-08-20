#!/usr/bin/env bash

set -Eeuo pipefail
umask 022

component_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
runtime="${BUZZARD_TORRENT_SEARCH_RUNTIME:-}"
node_root="${BUZZARD_NODE_ROOT:-/opt/node}"
output="${1:-${component_root}/dist}"
if [[ -z "${runtime}" || ! -e "${runtime}" ]]; then
  echo "Set BUZZARD_TORRENT_SEARCH_RUNTIME to the pinned Jackett Mini runtime directory" >&2
  exit 2
fi
if [[ ! -x "${node_root}/bin/node" ]]; then
  echo "Set BUZZARD_NODE_ROOT to the pinned Node.js runtime" >&2
  exit 2
fi
if [[ -z "${SOURCE_DATE_EPOCH:-}" ]]; then
  SOURCE_DATE_EPOCH="$(stat -c %Y "${runtime}/jackett-mini")"
fi
if [[ ! "${SOURCE_DATE_EPOCH}" =~ ^[0-9]+$ ]]; then
  echo "SOURCE_DATE_EPOCH must be an integer" >&2
  exit 2
fi
export SOURCE_DATE_EPOCH TZ=UTC LC_ALL=C
stage="$(mktemp -d)"
trap 'rm -r -- "${stage}"' EXIT
root="${stage}/buzzard-torrent-search_0.1.0-1_amd64"
install -d -m 0755 "${root}/DEBIAN" "${root}/usr/bin" "${root}/usr/lib/buzzard-torrent-search/app" "${root}/usr/lib/buzzard-torrent-search/runtime" "${root}/usr/lib/buzzard-torrent-search/node/bin" "${root}/usr/share/doc/buzzard-torrent-search"
install -m 0644 "${component_root}/packaging/control" "${root}/DEBIAN/control"
install -m 0755 "${component_root}/packaging/postinst" "${root}/DEBIAN/postinst"
install -m 0755 "${component_root}/packaging/buzzard-torrent-search" "${root}/usr/bin/buzzard-torrent-search"
install -m 0755 "${component_root}/packaging/buzzard-torrent-search-mcp" "${root}/usr/bin/buzzard-torrent-search-mcp"
install -m 0644 "${component_root}/src/cli.mjs" "${root}/usr/lib/buzzard-torrent-search/app/cli.mjs"
install -m 0644 "${component_root}/src/mcp.mjs" "${root}/usr/lib/buzzard-torrent-search/app/mcp.mjs"
install -m 0644 "${component_root}/src/service.mjs" "${root}/usr/lib/buzzard-torrent-search/app/service.mjs"
cp -a -- "${runtime}/." "${root}/usr/lib/buzzard-torrent-search/runtime/"
chmod 0755 "${root}/usr/lib/buzzard-torrent-search/runtime"
install -m 0755 "${node_root}/bin/node" "${root}/usr/lib/buzzard-torrent-search/node/bin/node"
if [[ -f "${node_root}/LICENSE" ]]; then
  install -m 0644 "${node_root}/LICENSE" "${root}/usr/lib/buzzard-torrent-search/node/LICENSE"
fi
install -m 0644 "${component_root}/README.md" "${root}/usr/share/doc/buzzard-torrent-search/README.md"
install -m 0644 "${component_root}/LICENSE" "${root}/usr/share/doc/buzzard-torrent-search/LICENSE.packaging"
install -m 0644 "${component_root}/debian/copyright" "${root}/usr/share/doc/buzzard-torrent-search/copyright"
gzip -n -9 -c "${component_root}/debian/changelog" >"${root}/usr/share/doc/buzzard-torrent-search/changelog.Debian.gz"
find "${root}" -exec touch --no-dereference --date="@${SOURCE_DATE_EPOCH}" {} +
mkdir -p -- "${output}"
dpkg-deb --root-owner-group --uniform-compression -Zzstd -z10 --build \
  "${root}" "${output}/buzzard-torrent-search_0.1.0-1_amd64.deb"
