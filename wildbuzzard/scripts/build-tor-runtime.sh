#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0

set -Eeuo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source_repo="$(cd -- "${script_dir}/../.." && pwd -P)"
build_root="$(dirname -- "${source_repo}")/wildbuzzard-tor-builds"
if [[ "${1:-}" == --build-root && $# == 2 ]]; then
  build_root="$2"
elif (($#)); then
  echo "Usage: $0 [--build-root DIR]" >&2
  exit 2
fi
if [[ "$(uname -s)" != Linux || "$(uname -m)" != x86_64 ]]; then
  echo "This Tor runtime builder targets Linux x86_64" >&2
  exit 2
fi
metadata="${source_repo}/wildbuzzard/third_party/tor.toml"
read_pin() { python3 -c 'import sys,tomllib; print(tomllib.load(open(sys.argv[1],"rb"))[sys.argv[2]])' "${metadata}" "$1"; }
tor_commit="$(read_pin commit)"
version="$(read_pin version)"
export SOURCE_DATE_EPOCH="$(read_pin source_date_epoch)"
run_root="${build_root}/runs/$(date -u +%Y%m%dT%H%M%SZ)-${version}-$$"
mkdir -p "${run_root}/source" "${run_root}/runtime" "${run_root}/artifacts"
run_root="$(cd "${run_root}" && pwd -P)"
source_archive="${run_root}/artifacts/wildbuzzard-tor-${version}-source.tar"
git -C "${source_repo}" archive "${tor_commit}" > "${source_archive}"
python3 "${script_dir}/tor-runtime-provenance.py" verify-source \
  --pin-config "${metadata}" --source "${source_archive}" \
  --source-root "${source_repo}/third_party/tor"
tar -xf "${source_archive}" -C "${run_root}/source"
mkdir -p "${run_root}/dependencies"
ln -s /usr/include "${run_root}/dependencies/include"
ln -s "/usr/lib/$(cc -print-multiarch)" "${run_root}/dependencies/lib"
cd "${run_root}/source"
./autogen.sh > "${run_root}/configure.log" 2>&1
./configure --disable-asciidoc --disable-system-torrc --disable-lzma \
  --disable-zstd --enable-static-libevent --enable-static-openssl \
  --enable-static-zlib --with-libevent-dir="${run_root}/dependencies" --with-openssl-dir="${run_root}/dependencies" \
  --with-zlib-dir="${run_root}/dependencies" --disable-unittests \
  CFLAGS="-O2 -fstack-protector-strong -D_FORTIFY_SOURCE=3" \
  LDFLAGS="-Wl,-z,relro,-z,now" >> "${run_root}/configure.log" 2>&1
make -j"${WILDBUZZARD_BUILD_JOBS:-8}" > "${run_root}/build.log" 2>&1
install -m 0755 src/app/tor "${run_root}/runtime/tor"
strip --strip-unneeded "${run_root}/runtime/tor"
install -m 0644 "${metadata}" "${run_root}/runtime/tor.toml"
python3 "${script_dir}/tor-runtime-provenance.py" create \
  --binary "${run_root}/runtime/tor" --pin-config "${metadata}" \
  --source "${source_archive}" --source-root "${source_repo}" \
  --provenance "${run_root}/runtime/tor-provenance.zip"
artifact="${run_root}/artifacts/tor-${version}-linux-x86_64"
provenance="${run_root}/artifacts/wildbuzzard-tor-${version}-provenance.zip"
install -m 0755 "${run_root}/runtime/tor" "${artifact}"
install -m 0644 "${run_root}/runtime/tor-provenance.zip" "${provenance}"
cat > "${run_root}/build-manifest.txt" <<EOF
tor_tag=$(read_pin tag)
tor_commit=${tor_commit}
tor_tree=$(read_pin tree)
artifact=${artifact}
binary_sha256=$(sha256sum "${artifact}" | awk '{print $1}')
config=${run_root}/runtime/tor.toml
config_sha256=$(sha256sum "${metadata}" | awk '{print $1}')
provenance=${provenance}
provenance_sha256=$(sha256sum "${provenance}" | awk '{print $1}')
source=${source_archive}
source_sha256=$(read_pin source_sha256)
runtime=${run_root}/runtime
EOF
echo "Tor runtime: ${run_root}/runtime"
