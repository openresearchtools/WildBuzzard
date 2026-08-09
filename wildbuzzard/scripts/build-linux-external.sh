#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Build a committed WildBuzzard revision in a runner-style checkout. Nothing is
# configured, compiled, cached, or packaged in the developer source checkout.

set -Eeuo pipefail

usage() {
  echo "Usage: $0 [options]"
  echo
  echo "Options:"
  echo "  --action ACTION    configure, build, test, package, appimage, or all (default: build)"
  echo "  --build-root DIR   external build root (default: ../wildbuzzard-builds)"
  echo "  --jobs NUMBER      parallel build jobs (default: all logical CPUs)"
  echo "  --ref REF          committed Git ref to build (default: HEAD)"
  echo "  --working-tree     include tracked and untracked developer changes"
  echo "  --pi-web-runtime FILE  Pi Web runtime ZIP to include in the browser package"
  echo "  --bootstrap        run mach bootstrap before the requested action"
  echo "  --help             show this help"
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source_repo="$(cd -- "${script_dir}/../.." && pwd -P)"
build_root="$(dirname -- "${source_repo}")/wildbuzzard-builds"
action="build"
build_ref="HEAD"
jobs="$(nproc)"
run_bootstrap=false
include_working_tree=false
pi_web_runtime=""

while (($#)); do
  case "$1" in
    --action)
      action="${2:?--action requires a value}"
      shift 2
      ;;
    --build-root)
      build_root="${2:?--build-root requires a directory}"
      shift 2
      ;;
    --jobs)
      jobs="${2:?--jobs requires a number}"
      shift 2
      ;;
    --ref)
      build_ref="${2:?--ref requires a Git ref}"
      shift 2
      ;;
    --working-tree)
      include_working_tree=true
      shift
      ;;
    --pi-web-runtime)
      pi_web_runtime="${2:?--pi-web-runtime requires a file}"
      shift 2
      ;;
    --bootstrap)
      run_bootstrap=true
      shift
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

if [[ -n "${pi_web_runtime}" ]]; then
  pi_web_runtime="$(realpath -- "${pi_web_runtime}")"
  if [[ ! -f "${pi_web_runtime}" ]]; then
    echo "--pi-web-runtime must name a ZIP file" >&2
    exit 2
  fi
fi

case "${action}" in
  configure|build|test|package|appimage|all) ;;
  *)
    echo "Unsupported action: ${action}" >&2
    exit 2
    ;;
esac

if [[ ! "${jobs}" =~ ^[1-9][0-9]*$ ]]; then
  echo "--jobs must be a positive integer" >&2
  exit 2
fi

mkdir -p -- "${build_root}"
build_root="$(cd -- "${build_root}" && pwd -P)"

case "${build_root}/" in
  "${source_repo}/"*)
    echo "Build root must be outside the source repository: ${source_repo}" >&2
    exit 2
    ;;
esac

commit="$(git -C "${source_repo}" rev-parse --verify "${build_ref}^{commit}")"
short_commit="$(git -C "${source_repo}" rev-parse --short=12 "${commit}")"
run_id="$(date -u +%Y%m%dT%H%M%SZ)-${short_commit}-$$"
run_root="${build_root}/runs/${run_id}"
checkout_dir="${run_root}/source"
object_dir="${run_root}/obj"
log_dir="${run_root}/logs"
state_dir="${build_root}/state"
ccache_dir="${build_root}/ccache"
sccache_dir="${build_root}/sccache"

mkdir -p -- \
  "${run_root}" \
  "${object_dir}" \
  "${log_dir}" \
  "${state_dir}" \
  "${ccache_dir}" \
  "${sccache_dir}"

if ! git -C "${source_repo}" diff --quiet ||
  ! git -C "${source_repo}" diff --cached --quiet; then
  if [[ "${include_working_tree}" == true ]]; then
    echo "Note: this run includes the developer working tree over ${commit}."
  else
    echo "Note: the developer checkout is dirty; this run builds committed ${commit} only."
  fi
fi

# The checkout has its own index and worktree, while Git objects are borrowed
# read-only from the developer repository. This avoids copying and recompressing
# Firefox's multi-gigabyte history; all generated files still stay external.
git clone --shared --no-checkout -- "${source_repo}" "${checkout_dir}"
git -C "${checkout_dir}" checkout --detach "${commit}"

if [[ "${include_working_tree}" == true ]]; then
  git -C "${source_repo}" diff --binary "${commit}" -- \
    >"${run_root}/working-tree.patch"
  if [[ -s "${run_root}/working-tree.patch" ]]; then
    git -C "${checkout_dir}" apply --binary "${run_root}/working-tree.patch"
  fi
  while IFS= read -r -d '' path; do
    mkdir -p -- "${checkout_dir}/$(dirname -- "${path}")"
    cp -a -- "${source_repo}/${path}" "${checkout_dir}/${path}"
  done < <(
    git -C "${source_repo}" ls-files \
      --others --exclude-standard -z
  )
fi

build_commit="${commit}"
if [[ "${include_working_tree}" == true ]]; then
  git -C "${checkout_dir}" add --all
  if ! git -C "${checkout_dir}" diff --cached --quiet; then
    git -C "${checkout_dir}" \
      -c user.name="WildBuzzard Build" \
      -c user.email="build@wildbuzzard.invalid" \
      commit -m "WildBuzzard external build snapshot"
    build_commit="$(git -C "${checkout_dir}" rev-parse HEAD)"
  fi
fi

{
  echo "base_commit=${commit}"
  echo "build_commit=${build_commit}"
  echo "ref=${build_ref}"
  echo "source_repo=${source_repo}"
  echo "run_root=${run_root}"
  echo "object_dir=${object_dir}"
  echo "jobs=${jobs}"
  echo "action=${action}"
  echo "working_tree=${include_working_tree}"
  echo "pi_web_runtime=${pi_web_runtime}"
  echo "started_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} >"${run_root}/build-manifest.txt"

export MOZBUILD_STATE_PATH="${state_dir}"
export CCACHE_DIR="${ccache_dir}"
export SCCACHE_DIR="${sccache_dir}"
# Normalize the per-run checkout prefix out of cache keys. Without this,
# otherwise identical source files in fresh runner directories miss the cache.
export SCCACHE_BASEDIR="${checkout_dir}"

run_step() {
  local name="$1"
  local log_file="${log_dir}/${name}.log"
  shift
  echo "==> ${name}"
  if (
    cd -- "${checkout_dir}"
    "$@"
  ) >"${log_file}" 2>&1; then
    echo "Completed ${name}; log: ${log_file}"
  else
    local status=$?
    echo "Failed ${name}; log: ${log_file}" >&2
    return "${status}"
  fi
}

run_blocker_tests() {
  run_step blocker-xpcshell-tests ./mach xpcshell-test \
    browser/components/blocker/test/unit/xpcshell.toml
  run_step blocker-browser-tests env MOZ_HEADLESS=1 ./mach mochitest \
    --flavor browser browser/components/blocker/test/browser/browser.toml
}

run_product_tests() {
  local manifest
  local relative_manifest
  local component

  while IFS= read -r manifest; do
    relative_manifest="${manifest#"${checkout_dir}/"}"
    component="${relative_manifest#wildbuzzard/browser/components/}"
    component="${component%%/*}"
    run_step "product-browser-${component}" env MOZ_HEADLESS=1 \
      ./mach mochitest --flavor browser "${relative_manifest}"
  done < <(
    find "${checkout_dir}/wildbuzzard/browser/components" \
      -path '*/test/browser/browser.toml' -print | sort
  )

  while IFS= read -r manifest; do
    relative_manifest="${manifest#"${checkout_dir}/"}"
    component="${relative_manifest#wildbuzzard/browser/components/}"
    component="${component%%/*}"
    run_step "product-xpcshell-${component}" ./mach xpcshell-test \
      "${relative_manifest}"
  done < <(
    find "${checkout_dir}/wildbuzzard/browser/components" \
      -path '*/test/*/xpcshell.toml' -print | sort
  )
}

run_deb_package() {
  run_step deb-package ./wildbuzzard/scripts/package-deb.sh \
    --dist-dir "${object_dir}/dist" \
    --output-dir "${run_root}/artifacts"
}

run_appimage_package() {
  run_step appimage-package ./wildbuzzard/scripts/package-appimage.sh \
    --dist-dir "${object_dir}/dist" \
    --output-dir "${run_root}/artifacts"
}

if [[ "${run_bootstrap}" == true ]]; then
  run_step bootstrap ./mach --no-interactive bootstrap \
    --application-choice browser \
    --no-system-changes
fi

# Bootstrap installs Mozilla's pinned sccache into the state directory. Write
# the configuration afterwards so a fresh runner uses it on its first build.
{
  echo "mk_add_options MOZ_OBJDIR=${object_dir}"
  echo "mk_add_options AUTOCLOBBER=1"
  echo "mk_add_options MOZ_MAKE_FLAGS=-j${jobs}"
  echo "ac_add_options --enable-application=browser"
  echo "ac_add_options --enable-optimize"
  echo "ac_add_options --disable-debug"
  echo "ac_add_options --disable-crashreporter"
  if [[ -n "${pi_web_runtime}" ]]; then
    echo "ac_add_options --with-wildbuzzard-pi-web-runtime=${pi_web_runtime}"
  fi
  if [[ -x "${state_dir}/sccache/sccache" ]]; then
    echo "ac_add_options --with-ccache=${state_dir}/sccache/sccache"
  elif command -v ccache >/dev/null 2>&1; then
    echo "ac_add_options --with-ccache=$(command -v ccache)"
  fi
} >"${checkout_dir}/.mozconfig"

case "${action}" in
  configure)
    run_step configure ./mach configure
    ;;
  build)
    run_step build ./mach build
    ;;
  test)
    run_step build ./mach build
    run_blocker_tests
    run_product_tests
    ;;
  package)
    run_step build ./mach build
    run_step package ./mach package
    run_deb_package
    run_appimage_package
    ;;
  appimage)
    run_step build ./mach build
    run_step package ./mach package
    run_appimage_package
    ;;
  all)
    run_step configure ./mach configure
    run_step build ./mach build
    run_blocker_tests
    run_product_tests
    run_step package ./mach package
    run_deb_package
    run_appimage_package
    ;;
esac

echo "Build run complete: ${run_root}"
echo "Packages, when requested, are under: ${object_dir}/dist"
echo "Shared sccache: ${sccache_dir}"
