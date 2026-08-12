#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

set -Eeuo pipefail

usage() {
  echo "Usage: $0 --dist-dir DIR --output-dir DIR [--appimagetool FILE] [--package FILE]"
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
product_dir="$(cd -- "${script_dir}/.." && pwd -P)"
dist_dir=""
output_dir=""
package_archive=""
appimagetool_path="$(command -v appimagetool || true)"

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
    --appimagetool)
      appimagetool_path="${2:?--appimagetool requires a file}"
      shift 2
      ;;
    --package)
      package_archive="${2:?--package requires a file}"
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

dist_dir="$(realpath -- "${dist_dir}")"
mkdir -p -- "${output_dir}"
output_dir="$(cd -- "${output_dir}" && pwd -P)"

if [[ -z "${package_archive}" ]]; then
  mapfile -t package_candidates < <(
    find "${dist_dir}" -maxdepth 1 -type f -name 'wildbuzzard*.tar.*' -printf '%T@ %p\n' |
      sort -nr
  )
  if ((${#package_candidates[@]} == 0)); then
    echo "No WildBuzzard release archive found under ${dist_dir}" >&2
    exit 1
  fi
  package_archive="${package_candidates[0]#* }"
fi

package_archive="$(realpath -- "${package_archive}")"
appimagetool_path="$(realpath -- "${appimagetool_path}")"
if [[ ! -f "${package_archive}" || ! -x "${appimagetool_path}" ]]; then
  echo "A release archive and executable appimagetool are required" >&2
  exit 2
fi

staging_root="${output_dir}/appimage-staging"
extract_root="${staging_root}/release"
app_dir="${staging_root}/WildBuzzard.AppDir"
if [[ -e "${staging_root}" ]]; then
  echo "AppImage staging path already exists: ${staging_root}" >&2
  exit 1
fi
mkdir -p -- "${extract_root}" "${app_dir}/usr/lib" "${app_dir}/usr/share/applications" "${app_dir}/usr/share/icons/hicolor/256x256/apps"
tar -xaf "${package_archive}" -C "${extract_root}"

browser_root="$(find "${extract_root}" -mindepth 1 -maxdepth 3 -type f -name wildbuzzard -perm -u+x -printf '%h\n' -quit)"
if [[ -z "${browser_root}" ]]; then
  echo "The release archive does not contain an executable WildBuzzard browser" >&2
  exit 1
fi

cp -a -- "${browser_root}" "${app_dir}/usr/lib/wildbuzzard"
searxng_executable="${app_dir}/usr/lib/wildbuzzard/runtime/search/wildbuzzard-searxng-2026.8.6+b023a28ba-linux-x86_64.AppImage"
for obsolete_path in \
  "runtime/search/wildbuzzard-searxng-runtime.zip" \
  "notices/source/wildbuzzard-searxng-2026.8.6+b023a28ba-source.tar.xz" \
  "notices/source/searxng-release.cdx.json"; do
  if [[ -e "${app_dir}/usr/lib/wildbuzzard/${obsolete_path}" || \
    -L "${app_dir}/usr/lib/wildbuzzard/${obsolete_path}" ]]; then
    echo "Release archive contains obsolete SearXNG payload: ${obsolete_path}" >&2
    exit 1
  fi
done
if [[ ! -f "${searxng_executable}" || -L "${searxng_executable}" ]]; then
  echo "Release archive is missing the required SearXNG executable" >&2
  exit 1
fi
if [[ "$(stat --format='%a' -- "${searxng_executable}")" != 755 ]]; then
  echo "Release archive SearXNG executable must have mode 0755" >&2
  exit 1
fi
python3 -I -B "${product_dir}/scripts/validate-searxng-executable.py" \
  "${searxng_executable}" \
  --lock "${product_dir}/third_party/agpl/searxng/executable-artifact.lock.json"

required_runtime_files=(
  "runtime/pi-web/wildbuzzard-pi-web-runtime.zip"
  "runtime/torrent/wildbuzzard-torrent-runtime.zip"
  "runtime/jackett-mini/wildbuzzard-jackett-mini-runtime.zip"
  "runtime/tor/arti"
  "runtime/tor/arti.toml"
  "notices/source/wildbuzzard-arti-2.5.1-provenance.zip"
)
for relative_path in "${required_runtime_files[@]}"; do
  runtime_file="${app_dir}/usr/lib/wildbuzzard/${relative_path}"
  if [[ ! -f "${runtime_file}" || -L "${runtime_file}" ]]; then
    echo "Release archive is missing required host-native runtime: ${relative_path}" >&2
    exit 1
  fi
done
python3 -I -B "${product_dir}/scripts/validate-pi-web-runtime-archive.py" \
  "${app_dir}/usr/lib/wildbuzzard/runtime/pi-web/wildbuzzard-pi-web-runtime.zip" \
  --lock "${product_dir}/pi-web-runtime-lock.json"
python3 -I -B "${product_dir}/scripts/validate-host-native-runtime-archive.py" \
  "${app_dir}/usr/lib/wildbuzzard/runtime/torrent/wildbuzzard-torrent-runtime.zip" \
  --kind torrent \
  --lock "${product_dir}/torrent-runtime-lock.json"
python3 -I -B "${product_dir}/scripts/validate-host-native-runtime-archive.py" \
  "${app_dir}/usr/lib/wildbuzzard/runtime/jackett-mini/wildbuzzard-jackett-mini-runtime.zip" \
  --kind jackett-mini \
  --lock "${product_dir}/jackett-mini-runtime-lock.json"
python3 -I -B "${product_dir}/scripts/arti-runtime-provenance.py" validate \
  --binary "${app_dir}/usr/lib/wildbuzzard/runtime/tor/arti" \
  --pin-config "${product_dir}/third_party/arti.toml" \
  --installed-config "${app_dir}/usr/lib/wildbuzzard/runtime/tor/arti.toml" \
  --provenance "${app_dir}/usr/lib/wildbuzzard/notices/source/wildbuzzard-arti-2.5.1-provenance.zip"
install -m 755 "${product_dir}/packaging/appimage/AppRun" "${app_dir}/AppRun"
install -m 644 "${product_dir}/packaging/appimage/wildbuzzard.desktop" "${app_dir}/wildbuzzard.desktop"
install -m 644 "${product_dir}/packaging/appimage/wildbuzzard.desktop" "${app_dir}/usr/share/applications/wildbuzzard.desktop"
install -m 644 "${product_dir}/browser/branding/default256.png" "${app_dir}/wildbuzzard.png"
install -m 644 "${product_dir}/browser/branding/default256.png" "${app_dir}/usr/share/icons/hicolor/256x256/apps/wildbuzzard.png"
ln -s wildbuzzard.png "${app_dir}/.DirIcon"

version="$(awk -F= '$1 == "Version" { print $2; exit }' "${app_dir}/usr/lib/wildbuzzard/application.ini")"
if [[ -z "${version}" ]]; then
  version="development"
fi

if [[ "$(uname -m)" != "x86_64" ]]; then
  echo "Unsupported AppImage architecture: $(uname -m)" >&2
  exit 2
fi
appimage_arch="x86_64"

appimage_path="${output_dir}/WildBuzzard-${version}-${appimage_arch}.AppImage"
ARCH="${appimage_arch}" APPIMAGE_EXTRACT_AND_RUN=1 "${appimagetool_path}" "${app_dir}" "${appimage_path}"
chmod 755 "${appimage_path}"
sha256sum "${appimage_path}" >"${appimage_path}.sha256"

echo "AppImage: ${appimage_path}"
echo "AppDir: ${app_dir}"
