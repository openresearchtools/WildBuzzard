#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0

set -Eeuo pipefail

usage() {
  echo "Usage: $0 [--build-root DIR] [--binary FILE]"
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source_repo="$(cd -- "${script_dir}/../.." && pwd -P)"
metadata="${source_repo}/wildbuzzard/third_party/arti.toml"
build_root="$(dirname -- "${source_repo}")/wildbuzzard-arti-builds"
input_binary=""

while (($#)); do
  case "$1" in
    --build-root)
      build_root="${2:?--build-root requires a directory}"
      shift 2
      ;;
    --binary)
      input_binary="${2:?--binary requires a file}"
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
arti_tree="$(read_pin tree)"
source_date_epoch="$(read_pin source_date_epoch)"
build_rustc="$(read_pin build_rustc)"
build_cargo="$(read_pin build_cargo)"
binary_sha256="$(read_pin linux_x86_64_binary_sha256)"
source_sha256="$(read_pin source_sha256)"
cargo_lock_sha256="$(read_pin cargo_lock_sha256)"
cargo_vendor_sha256="$(read_pin cargo_vendor_sha256)"
cargo_license_inventory_sha256="$(read_pin cargo_license_inventory_sha256)"
license_apache_sha256="$(read_pin license_apache_sha256)"
license_mit_sha256="$(read_pin license_mit_sha256)"
crate_inventory="${source_repo}/wildbuzzard/third_party/arti-crates/THIRD-PARTY.json"
crate_provenance="${script_dir}/arti_crate_provenance.py"

if [[ -n "${input_binary}" ]]; then
  input_binary="$(realpath -- "${input_binary}")"
  if [[ ! -f "${input_binary}" || ! -x "${input_binary}" || -L "${input_binary}" ]]; then
    echo "--binary must name a regular executable file" >&2
    exit 2
  fi
fi

if ! git -C "${source_repo}" diff --quiet -- third_party/arti ||
  [[ -n "$(git -C "${source_repo}" ls-files --others --exclude-standard -- third_party/arti)" ]]; then
  echo "The vendored Arti subtree must remain unmodified" >&2
  exit 2
fi

expected_tree="$(git -C "${source_repo}" rev-parse "${arti_commit}^{tree}")"
actual_tree="$(git -C "${source_repo}" rev-parse HEAD:third_party/arti)"
if [[ "${expected_tree}" != "${actual_tree}" || "${actual_tree}" != "${arti_tree}" ]]; then
  echo "The Arti subtree does not match pinned commit ${arti_commit}" >&2
  exit 2
fi
if [[ "$(git -C "${source_repo}" show -s --format=%ct "${arti_commit}")" != "${source_date_epoch}" ]]; then
  echo "The Arti commit timestamp differs from the release pin" >&2
  exit 2
fi
if [[ "$(sha256sum "${arti_source}/Cargo.lock" | awk '{ print $1 }')" != "${cargo_lock_sha256}" || \
  "$(sha256sum "${arti_source}/LICENSE-APACHE" | awk '{ print $1 }')" != "${license_apache_sha256}" || \
  "$(sha256sum "${arti_source}/LICENSE-MIT" | awk '{ print $1 }')" != "${license_mit_sha256}" ]]; then
  echo "The Arti lock or licenses differ from the release pins" >&2
  exit 2
fi
if [[ "$(sha256sum "${crate_inventory}" | awk '{ print $1 }')" != "${cargo_license_inventory_sha256}" ]]; then
  echo "The Arti crate license inventory differs from the release pin" >&2
  exit 2
fi
python3 -I -B "${crate_provenance}" verify
if [[ "$(rustc --version)" != "${build_rustc}" || "$(cargo --version)" != "${build_cargo}" ]]; then
  echo "The Arti build toolchain differs from the release pins" >&2
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
cargo_home="${build_root}/cargo-home/${arti_commit}"
artifacts_dir="${run_root}/artifacts"
vendor_dir="${run_root}/vendor"
mkdir -p -- "${run_root}" "${artifacts_dir}" "${target_dir}" "${cargo_home}"

if [[ "$(uname -m)" != "x86_64" ]]; then
  echo "Unsupported Arti artifact architecture: $(uname -m)" >&2
  exit 2
fi
artifact_arch="linux-x86_64"

env CARGO_HOME="${cargo_home}" cargo vendor \
  --locked \
  --versioned-dirs \
  --manifest-path "${arti_source}/Cargo.toml" \
  "${vendor_dir}" \
  >"${cargo_home}/config.toml" \
  2>"${run_root}/vendor.log"
printf '\n[net]\noffline = true\n' >>"${cargo_home}/config.toml"

cargo_vendor_archive="${artifacts_dir}/wildbuzzard-arti-${arti_version}-cargo-vendor.tar.xz"
python3 -I -B "${crate_provenance}" source-archive \
  --vendor-dir "${vendor_dir}" \
  --output "${cargo_vendor_archive}"
if [[ "$(sha256sum "${cargo_vendor_archive}" | awk '{ print $1 }')" != "${cargo_vendor_sha256}" ]]; then
  echo "The Arti Cargo vendor source archive differs from the release pin" >&2
  exit 1
fi
sha256sum "${cargo_vendor_archive}" >"${cargo_vendor_archive}.sha256"

if [[ -z "${input_binary}" ]]; then
  env \
    CARGO_HOME="${cargo_home}" \
    CARGO_NET_OFFLINE=true \
    CARGO_TARGET_DIR="${target_dir}" \
    cargo build \
    --manifest-path "${arti_source}/Cargo.toml" \
    --release \
    --frozen \
    --package arti \
    >"${run_root}/build.log" 2>&1
  input_binary="${target_dir}/release/arti"
else
  printf 'Reused pinned source-built artifact: %s\n' "${input_binary}" \
    >"${run_root}/build.log"
fi

artifact="${artifacts_dir}/arti-${arti_version}-${artifact_arch}"
install -m 755 "${input_binary}" "${artifact}"
if [[ "$(sha256sum "${artifact}" | awk '{ print $1 }')" != "${binary_sha256}" ]]; then
  echo "The Arti binary differs from the release pin" >&2
  exit 1
fi
sha256sum "${artifact}" >"${artifact}.sha256"

source_archive="${artifacts_dir}/wildbuzzard-arti-${arti_version}-source.tar.xz"
create_source_archive() {
  git -C "${source_repo}" archive \
    --format=tar \
    --prefix="arti-${arti_version}/" \
    "${arti_commit}" |
    xz --threads=1 --check=crc64 -9e >"${source_archive}"
}
create_source_archive
if [[ "$(sha256sum "${source_archive}" | awk '{ print $1 }')" != "${source_sha256}" ]]; then
  echo "The Arti corresponding-source archive differs from the release pin" >&2
  exit 1
fi
sha256sum "${source_archive}" >"${source_archive}.sha256"

provenance="${artifacts_dir}/wildbuzzard-arti-${arti_version}-provenance.zip"
python3 -I -B "${script_dir}/arti-runtime-provenance.py" create \
  --binary "${artifact}" \
  --config "${metadata}" \
  --source "${source_archive}" \
  --cargo-vendor "${cargo_vendor_archive}" \
  --inventory "${crate_inventory}" \
  --output "${provenance}" \
  --source-date-epoch "${source_date_epoch}"
sha256sum "${provenance}" >"${provenance}.sha256"

{
  echo "arti_tag=${arti_tag}"
  echo "arti_commit=${arti_commit}"
  echo "arti_tree=${arti_tree}"
  echo "rustc=${build_rustc}"
  echo "cargo=${build_cargo}"
  echo "artifact=${artifact}"
  echo "binary_sha256=${binary_sha256}"
  echo "source=${source_archive}"
  echo "source_sha256=${source_sha256}"
  echo "cargo_vendor=${cargo_vendor_archive}"
  echo "cargo_vendor_sha256=${cargo_vendor_sha256}"
  echo "cargo_license_inventory=${crate_inventory}"
  echo "cargo_license_inventory_sha256=${cargo_license_inventory_sha256}"
  echo "provenance=${provenance}"
  echo "provenance_sha256=$(sha256sum "${provenance}" | awk '{ print $1 }')"
} >"${run_root}/build-manifest.txt"

echo "Arti: ${artifact}"
echo "Arti provenance: ${provenance}"
echo "Manifest: ${run_root}/build-manifest.txt"
