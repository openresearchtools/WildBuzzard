#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

set -Eeuo pipefail
umask 022

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
node_sha256="d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307"

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

if [[ "${node_version}" != "22.23.2" ]]; then
  echo "No pinned checksum is configured for Node.js ${node_version}" >&2
  exit 2
fi

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
source_date_epoch="$(git -C "${source_repo}" show -s --format=%ct "${commit}")"

mkdir -p -- "${run_root}" "${runtime_dir}/bin" "${app_dir}" "${downloads_dir}" "${artifacts_dir}"
mkdir -p -- "${run_root}/home" "${build_root}/npm-cache"
install -m 600 /dev/null "${run_root}/npmrc"
npm_environment=(
  "HOME=${run_root}/home"
  "npm_config_cache=${build_root}/npm-cache"
  "npm_config_fund=false"
  "npm_config_globalconfig=${run_root}/npmrc"
  "npm_config_registry=https://registry.npmjs.org/"
  "npm_config_update_notifier=false"
  "npm_config_userconfig=${run_root}/npmrc"
)
git clone --shared --no-checkout -- "${source_repo}" "${checkout_dir}"
git -C "${checkout_dir}" sparse-checkout init --no-cone
git -C "${checkout_dir}" sparse-checkout set \
  /COPYING \
  /third_party/webtorrent/ \
  /wildbuzzard/scripts/build-webtorrent-runtime.sh \
  /wildbuzzard/scripts/generate-node-runtime-sbom.mjs \
  /wildbuzzard/torrent-runtime/ \
  /wildbuzzard/upstreams.toml
git -C "${checkout_dir}" checkout --detach "${commit}"

source_dir="${runtime_dir}/share/wildbuzzard/torrent"
source_name="wildbuzzard-torrent-runtime-1.0.0-${short_commit}-source.tar.xz"
source_archive="${source_dir}/${source_name}"
mkdir -p -- "${source_dir}"
create_source_archive() {
  git -C "${checkout_dir}" archive \
    --format=tar \
    --prefix="wildbuzzard-torrent-runtime-${commit}/" \
    "${commit}" -- \
    COPYING \
    third_party/webtorrent \
    wildbuzzard/scripts/build-webtorrent-runtime.sh \
    wildbuzzard/scripts/generate-node-runtime-sbom.mjs \
    wildbuzzard/torrent-runtime \
    wildbuzzard/upstreams.toml |
    xz --threads=1 --check=crc64 -9e >"${source_archive}"
}
create_source_archive
source_sha256="$(sha256sum "${source_archive}" | awk '{ print $1 }')"
rm -f -- "${source_archive}"
create_source_archive
if [[ "$(sha256sum "${source_archive}" | awk '{ print $1 }')" != "${source_sha256}" ]]; then
  echo "Deterministic torrent corresponding-source check failed" >&2
  exit 1
fi

cp -- "${checkout_dir}/wildbuzzard/torrent-runtime/package.json" "${app_dir}/"
cp -- "${checkout_dir}/wildbuzzard/torrent-runtime/package-lock.json" "${app_dir}/"
cp -- "${checkout_dir}/wildbuzzard/torrent-runtime/service.mjs" "${app_dir}/"
cp -a -- "${checkout_dir}/wildbuzzard/torrent-runtime/test" "${app_dir}/"
cp -a -- "${checkout_dir}/wildbuzzard/torrent-runtime/vendor" "${app_dir}/"
cp -- "${checkout_dir}/wildbuzzard/torrent-runtime/SECURITY.md" "${runtime_dir}/SECURITY.md"

if [[ ! -f "${downloads_dir}/${node_archive}" ]]; then
  curl --fail --location --output "${downloads_dir}/${node_archive}" "${node_url}"
fi
actual_sha="$(sha256sum "${downloads_dir}/${node_archive}" | awk '{ print $1 }')"
if [[ "${node_sha256}" != "${actual_sha}" ]]; then
  echo "Node.js archive checksum verification failed" >&2
  exit 1
fi
tar -xJf "${downloads_dir}/${node_archive}" -C "${runtime_dir}"
mv -- "${runtime_dir}/node-v${node_version}-linux-x64" "${runtime_dir}/node"
bundled_node="${runtime_dir}/node/bin/node"
bundled_npm_cli="${runtime_dir}/node/lib/node_modules/npm/bin/npm-cli.js"

(
  cd -- "${app_dir}"
  env "${npm_environment[@]}" \
    PATH="${runtime_dir}/node/bin:${PATH}" \
    "${bundled_node}" "${bundled_npm_cli}" ci --ignore-scripts --omit=optional
) >"${run_root}/npm-install.log" 2>&1

(
  cd -- "${checkout_dir}/third_party/webtorrent"
  env "${npm_environment[@]}" \
    PATH="${runtime_dir}/node/bin:${PATH}" \
    "${bundled_node}" "${bundled_npm_cli}" pack --ignore-scripts --pack-destination "${run_root}"
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
  env "${npm_environment[@]}" \
    PATH="${runtime_dir}/node/bin:${PATH}" \
    npm_config_nodedir="${runtime_dir}/node" \
    npm_config_build_from_source=true \
    CFLAGS="-ffile-prefix-map=${run_root}=. -fdebug-prefix-map=${run_root}=." \
    CXXFLAGS="-ffile-prefix-map=${run_root}=. -fdebug-prefix-map=${run_root}=." \
    "${bundled_node}" "${bundled_npm_cli}" rebuild utp-native
) >"${run_root}/utp-build.log" 2>&1
utp_module="$(find "${utp_dir}/build" -type f -name '*.node' -print -quit)"
if [[ -z "${utp_module}" ]]; then
  echo "The source-built µTP module was not produced" >&2
  exit 1
fi
if ldd "${utp_module}" | grep -Eq 'libnode|libuv'; then
  echo "The µTP module linked against host Node.js or libuv" >&2
  exit 1
fi
(
  cd -- "${app_dir}"
  "${bundled_node}" -e 'require("utp-native")'
) >"${run_root}/utp-load-test.log" 2>&1
rm -rf -- "${utp_dir}/build/Release/obj.target"

(
  cd -- "${app_dir}"
  "${bundled_node}" --test --test-concurrency=1 test/*.test.mjs
) >"${run_root}/runtime-test.log" 2>&1

(
  cd -- "${app_dir}"
  env "${npm_environment[@]}" \
    PATH="${runtime_dir}/node/bin:${PATH}" \
    "${bundled_node}" "${bundled_npm_cli}" audit --omit=dev --json
) >"${run_root}/npm-audit.json" 2>/dev/null || true
"${bundled_node}" - "${run_root}/npm-audit.json" <<'NODE'
const fs = require("node:fs");
const audit = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (audit.error || typeof audit.metadata?.vulnerabilities?.total !== "number") {
  throw new Error("The production dependency audit did not complete");
}
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
  env "${npm_environment[@]}" \
    PATH="${runtime_dir}/node/bin:${PATH}" \
    "${bundled_node}" "${bundled_npm_cli}" prune --omit=dev --omit=optional --ignore-scripts
)
rm -rf -- \
  "${app_dir}/node_modules/webtorrent" \
  "${app_dir}/node_modules/webrtc-polyfill"
mkdir -p -- \
  "${app_dir}/node_modules/webtorrent" \
  "${app_dir}/node_modules/webrtc-polyfill"
tar -xzf "${webtorrent_archive}" --strip-components=1 -C "${app_dir}/node_modules/webtorrent"
cp -a -- \
  "${app_dir}/vendor/webrtc-disabled/." \
  "${app_dir}/node_modules/webrtc-polyfill/"
rm -rf -- "${app_dir}/test"
(
  cd -- "${app_dir}"
  "${bundled_node}" -e 'require("utp-native")'
  "${bundled_node}" -e 'Promise.all([import("webtorrent"), import("webrtc-polyfill")])'
)
while IFS= read -r -d '' prebuild_dir; do
  rm -rf -- "${prebuild_dir}"
done < <(find "${app_dir}/node_modules" -type d -name prebuilds -print0)
while IFS= read -r -d '' bin_dir; do
  rm -rf -- "${bin_dir}"
done < <(find "${app_dir}/node_modules" -type d -name .bin -print0)

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

printf '%s\n' \
  '#!/bin/sh' \
  'launcher_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)' \
  'exec "${launcher_dir}/../node/bin/node" "${launcher_dir}/../app/service.mjs" "$@"' \
  >"${runtime_dir}/bin/wildbuzzard-torrent"
chmod 755 "${runtime_dir}/bin/wildbuzzard-torrent" "${runtime_dir}/node/bin/node"
rm -f -- \
  "${runtime_dir}/node/bin/corepack" \
  "${runtime_dir}/node/bin/npm" \
  "${runtime_dir}/node/bin/npx"
rm -rf -- \
  "${runtime_dir}/node/include" \
  "${runtime_dir}/node/lib/node_modules" \
  "${runtime_dir}/node/share"

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
sbom_path="${source_dir}/sbom.cdx.json"
"${bundled_node}" \
  "${checkout_dir}/wildbuzzard/scripts/generate-node-runtime-sbom.mjs" \
  --app-root "${app_dir}" \
  --commit "${commit}" \
  --node-archive-sha256 "${node_sha256}" \
  --node-version "${node_version}" \
  --output "${sbom_path}" \
  --package-lock-sha256 "${lock_sha}" \
  --source-date-epoch "${source_date_epoch}" \
  --source-sha256 "${source_sha256}" \
  --webtorrent-commit "${webtorrent_commit}"
if find "${runtime_dir}" -type l -print -quit | grep -q .; then
  echo "Torrent runtime contains a symbolic link" >&2
  exit 1
fi

"${bundled_node}" - \
  "${runtime_dir}" \
  "${commit}" \
  "${webtorrent_commit}" \
  "${lock_sha}" \
  "${node_version}" \
  "share/wildbuzzard/torrent/${source_name}" \
  "${source_sha256}" <<'NODE'
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const [
  root,
  commit,
  webTorrentCommit,
  lockSha,
  nodeVersion,
  correspondingSource,
  sourceSha256,
] = process.argv.slice(2);
const manifestName = "wildbuzzard-torrent-runtime.json";
const allowedExecutables = new Set([
  "bin/wildbuzzard-torrent",
  "node/bin/node",
]);
const paths = [];

function visit(directory) {
  for (const name of fs.readdirSync(directory).sort()) {
    const absolute = path.join(directory, name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    if (relative.includes("\n") || relative.includes("\0")) {
      throw new Error("Unsafe runtime path");
    }
    const entry = fs.lstatSync(absolute);
    if (entry.isSymbolicLink()) {
      throw new Error(`Symbolic link in runtime: ${relative}`);
    }
    if (entry.isDirectory()) {
      fs.chmodSync(absolute, 0o755);
      visit(absolute);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Unsupported runtime entry: ${relative}`);
    }
    if (relative !== manifestName) {
      paths.push(relative);
    }
  }
}

visit(root);
const files = paths.sort().map(relative => {
  const absolute = path.join(root, ...relative.split("/"));
  const executable = allowedExecutables.has(relative);
  fs.chmodSync(absolute, executable ? 0o755 : 0o644);
  const bytes = fs.readFileSync(absolute);
  return {
    path: relative,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    executable,
  };
});
for (const executable of allowedExecutables) {
  if (!files.some(file => file.path === executable && file.executable)) {
    throw new Error(`Missing runtime executable: ${executable}`);
  }
}
const payloadHash = createHash("sha256");
for (const file of files) {
  payloadHash.update(
    `${file.path}\0${file.size}\0${file.sha256}\0${file.executable ? 1 : 0}\n`
  );
}
const manifest = {
  schema: 3,
  component: "wildbuzzard-torrent-runtime",
  version: "1.0.0",
  protocolVersion: 1,
  wildbuzzardCommit: commit,
  webTorrentVersion: "3.0.21",
  webTorrentImportCommit: webTorrentCommit,
  packageLockSha256: lockSha,
  dependencyLockSha256: lockSha,
  nodeVersion,
  nodeArchiveSha256: "d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307",
  utpBuiltFromSource: true,
  platform: "linux-x64",
  architecture: "x86_64",
  correspondingSource,
  sourceSha256,
  sbom: "share/wildbuzzard/torrent/sbom.cdx.json",
  licenseLocations: [
    "WEBTORRENT-LICENSE",
    "WILDBUZZARD-LICENSE",
    "node/LICENSE",
  ],
  payloadSha256: payloadHash.digest("hex"),
  files,
};
fs.writeFileSync(
  path.join(root, manifestName),
  `${JSON.stringify(manifest, null, 2)}\n`,
  { mode: 0o644 }
);
NODE

while IFS= read -r -d '' path; do
  touch -h -d "@${source_date_epoch}" -- "${path}"
done < <(find "${runtime_dir}" -print0)

runtime_zip="${artifacts_dir}/wildbuzzard-torrent-runtime-linux-x64-${short_commit}.zip"
archive_list="${run_root}/runtime-files.txt"
(
  cd -- "${runtime_dir}"
  LC_ALL=C find . -type f -printf '%P\n' | LC_ALL=C sort >"${archive_list}"
  TZ=UTC zip -X -q -9 "${runtime_zip}" -@ <"${archive_list}"
)
first_runtime_sha256="$(sha256sum "${runtime_zip}" | awk '{ print $1 }')"
rm -f -- "${runtime_zip}"
(
  cd -- "${runtime_dir}"
  TZ=UTC zip -X -q -9 "${runtime_zip}" -@ <"${archive_list}"
)
if [[ "$(sha256sum "${runtime_zip}" | awk '{ print $1 }')" != "${first_runtime_sha256}" ]]; then
  echo "Deterministic torrent runtime archive check failed" >&2
  exit 1
fi
sha256sum "${runtime_zip}" >"${runtime_zip}.sha256"

{
  echo "wildbuzzard_commit=${commit}"
  echo "webtorrent_version=3.0.21"
  echo "node_version=${node_version}"
  echo "utp_built_from_source=true"
  echo "corresponding_source=${source_archive}"
  echo "source_sha256=${source_sha256}"
  echo "sbom=${sbom_path}"
  echo "sbom_sha256=$(sha256sum "${sbom_path}" | awk '{ print $1 }')"
  echo "runtime_zip=${runtime_zip}"
  echo "runtime_sha256=$(sha256sum "${runtime_zip}" | awk '{ print $1 }')"
} >"${run_root}/build-manifest.txt"

echo "WebTorrent runtime built from ${commit}"
echo "Runtime: ${runtime_zip}"
echo "Logs: ${run_root}"
