#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

set -Eeuo pipefail
umask 022

usage() {
  echo "Usage: $0 --wildbuzzard DIR --commit SHA --work-dir DIR --artifact-dir DIR --boost-archive FILE --qt-source-archive FILE --lrelease FILE"
}

wildbuzzard=""
commit=""
work_dir=""
artifact_dir=""
boost_archive=""
qt_source_archive=""
lrelease=""

while (($#)); do
  case "$1" in
    --wildbuzzard) wildbuzzard="${2:?}"; shift 2 ;;
    --commit) commit="${2:?}"; shift 2 ;;
    --work-dir) work_dir="${2:?}"; shift 2 ;;
    --artifact-dir) artifact_dir="${2:?}"; shift 2 ;;
    --boost-archive) boost_archive="${2:?}"; shift 2 ;;
    --qt-source-archive) qt_source_archive="${2:?}"; shift 2 ;;
    --lrelease) lrelease="${2:?}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

for variable in wildbuzzard commit work_dir artifact_dir boost_archive qt_source_archive lrelease; do
  if [[ -z "${!variable}" ]]; then
    echo "Missing required value: ${variable}" >&2
    exit 2
  fi
done

wildbuzzard="$(realpath -- "${wildbuzzard}")"
boost_archive="$(realpath -- "${boost_archive}")"
qt_source_archive="$(realpath -- "${qt_source_archive}")"
lrelease="$(realpath -- "${lrelease}")"
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

build_root="${work_dir}/qbittorrent"
"${wildbuzzard}/wildbuzzard/scripts/build-qbittorrent-runtime.sh" \
  --boost-archive "${boost_archive}" \
  --build-root "${build_root}" \
  --lrelease "${lrelease}" \
  --qt-source-archive "${qt_source_archive}" \
  --ref HEAD

mapfile -d '' -t runs < <(
  find "${build_root}/runs" -mindepth 1 -maxdepth 1 -type d -print0
)
if ((${#runs[@]} != 1)); then
  echo "Expected one qBittorrent build run, found ${#runs[@]}" >&2
  exit 1
fi
run="${runs[0]}"

cp -a -- "${run}/runtime" "${artifact_dir}/runtime"
find "${run}/artifacts" -mindepth 1 -maxdepth 1 -type f -exec \
  install -m 0644 -- {} "${artifact_dir}/" \;
install -m 0644 -- \
  "${run}/build-manifest.txt" \
  "${artifact_dir}/qbittorrent-build-manifest.txt"

(
  cd -- "${artifact_dir}"
  find . -type f ! -name SHA256SUMS -printf '%P\0' |
    LC_ALL=C sort -z |
    xargs -0 sha256sum >SHA256SUMS
)

echo "qBittorrent artifacts: ${artifact_dir}"
