#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

set -Eeuo pipefail
umask 022

usage() {
  echo "Usage: $0 --wildbuzzard DIR --commit SHA --work-dir DIR --artifact-dir DIR"
}

wildbuzzard=""
commit=""
work_dir=""
artifact_dir=""

while (($#)); do
  case "$1" in
    --wildbuzzard) wildbuzzard="${2:?}"; shift 2 ;;
    --commit) commit="${2:?}"; shift 2 ;;
    --work-dir) work_dir="${2:?}"; shift 2 ;;
    --artifact-dir) artifact_dir="${2:?}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

for variable in wildbuzzard commit work_dir artifact_dir; do
  if [[ -z "${!variable}" ]]; then
    echo "Missing required value: ${variable}" >&2
    exit 2
  fi
done

wildbuzzard="$(realpath -- "${wildbuzzard}")"
mkdir -p -- "${work_dir}" "${artifact_dir}"
work_dir="$(realpath -- "${work_dir}")"
artifact_dir="$(realpath -- "${artifact_dir}")"

if [[ ! "${commit}" =~ ^[0-9a-f]{40}$ ]] ||
  [[ "$(git -C "${wildbuzzard}" rev-parse HEAD)" != "${commit}" ]] ||
  [[ -n "$(git -C "${wildbuzzard}" status --short)" ]]; then
  echo "WildBuzzard must be a clean checkout at the requested commit" >&2
  exit 2
fi
if [[ -n "$(find "${artifact_dir}" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  echo "Artifact directory must be empty: ${artifact_dir}" >&2
  exit 2
fi
for output in "${work_dir}" "${artifact_dir}"; do
  case "${output}/" in
    "${wildbuzzard}/"*) echo "Build output must be outside the source checkout" >&2; exit 2 ;;
  esac
done

export TMPDIR="${work_dir}/tmp"
export UV_CACHE_DIR="${work_dir}/cache/uv"
export XDG_CACHE_HOME="${work_dir}/cache/xdg"
export CARGO_HOME="${work_dir}/cache/cargo-home"
mkdir -p -- "${TMPDIR}" "${UV_CACHE_DIR}" "${XDG_CACHE_HOME}" "${CARGO_HOME}"

one_run() {
  local root="$1"
  local -a matches
  mapfile -d '' -t matches < <(
    find "${root}/runs" -mindepth 1 -maxdepth 1 -type d -print0
  )
  if ((${#matches[@]} != 1)); then
    echo "Expected one build run under ${root}, found ${#matches[@]}" >&2
    exit 1
  fi
  printf '%s\n' "${matches[0]}"
}

one_file() {
  local root="$1"
  local pattern="$2"
  local -a matches
  mapfile -d '' -t matches < <(find "${root}" -type f -name "${pattern}" -print0)
  if ((${#matches[@]} != 1)); then
    echo "Expected one ${pattern} under ${root}, found ${#matches[@]}" >&2
    exit 1
  fi
  printf '%s\n' "${matches[0]}"
}

manifest_value() {
  local manifest="$1"
  local key="$2"
  local value
  value="$(sed -n "s/^${key}=//p" "${manifest}")"
  if [[ -z "${value}" ]]; then
    echo "Missing ${key} in ${manifest}" >&2
    exit 1
  fi
  printf '%s\n' "${value}"
}

arti_root="${work_dir}/arti"
"${wildbuzzard}/wildbuzzard/scripts/build-arti-runtime.sh" \
  --build-root "${arti_root}"
arti_run="$(one_run "${arti_root}")"
arti_manifest="${arti_run}/build-manifest.txt"
arti_binary="$(manifest_value "${arti_manifest}" artifact)"
arti_provenance="$(manifest_value "${arti_manifest}" provenance)"

browser_root="${work_dir}/browser"
"${wildbuzzard}/wildbuzzard/scripts/build-linux-external.sh" \
  --action deb \
  --build-root "${browser_root}" \
  --jobs "$(nproc)" \
  --ref HEAD \
  --arti-binary "${arti_binary}" \
  --arti-provenance "${arti_provenance}"
browser_run="$(one_run "${browser_root}")"

install -m 0644 -- \
  "$(one_file "${browser_run}/artifacts" 'wildbuzzard_*_amd64.deb')" \
  "${artifact_dir}/"
install -m 0644 -- "${arti_manifest}" "${artifact_dir}/arti-build-manifest.txt"
install -m 0644 -- \
  "${browser_run}/build-manifest.txt" \
  "${artifact_dir}/browser-build-manifest.txt"

cat >"${artifact_dir}/browser-artifact-manifest.txt" <<EOF
wildbuzzard_commit=${commit}
architecture=amd64
runner=ubuntu-24.04
external_component_repositories=none
EOF

(
  cd -- "${artifact_dir}"
  find . -maxdepth 1 -type f ! -name SHA256SUMS -printf '%f\0' |
    LC_ALL=C sort -z |
    xargs -0 sha256sum >SHA256SUMS
  sha256sum --check --strict SHA256SUMS
)

echo "Browser artifacts: ${artifact_dir}"
