#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

set -Eeuo pipefail

usage() {
  echo "Usage: $0 [options]"
  echo
  echo "Options:"
  echo "  --ref REF           committed WildBuzzard ref to build (default: HEAD)"
  echo "  --build-root DIR    external build root (default: ../../wildbuzzard-torrent-builds)"
  echo "  --node-version VER  bundled Node.js version (default: 22.23.2)"
  echo "  --help              show this help"
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source_repo="$(cd -- "${script_dir}/../.." && pwd -P)"
build_root="$(dirname -- "${source_repo}")/wildbuzzard-torrent-builds"
build_ref="HEAD"
node_version="22.23.2"

while (($#)); do
  case "$1" in
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

mkdir -p -- "${build_root}"
build_root="$(cd -- "${build_root}" && pwd -P)"
case "${build_root}/" in
  "${source_repo}/"*)
    echo "Build root must be outside the source repository" >&2
    exit 2
    ;;
esac

commit="$(git -C "${source_repo}" rev-parse --verify "${build_ref}^{commit}")"
short_commit="$(git -C "${source_repo}" rev-parse --short=12 "${commit}")"
run_id="$(date -u +%Y%m%dT%H%M%SZ)-${short_commit}-$$"
run_root="${build_root}/runs/${run_id}"
checkout_dir="${run_root}/source"
runtime_dir="${run_root}/runtime"
app_dir="${runtime_dir}/app"
downloads_dir="${build_root}/downloads"
artifacts_dir="${run_root}/artifacts"
node_archive="node-v${node_version}-linux-x64.tar.xz"
node_url="https://nodejs.org/dist/v${node_version}/${node_archive}"

mkdir -p -- "${run_root}" "${runtime_dir}/bin" "${app_dir}" "${downloads_dir}" "${artifacts_dir}"
git clone --shared --no-checkout -- "${source_repo}" "${checkout_dir}"
git -C "${checkout_dir}" checkout --detach "${commit}"

cp -- "${checkout_dir}/wildbuzzard/torrent-runtime/package.json" "${app_dir}/"
cp -- "${checkout_dir}/wildbuzzard/torrent-runtime/package-lock.json" "${app_dir}/"
cp -- "${checkout_dir}/wildbuzzard/torrent-runtime/service.mjs" "${app_dir}/"
cp -a -- "${checkout_dir}/wildbuzzard/torrent-runtime/test" "${app_dir}/"
cp -a -- "${checkout_dir}/wildbuzzard/torrent-runtime/vendor" "${app_dir}/"
cp -- "${checkout_dir}/wildbuzzard/torrent-runtime/SECURITY.md" "${runtime_dir}/SECURITY.md"

(
  cd -- "${app_dir}"
  npm ci --ignore-scripts --omit=optional
) >"${run_root}/npm-install.log" 2>&1

(
  cd -- "${checkout_dir}/third_party/webtorrent"
  npm pack --ignore-scripts --pack-destination "${run_root}"
) >"${run_root}/webtorrent-pack.log" 2>&1
webtorrent_archive="$(find "${run_root}" -maxdepth 1 -type f -name 'webtorrent-*.tgz' -print -quit)"
if [[ -z "${webtorrent_archive}" ]]; then
  echo "WebTorrent source package was not produced" >&2
  exit 1
fi
rm -rf -- "${app_dir}/node_modules/webtorrent"
mkdir -p -- "${app_dir}/node_modules/webtorrent"
tar -xzf "${webtorrent_archive}" --strip-components=1 -C "${app_dir}/node_modules/webtorrent"

utp_dir="${app_dir}/node_modules/utp-native"
if [[ ! -d "${utp_dir}/deps/libutp" ]]; then
  echo "utp-native source is missing" >&2
  exit 1
fi
rm -rf -- "${utp_dir}/prebuilds" "${utp_dir}/build"
(
  cd -- "${app_dir}"
  npm_config_build_from_source=true npm rebuild utp-native
) >"${run_root}/utp-build.log" 2>&1
if ! find "${utp_dir}/build" -type f -name '*.node' -print -quit | grep -q .; then
  echo "The source-built µTP module was not produced" >&2
  exit 1
fi
rm -rf -- "${utp_dir}/build/Release/obj.target"

(
  cd -- "${app_dir}"
  node --test test/*.test.mjs
) >"${run_root}/runtime-test.log" 2>&1

(
  cd -- "${app_dir}"
  npm audit --omit=dev --json
) >"${run_root}/npm-audit.json" 2>/dev/null || true
node - "${run_root}/npm-audit.json" <<'NODE'
const fs = require("node:fs");
const audit = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const vulnerabilities = Object.values(audit.vulnerabilities || {});
if (vulnerabilities.some(item => item.severity === "critical")) {
  throw new Error("Critical production dependency advisory detected");
}
const allowed = "https://github.com/advisories/GHSA-2p57-rm9w-gvfp";
for (const item of vulnerabilities.filter(value => value.severity === "high")) {
  const advisories = item.via.filter(value => typeof value === "object");
  if (advisories.length && advisories.some(value => value.url !== allowed)) {
    throw new Error(`Unexpected high-severity advisory in ${item.name}`);
  }
}
NODE

(
  cd -- "${app_dir}"
  npm prune --omit=dev --omit=optional --ignore-scripts
)
rm -rf -- "${app_dir}/test"
while IFS= read -r -d '' prebuild_dir; do
  rm -rf -- "${prebuild_dir}"
done < <(find "${app_dir}/node_modules" -type d -name prebuilds -print0)

unexpected_native=()
while IFS= read -r -d '' artifact; do
  artifact_type="$(file -b -- "${artifact}")"
  case "${artifact_type}" in
    *ELF*|*Mach-O*|*PE32*)
      case "${artifact}" in
        "${utp_dir}"/build/Release/*.node) ;;
        *) unexpected_native+=("${artifact}: ${artifact_type}") ;;
      esac
      ;;
  esac
done < <(find "${app_dir}/node_modules" -type f -print0)
if ((${#unexpected_native[@]})); then
  printf 'Unexpected native runtime artifact: %s\n' "${unexpected_native[@]}" >&2
  exit 1
fi
if find "${app_dir}/node_modules" -type f -name '*.bare' -print -quit | grep -q .; then
  echo "Unexpected Bare native runtime artifact" >&2
  exit 1
fi

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

printf '%s\n' \
  '#!/bin/sh' \
  'launcher_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)' \
  'exec "${launcher_dir}/../node/bin/node" "${launcher_dir}/../app/service.mjs" "$@"' \
  >"${runtime_dir}/bin/wildbuzzard-torrent"
chmod 755 "${runtime_dir}/bin/wildbuzzard-torrent" "${runtime_dir}/node/bin/node"

cp -- "${checkout_dir}/third_party/webtorrent/LICENSE" "${runtime_dir}/WEBTORRENT-LICENSE"
cp -- "${checkout_dir}/COPYING" "${runtime_dir}/WILDBUZZARD-LICENSE"
webtorrent_commit="$(awk '
  $0 == "[webtorrent]" { section = 1; next }
  /^\[/ { section = 0 }
  section && $1 == "commit" { gsub(/"/, "", $3); print $3; exit }
' "${checkout_dir}/wildbuzzard/upstreams.toml")"
if [[ ! "${webtorrent_commit}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Pinned WebTorrent commit is missing or invalid" >&2
  exit 1
fi
lock_sha="$(sha256sum "${app_dir}/package-lock.json" | awk '{ print $1 }')"
printf '{\n  "schema": 1,\n  "wildbuzzardCommit": "%s",\n  "webTorrentVersion": "3.0.21",\n  "webTorrentImportCommit": "%s",\n  "packageLockSha256": "%s",\n  "nodeVersion": "%s",\n  "utpBuiltFromSource": true,\n  "platform": "linux-x64"\n}\n' \
  "${commit}" "${webtorrent_commit}" "${lock_sha}" "${node_version}" \
  >"${runtime_dir}/wildbuzzard-torrent-runtime.json"

runtime_zip="${artifacts_dir}/wildbuzzard-torrent-runtime-linux-x64-${short_commit}.zip"
(
  cd -- "${runtime_dir}"
  zip -q -r "${runtime_zip}" .
)
sha256sum "${runtime_zip}" >"${runtime_zip}.sha256"

{
  echo "wildbuzzard_commit=${commit}"
  echo "webtorrent_version=3.0.21"
  echo "node_version=${node_version}"
  echo "utp_built_from_source=true"
  echo "runtime_zip=${runtime_zip}"
  echo "runtime_sha256=$(sha256sum "${runtime_zip}" | awk '{ print $1 }')"
} >"${run_root}/build-manifest.txt"

echo "WebTorrent runtime built from ${commit}"
echo "Runtime: ${runtime_zip}"
echo "Logs: ${run_root}"
