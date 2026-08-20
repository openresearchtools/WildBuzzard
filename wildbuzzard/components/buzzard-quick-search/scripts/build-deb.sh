#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later

set -eu
umask 022

component_root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
upstream_record_root="$component_root/../../third_party/agpl/unsloth-quick-search"
build_root=${BUZZARD_QUICK_SEARCH_BUILD_ROOT:-"$component_root/build"}
dist_root=${BUZZARD_QUICK_SEARCH_DIST_ROOT:-"$component_root/dist"}
build_python=${BUZZARD_QUICK_SEARCH_PYTHON:-python3}
export PYTHONHASHSEED=0
export SOURCE_DATE_EPOCH=1787059297
export LC_ALL=C
export TZ=UTC
export UV_LINK_MODE=copy

case "$build_root" in
  ""|/)
    echo "refusing unsafe build root: $build_root" >&2
    exit 1
    ;;
esac

if [ "$(uname -m)" != "x86_64" ]; then
  echo "buzzard-quick-search currently packages only x86-64" >&2
  exit 1
fi
if ! command -v uv >/dev/null 2>&1; then
  echo "uv is required to reproduce the locked Python environment" >&2
  exit 1
fi
if ! command -v dpkg-deb >/dev/null 2>&1; then
  echo "dpkg-deb is required" >&2
  exit 1
fi
if ! command -v "$build_python" >/dev/null 2>&1; then
  echo "build Python not found: $build_python" >&2
  exit 1
fi
if ! command -v readelf >/dev/null 2>&1; then
  echo "readelf from binutils is required" >&2
  exit 1
fi

rm -rf "$build_root"
mkdir -p "$build_root/tmp" "$dist_root"
export TMPDIR="$build_root/tmp"
cd "$component_root"
uv sync --frozen --group build --python "$build_python" --no-managed-python --no-python-downloads
uv run pyinstaller \
  --clean \
  --noconfirm \
  --onedir \
  --name buzzard-quick-search \
  --paths "$component_root/src" \
  --collect-all fake_useragent \
  --collect-all lxml \
  --collect-all primp \
  --collect-all pymupdf \
  --recursive-copy-metadata buzzard-quick-search \
  --distpath "$build_root/pyinstaller" \
  --workpath "$build_root/pyinstaller-work" \
  --specpath "$build_root" \
  "$component_root/packaging/entrypoint.py"

find "$build_root/pyinstaller/buzzard-quick-search" -type f \
  \( -name direct_url.json -o -name uv_cache.json -o -name RECORD \) \
  -delete

highest_glibc=$(
  find "$build_root/pyinstaller/buzzard-quick-search" -type f \
    -exec readelf --version-info {} + 2>/dev/null \
    | sed -n 's/.*Name: GLIBC_\([0-9.]*\).*/\1/p' \
    | sort -V \
    | tail -1
)
if [ -z "$highest_glibc" ]; then
  echo "could not determine the bundled executable's glibc requirement" >&2
  exit 1
fi
if [ "$(printf '%s\n%s\n' 2.39 "$highest_glibc" | sort -V | tail -1)" != "2.39" ]; then
  echo "bundled executable requires GLIBC_$highest_glibc; Ubuntu 24.04 supports 2.39" >&2
  exit 1
fi

package_root="$build_root/package"
install -d "$package_root/DEBIAN" "$package_root/usr/bin" \
  "$package_root/usr/lib/buzzard-quick-search" \
  "$package_root/usr/share/doc/buzzard-quick-search"
cp -a "$build_root/pyinstaller/buzzard-quick-search/." \
  "$package_root/usr/lib/buzzard-quick-search/"
install -m 0755 packaging/buzzard-quick-search packaging/buzzard-quick-search-mcp \
  "$package_root/usr/bin/"
install -m 0644 packaging/control "$package_root/DEBIAN/control"
install -m 0644 README.md LICENSE THIRD_PARTY_NOTICES.md uv.lock \
  "$package_root/usr/share/doc/buzzard-quick-search/"
install -m 0644 debian/copyright "$package_root/usr/share/doc/buzzard-quick-search/copyright"
install -m 0644 "$upstream_record_root/UPSTREAM.toml" \
  "$package_root/usr/share/doc/buzzard-quick-search/upstream.toml"
install -m 0644 "$upstream_record_root/SOURCE-MANIFEST.sha256" \
  "$package_root/usr/share/doc/buzzard-quick-search/upstream-source-manifest.sha256"
find "$package_root" ! -type d -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +
find "$package_root" -depth -type d -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +

output="$dist_root/buzzard-quick-search_0.1.0_amd64.deb"
dpkg-deb --build --root-owner-group --uniform-compression --threads-max=1 \
  -Zzstd -z10 "$package_root" "$output"
echo "$output"
