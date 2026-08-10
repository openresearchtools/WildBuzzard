#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

set -Eeuo pipefail

usage() {
  echo "Usage: $0 [--build-root DIR] [--jobs NUMBER]"
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source_repo="$(cd -- "${script_dir}/../.." && pwd -P)"
build_root="$(dirname -- "${source_repo}")/wildbuzzard-git-builds"
jobs="$(nproc)"
git_version="2.55.0"
git_commit="e9019fcafe0040228b8631c30f97ae1adb61bcdc"
git_sha256="262c0e5f0f082c8c05e8192040a786ec0c8cafeeeaf8b7fa2a16c17be2deefa2"
zlib_version="1.3.1"
zlib_commit="51b7f2abdade71cd9bb0e7a373ef2610ec6f9daf"
zlib_sha256="9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23"
openssl_version="3.5.4"
openssl_commit="c1eeb9406b6142148f267594197d853403d10208"
openssl_sha256="967311f84955316969bdb1d8d4b983718ef42338639c621ec4c34fddef355e99"
curl_version="8.17.0"
curl_commit="400fffa90f30c7a2dc762fa33009d24851bd2016"
curl_sha256="955f6e729ad6b3566260e8fef68620e76ba3c31acf0a18524416a185acf77992"
ca_bundle_date="2026-07-16"
ca_bundle_sha256="3ff344e30b9b1ed2971044eabb438a08f2e2245ddb5f8ab1a3ad8b63ab4eaf91"

while (($#)); do
  case "$1" in
    --build-root)
      build_root="${2:?--build-root requires a directory}"
      shift 2
      ;;
    --jobs)
      jobs="${2:?--jobs requires a number}"
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

if [[ ! "${jobs}" =~ ^[1-9][0-9]*$ ]]; then
  echo "--jobs must be a positive integer" >&2
  exit 2
fi

mkdir -p -- "${build_root}"
build_root="$(cd -- "${build_root}" && pwd -P)"
case "${build_root}/" in
  "${source_repo}/"*)
    echo "Build root must be outside the source repository" >&2
    exit 2
    ;;
esac

run_id="$(date -u +%Y%m%dT%H%M%SZ)-${git_commit:0:12}-$$"
run_root="${build_root}/runs/${run_id}"
source_dir="${run_root}/source"
stage_dir="${run_root}/stage"
runtime_dir="${run_root}/runtime"
deps_dir="${run_root}/deps"
artifact_dir="${run_root}/artifacts"
download_dir="${build_root}/downloads"
git_archive="${download_dir}/git-${git_commit}.tar.gz"
zlib_archive="${download_dir}/zlib-${zlib_version}.tar.gz"
openssl_archive="${download_dir}/openssl-${openssl_version}.tar.gz"
curl_archive="${download_dir}/curl-${curl_version}.tar.xz"
ca_bundle="${download_dir}/cacert-${ca_bundle_date}.pem"
mkdir -p -- \
  "${source_dir}/git" \
  "${source_dir}/zlib" \
  "${source_dir}/openssl" \
  "${source_dir}/curl" \
  "${stage_dir}" \
  "${deps_dir}" \
  "${runtime_dir}/bin" \
  "${runtime_dir}/libexec/git-core" \
  "${runtime_dir}/share/licenses" \
  "${runtime_dir}/source/archives" \
  "${artifact_dir}" \
  "${download_dir}"

download() {
  local destination="$1"
  local url="$2"
  local expected_sha256="$3"
  if [[ ! -f "${destination}" ]]; then
    curl --fail --location --output "${destination}" "${url}"
  fi
  if [[ "$(sha256sum "${destination}" | awk '{ print $1 }')" != "${expected_sha256}" ]]; then
    echo "Source archive checksum mismatch: ${destination}" >&2
    exit 1
  fi
}

download "${git_archive}" "https://github.com/git/git/archive/${git_commit}.tar.gz" "${git_sha256}"
download "${zlib_archive}" "https://zlib.net/fossils/zlib-${zlib_version}.tar.gz" "${zlib_sha256}"
download "${openssl_archive}" "https://github.com/openssl/openssl/releases/download/openssl-${openssl_version}/openssl-${openssl_version}.tar.gz" "${openssl_sha256}"
download "${curl_archive}" "https://curl.se/download/curl-${curl_version}.tar.xz" "${curl_sha256}"
download "${ca_bundle}" "https://curl.se/ca/cacert-${ca_bundle_date}.pem" "${ca_bundle_sha256}"

tar -xzf "${git_archive}" --strip-components=1 -C "${source_dir}/git"
tar -xzf "${zlib_archive}" --strip-components=1 -C "${source_dir}/zlib"
tar -xzf "${openssl_archive}" --strip-components=1 -C "${source_dir}/openssl"
tar -xJf "${curl_archive}" --strip-components=1 -C "${source_dir}/curl"

(
  cd -- "${source_dir}/zlib"
  ./configure --static --prefix="${deps_dir}"
  make -j"${jobs}"
  make install
) >"${run_root}/zlib-build.log" 2>&1
(
  cd -- "${source_dir}/openssl"
  ./Configure linux-x86_64 no-shared no-tests no-module no-dso \
    --prefix="${deps_dir}" --openssldir="${deps_dir}/ssl"
  make -j"${jobs}"
  make install_sw
) >"${run_root}/openssl-build.log" 2>&1
(
  cd -- "${source_dir}/curl"
  PKG_CONFIG_PATH="${deps_dir}/lib64/pkgconfig:${deps_dir}/lib/pkgconfig" \
    CPPFLAGS="-I${deps_dir}/include" \
    LDFLAGS="-L${deps_dir}/lib64 -L${deps_dir}/lib" \
    ./configure \
      --prefix="${deps_dir}" \
      --disable-shared \
      --enable-static \
      --disable-ldap \
      --disable-ldaps \
      --disable-rtsp \
      --disable-dict \
      --disable-telnet \
      --disable-tftp \
      --disable-pop3 \
      --disable-imap \
      --disable-smb \
      --disable-smtp \
      --disable-gopher \
      --disable-mqtt \
      --disable-manual \
      --without-libpsl \
      --without-libidn2 \
      --without-libssh2 \
      --without-librtmp \
      --without-brotli \
      --without-zstd \
      --without-nghttp2 \
      --with-openssl="${deps_dir}" \
      --with-zlib="${deps_dir}"
  make -j"${jobs}"
  make install
) >"${run_root}/curl-build.log" 2>&1

if find "${deps_dir}" -type f \( -name 'libcurl.so*' -o -name 'libssl.so*' -o -name 'libcrypto.so*' -o -name 'libz.so*' \) -print -quit | grep -q .; then
  echo "A dependency unexpectedly produced a shared library" >&2
  exit 1
fi

make_options=(
  "prefix=/usr"
  "CURL_CONFIG=${deps_dir}/bin/curl-config"
  "CFLAGS=-O2 -I${deps_dir}/include"
  "LDFLAGS=-L${deps_dir}/lib64 -L${deps_dir}/lib"
  "NO_TCLTK=YesPlease"
  "NO_GETTEXT=YesPlease"
  "NO_PERL=YesPlease"
  "NO_PYTHON=YesPlease"
  "NO_EXPAT=YesPlease"
)
(
  cd -- "${source_dir}/git"
  make -j"${jobs}" "${make_options[@]}" all
) >"${run_root}/git-build.log" 2>&1
(
  cd -- "${source_dir}/git"
  make "${make_options[@]}" "DESTDIR=${stage_dir}" install
) >"${run_root}/git-install.log" 2>&1

install -s -m 755 "${stage_dir}/usr/bin/git" "${runtime_dir}/bin/git.bin"
install -s -m 755 \
  "${stage_dir}/usr/libexec/git-core/git-remote-http" \
  "${runtime_dir}/libexec/git-core/git-remote-http"
printf '%s\n' '#!/bin/sh' 'exec "${0%/*}/git-remote-http" "$@"' \
  >"${runtime_dir}/libexec/git-core/git-remote-https"
chmod 755 "${runtime_dir}/libexec/git-core/git-remote-https"
cp -a -- "${stage_dir}/usr/share/git-core" "${runtime_dir}/share"
install -m 644 "${ca_bundle}" "${runtime_dir}/share/ca-bundle.crt"
install -m 644 "${source_dir}/git/COPYING" "${runtime_dir}/share/licenses/Git-COPYING"
install -m 644 "${source_dir}/zlib/LICENSE" "${runtime_dir}/share/licenses/zlib-LICENSE"
install -m 644 "${source_dir}/openssl/LICENSE.txt" "${runtime_dir}/share/licenses/OpenSSL-LICENSE.txt"
install -m 644 "${source_dir}/curl/COPYING" "${runtime_dir}/share/licenses/curl-COPYING"
cp -a -- "${git_archive}" "${zlib_archive}" "${openssl_archive}" "${curl_archive}" \
  "${ca_bundle}" "${runtime_dir}/source/archives/"

printf '%s\n' \
  '#!/bin/sh' \
  'git_bin_dir=${0%/*}' \
  'git_root=${git_bin_dir}/..' \
  'export GIT_EXEC_PATH="${git_root}/libexec/git-core"' \
  'export GIT_TEMPLATE_DIR="${git_root}/share/git-core/templates"' \
  'export GIT_SSL_CAINFO="${git_root}/share/ca-bundle.crt"' \
  'export PATH="${git_bin_dir}"' \
  'exec "${git_root}/bin/git.bin" "$@"' \
  >"${runtime_dir}/bin/git"
chmod 755 "${runtime_dir}/bin/git"

dynamic_libraries="${run_root}/dynamic-libraries.log"
ldd "${runtime_dir}/bin/git.bin" >"${dynamic_libraries}" 2>&1
ldd "${runtime_dir}/libexec/git-core/git-remote-http" >>"${dynamic_libraries}" 2>&1
if grep -Eiq 'lib(curl|ssl|crypto|z)\.so' "${dynamic_libraries}"; then
  echo "Git runtime still depends on a system networking library" >&2
  exit 1
fi

binary_sha256="$(sha256sum "${runtime_dir}/bin/git.bin" | awk '{ print $1 }')"
remote_http_sha256="$(sha256sum "${runtime_dir}/libexec/git-core/git-remote-http" | awk '{ print $1 }')"
printf '{\n  "schema": 2,\n  "component": "git",\n  "version": "%s",\n  "commit": "%s",\n  "sourceSha256": "%s",\n  "binarySha256": "%s",\n  "remoteHttpSha256": "%s",\n  "dependencies": {\n    "zlib": { "version": "%s", "commit": "%s", "sourceSha256": "%s" },\n    "openssl": { "version": "%s", "commit": "%s", "sourceSha256": "%s" },\n    "curl": { "version": "%s", "commit": "%s", "sourceSha256": "%s" },\n    "caBundle": { "date": "%s", "sha256": "%s" }\n  },\n  "platform": "linux-x64"\n}\n' \
  "${git_version}" "${git_commit}" "${git_sha256}" "${binary_sha256}" "${remote_http_sha256}" \
  "${zlib_version}" "${zlib_commit}" "${zlib_sha256}" \
  "${openssl_version}" "${openssl_commit}" "${openssl_sha256}" \
  "${curl_version}" "${curl_commit}" "${curl_sha256}" \
  "${ca_bundle_date}" "${ca_bundle_sha256}" \
  >"${runtime_dir}/wildbuzzard-git-runtime.json"

"${runtime_dir}/bin/git" --version >"${run_root}/version.log" 2>&1
mkdir -p -- "${run_root}/empty-home"
env -i HOME="${run_root}/empty-home" \
  "${runtime_dir}/bin/git" clone --depth=1 \
  https://github.com/git/git.git "${run_root}/github-clone" \
  >"${run_root}/github-clone.log" 2>&1
test -f "${run_root}/github-clone/README.md"

runtime_zip="${artifact_dir}/wildbuzzard-git-runtime-linux-x64-${git_commit:0:12}.zip"
(
  cd -- "${runtime_dir}"
  zip -q -9 -r "${runtime_zip}" .
)
sha256sum "${runtime_zip}" >"${runtime_zip}.sha256"

{
  echo "git_version=${git_version}"
  echo "git_commit=${git_commit}"
  echo "git_source_sha256=${git_sha256}"
  echo "zlib_version=${zlib_version}"
  echo "zlib_commit=${zlib_commit}"
  echo "zlib_source_sha256=${zlib_sha256}"
  echo "openssl_version=${openssl_version}"
  echo "openssl_commit=${openssl_commit}"
  echo "openssl_source_sha256=${openssl_sha256}"
  echo "curl_version=${curl_version}"
  echo "curl_commit=${curl_commit}"
  echo "curl_source_sha256=${curl_sha256}"
  echo "ca_bundle_date=${ca_bundle_date}"
  echo "ca_bundle_sha256=${ca_bundle_sha256}"
  echo "binary_sha256=${binary_sha256}"
  echo "remote_http_sha256=${remote_http_sha256}"
  echo "runtime_zip=${runtime_zip}"
  echo "runtime_sha256=$(sha256sum "${runtime_zip}" | awk '{ print $1 }')"
} >"${run_root}/build-manifest.txt"

echo "Git runtime: ${runtime_zip}"
echo "Logs: ${run_root}"
