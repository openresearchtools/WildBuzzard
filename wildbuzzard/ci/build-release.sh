#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

set -Eeuo pipefail
umask 022

usage() {
  cat <<'EOF'
Usage: build-release.sh OPTIONS

Required options:
  --wildbuzzard DIR --wildbuzzard-commit SHA
  --buzzard-search DIR --buzzard-search-commit SHA
  --buzzard-minijtt DIR --buzzard-minijtt-commit SHA
  --extensions DIR --extensions-commit SHA
  --work-dir DIR --artifact-dir DIR
EOF
}

wildbuzzard=""
wildbuzzard_commit=""
buzzard_search=""
buzzard_search_commit=""
buzzard_minijtt=""
buzzard_minijtt_commit=""
extensions=""
extensions_commit=""
work_dir=""
artifact_dir=""

while (($#)); do
  case "$1" in
    --wildbuzzard) wildbuzzard="${2:?}"; shift 2 ;;
    --wildbuzzard-commit) wildbuzzard_commit="${2:?}"; shift 2 ;;
    --buzzard-search) buzzard_search="${2:?}"; shift 2 ;;
    --buzzard-search-commit) buzzard_search_commit="${2:?}"; shift 2 ;;
    --buzzard-minijtt) buzzard_minijtt="${2:?}"; shift 2 ;;
    --buzzard-minijtt-commit) buzzard_minijtt_commit="${2:?}"; shift 2 ;;
    --extensions) extensions="${2:?}"; shift 2 ;;
    --extensions-commit) extensions_commit="${2:?}"; shift 2 ;;
    --work-dir) work_dir="${2:?}"; shift 2 ;;
    --artifact-dir) artifact_dir="${2:?}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

for variable in \
  wildbuzzard wildbuzzard_commit \
  buzzard_search buzzard_search_commit \
  buzzard_minijtt buzzard_minijtt_commit \
  extensions extensions_commit \
  work_dir artifact_dir; do
  if [[ -z "${!variable}" ]]; then
    echo "Missing required value: ${variable}" >&2
    exit 2
  fi
done

wildbuzzard="$(realpath -- "${wildbuzzard}")"
buzzard_search="$(realpath -- "${buzzard_search}")"
buzzard_minijtt="$(realpath -- "${buzzard_minijtt}")"
extensions="$(realpath -- "${extensions}")"
mkdir -p -- "${work_dir}" "${artifact_dir}"
work_dir="$(realpath -- "${work_dir}")"
artifact_dir="$(realpath -- "${artifact_dir}")"

if [[ -n "$(find "${artifact_dir}" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  echo "Artifact directory must be empty: ${artifact_dir}" >&2
  exit 2
fi

repositories=(
  "wildbuzzard=${wildbuzzard}=${wildbuzzard_commit}"
  "buzzard-search=${buzzard_search}=${buzzard_search_commit}"
  "buzzard-minijtt=${buzzard_minijtt}=${buzzard_minijtt_commit}"
  "extensions=${extensions}=${extensions_commit}"
)

for entry in "${repositories[@]}"; do
  IFS='=' read -r name repository expected_commit <<<"${entry}"
  if [[ ! "${expected_commit}" =~ ^[0-9a-f]{40}$ ]]; then
    echo "${name} commit must be a lowercase 40-character SHA" >&2
    exit 2
  fi
  actual_commit="$(git -C "${repository}" rev-parse HEAD)"
  if [[ "${actual_commit}" != "${expected_commit}" ]]; then
    echo "${name} checkout is ${actual_commit}, expected ${expected_commit}" >&2
    exit 2
  fi
  if [[ -n "$(git -C "${repository}" status --short)" ]]; then
    echo "${name} checkout must be clean" >&2
    exit 2
  fi
done

mapfile -t firefox_release < <(
  python3 -I -B - "${wildbuzzard}/wildbuzzard/upstreams.toml" <<'PY'
import pathlib
import sys
import tomllib

firefox = tomllib.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))["firefox"]
for field in ("ref", "commit", "version"):
    print(firefox[field])
PY
)
if (( ${#firefox_release[@]} != 3 )); then
  echo "Firefox release pin is incomplete" >&2
  exit 2
fi
firefox_ref="${firefox_release[0]}"
firefox_commit="${firefox_release[1]}"
firefox_version="${firefox_release[2]}"
if [[ ! "${firefox_ref}" =~ ^FIREFOX_[0-9_]+esr_RELEASE$ ]] ||
  [[ ! "${firefox_commit}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Firefox must be pinned to an exact ESR release tag and commit" >&2
  exit 2
fi
if [[ "$(git -C "${wildbuzzard}" rev-parse --is-shallow-repository)" == true ]]; then
  if git -C "${wildbuzzard}" show-ref --verify --quiet "refs/tags/${firefox_ref}"; then
    if ! resolved_firefox_commit="$(
      git -C "${wildbuzzard}" rev-parse --verify "${firefox_ref}^{commit}" 2>/dev/null
    )" || [[ "${resolved_firefox_commit}" != "${firefox_commit}" ]]; then
      echo "WildBuzzard has an unexpected commit for ${firefox_ref}" >&2
      exit 2
    fi
  fi
  echo "WildBuzzard is a shallow checkout; pinned Firefox ancestry is unavailable"
else
  resolved_firefox_commit="$(git -C "${wildbuzzard}" rev-parse "${firefox_ref}^{commit}")"
  if [[ "${resolved_firefox_commit}" != "${firefox_commit}" ]] ||
    ! git -C "${wildbuzzard}" merge-base --is-ancestor \
      "${firefox_commit}" "${wildbuzzard_commit}"; then
    echo "WildBuzzard does not contain the exact pinned Firefox ESR release" >&2
    exit 2
  fi
fi
if [[ "$(<"${wildbuzzard}/browser/config/version_display.txt")" != "${firefox_version}" ]] ||
  [[ "$(<"${wildbuzzard}/browser/config/version.txt")esr" != "${firefox_version}" ]]; then
  echo "Firefox version files do not match the exact ESR release pin" >&2
  exit 2
fi

for repository in \
  "${wildbuzzard}" \
  "${buzzard_search}" \
  "${buzzard_minijtt}" \
  "${extensions}"; do
  case "${work_dir}/" in "${repository}/"*) echo "Work directory is inside ${repository}" >&2; exit 2 ;; esac
  case "${artifact_dir}/" in "${repository}/"*) echo "Artifact directory is inside ${repository}" >&2; exit 2 ;; esac
done

export TMPDIR="${work_dir}/tmp"
export UV_CACHE_DIR="${work_dir}/cache/uv"
export XDG_CACHE_HOME="${work_dir}/cache/xdg"
export DOTNET_CLI_HOME="${work_dir}/cache/dotnet-home"
export NUGET_PACKAGES="${work_dir}/cache/nuget"
export npm_config_cache="${work_dir}/cache/npm"
mkdir -p -- \
  "${TMPDIR}" \
  "${UV_CACHE_DIR}" \
  "${XDG_CACHE_HOME}" \
  "${DOTNET_CLI_HOME}" \
  "${NUGET_PACKAGES}" \
  "${npm_config_cache}"

wildbuzzard_repository="${wildbuzzard}"
buzzard_search_repository="${buzzard_search}"
buzzard_minijtt_repository="${buzzard_minijtt}"
extensions_repository="${extensions}"
checkout_root="${work_dir}/source-checkouts"
if [[ -e "${checkout_root}" ]]; then
  echo "Source checkout directory already exists: ${checkout_root}" >&2
  exit 2
fi
mkdir -p -- "${checkout_root}"

clean_checkout() {
  local name="$1"
  local repository="$2"
  local commit="$3"
  local checkout="${checkout_root}/${name}"
  git clone --quiet --no-hardlinks --no-checkout -- "${repository}" "${checkout}"
  git -C "${checkout}" checkout --quiet --detach "${commit}"
  if [[ "$(git -C "${checkout}" rev-parse HEAD)" != "${commit}" ]] ||
    [[ -n "$(git -C "${checkout}" status --short)" ]]; then
    echo "Failed to create clean ${name} checkout at ${commit}" >&2
    exit 2
  fi
  printf '%s\n' "${checkout}"
}

buzzard_search="$(clean_checkout \
  buzzard-search "${buzzard_search_repository}" "${buzzard_search_commit}")"
buzzard_minijtt="$(clean_checkout \
  buzzard-minijtt "${buzzard_minijtt_repository}" "${buzzard_minijtt_commit}")"
extensions="$(clean_checkout \
  extensions "${extensions_repository}" "${extensions_commit}")"

one_file() {
  local root="$1"
  local pattern="$2"
  local -a matches
  mapfile -d '' -t matches < <(
    find "${root}" -type f -name "${pattern}" -print0
  )
  if ((${#matches[@]} != 1)); then
    echo "Expected one ${pattern} under ${root}, found ${#matches[@]}" >&2
    return 1
  fi
  printf '%s\n' "${matches[0]}"
}

one_run() {
  local root="$1"
  local -a matches
  mapfile -d '' -t matches < <(
    find "${root}/runs" -mindepth 1 -maxdepth 1 -type d -print0
  )
  if ((${#matches[@]} != 1)); then
    echo "Expected one build run under ${root}, found ${#matches[@]}" >&2
    return 1
  fi
  printf '%s\n' "${matches[0]}"
}

copy_artifact() {
  local source="$1"
  local mode="${2:-0644}"
  local destination
  destination="${artifact_dir}/$(basename -- "${source}")"
  if [[ -e "${destination}" ]]; then
    echo "Artifact already exists: ${destination}" >&2
    return 1
  fi
  install -m "${mode}" -- "${source}" "${destination}"
}

python3 "${wildbuzzard}/wildbuzzard/scripts/sync_builtin_search_extensions.py" \
  check \
  --extensions-source "${extensions}"
(
  cd -- "${wildbuzzard}"
  python3 -m unittest -v \
    wildbuzzard/scripts/tests/test_arti_crate_provenance.py \
    wildbuzzard/scripts/tests/test_arti_runtime_packaging.py \
    wildbuzzard/scripts/tests/test_blocker_asset_provenance.py \
    wildbuzzard/scripts/tests/test_builtin_search_extensions.py \
    wildbuzzard/scripts/tests/test_feature_ownership.py \
    wildbuzzard/scripts/tests/test_installable_extension_xpis.py \
    wildbuzzard/scripts/tests/test_legal_payload.py \
    wildbuzzard/scripts/tests/test_product_namespace_isolation.py \
    wildbuzzard/scripts/tests/test_runner_crate_provenance.py \
    wildbuzzard/scripts/tests/test_release_manifest.py
)

python3 -I -B \
  "${wildbuzzard}/wildbuzzard/scripts/runner_crate_provenance.py" \
  source-archive \
  --cache-dir "${work_dir}/cache/runner-crates" \
  --output "${artifact_dir}/wildbuzzard-runner-crates-source.tar.xz"

python3 -I -B \
  "${wildbuzzard}/wildbuzzard/scripts/blocker_asset_provenance.py" \
  build \
  --repository "${wildbuzzard}" \
  --cache-dir "${work_dir}/cache/blocker-assets" \
  --output "${artifact_dir}/wildbuzzard-blocker-assets-source.tar.xz" \
  --node "$(command -v node)"

(
  cd -- "${extensions}/extensions/web-search"
  node scripts/check.mjs
  node --test tests/*.test.mjs
  scripts/package.sh "${artifact_dir}"
)
(
  cd -- "${extensions}/extensions/torrent-search"
  node scripts/check.mjs
  node --test tests/*.test.mjs
  scripts/package.sh "${artifact_dir}"
)
python3 "${wildbuzzard}/wildbuzzard/scripts/verify_installable_extension_xpis.py" \
  --pins "${wildbuzzard}/toolkit/mozapps/extensions/internal/WildBuzzardXPIPins.json" \
  --xpi "$(one_file "${artifact_dir}" 'wildbuzzard-web-search-*.xpi')" \
  --xpi "$(one_file "${artifact_dir}" 'wildbuzzard-torrent-search-*.xpi')"

search_release_root="${work_dir}/buzzard-search-release"
(
  cd -- "${buzzard_search}"
  env BUZZARD_SEARCH_CI_RUN_ROOT="${search_release_root}" \
    ./ci/verify-release.sh
)
search_release="${search_release_root}/artifacts/final"
copy_artifact "$(one_file "${search_release}" 'buzzard-search_*_amd64.deb')"
copy_artifact "$(one_file "${search_release}" 'buzzard-search-*-source-license.tar.xz')"

minijtt_release_root="${work_dir}/buzzard-minijtt-release"
(
  cd -- "${buzzard_minijtt}"
  env BUZZARD_MINIJTT_CI_RUN_ROOT="${minijtt_release_root}" \
    ./ci/verify-release.sh
)
minijtt_release="${minijtt_release_root}/artifacts/final"
copy_artifact "$(one_file "${minijtt_release}" 'buzzard-minijtt_*_amd64.deb')"
copy_artifact "$(one_file "${minijtt_release}" 'buzzard-minijtt-*-source-license.tar.xz')"

python3 -m unittest discover \
  -s "${wildbuzzard}/wildbuzzard/components/buzzard-torrent/test" \
  -p 'test_*.py' -v
qbittorrent_build_root="${work_dir}/qbittorrent"
"${wildbuzzard}/wildbuzzard/scripts/build-qbittorrent-runtime.sh" \
  --boost-archive /opt/wildbuzzard-inputs/boost_1_88_0.tar.bz2 \
  --build-root "${qbittorrent_build_root}" \
  --lrelease /usr/local/bin/lrelease \
  --qt-source-archive /opt/wildbuzzard-inputs/qtbase-everywhere-src-6.10.2.tar.xz \
  --ref HEAD
qbittorrent_run="$(one_run "${qbittorrent_build_root}")"
env \
  BUZZARD_TORRENT_RUNTIME="${qbittorrent_run}/runtime" \
  "${wildbuzzard}/wildbuzzard/components/buzzard-torrent/scripts/build-deb.sh" \
  "${work_dir}/buzzard-torrent/packages"
copy_artifact "$(one_file "${work_dir}/buzzard-torrent/packages" 'buzzard-torrent_*_amd64.deb')"
copy_artifact "$(one_file "${qbittorrent_run}/artifacts" '*.zip')"
copy_artifact "$(sed -n 's/^core_source=//p' "${qbittorrent_run}/build-manifest.txt")"
copy_artifact "$(sed -n 's/^boost_source=//p' "${qbittorrent_run}/build-manifest.txt")"
copy_artifact "$(sed -n 's/^qt_source=//p' "${qbittorrent_run}/build-manifest.txt")"
copy_artifact "$(sed -n 's/^system_source=//p' "${qbittorrent_run}/build-manifest.txt")"
install -m 0644 -- \
  "${qbittorrent_run}/build-manifest.txt" \
  "${artifact_dir}/qbittorrent-build-manifest.txt"

arti_build_root="${work_dir}/arti"
"${wildbuzzard}/wildbuzzard/scripts/build-arti-runtime.sh" \
  --build-root "${arti_build_root}"
arti_run="$(one_run "${arti_build_root}")"
arti_binary="$(sed -n 's/^artifact=//p' "${arti_run}/build-manifest.txt")"
arti_config="$(sed -n 's/^config=//p' "${arti_run}/build-manifest.txt")"
arti_provenance="$(sed -n 's/^provenance=//p' "${arti_run}/build-manifest.txt")"
arti_source="$(sed -n 's/^source=//p' "${arti_run}/build-manifest.txt")"
arti_cargo_vendor="$(sed -n 's/^cargo_vendor=//p' "${arti_run}/build-manifest.txt")"
copy_artifact "${arti_binary}" 0755
copy_artifact "${arti_provenance}"
copy_artifact "${arti_source}"
copy_artifact "${arti_cargo_vendor}"
install -m 0644 -- \
  "${arti_run}/build-manifest.txt" \
  "${artifact_dir}/arti-build-manifest.txt"

browser_build_root="${work_dir}/browser"
"${wildbuzzard}/wildbuzzard/scripts/build-linux-external.sh" \
  --action all \
  --build-root "${browser_build_root}" \
  --jobs "$(nproc)" \
  --ref HEAD \
  --arti-binary "${arti_binary}" \
  --arti-config "${arti_config}" \
  --arti-provenance "${arti_provenance}"
browser_run="$(one_run "${browser_build_root}")"
browser_object_dir="$(sed -n 's/^object_dir=//p' "${browser_run}/build-manifest.txt")"
copy_artifact "$(one_file "${browser_run}/artifacts" 'wildbuzzard_*_amd64.deb')"
copy_artifact "$(one_file "${browser_run}/artifacts" 'WildBuzzard-*.AppImage')" 0755
copy_artifact "$(one_file "${browser_object_dir}/dist" 'wildbuzzard-*.en-US.linux-x86_64.tar.*')"
install -m 0644 -- \
  "${browser_run}/build-manifest.txt" \
  "${artifact_dir}/browser-build-manifest.txt"

python3 "${wildbuzzard}/wildbuzzard/ci/create-release-manifest.py" \
  --artifact-dir "${artifact_dir}" \
  --repository "wildbuzzard=${wildbuzzard_repository}" \
  --repository "buzzard-search=${buzzard_search_repository}" \
  --repository "buzzard-minijtt=${buzzard_minijtt_repository}" \
  --repository "extensions=${extensions_repository}" \
  --build-manifest "arti=${artifact_dir}/arti-build-manifest.txt" \
  --build-manifest "browser=${artifact_dir}/browser-build-manifest.txt" \
  --build-manifest "qbittorrent=${artifact_dir}/qbittorrent-build-manifest.txt"
checksum_file="${work_dir}/SHA256SUMS"
(
  cd -- "${artifact_dir}"
  find . -maxdepth 1 -type f ! -name SHA256SUMS -printf '%f\0' |
    LC_ALL=C sort -z |
    xargs -0 sha256sum >"${checksum_file}"
  install -m 0644 -- "${checksum_file}" SHA256SUMS
  sha256sum --check --strict SHA256SUMS
)

echo "Release artifacts: ${artifact_dir}"
