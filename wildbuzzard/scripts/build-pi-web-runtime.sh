#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

set -Eeuo pipefail
umask 077

usage() {
  echo "Usage: $0 [options]"
  echo
  echo "Options:"
  echo "  --fork DIR                 clean local Pi Web fork"
  echo "  --source-ref REF           committed WildBuzzard ref (default: HEAD)"
  echo "  --build-root DIR           external build root"
  echo "  --git-runtime FILE         source-built Git runtime ZIP"
  echo "  --git-runtime-sha256 SHA   expected Git runtime ZIP SHA256"
  echo "  --ytdlp-runtime FILE       source-built yt-dlp runtime ZIP"
  echo "  --ytdlp-runtime-sha256 SHA expected yt-dlp runtime ZIP SHA256"
  echo "  --offline                  require all network inputs in local caches"
  echo "  --compare-to RECORD        compare with a prior clean-build record"
  echo "  --help                     show this help"
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source_repo="$(cd -- "${script_dir}/../.." && pwd -P)"
pin_file="${source_repo}/wildbuzzard/pi-web-runtime-lock.json"
fork_repo="$(dirname -- "${source_repo}")/WildBuzzard-pi-web"
build_root="$(dirname -- "${source_repo}")/wildbuzzard-pi-web-builds"
source_ref="HEAD"
git_runtime=""
git_runtime_expected=""
ytdlp_runtime=""
ytdlp_runtime_expected=""
offline=0
compare_to=""

while (($#)); do
  case "$1" in
    --fork)
      fork_repo="${2:?--fork requires a directory}"
      shift 2
      ;;
    --source-ref)
      source_ref="${2:?--source-ref requires a ref}"
      shift 2
      ;;
    --build-root)
      build_root="${2:?--build-root requires a directory}"
      shift 2
      ;;
    --git-runtime)
      git_runtime="${2:?--git-runtime requires a file}"
      shift 2
      ;;
    --git-runtime-sha256)
      git_runtime_expected="${2:?--git-runtime-sha256 requires a digest}"
      shift 2
      ;;
    --ytdlp-runtime)
      ytdlp_runtime="${2:?--ytdlp-runtime requires a file}"
      shift 2
      ;;
    --ytdlp-runtime-sha256)
      ytdlp_runtime_expected="${2:?--ytdlp-runtime-sha256 requires a digest}"
      shift 2
      ;;
    --offline)
      offline=1
      shift
      ;;
    --compare-to)
      compare_to="${2:?--compare-to requires a build record}"
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

if [[ -z "${git_runtime}" || -z "${ytdlp_runtime}" ||
      ! "${git_runtime_expected}" =~ ^[0-9a-f]{64}$ ||
      ! "${ytdlp_runtime_expected}" =~ ^[0-9a-f]{64}$ ]]; then
  echo "Both runtime ZIPs and their exact SHA256 values are required" >&2
  exit 2
fi

python3 "${script_dir}/verify-pi-web-runtime-inputs.py" check "${pin_file}"
mapfile -t pins < <(
  python3 "${script_dir}/verify-pi-web-runtime-inputs.py" values "${pin_file}"
)
if ((${#pins[@]} != 11)); then
  echo "Pi Web runtime lock did not return all required pins" >&2
  exit 1
fi
pi_web_commit="${pins[0]}"
pi_web_tree="${pins[1]}"
pi_web_name="${pins[2]}"
pi_web_version="${pins[3]}"
pi_web_package_manager="${pins[4]}"
pi_web_repository="${pins[5]}"
pi_web_lock_sha256="${pins[6]}"
node_version="${pins[7]}"
node_archive="${pins[8]}"
node_url="${pins[9]}"
node_sha256="${pins[10]}"

fork_repo="$(realpath -- "${fork_repo}")"
python3 "${script_dir}/verify-pi-web-runtime-inputs.py" fork \
  "${pin_file}" "${fork_repo}"
git_runtime="$(realpath -- "${git_runtime}")"
ytdlp_runtime="$(realpath -- "${ytdlp_runtime}")"
if [[ ! -f "${git_runtime}" || ! -f "${ytdlp_runtime}" ]]; then
  echo "Runtime arguments must name regular ZIP files" >&2
  exit 2
fi
git_runtime_sha256="$(sha256sum "${git_runtime}" | awk '{ print $1 }')"
ytdlp_runtime_sha256="$(sha256sum "${ytdlp_runtime}" | awk '{ print $1 }')"
if [[ "${git_runtime_sha256}" != "${git_runtime_expected}" ||
      "${ytdlp_runtime_sha256}" != "${ytdlp_runtime_expected}" ]]; then
  echo "A supplied helper runtime does not match its expected SHA256" >&2
  exit 1
fi
python3 "${script_dir}/runtime-archive-manifest.py" structure "${git_runtime}"
python3 "${script_dir}/runtime-archive-manifest.py" structure "${ytdlp_runtime}"

mkdir -p -- "${build_root}"
build_root="$(cd -- "${build_root}" && pwd -P)"
case "${build_root}/" in
  "${source_repo}/"*|"${fork_repo}/"*)
    echo "Build root must be outside both source repositories" >&2
    exit 2
    ;;
esac

source_commit="$(git -C "${source_repo}" rev-parse --verify "${source_ref}^{commit}")"
source_tree="$(git -C "${source_repo}" show -s --format=%T "${source_commit}")"
short_source="${source_commit:0:12}"
short_pi_web="${pi_web_commit:0:12}"
source_date_epoch="$(git -C "${source_repo}" show -s --format=%ct "${source_commit}")"
for path in \
  wildbuzzard/scripts/build-pi-web-runtime.sh \
  wildbuzzard/scripts/assemble-pi-web-runtime.mjs \
  wildbuzzard/scripts/compare-pi-web-runtime-builds.py \
  wildbuzzard/scripts/runtime-archive-manifest.py \
  wildbuzzard/scripts/test-pi-web-runtime-lifecycle.mjs \
  wildbuzzard/scripts/verify-pi-web-installed-tree.mjs \
  wildbuzzard/scripts/verify-pi-web-runtime-inputs.py \
  wildbuzzard/pi-web-runtime-lock.json; do
  committed_sha="$(git -C "${source_repo}" show "${source_commit}:${path}" | sha256sum | awk '{ print $1 }')"
  working_sha="$(sha256sum "${source_repo}/${path}" | awk '{ print $1 }')"
  if [[ "${committed_sha}" != "${working_sha}" ]]; then
    echo "Build input is not committed at ${source_commit}: ${path}" >&2
    exit 1
  fi
done

run_id="$(date -u +%Y%m%dT%H%M%SZ)-${short_source}-${short_pi_web}-$$"
run_root="${build_root}/runs/${run_id}"
source_checkout="${run_root}/wildbuzzard-source"
pi_web_checkout="${run_root}/pi-web-source"
runtime_dir="${run_root}/runtime"
downloads_dir="${build_root}/downloads"
cargo_home="${build_root}/cargo-home"
cargo_target="${run_root}/cargo-target"
artifacts_dir="${run_root}/artifacts"
node_path="${downloads_dir}/${node_archive}"
mkdir -p -- \
  "${run_root}" \
  "${runtime_dir}/bin" \
  "${runtime_dir}/node_modules/@jmfederico/pi-web" \
  "${runtime_dir}/seed/browser-tools" \
  "${runtime_dir}/seed/web-access" \
  "${runtime_dir}/source" \
  "${runtime_dir}/tools/git" \
  "${runtime_dir}/tools/yt-dlp" \
  "${downloads_dir}" \
  "${cargo_home}" \
  "${artifacts_dir}" \
  "${run_root}/home" \
  "${run_root}/npm-cache"
install -m 600 /dev/null "${run_root}/npmrc-global"
install -m 600 /dev/null "${run_root}/npmrc-user"

if [[ ! -f "${node_path}" ]]; then
  if [[ "${offline}" == 1 ]]; then
    echo "Missing offline Node.js input: ${node_path}" >&2
    exit 1
  fi
  curl --fail --location --proto '=https' --tlsv1.2 \
    --output "${node_path}.part" "${node_url}"
  mv -- "${node_path}.part" "${node_path}"
fi
if [[ "$(sha256sum "${node_path}" | awk '{ print $1 }')" != "${node_sha256}" ]]; then
  echo "Node.js archive checksum verification failed" >&2
  exit 1
fi
tar -xJf "${node_path}" -C "${runtime_dir}"
mv -- "${runtime_dir}/node-v${node_version}-linux-x64" "${runtime_dir}/node"
bundled_node="${runtime_dir}/node/bin/node"
bundled_npm="${runtime_dir}/node/lib/node_modules/npm/bin/npm-cli.js"
bundled_npm_version="$("${bundled_node}" "${bundled_npm}" --version)"
if [[ "npm@${bundled_npm_version}" != "${pi_web_package_manager}" ]]; then
  echo "Bundled npm does not match the Pi Web package-manager pin" >&2
  exit 1
fi
npm_environment=(
  "HOME=${run_root}/home"
  "LANG=C.UTF-8"
  "LC_ALL=C.UTF-8"
  "TZ=UTC"
  "npm_config_cache=${run_root}/npm-cache"
  "npm_config_fund=false"
  "npm_config_globalconfig=${run_root}/npmrc-global"
  "npm_config_registry=https://registry.npmjs.org/"
  "npm_config_update_notifier=false"
  "npm_config_userconfig=${run_root}/npmrc-user"
)
if [[ "${offline}" == 1 ]]; then
  npm_environment+=("npm_config_offline=true")
fi

git clone --shared --no-checkout -- "${source_repo}" "${source_checkout}"
git -C "${source_checkout}" sparse-checkout init --no-cone
git -C "${source_checkout}" sparse-checkout set \
  /COPYING \
  /agent/extensions/browser-tools/ \
  /agent/extensions/web-access/ \
  /agent/runtime/browser-runner/ \
  /wildbuzzard/pi-web-runtime-lock.json \
  /wildbuzzard/scripts/assemble-pi-web-runtime.mjs \
  /wildbuzzard/scripts/build-pi-web-runtime.sh \
  /wildbuzzard/scripts/compare-pi-web-runtime-builds.py \
  /wildbuzzard/scripts/runtime-archive-manifest.py \
  /wildbuzzard/scripts/test-pi-web-runtime-lifecycle.mjs \
  /wildbuzzard/scripts/verify-pi-web-installed-tree.mjs \
  /wildbuzzard/scripts/verify-pi-web-runtime-inputs.py
git -C "${source_checkout}" checkout --detach "${source_commit}"
git clone --shared --no-checkout -- "${fork_repo}" "${pi_web_checkout}"
git -C "${pi_web_checkout}" checkout --detach "${pi_web_commit}"
if [[ "$(git -C "${pi_web_checkout}" show -s --format=%T HEAD)" != "${pi_web_tree}" ||
      "$(sha256sum "${pi_web_checkout}/package-lock.json" | awk '{ print $1 }')" != "${pi_web_lock_sha256}" ]]; then
  echo "The checked-out Pi Web source differs from the runtime lock" >&2
  exit 1
fi

(
  cd -- "${pi_web_checkout}"
  env "${npm_environment[@]}" PATH="${runtime_dir}/node/bin:/usr/bin:/bin" \
    "${bundled_node}" "${bundled_npm}" ci
  "${bundled_node}" \
    "${source_checkout}/wildbuzzard/scripts/verify-pi-web-installed-tree.mjs" \
    "${pi_web_checkout}"
  env "${npm_environment[@]}" PATH="${runtime_dir}/node/bin:/usr/bin:/bin" \
    "${bundled_node}" "${bundled_npm}" run verify
  env "${npm_environment[@]}" PATH="${runtime_dir}/node/bin:/usr/bin:/bin" \
    "${bundled_node}" "${bundled_npm}" run build
  env "${npm_environment[@]}" PATH="${runtime_dir}/node/bin:/usr/bin:/bin" \
    "${bundled_node}" "${bundled_npm}" pack --ignore-scripts \
      --pack-destination "${run_root}"
) >"${run_root}/pi-web-build.log" 2>&1

package_tarball="$(find "${run_root}" -maxdepth 1 -type f -name 'jmfederico-pi-web-*.tgz' -print -quit)"
if [[ -z "${package_tarball}" ]]; then
  echo "Pi Web package archive was not produced" >&2
  exit 1
fi
tar -xzf "${package_tarball}" --strip-components=1 \
  -C "${runtime_dir}/node_modules/@jmfederico/pi-web"
cp -- "${pi_web_checkout}/package-lock.json" "${runtime_dir}/source/pi-web-package-lock.json"
cp -- "${package_tarball}" "${runtime_dir}/source/pi-web-package-${pi_web_commit}.tgz"

runtime_inventory="${runtime_dir}/source/runtime-dependencies.json"
sbom_path="${runtime_dir}/source/sbom.cdx.json"
spdx_path="${runtime_dir}/source/sbom.spdx.json"

(
  cd -- "${pi_web_checkout}"
  env "${npm_environment[@]}" PATH="${runtime_dir}/node/bin:/usr/bin:/bin" \
    "${bundled_node}" "${bundled_npm}" audit --omit=dev --json
) >"${run_root}/npm-production-audit.json" 2>/dev/null || true
(
  cd -- "${pi_web_checkout}"
  env "${npm_environment[@]}" PATH="${runtime_dir}/node/bin:/usr/bin:/bin" \
    "${bundled_node}" "${bundled_npm}" audit --json
) >"${run_root}/npm-locked-tree-audit.json" 2>/dev/null || true
"${bundled_node}" - \
  "${run_root}/npm-production-audit.json" \
  "${run_root}/npm-locked-tree-audit.json" <<'NODE'
const fs = require("node:fs");
for (const path of process.argv.slice(2)) {
  const audit = JSON.parse(fs.readFileSync(path, "utf8"));
  if (audit.error || typeof audit.metadata?.vulnerabilities?.total !== "number") {
    throw new Error("The Pi Web dependency audit did not complete");
  }
  const blocked = Object.values(audit.vulnerabilities || {}).filter(item =>
    item.severity === "critical" || item.severity === "high"
  );
  if (blocked.length) {
    throw new Error(`High-severity Pi Web advisory: ${blocked.map(item => item.name).sort().join(", ")}`);
  }
}
NODE

cargo_command="$(command -v cargo || true)"
if [[ -z "${cargo_command}" ]]; then
  echo "Cargo is required to build the browser-control runner" >&2
  exit 2
fi
cargo_arguments=(build --release --locked)
if [[ "${offline}" == 1 ]]; then
  cargo_arguments+=(--offline)
fi
CARGO_HOME="${cargo_home}" CARGO_TARGET_DIR="${cargo_target}" \
  CARGO_INCREMENTAL=0 \
  CFLAGS="-ffile-prefix-map=${run_root}=. -fdebug-prefix-map=${run_root}=." \
  CXXFLAGS="-ffile-prefix-map=${run_root}=. -fdebug-prefix-map=${run_root}=." \
  RUSTFLAGS="--remap-path-prefix=${run_root}=. --remap-path-prefix=${source_checkout}=wildbuzzard-source" \
  "${cargo_command}" "${cargo_arguments[@]}" \
  --manifest-path "${source_checkout}/agent/runtime/browser-runner/Cargo.toml" \
  >"${run_root}/browser-runner-build.log" 2>&1
cargo_metadata="${run_root}/cargo-metadata.json"
CARGO_HOME="${cargo_home}" CARGO_TARGET_DIR="${cargo_target}" \
  "${cargo_command}" metadata --locked --format-version 1 \
  --manifest-path "${source_checkout}/agent/runtime/browser-runner/Cargo.toml" \
  >"${cargo_metadata}"
python3 - "${cargo_metadata}" "${runtime_dir}/licenses/cargo" \
  "${runtime_dir}/source/rust-dependency-licenses.json" <<'PY'
import json
import shutil
import stat
import sys
from pathlib import Path

metadata = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
destination = Path(sys.argv[2])
records = []
for package in sorted(metadata["packages"], key=lambda item: (item["name"], item["version"])):
    if package.get("source") is None:
        continue
    source = Path(package["manifest_path"]).parent
    copied = []
    target = destination / f'{package["name"]}-{package["version"]}'
    for path in sorted(source.iterdir()):
        if not path.name.upper().startswith(("LICENSE", "COPYING", "NOTICE")):
            continue
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_size > 1024 * 1024:
            raise ValueError(f"unsafe Cargo license file: {path}")
        target.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target / path.name)
        copied.append((target / path.name).relative_to(destination.parents[1]).as_posix())
    records.append({
        "name": package["name"],
        "version": package["version"],
        "license": package.get("license") or "NOASSERTION",
        "source": package["source"],
        "licenseFiles": copied,
    })
Path(sys.argv[3]).write_text(
    json.dumps({"schema": 1, "packages": records}, indent=2, sort_keys=True) + "\n",
    encoding="utf-8",
)
PY
cargo_audit_arguments=(
  audit --deny warnings --format json
  --db "${build_root}/rustsec-advisory-db"
  --file "${source_checkout}/agent/runtime/browser-runner/Cargo.lock"
)
if [[ "${offline}" == 1 ]]; then
  cargo_audit_arguments+=(--no-fetch)
fi
CARGO_HOME="${cargo_home}" "${cargo_command}" "${cargo_audit_arguments[@]}" \
  >"${run_root}/cargo-audit.json"
rustsec_commit="$(git -C "${build_root}/rustsec-advisory-db" rev-parse HEAD)"

cp -a -- "${source_checkout}/agent/extensions/browser-tools/." "${runtime_dir}/seed/browser-tools/"
cp -- "${cargo_target}/release/wildbuzzard-browser-runner" \
  "${runtime_dir}/seed/browser-tools/wildbuzzard-browser-runner"
(
  cd -- "${source_checkout}/agent/extensions/web-access"
  tar --exclude='./node_modules' --exclude='./.npm' -cf - .
) | tar -xf - -C "${runtime_dir}/seed/web-access"
cp -- "${pi_web_checkout}/LICENSE" "${runtime_dir}/PI-WEB-LICENSE"
cp -- "${source_checkout}/COPYING" "${runtime_dir}/WILDBUZZARD-LICENSE"

unzip -q "${git_runtime}" -d "${runtime_dir}/tools/git"
if [[ ! -f "${runtime_dir}/tools/git/wildbuzzard-git-runtime.json" ||
      ! -x "${runtime_dir}/tools/git/bin/git" ]]; then
  echo "Invalid Git runtime ZIP" >&2
  exit 1
fi
unzip -q "${ytdlp_runtime}" -d "${runtime_dir}/tools/yt-dlp"
if [[ ! -f "${runtime_dir}/tools/yt-dlp/wildbuzzard-ytdlp-runtime.json" ||
      ! -x "${runtime_dir}/tools/yt-dlp/bin/yt-dlp" ]]; then
  echo "Invalid yt-dlp runtime ZIP" >&2
  exit 1
fi

(
  cd -- "${runtime_dir}/seed/browser-tools"
  "${pi_web_checkout}/node_modules/.bin/tsc" --project tsconfig.json
  "${bundled_node}" --experimental-strip-types --test test/*.test.ts
) >"${run_root}/browser-tools-validation.log" 2>&1
(
  cd -- "${runtime_dir}/seed/web-access"
  env "${npm_environment[@]}" PATH="${runtime_dir}/node/bin:/usr/bin:/bin" \
    "${bundled_node}" "${bundled_npm}" ci --ignore-scripts
  env "${npm_environment[@]}" PATH="${runtime_dir}/node/bin:/usr/bin:/bin" \
    "${bundled_node}" "${bundled_npm}" run typecheck
  env "${npm_environment[@]}" PATH="${runtime_dir}/node/bin:/usr/bin:/bin" \
    "${bundled_node}" "${bundled_npm}" test
  env "${npm_environment[@]}" PATH="${runtime_dir}/node/bin:/usr/bin:/bin" \
    "${bundled_node}" "${bundled_npm}" prune --omit=dev --ignore-scripts
) >"${run_root}/web-access-validation.log" 2>&1

(
  cd -- "${runtime_dir}/seed/web-access"
  env "${npm_environment[@]}" PATH="${runtime_dir}/node/bin:/usr/bin:/bin" \
    "${bundled_node}" "${bundled_npm}" audit --omit=dev --json
) >"${run_root}/web-access-production-audit.json" 2>/dev/null || true
"${bundled_node}" - "${run_root}/web-access-production-audit.json" <<'NODE'
const fs = require("node:fs");
const audit = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (audit.error || typeof audit.metadata?.vulnerabilities?.total !== "number") {
  throw new Error("The web-access production dependency audit did not complete");
}
const blocked = Object.values(audit.vulnerabilities || {}).filter(item =>
  item.severity === "critical" || item.severity === "high"
);
if (blocked.length) {
  throw new Error(`High-severity web-access advisory: ${blocked.map(item => item.name).sort().join(", ")}`);
}
NODE

find "${runtime_dir}/seed/web-access/node_modules" -type d -name .bin \
  -exec rm -r -- {} +
web_access_lock_sha256="$(sha256sum "${runtime_dir}/seed/web-access/package-lock.json" | awk '{ print $1 }')"
cargo_lock_sha256="$(sha256sum "${source_checkout}/agent/runtime/browser-runner/Cargo.lock" | awk '{ print $1 }')"
"${bundled_node}" \
  "${source_checkout}/wildbuzzard/scripts/assemble-pi-web-runtime.mjs" \
  --cargo-lock-sha256 "${cargo_lock_sha256}" \
  --cargo-metadata "${cargo_metadata}" \
  --commit "${pi_web_commit}" \
  --lock-sha256 "${pi_web_lock_sha256}" \
  --node-sha256 "${node_sha256}" \
  --node-version "${node_version}" \
  --output-inventory "${runtime_inventory}" \
  --output-sbom "${sbom_path}" \
  --output-spdx "${spdx_path}" \
  --pi-web-name "${pi_web_name}" \
  --pi-web-version "${pi_web_version}" \
  --runtime-root "${runtime_dir}" \
  --source-date-epoch "${source_date_epoch}" \
  --source-root "${pi_web_checkout}" \
  --web-access-lock-sha256 "${web_access_lock_sha256}" \
  --web-access-root "${runtime_dir}/seed/web-access"

find "${runtime_dir}/node" -mindepth 1 -maxdepth 1 \
  ! -name bin ! -name LICENSE -exec rm -r -- {} +
find "${runtime_dir}/node/bin" -mindepth 1 ! -name node -delete

launcher() {
  local name="$1"
  local entrypoint="$2"
  printf '%s\n' \
    '#!/bin/sh' \
    'launcher_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)' \
    'export PI_TELEMETRY=0' \
    'export PI_SKIP_VERSION_CHECK=1' \
    "exec \"\${launcher_dir}/../node/bin/node\" \"\${launcher_dir}/../${entrypoint}\" \"\$@\"" \
    >"${runtime_dir}/bin/${name}"
  chmod 755 "${runtime_dir}/bin/${name}"
}

launcher pi-web node_modules/@jmfederico/pi-web/dist/cli.js
launcher pi-web-server node_modules/@jmfederico/pi-web/dist/server/index.js
launcher pi-web-sessiond node_modules/@jmfederico/pi-web/dist/server/sessiond.js
launcher pi node_modules/@earendil-works/pi-coding-agent/dist/cli.js
chmod 755 \
  "${runtime_dir}/node/bin/node" \
  "${runtime_dir}/seed/browser-tools/wildbuzzard-browser-runner" \
  "${runtime_dir}/tools/git/bin/git" \
  "${runtime_dir}/tools/git/bin/git.bin" \
  "${runtime_dir}/tools/yt-dlp/bin/yt-dlp"
"${bundled_node}" \
  "${source_checkout}/wildbuzzard/scripts/test-pi-web-runtime-lifecycle.mjs" \
  --runtime "${runtime_dir}" \
  >"${run_root}/pi-web-lifecycle.json"

source_stage="${run_root}/corresponding-source"
mkdir -p -- "${source_stage}/wildbuzzard" "${source_stage}/pi-web"
git -C "${source_checkout}" archive "${source_commit}" -- \
  COPYING \
  agent/extensions/browser-tools \
  agent/extensions/web-access \
  agent/runtime/browser-runner \
  wildbuzzard/pi-web-runtime-lock.json \
  wildbuzzard/scripts/assemble-pi-web-runtime.mjs \
  wildbuzzard/scripts/build-pi-web-runtime.sh \
  wildbuzzard/scripts/compare-pi-web-runtime-builds.py \
  wildbuzzard/scripts/runtime-archive-manifest.py \
  wildbuzzard/scripts/test-pi-web-runtime-lifecycle.mjs \
  wildbuzzard/scripts/validate-pi-web-runtime-archive.py \
  wildbuzzard/scripts/verify-pi-web-runtime-inputs.py |
  tar -xf - -C "${source_stage}/wildbuzzard"
git -C "${pi_web_checkout}" archive "${pi_web_commit}" |
  tar -xf - -C "${source_stage}/pi-web"
source_name="wildbuzzard-pi-web-${short_source}-${short_pi_web}-source.tar.xz"
source_archive="${artifacts_dir}/${source_name}"
create_source_archive() {
  tar --sort=name \
    --mtime="@${source_date_epoch}" \
    --owner=0 --group=0 --numeric-owner \
    -cJf "${source_archive}" \
    -C "${source_stage}" .
}
create_source_archive
source_sha256="$(sha256sum "${source_archive}" | awk '{ print $1 }')"
rm -f -- "${source_archive}"
create_source_archive
if [[ "$(sha256sum "${source_archive}" | awk '{ print $1 }')" != "${source_sha256}" ]]; then
  echo "Deterministic Pi Web corresponding-source check failed" >&2
  exit 1
fi
cp -- "${source_archive}" "${runtime_dir}/source/${source_name}"

browser_tools_sha256="$(
  cd -- "${source_checkout}"
  git ls-files -z agent/extensions/browser-tools |
    LC_ALL=C sort -z |
    xargs -0 sha256sum |
    sha256sum |
    awk '{ print $1 }'
)"
web_access_sha256="$(
  cd -- "${source_checkout}"
  git ls-files -z agent/extensions/web-access |
    LC_ALL=C sort -z |
    xargs -0 sha256sum |
    sha256sum |
    awk '{ print $1 }'
)"
browser_runner_sha256="$(sha256sum "${runtime_dir}/seed/browser-tools/wildbuzzard-browser-runner" | awk '{ print $1 }')"
pi_web_package_sha256="$(sha256sum "${package_tarball}" | awk '{ print $1 }')"
build_script_sha256="$(sha256sum "${source_checkout}/wildbuzzard/scripts/build-pi-web-runtime.sh" | awk '{ print $1 }')"

environment_json="${run_root}/environment.json"
SOURCE_DATE_EPOCH="${source_date_epoch}" \
SOURCE_COMMIT="${source_commit}" \
SOURCE_TREE="${source_tree}" \
PI_WEB_COMMIT="${pi_web_commit}" \
PI_WEB_TREE="${pi_web_tree}" \
NODE_VERSION="${node_version}" \
NPM_VERSION="${bundled_npm_version}" \
CARGO_VERSION="$("${cargo_command}" --version)" \
RUSTC_VERSION="$(rustc --version)" \
PYTHON_VERSION="$(python3 --version 2>&1)" \
KERNEL="$(uname -srmo)" \
RUSTSEC_COMMIT="${rustsec_commit}" \
WEB_ACCESS_LOCK_SHA256="${web_access_lock_sha256}" \
CARGO_LOCK_SHA256="${cargo_lock_sha256}" \
  python3 - "${environment_json}" <<'PY'
import json
import os
import sys

value = {
    "schema": 1,
    "sourceDateEpoch": int(os.environ["SOURCE_DATE_EPOCH"]),
    "locale": "C.UTF-8",
    "timezone": "UTC",
    "wildbuzzardCommit": os.environ["SOURCE_COMMIT"],
    "wildbuzzardTree": os.environ["SOURCE_TREE"],
    "piWebCommit": os.environ["PI_WEB_COMMIT"],
    "piWebTree": os.environ["PI_WEB_TREE"],
    "node": os.environ["NODE_VERSION"],
    "npm": os.environ["NPM_VERSION"],
    "cargo": os.environ["CARGO_VERSION"],
    "rustc": os.environ["RUSTC_VERSION"],
    "python": os.environ["PYTHON_VERSION"],
    "kernel": os.environ["KERNEL"],
    "rustSecAdvisoryCommit": os.environ["RUSTSEC_COMMIT"],
    "webAccessPackageLockSha256": os.environ["WEB_ACCESS_LOCK_SHA256"],
    "browserRunnerCargoLockSha256": os.environ["CARGO_LOCK_SHA256"],
}
with open(sys.argv[1], "w", encoding="utf-8") as output:
    json.dump(value, output, sort_keys=True, separators=(",", ":"))
    output.write("\n")
PY
cp -- "${environment_json}" "${runtime_dir}/source/build-inputs.json"

metadata_path="${run_root}/runtime-metadata.json"
PI_WEB_VERSION="${pi_web_version}" \
PI_WEB_COMMIT="${pi_web_commit}" \
PI_WEB_TREE="${pi_web_tree}" \
PI_WEB_REPOSITORY="${pi_web_repository}" \
SOURCE_COMMIT="${source_commit}" \
SOURCE_TREE="${source_tree}" \
SOURCE_NAME="source/${source_name}" \
SOURCE_SHA256="${source_sha256}" \
PI_WEB_PACKAGE_SHA256="${pi_web_package_sha256}" \
LOCK_SHA256="${pi_web_lock_sha256}" \
BROWSER_TOOLS_SHA256="${browser_tools_sha256}" \
WEB_ACCESS_SHA256="${web_access_sha256}" \
BROWSER_RUNNER_SHA256="${browser_runner_sha256}" \
GIT_RUNTIME_SHA256="${git_runtime_sha256}" \
YTDLP_RUNTIME_SHA256="${ytdlp_runtime_sha256}" \
NODE_VERSION="${node_version}" \
NODE_SHA256="${node_sha256}" \
WEB_ACCESS_LOCK_SHA256="${web_access_lock_sha256}" \
CARGO_LOCK_SHA256="${cargo_lock_sha256}" \
BUILD_SCRIPT_SHA256="${build_script_sha256}" \
  python3 - "${metadata_path}" <<'PY'
import json
import os
import sys

value = {
    "component": "pi-web",
    "version": os.environ["PI_WEB_VERSION"],
    "piWebCommit": os.environ["PI_WEB_COMMIT"],
    "piWebTree": os.environ["PI_WEB_TREE"],
    "piWebRepository": os.environ["PI_WEB_REPOSITORY"],
    "wildbuzzardCommit": os.environ["SOURCE_COMMIT"],
    "wildbuzzardTree": os.environ["SOURCE_TREE"],
    "sourceSha256": os.environ["SOURCE_SHA256"],
    "piWebPackageSha256": os.environ["PI_WEB_PACKAGE_SHA256"],
    "dependencyLockSha256": os.environ["LOCK_SHA256"],
    "browserToolsSha256": os.environ["BROWSER_TOOLS_SHA256"],
    "webAccessSha256": os.environ["WEB_ACCESS_SHA256"],
    "browserRunnerSha256": os.environ["BROWSER_RUNNER_SHA256"],
    "gitRuntimeSha256": os.environ["GIT_RUNTIME_SHA256"],
    "ytdlpRuntimeSha256": os.environ["YTDLP_RUNTIME_SHA256"],
    "nodeVersion": os.environ["NODE_VERSION"],
    "nodeArchiveSha256": os.environ["NODE_SHA256"],
    "webAccessPackageLockSha256": os.environ["WEB_ACCESS_LOCK_SHA256"],
    "browserRunnerCargoLockSha256": os.environ["CARGO_LOCK_SHA256"],
    "buildScriptSha256": os.environ["BUILD_SCRIPT_SHA256"],
    "protocolVersion": 1,
    "licenseLocations": [
        "PI-WEB-LICENSE",
        "WILDBUZZARD-LICENSE",
        "node/LICENSE",
        "seed/web-access/LICENSE.pi-web-access",
        "seed/web-access/UPSTREAM.toml",
        "source/rust-dependency-licenses.json",
    ],
    "correspondingSource": os.environ["SOURCE_NAME"],
    "sbom": "source/sbom.cdx.json",
    "spdxSbom": "source/sbom.spdx.json",
    "runtimeDependencyInventory": "source/runtime-dependencies.json",
    "buildInputs": "source/build-inputs.json",
    "platform": "linux-x64",
}
with open(sys.argv[1], "w", encoding="utf-8") as output:
    json.dump(value, output, sort_keys=True, separators=(",", ":"))
    output.write("\n")
PY

find "${runtime_dir}" -type d -exec chmod 755 {} +
find "${runtime_dir}" -type f -exec chmod 644 {} +
chmod 755 \
  "${runtime_dir}/bin/"* \
  "${runtime_dir}/node/bin/node" \
  "${runtime_dir}/seed/browser-tools/wildbuzzard-browser-runner" \
  "${runtime_dir}/tools/git/bin/git" \
  "${runtime_dir}/tools/git/bin/git.bin" \
  "${runtime_dir}/tools/yt-dlp/bin/yt-dlp"
if find "${runtime_dir}" -type l -print -quit | grep -q .; then
  echo "Pi Web runtime contains a symbolic link" >&2
  exit 1
fi
find "${runtime_dir}" -exec touch -h --date="@${source_date_epoch}" {} +
python3 "${source_checkout}/wildbuzzard/scripts/runtime-archive-manifest.py" build \
  "${runtime_dir}" "${metadata_path}"
touch --date="@${source_date_epoch}" "${runtime_dir}/${RUNTIME_MANIFEST:-wildbuzzard-runtime.json}"

runtime_name="wildbuzzard-pi-web-runtime-linux-x64-${short_source}-${short_pi_web}.zip"
runtime_zip="${artifacts_dir}/${runtime_name}"
python3 "${source_checkout}/wildbuzzard/scripts/runtime-archive-manifest.py" archive \
  "${runtime_dir}" "${runtime_zip}" "${source_date_epoch}"
python3 "${source_checkout}/wildbuzzard/scripts/runtime-archive-manifest.py" verify \
  "${runtime_zip}"
runtime_sha256="$(sha256sum "${runtime_zip}" | awk '{ print $1 }')"
sha256sum "${runtime_zip}" >"${runtime_zip}.sha256"
sha256sum "${source_archive}" >"${source_archive}.sha256"

build_record="${artifacts_dir}/build-record.json"
ENVIRONMENT="${environment_json}" \
RUNTIME_PATH="${runtime_name}" \
RUNTIME_SHA256="${runtime_sha256}" \
SOURCE_PATH="${source_name}" \
SOURCE_SHA256="${source_sha256}" \
PIN_SHA256="$(sha256sum "${pin_file}" | awk '{ print $1 }')" \
LOCK_SHA256="${pi_web_lock_sha256}" \
NODE_SHA256="${node_sha256}" \
GIT_SHA256="${git_runtime_sha256}" \
YTDLP_SHA256="${ytdlp_runtime_sha256}" \
PI_WEB_REPOSITORY="${pi_web_repository}" \
PI_WEB_COMMIT="${pi_web_commit}" \
WEB_ACCESS_LOCK_SHA256="${web_access_lock_sha256}" \
CARGO_LOCK_SHA256="${cargo_lock_sha256}" \
RUSTSEC_COMMIT="${rustsec_commit}" \
  python3 - "${build_record}" <<'PY'
import json
import os
import sys

with open(os.environ["ENVIRONMENT"], encoding="utf-8") as source:
    environment = json.load(source)
value = {
    "schema": 1,
    "environment": environment,
    "inputs": {
        "runtimePinSha256": os.environ["PIN_SHA256"],
        "packageLockSha256": os.environ["LOCK_SHA256"],
        "nodeArchiveSha256": os.environ["NODE_SHA256"],
        "gitRuntimeSha256": os.environ["GIT_SHA256"],
        "ytdlpRuntimeSha256": os.environ["YTDLP_SHA256"],
        "piWebRepository": os.environ["PI_WEB_REPOSITORY"],
        "piWebCommit": os.environ["PI_WEB_COMMIT"],
        "webAccessPackageLockSha256": os.environ["WEB_ACCESS_LOCK_SHA256"],
        "browserRunnerCargoLockSha256": os.environ["CARGO_LOCK_SHA256"],
        "rustSecAdvisoryCommit": os.environ["RUSTSEC_COMMIT"],
    },
    "runtimeArchive": {
        "path": os.environ["RUNTIME_PATH"],
        "sha256": os.environ["RUNTIME_SHA256"],
    },
    "sourceArchive": {
        "path": os.environ["SOURCE_PATH"],
        "sha256": os.environ["SOURCE_SHA256"],
    },
}
with open(sys.argv[1], "w", encoding="utf-8") as output:
    json.dump(value, output, sort_keys=True, separators=(",", ":"))
    output.write("\n")
PY
touch --date="@${source_date_epoch}" \
  "${runtime_zip}" \
  "${runtime_zip}.sha256" \
  "${source_archive}" \
  "${source_archive}.sha256" \
  "${build_record}"

if [[ -n "${compare_to}" ]]; then
  python3 "${source_checkout}/wildbuzzard/scripts/compare-pi-web-runtime-builds.py" \
    "$(realpath -- "${compare_to}")" "${build_record}"
fi

echo "Pi Web runtime built from ${pi_web_commit} with WildBuzzard ${source_commit}"
echo "Runtime: ${runtime_zip}"
echo "Build record: ${build_record}"
echo "Logs: ${run_root}"
