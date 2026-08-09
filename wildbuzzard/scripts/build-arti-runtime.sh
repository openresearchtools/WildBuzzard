#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0

set -Eeuo pipefail

usage() {
  echo "Usage: $0 [--build-root DIR]"
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source_repo="$(cd -- "${script_dir}/../.." && pwd -P)"
metadata="${source_repo}/wildbuzzard/third_party/arti.toml"
build_root="$(dirname -- "${source_repo}")/wildbuzzard-arti-builds"

while (($#)); do
  case "$1" in
    --build-root)
      build_root="${2:?--build-root requires a directory}"
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

read_pin() {
  awk -F' = ' -v key="$1" '$1 == key { gsub(/^"|"$/, "", $2); print $2 }' "${metadata}"
}

arti_commit="$(read_pin commit)"
arti_tag="$(read_pin tag)"
arti_version="${arti_tag#arti-v}"
arti_source="${source_repo}/third_party/arti"

if ! git -C "${source_repo}" diff --quiet -- third_party/arti ||
  [[ -n "$(git -C "${source_repo}" ls-files --others --exclude-standard -- third_party/arti)" ]]; then
  echo "The vendored Arti subtree must remain unmodified" >&2
  exit 2
fi

expected_tree="$(git -C "${source_repo}" rev-parse "${arti_commit}^{tree}")"
actual_tree="$(git -C "${source_repo}" rev-parse HEAD:third_party/arti)"
if [[ "${expected_tree}" != "${actual_tree}" ]]; then
  echo "The Arti subtree does not match pinned commit ${arti_commit}" >&2
  exit 2
fi

mkdir -p -- "${build_root}"
build_root="$(cd -- "${build_root}" && pwd -P)"
case "${build_root}/" in
  "${source_repo}/"*)
    echo "Build root must be outside the WildBuzzard repository" >&2
    exit 2
    ;;
esac

run_id="$(date -u +%Y%m%dT%H%M%SZ)-${arti_version}-$$"
run_root="${build_root}/runs/${run_id}"
target_dir="${build_root}/cargo/${arti_commit}"
artifacts_dir="${run_root}/artifacts"
mkdir -p -- "${run_root}" "${artifacts_dir}" "${target_dir}"

CARGO_TARGET_DIR="${target_dir}" cargo build \
  --manifest-path "${arti_source}/Cargo.toml" \
  --release \
  --locked \
  --package arti \
  >"${run_root}/build.log" 2>&1

case "$(uname -m)" in
  x86_64) artifact_arch="linux-x86_64" ;;
  aarch64|arm64) artifact_arch="linux-aarch64" ;;
  *)
    echo "Unsupported Arti artifact architecture: $(uname -m)" >&2
    exit 2
    ;;
esac

artifact="${artifacts_dir}/arti-${arti_version}-${artifact_arch}"
install -m 755 "${target_dir}/release/arti" "${artifact}"
sha256sum "${artifact}" >"${artifact}.sha256"

{
  echo "arti_tag=${arti_tag}"
  echo "arti_commit=${arti_commit}"
  echo "arti_tree=${actual_tree}"
  echo "rustc=$(rustc --version)"
  echo "cargo=$(cargo --version)"
  echo "artifact=${artifact}"
  echo "sha256=$(sha256sum "${artifact}" | awk '{ print $1 }')"
} >"${run_root}/build-manifest.txt"

echo "Arti: ${artifact}"
echo "Manifest: ${run_root}/build-manifest.txt"
