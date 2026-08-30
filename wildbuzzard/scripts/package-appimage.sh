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
if [[ -z "${appimagetool_path}" ]]; then
  echo "Executable appimagetool was not found; install it or pass --appimagetool FILE" >&2
  exit 2
fi
appimagetool_path="$(realpath -- "${appimagetool_path}")"
if [[ ! -f "${package_archive}" || ! -x "${appimagetool_path}" ]]; then
  echo "A release archive and executable appimagetool are required" >&2
  exit 2
fi

staging_root="${output_dir}/appimage-staging"
extract_root="${staging_root}/release"
app_dir="${staging_root}/WildBuzzard.AppDir"
cli_build="${staging_root}/wildbuzzard-cli"
if [[ -e "${staging_root}" ]]; then
  echo "AppImage staging path already exists: ${staging_root}" >&2
  exit 1
fi
mkdir -p -- \
  "${extract_root}" \
  "${app_dir}/usr/bin" \
  "${app_dir}/usr/lib" \
  "${app_dir}/usr/share/applications" \
  "${app_dir}/usr/share/doc/wildbuzzard" \
  "${app_dir}/usr/share/doc/wildbuzzard/arti-third-party" \
  "${app_dir}/usr/share/doc/wildbuzzard/blocker" \
  "${app_dir}/usr/share/doc/wildbuzzard/runner-third-party/licenses" \
  "${app_dir}/usr/share/icons/hicolor/256x256/apps" \
  "${app_dir}/usr/share/wildbuzzard/skills/wildbuzzard"
tar -xaf "${package_archive}" -C "${extract_root}"

browser_root="$(find "${extract_root}" -mindepth 1 -maxdepth 3 -type f -name wildbuzzard -perm -u+x -printf '%h\n' -quit)"
if [[ -z "${browser_root}" ]]; then
  echo "The release archive does not contain an executable WildBuzzard browser" >&2
  exit 1
fi

cp -a -- "${browser_root}" "${app_dir}/usr/lib/wildbuzzard"
for component_path in \
  "runtime/search" \
  "runtime/pi-web" \
  "runtime/torrent" \
  "runtime/jackett-mini"; do
  target="${app_dir}/usr/lib/wildbuzzard/${component_path}"
  if [[ -e "${target}" || -L "${target}" ]]; then
    echo "Browser archive unexpectedly contains external component: ${component_path}" >&2
    exit 1
  fi
done

required_runtime_files=(
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
python3 -I -B "${product_dir}/scripts/arti-runtime-provenance.py" validate \
  --binary "${app_dir}/usr/lib/wildbuzzard/runtime/tor/arti" \
  --pin-config "${app_dir}/usr/lib/wildbuzzard/runtime/tor/arti.toml" \
  --installed-config "${app_dir}/usr/lib/wildbuzzard/runtime/tor/arti.toml" \
  --inventory "${app_dir}/usr/lib/wildbuzzard/notices/arti-crates/THIRD-PARTY.json" \
  --provenance "${app_dir}/usr/lib/wildbuzzard/notices/source/wildbuzzard-arti-2.5.1-provenance.zip"
python3 -I -B "${product_dir}/scripts/verify_browser_legal_payload.py" \
  --source-root "${product_dir}/.." \
  --browser-root "${app_dir}/usr/lib/wildbuzzard"
cp -a -- "${product_dir}/components/wildbuzzard-cli/." "${cli_build}/"
(
  cd -- "${cli_build}"
  cargo build --locked --release --manifest-path runner/Cargo.toml
)
install -m 755 \
  "${cli_build}/runner/target/release/wildbuzzard-native-client" \
  "${app_dir}/usr/bin/wildbuzzard-native-client"
install -m 644 \
  "${app_dir}/usr/lib/wildbuzzard/notices/NOTICE" \
  "${app_dir}/usr/share/doc/wildbuzzard/cli-NOTICE"
for legal_file in \
  BLOCKER-ASSET-SOURCE-NOTICE \
  COPYING \
  LICENSE \
  MOZILLA-MCP-LICENSE \
  SOURCE-NOTICE; do
  install -m 644 \
    "${app_dir}/usr/lib/wildbuzzard/notices/${legal_file}" \
    "${app_dir}/usr/share/doc/wildbuzzard/${legal_file}"
done
install -m 644 \
  "${app_dir}/usr/lib/wildbuzzard/notices/blocker/SOURCES.lock.json" \
  "${app_dir}/usr/share/doc/wildbuzzard/blocker/SOURCES.lock.json"
cp -a -- \
  "${app_dir}/usr/lib/wildbuzzard/notices/arti-crates/." \
  "${app_dir}/usr/share/doc/wildbuzzard/arti-third-party/"
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
  install -m 644 \
    "${app_dir}/usr/lib/wildbuzzard/notices/wildbuzzard-cli/${legal_file}" \
    "${app_dir}/usr/share/doc/wildbuzzard/runner-third-party/${legal_file}"
done
install -m 644 \
  "${product_dir}/components/wildbuzzard-cli/skills/wildbuzzard/SKILL.md" \
  "${app_dir}/usr/share/wildbuzzard/skills/wildbuzzard/SKILL.md"
install -m 755 "${product_dir}/packaging/appimage/AppRun" "${app_dir}/AppRun"
install -m 644 "${product_dir}/packaging/appimage/wildbuzzard.desktop" "${app_dir}/org.wildbuzzard.WildBuzzard.desktop"
install -m 644 "${product_dir}/packaging/appimage/wildbuzzard.desktop" "${app_dir}/usr/share/applications/org.wildbuzzard.WildBuzzard.desktop"
install -m 644 "${product_dir}/browser/branding/default256.png" "${app_dir}/org.wildbuzzard.WildBuzzard.png"
install -m 644 "${product_dir}/browser/branding/default256.png" "${app_dir}/usr/share/icons/hicolor/256x256/apps/org.wildbuzzard.WildBuzzard.png"
ln -s org.wildbuzzard.WildBuzzard.png "${app_dir}/.DirIcon"
python3 -I -B "${product_dir}/scripts/verify_browser_legal_payload.py" \
  --source-root "${product_dir}/.." \
  --browser-root "${app_dir}/usr/lib/wildbuzzard" \
  --documentation-root "${app_dir}/usr/share/doc/wildbuzzard"

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
appimage_options=()
if [[ -n "${SOURCE_DATE_EPOCH:-}" ]]; then
  if [[ ! "${SOURCE_DATE_EPOCH}" =~ ^[0-9]+$ ]]; then
    echo "SOURCE_DATE_EPOCH must be an unsigned integer" >&2
    exit 2
  fi
  appimage_options+=(
    "--mksquashfs-opt=-all-time"
    "--mksquashfs-opt=${SOURCE_DATE_EPOCH}"
    "--mksquashfs-opt=-mkfs-time"
    "--mksquashfs-opt=${SOURCE_DATE_EPOCH}"
  )
fi
env -u SOURCE_DATE_EPOCH \
  ARCH="${appimage_arch}" \
  APPIMAGE_EXTRACT_AND_RUN=1 \
  "${appimagetool_path}" \
  "${appimage_options[@]}" \
  "${app_dir}" \
  "${appimage_path}"
chmod 755 "${appimage_path}"
appimage_verification="${staging_root}/appimage-verification"
mkdir -p -- "${appimage_verification}"
(
  cd -- "${appimage_verification}"
  "${appimage_path}" --appimage-extract >/dev/null
)
python3 -I -B "${product_dir}/scripts/verify_browser_legal_payload.py" \
  --source-root "${product_dir}/.." \
  --browser-root "${appimage_verification}/squashfs-root/usr/lib/wildbuzzard" \
  --documentation-root "${appimage_verification}/squashfs-root/usr/share/doc/wildbuzzard"
rm -r -- "${appimage_verification}"
sha256sum "${appimage_path}" >"${appimage_path}.sha256"

echo "AppImage: ${appimage_path}"
echo "AppDir: ${app_dir}"
