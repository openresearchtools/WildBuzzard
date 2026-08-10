#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

set -Eeuo pipefail

usage() {
  echo "Usage: $0 [options]"
  echo
  echo "Options:"
  echo "  --fork DIR          local Pi Web fork (default: ../../WildBuzzard-pi-web)"
  echo "  --ref REF           committed Pi Web ref to build (default: HEAD)"
  echo "  --build-root DIR    external build root (default: ../../wildbuzzard-pi-web-builds)"
  echo "  --node-version VER  bundled Node.js version (default: 22.23.2)"
  echo "  --git-runtime FILE  pinned source-built Git runtime ZIP (required)"
  echo "  --ytdlp-runtime FILE  pinned source-built yt-dlp runtime ZIP (required)"
  echo "  --help              show this help"
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source_repo="$(cd -- "${script_dir}/../.." && pwd -P)"
fork_repo="$(dirname -- "${source_repo}")/WildBuzzard-pi-web"
build_root="$(dirname -- "${source_repo}")/wildbuzzard-pi-web-builds"
build_ref="HEAD"
node_version="22.23.2"
git_runtime=""
ytdlp_runtime=""

while (($#)); do
  case "$1" in
    --fork)
      fork_repo="${2:?--fork requires a directory}"
      shift 2
      ;;
    --ref)
      build_ref="${2:?--ref requires a ref}"
      shift 2
      ;;
    --build-root)
      build_root="${2:?--build-root requires a directory}"
      shift 2
      ;;
    --node-version)
      node_version="${2:?--node-version requires a version}"
      shift 2
      ;;
    --git-runtime)
      git_runtime="${2:?--git-runtime requires a file}"
      shift 2
      ;;
    --ytdlp-runtime)
      ytdlp_runtime="${2:?--ytdlp-runtime requires a file}"
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

if [[ -z "${git_runtime}" || -z "${ytdlp_runtime}" ]]; then
  echo "--git-runtime and --ytdlp-runtime are required" >&2
  exit 2
fi
git_runtime="$(realpath -- "${git_runtime}")"
ytdlp_runtime="$(realpath -- "${ytdlp_runtime}")"
if [[ ! -f "${git_runtime}" || ! -f "${ytdlp_runtime}" ]]; then
  echo "Runtime arguments must name ZIP files" >&2
  exit 2
fi

fork_repo="$(realpath -- "${fork_repo}")"
mkdir -p -- "${build_root}"
build_root="$(cd -- "${build_root}" && pwd -P)"

case "${build_root}/" in
  "${source_repo}/"*|"${fork_repo}/"*)
    echo "Build root must be outside both source repositories" >&2
    exit 2
    ;;
esac

if [[ -n "$(git -C "${fork_repo}" status --porcelain)" ]]; then
  echo "The Pi Web fork must be clean; commit the fork before building" >&2
  exit 2
fi

commit="$(git -C "${fork_repo}" rev-parse --verify "${build_ref}^{commit}")"
short_commit="$(git -C "${fork_repo}" rev-parse --short=12 "${commit}")"
run_id="$(date -u +%Y%m%dT%H%M%SZ)-${short_commit}-$$"
run_root="${build_root}/runs/${run_id}"
checkout_dir="${run_root}/source"
runtime_dir="${run_root}/runtime"
downloads_dir="${build_root}/downloads"
cargo_target="${build_root}/cargo/browser-runner"
artifacts_dir="${run_root}/artifacts"
node_archive="node-v${node_version}-linux-x64.tar.xz"
node_url="https://nodejs.org/dist/v${node_version}/${node_archive}"

mkdir -p -- \
  "${run_root}" \
  "${runtime_dir}/bin" \
  "${runtime_dir}/seed/browser-tools" \
  "${runtime_dir}/seed/web-access" \
  "${runtime_dir}/source" \
  "${runtime_dir}/tools/git" \
  "${runtime_dir}/tools/yt-dlp" \
  "${downloads_dir}" \
  "${artifacts_dir}"
git clone --shared --no-checkout -- "${fork_repo}" "${checkout_dir}"
git -C "${checkout_dir}" checkout --detach "${commit}"

(
  cd -- "${checkout_dir}"
  npm ci
  npm run verify
  npm run build
  npm pack --ignore-scripts --pack-destination "${run_root}"
) >"${run_root}/pi-web-build.log" 2>&1

package_tarball="$(find "${run_root}" -maxdepth 1 -type f -name 'jmfederico-pi-web-*.tgz' -print -quit)"
if [[ -z "${package_tarball}" ]]; then
  echo "Pi Web package archive was not produced" >&2
  exit 1
fi

printf '{"private":true,"type":"module"}\n' >"${runtime_dir}/package.json"
(
  cd -- "${runtime_dir}"
  npm install --omit=dev --package-lock=false --ignore-scripts=false \
    "${package_tarball}" \
    @earendil-works/pi-agent-core@0.83.0 \
    @earendil-works/pi-ai@0.83.0 \
    @earendil-works/pi-coding-agent@0.83.0
) >"${run_root}/runtime-install.log" 2>&1

if [[ ! -f "${downloads_dir}/${node_archive}" ]]; then
  curl --fail --location --output "${downloads_dir}/${node_archive}" "${node_url}"
fi
curl --fail --location --output "${run_root}/SHASUMS256.txt" "https://nodejs.org/dist/v${node_version}/SHASUMS256.txt"
expected_sha="$(awk -v archive="${node_archive}" '$2 == archive { print $1 }' "${run_root}/SHASUMS256.txt")"
actual_sha="$(sha256sum "${downloads_dir}/${node_archive}" | awk '{ print $1 }')"
if [[ -z "${expected_sha}" || "${expected_sha}" != "${actual_sha}" ]]; then
  echo "Node.js archive checksum verification failed" >&2
  exit 1
fi
tar -xJf "${downloads_dir}/${node_archive}" -C "${runtime_dir}"
mv -- "${runtime_dir}/node-v${node_version}-linux-x64" "${runtime_dir}/node"

python3 "${script_dir}/runtime-archive-manifest.py" structure "${git_runtime}"
unzip -q "${git_runtime}" -d "${runtime_dir}/tools/git"
if [[ ! -f "${runtime_dir}/tools/git/wildbuzzard-git-runtime.json" ||
      ! -x "${runtime_dir}/tools/git/bin/git" ]]; then
  echo "Invalid Git runtime ZIP" >&2
  exit 1
fi

python3 "${script_dir}/runtime-archive-manifest.py" structure "${ytdlp_runtime}"
unzip -q "${ytdlp_runtime}" -d "${runtime_dir}/tools/yt-dlp"
if [[ ! -f "${runtime_dir}/tools/yt-dlp/wildbuzzard-ytdlp-runtime.json" ||
      ! -x "${runtime_dir}/tools/yt-dlp/bin/yt-dlp" ]]; then
  echo "Invalid yt-dlp runtime ZIP" >&2
  exit 1
fi

cargo_command="$(command -v cargo || true)"
if [[ -z "${cargo_command}" ]]; then
  echo "Cargo is required to build the browser-control runner" >&2
  exit 2
fi
CARGO_TARGET_DIR="${cargo_target}" "${cargo_command}" build --release --locked \
  --manifest-path "${source_repo}/agent/runtime/browser-runner/Cargo.toml" \
  >"${run_root}/browser-runner-build.log" 2>&1

cp -a -- "${source_repo}/agent/extensions/browser-tools/." "${runtime_dir}/seed/browser-tools/"
cp -- "${cargo_target}/release/wildbuzzard-browser-runner" "${runtime_dir}/seed/browser-tools/wildbuzzard-browser-runner"
(
  cd -- "${source_repo}/agent/extensions/web-access"
  tar --exclude='./node_modules' --exclude='./.npm' -cf - .
) | tar -xf - -C "${runtime_dir}/seed/web-access"
cp -- "${checkout_dir}/LICENSE" "${runtime_dir}/PI-WEB-LICENSE"
cp -- "${source_repo}/COPYING" "${runtime_dir}/WILDBUZZARD-LICENSE"
cp -- "${package_tarball}" "${runtime_dir}/source/pi-web-${commit}.tgz"

(
  cd -- "${runtime_dir}/seed/browser-tools"
  "${checkout_dir}/node_modules/.bin/tsc" --project tsconfig.json
  "${runtime_dir}/node/bin/node" --experimental-strip-types --test test/*.test.ts
) >"${run_root}/browser-tools-validation.log" 2>&1

(
  cd -- "${runtime_dir}/seed/web-access"
  npm_cli="${runtime_dir}/node/lib/node_modules/npm/bin/npm-cli.js"
  "${runtime_dir}/node/bin/node" "${npm_cli}" ci --ignore-scripts
  "${runtime_dir}/node/bin/node" "${npm_cli}" run typecheck
  "${runtime_dir}/node/bin/node" "${npm_cli}" test
  "${runtime_dir}/node/bin/node" "${npm_cli}" prune --omit=dev --ignore-scripts
) >"${run_root}/web-access-validation.log" 2>&1

launcher() {
  local name="$1"
  local entrypoint="$2"
  printf '%s\n' \
    '#!/bin/sh' \
    'launcher_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)' \
    "exec \"\${launcher_dir}/../node/bin/node\" \"\${launcher_dir}/../${entrypoint}\" \"\$@\"" \
    >"${runtime_dir}/bin/${name}"
  chmod 755 "${runtime_dir}/bin/${name}"
}

launcher pi-web node_modules/@jmfederico/pi-web/dist/cli.js
launcher pi-web-server node_modules/@jmfederico/pi-web/dist/server/index.js
launcher pi-web-sessiond node_modules/@jmfederico/pi-web/dist/server/sessiond.js
launcher pi node_modules/@earendil-works/pi-coding-agent/dist/cli.js
chmod 755 "${runtime_dir}/node/bin/node" "${runtime_dir}/seed/browser-tools/wildbuzzard-browser-runner"
chmod 755 "${runtime_dir}/tools/git/bin/git" "${runtime_dir}/tools/git/bin/git.bin"
chmod 755 "${runtime_dir}/tools/yt-dlp/bin/yt-dlp"

browser_tools_sha="$(find "${source_repo}/agent/extensions/browser-tools" -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{ print $1 }')"
web_access_sha="$(
  cd -- "${source_repo}"
  git ls-files -z agent/extensions/web-access |
    sort -z |
    xargs -0 sha256sum |
    sha256sum |
    awk '{ print $1 }'
)"
browser_runner_sha="$(sha256sum "${runtime_dir}/seed/browser-tools/wildbuzzard-browser-runner" | awk '{ print $1 }')"
git_runtime_sha="$(sha256sum "${git_runtime}" | awk '{ print $1 }')"
ytdlp_runtime_sha="$(sha256sum "${ytdlp_runtime}" | awk '{ print $1 }')"
dependency_lock_sha="$(sha256sum "${checkout_dir}/package-lock.json" | awk '{ print $1 }')"
pi_web_source_sha="$(sha256sum "${package_tarball}" | awk '{ print $1 }')"
pi_web_version="$("${runtime_dir}/node/bin/node" -p "require('${checkout_dir}/package.json').version")"

metadata_path="${run_root}/runtime-metadata.json"
printf '{\n  "component": "pi-web",\n  "version": "%s",\n  "piWebCommit": "%s",\n  "piWebRef": "%s",\n  "sourceSha256": "%s",\n  "dependencyLockSha256": "%s",\n  "browserToolsSha256": "%s",\n  "webAccessSha256": "%s",\n  "browserRunnerSha256": "%s",\n  "gitRuntimeSha256": "%s",\n  "ytdlpRuntimeSha256": "%s",\n  "nodeVersion": "%s",\n  "protocolVersion": 1,\n  "licenseLocations": ["PI-WEB-LICENSE", "WILDBUZZARD-LICENSE"],\n  "correspondingSource": "%s",\n  "platform": "linux-x64"\n}\n' \
  "${pi_web_version}" "${commit}" "${build_ref}" "${pi_web_source_sha}" "${dependency_lock_sha}" \
  "${browser_tools_sha}" "${web_access_sha}" "${browser_runner_sha}" \
  "${git_runtime_sha}" "${ytdlp_runtime_sha}" "${node_version}" "source/pi-web-${commit}.tgz" \
  >"${metadata_path}"

archive_root="${run_root}/archive-root"
mkdir -p -- "${archive_root}"
cp -LR --preserve=mode,timestamps -- "${runtime_dir}/." "${archive_root}/"
python3 "${script_dir}/runtime-archive-manifest.py" build \
  "${archive_root}" "${metadata_path}"

runtime_zip="${artifacts_dir}/wildbuzzard-pi-web-runtime-linux-x64-${short_commit}.zip"
(
  cd -- "${archive_root}"
  zip -q -9 -r "${runtime_zip}" .
)
python3 "${script_dir}/runtime-archive-manifest.py" verify "${runtime_zip}"
sha256sum "${runtime_zip}" >"${runtime_zip}.sha256"
runtime_sha="$(sha256sum "${runtime_zip}" | awk '{ print $1 }')"

{
  echo "pi_web_fork=${fork_repo}"
  echo "pi_web_ref=${build_ref}"
  echo "pi_web_commit=${commit}"
  echo "pi_web_source_sha256=${pi_web_source_sha}"
  echo "browser_tools_sha256=${browser_tools_sha}"
  echo "web_access_sha256=${web_access_sha}"
  echo "browser_runner_sha256=${browser_runner_sha}"
  echo "git_runtime=${git_runtime}"
  echo "git_runtime_sha256=${git_runtime_sha}"
  echo "ytdlp_runtime=${ytdlp_runtime}"
  echo "ytdlp_runtime_sha256=${ytdlp_runtime_sha}"
  echo "node_version=${node_version}"
  echo "dependency_lock_sha256=${dependency_lock_sha}"
  echo "runtime_zip=${runtime_zip}"
  echo "runtime_sha256=${runtime_sha}"
} >"${run_root}/build-manifest.txt"

echo "Pi Web runtime built from ${commit}"
echo "Runtime: ${runtime_zip}"
echo "Logs: ${run_root}"
