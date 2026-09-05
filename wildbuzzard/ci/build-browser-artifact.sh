#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

set -Eeuo pipefail
umask 022

usage() {
  echo "Usage: $0 --wildbuzzard DIR --commit SHA --input-digest SHA256 --work-dir DIR --artifact-dir DIR"
}

wildbuzzard=""
commit=""
work_dir=""
artifact_dir=""
input_digest=""

while (($#)); do
  case "$1" in
    --wildbuzzard) wildbuzzard="${2:?}"; shift 2 ;;
    --commit) commit="${2:?}"; shift 2 ;;
    --work-dir) work_dir="${2:?}"; shift 2 ;;
    --artifact-dir) artifact_dir="${2:?}"; shift 2 ;;
    --input-digest) input_digest="${2:?}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

for variable in wildbuzzard commit input_digest work_dir artifact_dir; do
  if [[ -z "${!variable}" ]]; then
    echo "Missing required value: ${variable}" >&2
    exit 2
  fi
done

if [[ ! "${input_digest}" =~ ^[0-9a-f]{64}$ ]]; then
  echo "--input-digest must be a lowercase SHA-256 digest" >&2
  exit 2
fi

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

python3 -I -B "${wildbuzzard}/wildbuzzard/scripts/firefox_release.py" check --versions-only

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

browser_root="${work_dir}/browser"
"${wildbuzzard}/wildbuzzard/scripts/build-linux-external.sh" \
  --action archive \
  --build-root "${browser_root}" \
  --jobs "${WILDBUZZARD_BUILD_JOBS:-$(nproc)}" \
  --ref HEAD
browser_run="$(one_run "${browser_root}")"

install -m 0644 -- \
  "$(one_file "${browser_run}/obj/dist" 'wildbuzzard-*.en-US.linux-x86_64.tar.*')" \
  "${artifact_dir}/"
install -m 0644 -- \
  "${browser_run}/build-manifest.txt" \
  "${artifact_dir}/browser-build-manifest.txt"

cat >"${artifact_dir}/browser-artifact-manifest.txt" <<EOF
wildbuzzard_commit=${commit}
browser_input_sha256=${input_digest}
architecture=amd64
runner=ubuntu-24.04
external_components=deferred-to-final-assembly
EOF

(
  cd -- "${artifact_dir}"
  find . -maxdepth 1 -type f ! -name SHA256SUMS -printf '%f\0' |
    LC_ALL=C sort -z |
    xargs -0 sha256sum >SHA256SUMS
)

echo "Browser artifacts: ${artifact_dir}"
