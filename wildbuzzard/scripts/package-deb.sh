#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

set -Eeuo pipefail

usage() {
  echo "Usage: $0 --dist-dir DIR --output-dir DIR"
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source_root="$(cd -- "${script_dir}/../.." && pwd -P)"
dist_dir=""
output_dir=""

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

if [[ -z "${dist_dir}" || -z "${output_dir}" ]]; then
  usage >&2
  exit 2
fi

dist_dir="$(cd -- "${dist_dir}" && pwd -P)"
mkdir -p -- "${output_dir}"
output_dir="$(cd -- "${output_dir}" && pwd -P)"

archive=""
for candidate in \
  "${dist_dir}"/wildbuzzard-*.tar.xz \
  "${dist_dir}"/wildbuzzard-*.tar.bz2 \
  "${dist_dir}"/wildbuzzard-*.tar.gz; do
  if [[ -f "${candidate}" ]]; then
    archive="${candidate}"
    break
  fi
done

if [[ -z "${archive}" ]]; then
  echo "No WildBuzzard Linux package archive found in ${dist_dir}" >&2
  exit 1
fi

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
cli_build="$(mktemp -d --tmpdir="${output_dir}" wildbuzzard-cli.XXXXXXXX)"
trap 'rm -r -- "${stage}" "${cli_build}"' EXIT

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
  "runtime/jackett-mini"; do
  target="${stage}/opt/wildbuzzard/${component_path}"
  if [[ -e "${target}" || -L "${target}" ]]; then
    echo "Browser archive unexpectedly contains external component: ${component_path}" >&2
    exit 1
  fi
done

arti_binary="${stage}/opt/wildbuzzard/runtime/tor/arti"
arti_config="${stage}/opt/wildbuzzard/runtime/tor/arti.toml"
arti_provenance="${stage}/opt/wildbuzzard/notices/source/wildbuzzard-arti-2.5.1-provenance.zip"
for arti_file in "${arti_binary}" "${arti_config}" "${arti_provenance}"; do
  if [[ ! -f "${arti_file}" || -L "${arti_file}" ]]; then
    echo "Release archive is missing required Arti runtime provenance" >&2
    exit 1
  fi
done
python3 -I -B "${script_dir}/arti-runtime-provenance.py" validate \
  --binary "${arti_binary}" \
  --pin-config "${script_dir}/../third_party/arti.toml" \
  --installed-config "${arti_config}" \
  --provenance "${arti_provenance}"
python3 -I -B "${script_dir}/verify_browser_legal_payload.py" \
  --source-root "${source_root}" \
  --browser-root "${stage}/opt/wildbuzzard"

cp -a -- "${script_dir}/../components/wildbuzzard-cli/." "${cli_build}/"
(
  cd -- "${cli_build}"
  cargo test --locked --manifest-path runner/Cargo.toml
  cargo build --locked --release --manifest-path runner/Cargo.toml
)
install -d -m 0755 \
  "${stage}/usr/share/doc/wildbuzzard" \
  "${stage}/usr/share/wildbuzzard/skills/wildbuzzard"
install -m 0755 \
  "${cli_build}/runner/target/release/wildbuzzard-native-client" \
  "${stage}/usr/bin/wildbuzzard"
install -m 0644 \
  "${stage}/opt/wildbuzzard/notices/NOTICE" \
  "${stage}/usr/share/doc/wildbuzzard/cli-NOTICE"
for legal_file in COPYING LICENSE MOZILLA-MCP-LICENSE SOURCE-NOTICE; do
  install -m 0644 \
    "${stage}/opt/wildbuzzard/notices/${legal_file}" \
    "${stage}/usr/share/doc/wildbuzzard/${legal_file}"
done
install -m 0644 \
  "${script_dir}/../components/wildbuzzard-cli/skills/wildbuzzard/SKILL.md" \
  "${stage}/usr/share/wildbuzzard/skills/wildbuzzard/SKILL.md"
install -m 0644 \
  wildbuzzard/browser/installer/linux/wildbuzzard.desktop \
  "${stage}/usr/share/applications/org.wildbuzzard.WildBuzzard.desktop"
install -m 0644 \
  wildbuzzard/browser/branding/content/about-logo.svg \
  "${stage}/usr/share/icons/hicolor/scalable/apps/org.wildbuzzard.WildBuzzard.svg"
python3 -I -B "${script_dir}/verify_browser_legal_payload.py" \
  --source-root "${source_root}" \
  --browser-root "${stage}/opt/wildbuzzard" \
  --documentation-root "${stage}/usr/share/doc/wildbuzzard"

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
Depends: libasound2t64 | libasound2, libdbus-glib-1-2, libgtk-3-0 | libgtk-3-0t64, libx11-xcb1, buzzard-torrent
Suggests: buzzard-search, buzzard-minijtt
Provides: wild-buzzard
Replaces: wild-buzzard
Breaks: wild-buzzard
Description: privacy-oriented Firefox ESR browser with native automation
 Wild Buzzard combines a Firefox ESR browser with content blocking, Tor tabs,
 native torrent downloads, developer tooling, a general browser-control
 command line interface, and built-in search extension UIs backed by optional,
 separately packaged command-line services.
EOF

package_path="${output_dir}/wildbuzzard_${deb_version}_amd64.deb"
dpkg-deb --root-owner-group --build "${stage}" "${package_path}"
dpkg-deb --info "${package_path}"
echo "Debian package: ${package_path}"
