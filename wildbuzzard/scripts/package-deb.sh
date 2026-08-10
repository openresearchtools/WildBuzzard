#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

set -Eeuo pipefail

usage() {
  echo "Usage: $0 --dist-dir DIR --output-dir DIR"
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
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
trap 'rm -rf -- "${stage}"' EXIT

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
searxng_runtime="${stage}/opt/wildbuzzard/runtime/search/wildbuzzard-searxng-runtime.zip"
searxng_source="${stage}/opt/wildbuzzard/notices/source/wildbuzzard-searxng-2026.8.6+b023a28ba-source.tar.xz"
searxng_inventory="${stage}/opt/wildbuzzard/notices/source/searxng-release.cdx.json"
for searxng_file in \
  "${searxng_runtime}" \
  "${searxng_source}" \
  "${searxng_inventory}"; do
  if [[ ! -f "${searxng_file}" || -L "${searxng_file}" ]]; then
    echo "Release archive is missing a required SearXNG runtime, source, or inventory" >&2
    exit 1
  fi
done
python3 -I -B "${script_dir}/validate-searxng-runtime-archive.py" \
  "${searxng_runtime}" \
  --source "${searxng_source}" \
  --inventory "${searxng_inventory}"

ln -s /opt/wildbuzzard/wildbuzzard "${stage}/usr/bin/wildbuzzard"
install -m 0644 \
  wildbuzzard/browser/installer/linux/wildbuzzard.desktop \
  "${stage}/usr/share/applications/org.wildbuzzard.WildBuzzard.desktop"
install -m 0644 \
  wildbuzzard/browser/branding/content/about-logo.svg \
  "${stage}/usr/share/icons/hicolor/scalable/apps/org.wildbuzzard.WildBuzzard.svg"

installed_size="$(du -sk "${stage}/opt/wildbuzzard" | cut -f1)"
cat >"${stage}/DEBIAN/control" <<EOF
Package: wildbuzzard
Version: ${deb_version}
Section: web
Priority: optional
Architecture: amd64
Installed-Size: ${installed_size}
Maintainer: WildBuzzard contributors
Homepage: https://github.com/openresearchtools/WildBuzzard
Depends: libasound2 | libasound2t64, libdbus-glib-1-2, libgtk-3-0 | libgtk-3-0t64
Description: privacy-oriented Firefox ESR browser for development agents
 WildBuzzard combines a Firefox ESR browser with native content blocking,
 developer tooling, and project-owned browser integrations.
EOF

package_path="${output_dir}/wildbuzzard_${deb_version}_amd64.deb"
dpkg-deb --root-owner-group --build "${stage}" "${package_path}"
dpkg-deb --info "${package_path}"
echo "Debian package: ${package_path}"
