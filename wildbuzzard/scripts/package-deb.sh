#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

set -Eeuo pipefail

usage() {
  echo "Usage: $0 --dist-dir DIR --output-dir DIR --arti-dir DIR --qbittorrent-runtime DIR --cli-binary FILE"
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
dist_dir=""
output_dir=""
arti_dir=""
qbittorrent_runtime=""
cli_binary=""

while (($#)); do
  case "$1" in
    --dist-dir)
      dist_dir="${2:?--dist-dir requires a directory}"
      shift 2
      ;;
    --output-dir)
      output_dir="${2:?--output-dir requires a directory}"
      shift 2
      ;;
    --arti-dir)
      arti_dir="${2:?--arti-dir requires a directory}"
      shift 2
      ;;
    --qbittorrent-runtime)
      qbittorrent_runtime="${2:?--qbittorrent-runtime requires a directory}"
      shift 2
      ;;
    --cli-binary)
      cli_binary="${2:?--cli-binary requires a file}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "${dist_dir}" || -z "${output_dir}" || -z "${arti_dir}" || -z "${qbittorrent_runtime}" || -z "${cli_binary}" ]]; then
  usage >&2
  exit 2
fi

dist_dir="$(cd -- "${dist_dir}" && pwd -P)"
arti_dir="$(cd -- "${arti_dir}" && pwd -P)"
qbittorrent_runtime="$(cd -- "${qbittorrent_runtime}" && pwd -P)"
cli_binary="$(realpath -- "${cli_binary}")"
if [[ ! -f "${cli_binary}" || -L "${cli_binary}" || ! -x "${cli_binary}" ]]; then
  echo "--cli-binary must name the compiled native client" >&2
  exit 2
fi
mkdir -p -- "${output_dir}"
output_dir="$(cd -- "${output_dir}" && pwd -P)"

shopt -s nullglob
archives=(
  "${dist_dir}"/wildbuzzard-*.tar.xz
  "${dist_dir}"/wildbuzzard-*.tar.bz2
  "${dist_dir}"/wildbuzzard-*.tar.gz
)
shopt -u nullglob

if ((${#archives[@]} != 1)); then
  echo \
    "Expected exactly one WildBuzzard Linux package archive in ${dist_dir}; found ${#archives[@]}" \
    >&2
  exit 1
fi
archive="${archives[0]}"

version="$(
  basename -- "${archive}" |
    sed -E 's/^wildbuzzard-([^.]+(\.[^.]+)*)\.en-US\.linux-x86_64\.tar\.(xz|bz2|gz)$/\1/'
)"
if [[ -z "${version}" || "${version}" == "$(basename -- "${archive}")" ]]; then
  echo "Could not derive a Debian version from $(basename -- "${archive}")" >&2
  exit 1
fi

deb_version="$(printf '%s' "${version}" | sed -E 's/esr/~esr/g; s/[^0-9A-Za-z.+:~_-]/-/g')"
stage="$(mktemp -d --tmpdir="${output_dir}" wildbuzzard-deb.XXXXXXXX)"
trap 'rm -r -- "${stage}"' EXIT

mkdir -p -- \
  "${stage}/DEBIAN" \
  "${stage}/opt" \
  "${stage}/usr/bin" \
  "${stage}/usr/share/applications" \
  "${stage}/usr/share/icons/hicolor/scalable/apps"

tar -xf "${archive}" -C "${stage}/opt"
product_dir="$(find "${stage}/opt" -mindepth 1 -maxdepth 1 -type d -print -quit)"
if [[ -z "${product_dir}" || ! -x "${product_dir}/wildbuzzard" ]]; then
  echo "Archive does not contain an executable WildBuzzard application" >&2
  exit 1
fi
if [[ "${product_dir}" != "${stage}/opt/wildbuzzard" ]]; then
  mv -- "${product_dir}" "${stage}/opt/wildbuzzard"
fi
for component_path in \
  "runtime/search" \
  "runtime/pi-web" \
  "runtime/torrent" \
  "runtime/tor" \
  "runtime/jackett-mini"; do
  target="${stage}/opt/wildbuzzard/${component_path}"
  if [[ -e "${target}" || -L "${target}" ]]; then
    echo "Browser archive unexpectedly contains external component: ${component_path}" >&2
    exit 1
  fi
done

for arti_name in arti arti.toml arti-provenance.zip; do
  if [[ ! -f "${arti_dir}/${arti_name}" || -L "${arti_dir}/${arti_name}" ]]; then
    echo "Arti input is missing required file: ${arti_name}" >&2
    exit 1
  fi
done
install -d -m 0755 \
  "${stage}/opt/wildbuzzard/runtime/tor" \
  "${stage}/opt/wildbuzzard/notices/source"
install -m 0755 \
  "${arti_dir}/arti" \
  "${stage}/opt/wildbuzzard/runtime/tor/arti"
install -m 0644 \
  "${arti_dir}/arti.toml" \
  "${stage}/opt/wildbuzzard/runtime/tor/arti.toml"
install -m 0644 \
  "${arti_dir}/arti-provenance.zip" \
  "${stage}/opt/wildbuzzard/notices/source/wildbuzzard-arti-2.5.1-provenance.zip"

install -d -m 0755 "${stage}/opt/wildbuzzard/runtime/torrent"
cp -a -- \
  "${qbittorrent_runtime}/." \
  "${stage}/opt/wildbuzzard/runtime/torrent/"
if find "${stage}/opt/wildbuzzard/runtime/torrent" ! -type f ! -type d -print -quit | grep -q .; then
  echo "qBittorrent runtime contains a non-file payload" >&2
  exit 1
fi
find "${stage}/opt/wildbuzzard/runtime/torrent" -type d -exec chmod 0755 {} +
find "${stage}/opt/wildbuzzard/runtime/torrent" -type f -exec chmod 0644 {} +
chmod 0755 "${stage}/opt/wildbuzzard/runtime/torrent/bin/qbittorrent-nox"
arti_binary="${stage}/opt/wildbuzzard/runtime/tor/arti"
arti_config="${stage}/opt/wildbuzzard/runtime/tor/arti.toml"
arti_provenance="${stage}/opt/wildbuzzard/notices/source/wildbuzzard-arti-2.5.1-provenance.zip"
for arti_file in "${arti_binary}" "${arti_config}" "${arti_provenance}"; do
  if [[ ! -f "${arti_file}" || -L "${arti_file}" ]]; then
    echo "Release archive is missing required Arti runtime provenance" >&2
    exit 1
  fi
done
install -d -m 0755 \
  "${stage}/usr/share/doc/wildbuzzard" \
  "${stage}/usr/share/doc/wildbuzzard/arti-third-party" \
  "${stage}/usr/share/doc/wildbuzzard/blocker" \
  "${stage}/usr/share/doc/wildbuzzard/runner-third-party/licenses" \
  "${stage}/usr/share/wildbuzzard/skills/wildbuzzard"
install -m 0755 \
  "${cli_binary}" \
  "${stage}/usr/bin/wildbuzzard"
install -m 0644 \
  "${stage}/opt/wildbuzzard/notices/NOTICE" \
  "${stage}/usr/share/doc/wildbuzzard/cli-NOTICE"
for legal_file in \
  BLOCKER-ASSET-SOURCE-NOTICE \
  COPYING \
  LICENSE \
  MOZILLA-MCP-LICENSE \
  SOURCE-NOTICE; do
  install -m 0644 \
    "${stage}/opt/wildbuzzard/notices/${legal_file}" \
    "${stage}/usr/share/doc/wildbuzzard/${legal_file}"
done
install -m 0644 \
  "${stage}/opt/wildbuzzard/notices/blocker/SOURCES.lock.json" \
  "${stage}/usr/share/doc/wildbuzzard/blocker/SOURCES.lock.json"
cp -a -- \
  "${stage}/opt/wildbuzzard/notices/arti-crates/." \
  "${stage}/usr/share/doc/wildbuzzard/arti-third-party/"
runner_legal_files=(
  "THIRD-PARTY.json"
  "licenses/Apache-2.0.txt"
  "licenses/MIT-dtolnay-serde.txt"
  "licenses/Unicode-3.0.txt"
  "licenses/Unlicense.txt"
  "licenses/memchr-COPYING.txt"
  "licenses/memchr-MIT.txt"
)
for legal_file in "${runner_legal_files[@]}"; do
  install -m 0644 \
    "${stage}/opt/wildbuzzard/notices/wildbuzzard-cli/${legal_file}" \
    "${stage}/usr/share/doc/wildbuzzard/runner-third-party/${legal_file}"
done
install -m 0644 \
  "${script_dir}/../components/wildbuzzard-cli/skills/wildbuzzard/SKILL.md" \
  "${stage}/usr/share/wildbuzzard/skills/wildbuzzard/SKILL.md"
install -m 0644 \
  "${script_dir}/../browser/installer/linux/wildbuzzard.desktop" \
  "${stage}/usr/share/applications/org.wildbuzzard.WildBuzzard.desktop"
install -m 0644 \
  "${script_dir}/../browser/branding/content/about-logo.svg" \
  "${stage}/usr/share/icons/hicolor/scalable/apps/org.wildbuzzard.WildBuzzard.svg"
installed_size="$(du -sk --apparent-size "${stage}/opt" "${stage}/usr" | awk '{ total += $1 } END { print total }')"
cat >"${stage}/DEBIAN/control" <<EOF
Package: wildbuzzard
Version: ${deb_version}
Section: web
Priority: optional
Architecture: amd64
Installed-Size: ${installed_size}
Maintainer: openresearchtools <229047507+openresearchtools@users.noreply.github.com>
Homepage: https://github.com/openresearchtools/WildBuzzard
Depends: libasound2t64 | libasound2, libdbus-glib-1-2, libgtk-3-0 | libgtk-3-0t64, libx11-xcb1
Suggests: buzzard-search, buzzard-minijtt
Provides: wild-buzzard
Replaces: wild-buzzard
Breaks: wild-buzzard
Description: privacy-oriented Firefox ESR browser with native automation
 Wild Buzzard combines a Firefox ESR browser with content blocking, Tor tabs,
 native torrent downloads, developer tooling, a general browser-control
 command line interface, and built-in extension UIs backed by optional search
 and torrent-discovery command-line services.
EOF

package_path="${output_dir}/wildbuzzard_${deb_version}_amd64.deb"
dpkg-deb --root-owner-group --build "${stage}" "${package_path}"
echo "Debian package: ${package_path}"
