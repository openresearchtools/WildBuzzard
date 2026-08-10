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
searxng_runtime="${app_dir}/usr/lib/wildbuzzard/runtime/search/wildbuzzard-searxng-runtime.zip"
searxng_source="${app_dir}/usr/lib/wildbuzzard/notices/source/wildbuzzard-searxng-2026.8.6+b023a28ba-source.tar.xz"
searxng_inventory="${app_dir}/usr/lib/wildbuzzard/notices/source/searxng-release.cdx.json"
if [[ -e "${searxng_runtime}" || -L "${searxng_runtime}" || \
  -e "${searxng_source}" || -L "${searxng_source}" || \
  -e "${searxng_inventory}" || -L "${searxng_inventory}" ]]; then
  python3 -I -B "${product_dir}/scripts/validate-searxng-runtime-archive.py" \
    "${searxng_runtime}" \
    --source "${searxng_source}" \
    --inventory "${searxng_inventory}"
fi
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

case "$(uname -m)" in
  x86_64) appimage_arch="x86_64" ;;
  aarch64|arm64) appimage_arch="aarch64" ;;
  *)
    echo "Unsupported AppImage architecture: $(uname -m)" >&2
    exit 2
    ;;
esac

appimage_path="${output_dir}/WildBuzzard-${version}-${appimage_arch}.AppImage"
ARCH="${appimage_arch}" APPIMAGE_EXTRACT_AND_RUN=1 "${appimagetool_path}" "${app_dir}" "${appimage_path}"
chmod 755 "${appimage_path}"
sha256sum "${appimage_path}" >"${appimage_path}.sha256"

echo "AppImage: ${appimage_path}"
echo "AppDir: ${app_dir}"
