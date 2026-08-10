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
archive_sha256="262c0e5f0f082c8c05e8192040a786ec0c8cafeeeaf8b7fa2a16c17be2deefa2"

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
artifact_dir="${run_root}/artifacts"
download_dir="${build_root}/downloads"
archive="${download_dir}/git-${git_commit}.tar.gz"
mkdir -p -- \
  "${source_dir}" \
  "${stage_dir}" \
  "${runtime_dir}/bin" \
  "${runtime_dir}/libexec/git-core" \
  "${runtime_dir}/source" \
  "${artifact_dir}" \
  "${download_dir}"

if [[ ! -f "${archive}" ]]; then
  curl --fail --location \
    --output "${archive}" \
    "https://github.com/git/git/archive/${git_commit}.tar.gz"
fi
actual_sha256="$(sha256sum "${archive}" | awk '{ print $1 }')"
if [[ "${actual_sha256}" != "${archive_sha256}" ]]; then
  echo "Git source archive checksum mismatch" >&2
  exit 1
fi

tar -xzf "${archive}" --strip-components=1 -C "${source_dir}"
make_options=(
  "prefix=/usr"
  "NO_TCLTK=YesPlease"
  "NO_GETTEXT=YesPlease"
  "NO_PERL=YesPlease"
  "NO_PYTHON=YesPlease"
)
(
  cd -- "${source_dir}"
  make -j"${jobs}" "${make_options[@]}" all
) >"${run_root}/build.log" 2>&1
(
  cd -- "${source_dir}"
  make "${make_options[@]}" "DESTDIR=${stage_dir}" install
) >"${run_root}/install.log" 2>&1

install -s -m 755 "${stage_dir}/usr/bin/git" "${runtime_dir}/bin/git.bin"
install -s -m 755 \
  "${stage_dir}/usr/libexec/git-core/git-remote-http" \
  "${runtime_dir}/libexec/git-core/git-remote-http"
printf '%s\n' \
  '#!/bin/sh' \
  'exec "${0%/*}/git-remote-http" "$@"' \
  >"${runtime_dir}/libexec/git-core/git-remote-https"
chmod 755 "${runtime_dir}/libexec/git-core/git-remote-https"
cp -a -- "${stage_dir}/usr/share/git-core" "${runtime_dir}/share"
install -m 644 "${source_dir}/COPYING" "${runtime_dir}/COPYING"
install -m 644 "${archive}" "${runtime_dir}/source/git-${git_commit}.tar.gz"

printf '%s\n' \
  '#!/bin/sh' \
  'git_bin_dir=${0%/*}' \
  'git_root=${git_bin_dir}/..' \
  'export GIT_EXEC_PATH="${git_root}/libexec/git-core"' \
  'export GIT_TEMPLATE_DIR="${git_root}/share/templates"' \
  'export PATH="${git_bin_dir}"' \
  'exec "${git_root}/bin/git.bin" "$@"' \
  >"${runtime_dir}/bin/git"
chmod 755 "${runtime_dir}/bin/git"

binary_sha256="$(sha256sum "${runtime_dir}/bin/git.bin" | awk '{ print $1 }')"
printf '{\n  "schema": 1,\n  "component": "git",\n  "version": "%s",\n  "commit": "%s",\n  "sourceSha256": "%s",\n  "binarySha256": "%s",\n  "platform": "linux-x64"\n}\n' \
  "${git_version}" \
  "${git_commit}" \
  "${archive_sha256}" \
  "${binary_sha256}" \
  >"${runtime_dir}/wildbuzzard-git-runtime.json"

"${runtime_dir}/bin/git" --version >"${run_root}/version.log" 2>&1
ldd "${runtime_dir}/bin/git.bin" >"${run_root}/dynamic-libraries.log" 2>&1

runtime_zip="${artifact_dir}/wildbuzzard-git-runtime-linux-x64-${git_commit:0:12}.zip"
(
  cd -- "${runtime_dir}"
  zip -q -r "${runtime_zip}" .
)
sha256sum "${runtime_zip}" >"${runtime_zip}.sha256"

{
  echo "git_version=${git_version}"
  echo "git_commit=${git_commit}"
  echo "source_sha256=${archive_sha256}"
  echo "binary_sha256=${binary_sha256}"
  echo "runtime_zip=${runtime_zip}"
  echo "runtime_sha256=$(sha256sum "${runtime_zip}" | awk '{ print $1 }')"
} >"${run_root}/build-manifest.txt"

echo "Git runtime: ${runtime_zip}"
echo "Logs: ${run_root}"
