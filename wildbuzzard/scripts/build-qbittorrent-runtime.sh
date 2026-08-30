#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

set -Eeuo pipefail
umask 022

usage() {
  echo "Usage: $0 --boost-archive FILE --qt-source-archive FILE [options]"
  echo
  echo "Options:"
  echo "  --boost-archive FILE  pinned Boost 1.88.0 source archive"
  echo "  --qt-source-archive FILE  pinned Qt 6.10.2 source archive"
  echo "  --build-root DIR      external build root"
  echo "  --lrelease FILE       Qt 6 lrelease executable"
  echo "  --ref REF             committed WildBuzzard ref (default: HEAD)"
  echo "  --working-tree        include relevant tracked and untracked changes"
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source_repo="$(cd -- "${script_dir}/../.." && pwd -P)"
build_root="$(dirname -- "${source_repo}")/wildbuzzard-qbittorrent-builds"
build_ref="HEAD"
include_working_tree=false
boost_archive=""
qt_source_archive=""
lrelease="$(command -v lrelease || true)"

while (($#)); do
  case "$1" in
    --boost-archive)
      boost_archive="${2:?--boost-archive requires a file}"
      shift 2
      ;;
    --build-root)
      build_root="${2:?--build-root requires a directory}"
      shift 2
      ;;
    --qt-source-archive)
      qt_source_archive="${2:?--qt-source-archive requires a file}"
      shift 2
      ;;
    --lrelease)
      lrelease="${2:?--lrelease requires a file}"
      shift 2
      ;;
    --ref)
      build_ref="${2:?--ref requires a ref}"
      shift 2
      ;;
    --working-tree)
      include_working_tree=true
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

if [[ -z "${boost_archive}" || ! -f "${boost_archive}" ]]; then
  echo "--boost-archive must name the pinned Boost source archive" >&2
  exit 2
fi
if [[ -z "${qt_source_archive}" || ! -f "${qt_source_archive}" ]]; then
  echo "--qt-source-archive must name the pinned Qt source archive" >&2
  exit 2
fi
if [[ -z "${lrelease}" || ! -x "${lrelease}" ]]; then
  echo "--lrelease must name an executable Qt 6 lrelease" >&2
  exit 2
fi
if [[ "$(sha256sum "${boost_archive}" | awk '{print $1}')" != "46d9d2c06637b219270877c9e16155cbd015b6dc84349af064c088e9b5b12f7b" ]]; then
  echo "Boost source archive differs from the pin" >&2
  exit 1
fi
qt_source_sha256="aeb78d29291a2b5fd53cb55950f8f5065b4978c25fb1d77f627d695ab9adf21e"
if [[ "$(sha256sum "${qt_source_archive}" | awk '{print $1}')" != "${qt_source_sha256}" ]]; then
  echo "Qt source archive differs from the pin" >&2
  exit 1
fi
qt_lrelease_sha256="e9f9f468f45fe73b1fe56a235438d802d51fd45dd55b52f06b212029bce458b8"
if [[ "$(${lrelease} -version 2>&1)" != "lrelease version 6.10.2" ]]; then
  echo "Qt lrelease version differs from the pin" >&2
  exit 1
fi
if [[ "$(sha256sum "${lrelease}" | awk '{print $1}')" != "${qt_lrelease_sha256}" ]]; then
  echo "Qt lrelease executable differs from the pin" >&2
  exit 1
fi
qt_prefix="$(dirname -- "$(dirname -- "$(realpath -- "${lrelease}")")")"
qtpaths="${qt_prefix}/bin/qtpaths"
if [[ ! -x "${qtpaths}" ]]; then
  qtpaths="${qt_prefix}/bin/qtpaths6"
fi
if [[ ! -x "${qtpaths}" ]]; then
  echo "The pinned Qt installation does not provide qtpaths" >&2
  exit 1
fi
if [[ "$(${qtpaths} --query QT_VERSION)" != "6.10.2" ]]; then
  echo "Qt runtime version differs from the pin" >&2
  exit 1
fi
qt_plugin_root="$(${qtpaths} --query QT_INSTALL_PLUGINS)"

mkdir -p -- "${build_root}"
build_root="$(cd -- "${build_root}" && pwd -P)"
case "${build_root}/" in
  "${source_repo}/"*)
    echo "Build root must be outside the source repository" >&2
    exit 2
    ;;
esac

base_commit="$(git -C "${source_repo}" rev-parse --verify "${build_ref}^{commit}")"
commit="${base_commit}"
short_commit="${base_commit:0:12}"
source_date_epoch="$(git -C "${source_repo}" show -s --format=%ct "${base_commit}")"
export SOURCE_DATE_EPOCH="${source_date_epoch}"
export TZ=UTC
export LANG=C.UTF-8
export LC_ALL=C.UTF-8
run_id="$(date -u +%Y%m%dT%H%M%SZ)-${short_commit}-$$"
run_root="${build_root}/runs/${run_id}"
checkout="${run_root}/source"
work="${run_root}/work"
prefix="${work}/prefix"
runtime="${run_root}/runtime"
artifacts="${run_root}/artifacts"

mkdir -p -- "${run_root}" "${work}" "${prefix}" "${runtime}/bin" "${runtime}/lib" "${runtime}/plugins/sqldrivers" "${runtime}/plugins/tls" "${runtime}/licenses" "${artifacts}"
git clone --shared --no-checkout -- "${source_repo}" "${checkout}"
git -C "${checkout}" checkout --detach "${commit}"

snapshot_paths=(
  COPYING
  wildbuzzard/scripts/build-qbittorrent-runtime.sh
  wildbuzzard/scripts/generate-qbittorrent-runtime-provenance.py
  wildbuzzard/scripts/generate-torrent-document-sources.py
  wildbuzzard/browser/components/torrent
  wildbuzzard/third_party/bsd3/libtorrent
  wildbuzzard/third_party/gpl2/qbittorrent
  wildbuzzard/third_party/lgpl3/qt/source.lock.json
  wildbuzzard/upstreams.toml
)
if [[ "${include_working_tree}" == true ]]; then
  git -C "${source_repo}" diff --binary "${base_commit}" -- \
    "${snapshot_paths[@]}" >"${run_root}/working-tree.patch"
  if [[ -s "${run_root}/working-tree.patch" ]]; then
    git -C "${checkout}" apply --binary "${run_root}/working-tree.patch"
  fi
  while IFS= read -r -d '' path; do
    mkdir -p -- "${checkout}/$(dirname -- "${path}")"
    cp -a -- "${source_repo}/${path}" "${checkout}/${path}"
  done < <(
    git -C "${source_repo}" ls-files --others --exclude-standard -z -- \
      "${snapshot_paths[@]}"
  )
  git -C "${checkout}" add --all -- "${snapshot_paths[@]}"
  if ! git -C "${checkout}" diff --cached --quiet; then
    GIT_AUTHOR_DATE="@${source_date_epoch} +0000" \
      GIT_COMMITTER_DATE="@${source_date_epoch} +0000" \
      git -C "${checkout}" \
      -c user.name="openresearchtools" \
      -c user.email="229047507+openresearchtools@users.noreply.github.com" \
      commit -m "WildBuzzard qBittorrent runtime snapshot"
    commit="$(git -C "${checkout}" rev-parse HEAD)"
  fi
fi
short_commit="${commit:0:12}"

{
  echo "base_commit=${base_commit}"
  echo "build_commit=${commit}"
  echo "working_tree=${include_working_tree}"
  echo "source_date_epoch=${source_date_epoch}"
} >"${run_root}/build-manifest.txt"

qbt_source="${work}/qbittorrent"
libtorrent_source="${work}/libtorrent"
boost_source="${work}/boost"
cp -a -- "${checkout}/wildbuzzard/third_party/gpl2/qbittorrent/upstream" "${qbt_source}"
cp -a -- "${checkout}/wildbuzzard/third_party/bsd3/libtorrent/upstream" "${libtorrent_source}"
while IFS= read -r patch_name; do
  case "${patch_name}" in
    ""|\#*) continue ;;
  esac
  patch --batch --forward --fuzz=0 -d "${qbt_source}" -p1 < "${checkout}/wildbuzzard/third_party/gpl2/qbittorrent/patches/${patch_name}"
done < "${checkout}/wildbuzzard/third_party/gpl2/qbittorrent/patches/series"

python3 "${checkout}/wildbuzzard/scripts/generate-torrent-document-sources.py" \
  --source "${qbt_source}" \
  --check "${checkout}/wildbuzzard/browser/components/torrent/TorrentDocumentSources.sys.mjs"

assert_patch_absent() {
  local marker="$1"
  local file="$2"
  if grep -Fq -- "${marker}" "${qbt_source}/${file}"; then
    echo "Forbidden qBittorrent runtime integration remains in ${file}: ${marker}" >&2
    exit 1
  fi
}
assert_patch_present() {
  local marker="$1"
  local file="$2"
  if ! grep -Fq -- "${marker}" "${qbt_source}/${file}"; then
    echo "Required qBittorrent runtime integration is missing from ${file}: ${marker}" >&2
    exit 1
  fi
}
assert_patch_absent "src/searchengine/searchengine.qrc" "src/app/CMakeLists.txt"
assert_patch_absent "search/searchpluginmanager.cpp" "src/base/CMakeLists.txt"
assert_patch_absent "utils/foreignapps.cpp" "src/base/CMakeLists.txt"
assert_patch_absent "api/searchcontroller.cpp" "src/webui/CMakeLists.txt"
assert_patch_absent "SearchController" "src/webui/webapplication.cpp"
assert_patch_absent "SearchPluginManager" "src/webui/api/torrentscontroller.cpp"
assert_patch_absent 'u"downloader"_s' "src/webui/api/torrentscontroller.cpp"
assert_patch_absent "base/addtorrentmanager.h" "src/webui/api/torrentscontroller.cpp"
assert_patch_absent "addTorrentManager()->addTorrent" "src/webui/api/torrentscontroller.cpp"
assert_patch_absent "m_torrentSourceCache" "src/webui/api/torrentscontroller.cpp"
assert_patch_absent "m_torrentSourceCache" "src/webui/api/torrentscontroller.h"
assert_patch_absent "fetchMetadataAction" "src/webui/api/torrentscontroller.cpp"
assert_patch_absent "fetchMetadataAction" "src/webui/api/torrentscontroller.h"
assert_patch_absent 'u"fetchMetadata"_s' "src/webui/webapplication.h"
assert_patch_absent "base/net/downloadmanager.h" "src/webui/api/torrentscontroller.cpp"
assert_patch_absent "api/v2/torrents/fetchMetadata" "src/webui/www/private/scripts/addtorrent.js"
assert_patch_absent "saveMetadataAction" "src/webui/api/torrentscontroller.cpp"
assert_patch_absent "saveMetadataAction" "src/webui/api/torrentscontroller.h"
assert_patch_absent "api/v2/torrents/saveMetadata" "src/webui/www/private/addtorrent.html"
assert_patch_absent "private/scripts/search.js" "src/webui/www/webui.qrc"
assert_patch_absent "showSearchEngine" "src/webui/www/private/scripts/client.js"
assert_patch_absent "downloader" "src/webui/www/private/scripts/addtorrent.js"
assert_patch_absent "handleDownloadParam" "src/webui/www/private/scripts/client.js"
assert_patch_absent "#download=" "src/webui/www/private/scripts/client.js"
assert_patch_absent "requestedDownload" "src/webui/www/private/scripts/client.js"
assert_patch_absent "WildBuzzardTorrentDownloadRouted" "src/webui/www/private/scripts/client.js"
assert_patch_absent "title: title," "src/webui/www/private/scripts/client.js"
assert_patch_present "void TorrentsController::addAction()" "src/webui/api/torrentscontroller.cpp"
assert_patch_present "bool isCanonicalBTIHMagnet" "src/webui/api/torrentscontroller.cpp"
assert_patch_present "if (!isCanonicalBTIHMagnet(url))" "src/webui/api/torrentscontroller.cpp"
assert_patch_present "source.toUtf8().size() <= 8192" "src/webui/api/torrentscontroller.cpp"
assert_patch_present "xl=[0-9]{1,20}|so=[0-9,-]{1,256}" "src/webui/api/torrentscontroller.cpp"
assert_patch_present ")){0,16}" "src/webui/api/torrentscontroller.cpp"
assert_patch_absent "xs=" "src/webui/api/torrentscontroller.cpp"
assert_patch_absent "as=" "src/webui/api/torrentscontroller.cpp"
assert_patch_absent "ws=" "src/webui/api/torrentscontroller.cpp"
assert_patch_absent "mt=" "src/webui/api/torrentscontroller.cpp"
assert_patch_absent "kt=" "src/webui/api/torrentscontroller.cpp"
assert_patch_absent "&xt=" "src/webui/api/torrentscontroller.cpp"
assert_patch_absent "x.pe=" "src/webui/api/torrentscontroller.cpp"
canonical_btih_error="Only canonical BTIH magnet links are accepted in the \`urls\` field"
assert_patch_present "${canonical_btih_error}" "src/webui/api/torrentscontroller.cpp"
assert_patch_present 'params()[u"metadataId"_s].trimmed()' "src/webui/api/torrentscontroller.cpp"
assert_patch_present "TorrentDescriptor::load(it.value())" "src/webui/api/torrentscontroller.cpp"
assert_patch_present "MAX_CONTENT_SIZE = 64 * 1024 * 1024" "src/base/http/requestparser.h"
assert_patch_present '{{u"torrents"_s, u"add"_s}, Http::METHOD_POST}' "src/webui/webapplication.h"
assert_patch_present 'form action="api/v2/torrents/add"' "src/webui/www/private/addtorrent.html"
assert_patch_present 'name="metadataId" disabled' "src/webui/www/private/addtorrent.html"
assert_patch_present "title: window.qBittorrent.Misc.escapeHtml(String(title))" "src/webui/www/private/scripts/client.js"

mkdir -p -- "${boost_source}"
tar -xjf "${boost_archive}" --strip-components=1 -C "${boost_source}"

prefix_flags="-ffile-prefix-map=${run_root}=. -fdebug-prefix-map=${run_root}=. -fmacro-prefix-map=${run_root}=. -frandom-seed=${commit}"
cmake -S "${libtorrent_source}" -B "${work}/libtorrent-build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_CXX_FLAGS_RELEASE="-O3 -DNDEBUG ${prefix_flags}" \
  -DCMAKE_C_FLAGS_RELEASE="-O3 -DNDEBUG ${prefix_flags}" \
  -DCMAKE_INSTALL_PREFIX="${prefix}" \
  -DBOOST_ROOT="${boost_source}" \
  -DBoost_INCLUDE_DIR="${boost_source}" \
  -DBUILD_SHARED_LIBS=OFF \
  -Dbuild_examples=OFF \
  -Dbuild_tests=OFF \
  -Dbuild_tools=OFF \
  -Ddeprecated-functions=OFF \
  -Dpython-bindings=OFF \
  >"${run_root}/libtorrent-configure.log" 2>&1
cmake --build "${work}/libtorrent-build" --parallel "$(nproc)" >"${run_root}/libtorrent-build.log" 2>&1
cmake --install "${work}/libtorrent-build" >"${run_root}/libtorrent-install.log" 2>&1

cmake -S "${qbt_source}" -B "${work}/qbittorrent-build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_CXX_FLAGS_RELEASE="-O3 -DNDEBUG ${prefix_flags}" \
  -DCMAKE_INSTALL_PREFIX="${prefix}/qbittorrent" \
  -DBOOST_ROOT="${boost_source}" \
  -DBoost_INCLUDE_DIR="${boost_source}" \
  -DCMAKE_PREFIX_PATH="${qt_prefix}" \
  -DGUI=OFF \
  -DLibtorrentRasterbar_DIR="${prefix}/lib/cmake/LibtorrentRasterbar" \
  -DQT_LRELEASE_EXECUTABLE="${lrelease}" \
  -DSTACKTRACE=OFF \
  -DSYSTEMD=OFF \
  -DTESTING=OFF \
  -DWEBUI=ON \
  >"${run_root}/qbittorrent-configure.log" 2>&1
cmake --build "${work}/qbittorrent-build" --parallel "$(nproc)" >"${run_root}/qbittorrent-build.log" 2>&1
install -m 755 -- "${work}/qbittorrent-build/qbittorrent-nox" "${runtime}/bin/qbittorrent-nox"

copy_plugin() {
  local source="$1"
  local destination="$2"
  if [[ ! -f "${source}" ]]; then
    echo "Missing required Qt plugin: ${source}" >&2
    exit 1
  fi
  install -m 644 -- "${source}" "${destination}"
}
qt_plugins=(
  "${qt_plugin_root}/sqldrivers/libqsqlite.so"
  "${qt_plugin_root}/tls/libqcertonlybackend.so"
  "${qt_plugin_root}/tls/libqopensslbackend.so"
)
copy_plugin "${qt_plugins[0]}" "${runtime}/plugins/sqldrivers/libqsqlite.so"
copy_plugin "${qt_plugins[1]}" "${runtime}/plugins/tls/libqcertonlybackend.so"
copy_plugin "${qt_plugins[2]}" "${runtime}/plugins/tls/libqopensslbackend.so"

declare -A scanned=()
declare -A libraries=()
queue=("${runtime}/bin/qbittorrent-nox" "${runtime}/plugins/sqldrivers/libqsqlite.so" "${runtime}/plugins/tls/libqcertonlybackend.so" "${runtime}/plugins/tls/libqopensslbackend.so")
while ((${#queue[@]})); do
  binary="${queue[0]}"
  queue=("${queue[@]:1}")
  [[ -n "${scanned[${binary}]:-}" ]] && continue
  scanned["${binary}"]=1
  while read -r soname resolved; do
    [[ -z "${soname}" || -z "${resolved}" ]] && continue
    case "${soname}" in
      ld-linux-*.so.*|libc.so.*|libdl.so.*|libm.so.*|libpthread.so.*|libresolv.so.*|librt.so.*) continue ;;
    esac
    if [[ -z "${libraries[${soname}]:-}" ]]; then
      libraries["${soname}"]="${resolved}"
      install -m 644 -- "${resolved}" "${runtime}/lib/${soname}"
      queue+=("${runtime}/lib/${soname}")
    elif ! cmp -s -- "${libraries[${soname}]}" "${resolved}"; then
      echo "Conflicting runtime library resolution for ${soname}" >&2
      exit 1
    fi
  done < <(ldd "${binary}" | awk '/=> \/.* \(0x/{print $1, $3} /^\/[^(]+ \(0x/{print $1, $1}')
done

if strings -a "${runtime}/bin/qbittorrent-nox" | grep -Fq "${run_root}"; then
  echo "qBittorrent binary leaks its build root" >&2
  exit 1
fi
for marker in "SearchPluginManager" "nova2.py" "nova2dl.py" "api/v2/search" \
    "fetchMetadataAction" "api/v2/torrents/fetchMetadata" "saveMetadataAction" \
    "handleDownloadParam" "#download=" "requestedDownload" \
    "WildBuzzardTorrentDownloadRouted"; do
  if grep -aFq -- "${marker}" "${runtime}/bin/qbittorrent-nox"; then
    echo "qBittorrent binary contains forbidden integration marker: ${marker}" >&2
    exit 1
  fi
done
if ! grep -aFq -- "${canonical_btih_error}" "${runtime}/bin/qbittorrent-nox"; then
  echo "qBittorrent binary is missing the magnet-only add boundary" >&2
  exit 1
fi

cp -- "${checkout}/wildbuzzard/third_party/gpl2/qbittorrent/upstream/COPYING" "${runtime}/licenses/qbittorrent-COPYING.txt"
cp -- "${checkout}/wildbuzzard/third_party/bsd3/libtorrent/upstream/COPYING" "${runtime}/licenses/libtorrent-BSD-3-Clause.txt"
cp -- "${boost_source}/LICENSE_1_0.txt" "${runtime}/licenses/boost-BSL-1.0.txt"
for qt_license in LGPL-3.0-only GPL-2.0-only GPL-3.0-only; do
  qt_license_member="$(
    tar -tf "${qt_source_archive}" |
      awk -v suffix="/LICENSES/${qt_license}.txt" '$0 ~ suffix "$" { print }'
  )"
  if [[ -z "${qt_license_member}" || "${qt_license_member}" == *$'\n'* ]]; then
    echo "Qt source archive lacks one exact ${qt_license} license file" >&2
    exit 1
  fi
  tar -xOf "${qt_source_archive}" "${qt_license_member}" >"${runtime}/licenses/qt-${qt_license}.txt"
done
install -m 644 -- \
  "${checkout}/wildbuzzard/third_party/lgpl3/qt/source.lock.json" \
  "${runtime}/licenses/qt-source.lock.json"

source_name="wildbuzzard-qbittorrent-runtime-${short_commit}-source.tar.xz"
source_path="${artifacts}/${source_name}"
git -C "${checkout}" archive --format=tar --prefix="wildbuzzard-qbittorrent-runtime-${commit}/" "${commit}" -- \
  COPYING \
  wildbuzzard/scripts/build-qbittorrent-runtime.sh \
  wildbuzzard/scripts/generate-qbittorrent-runtime-provenance.py \
  wildbuzzard/scripts/generate-torrent-document-sources.py \
  wildbuzzard/browser/components/torrent/TorrentDocumentSources.sys.mjs \
  wildbuzzard/third_party/bsd3/libtorrent \
  wildbuzzard/third_party/gpl2/qbittorrent \
  wildbuzzard/third_party/lgpl3/qt/source.lock.json \
  wildbuzzard/upstreams.toml | xz --threads=1 --check=crc64 -9e >"${source_path}"

component_inputs="${run_root}/component-inputs.tsv"
: >"${component_inputs}"
for plugin in "${qt_plugins[@]}"; do
  relative="plugins/${plugin#"${qt_plugin_root}/"}"
  printf '%s\t%s\t%s\t%s\n' "${relative}" "$(basename -- "${plugin}")" "${plugin}" "qt" >>"${component_inputs}"
done
for soname in $(printf '%s\n' "${!libraries[@]}" | LC_ALL=C sort); do
  source_library="${libraries[${soname}]}"
  if [[ "${source_library}/" == "${qt_prefix}/"* ]]; then
    component_kind="qt"
  else
    component_kind="debian"
  fi
  printf '%s\t%s\t%s\t%s\n' "lib/${soname}" "${soname}" "${source_library}" "${component_kind}" >>"${component_inputs}"
done

python3 "${checkout}/wildbuzzard/scripts/generate-qbittorrent-runtime-provenance.py" \
  --runtime "${runtime}" \
  --artifacts "${artifacts}" \
  --component-inputs "${component_inputs}" \
  --core-source-archive "${source_path}" \
  --qt-source-archive "${qt_source_archive}" \
  --boost-source-archive "${boost_archive}" \
  --commit "${commit}" \
  --source-date-epoch "${source_date_epoch}" \
  --lrelease-sha256 "${qt_lrelease_sha256}" \
  >"${run_root}/qbittorrent-provenance.json"

python3 - "${runtime}" "${commit}" "${source_date_epoch}" <<'PY'
import hashlib
import json
import os
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
commit = sys.argv[2]
epoch = int(sys.argv[3])
manifest_name = "wildbuzzard-qbittorrent-runtime.json"
files = []
for path in sorted(root.rglob("*")):
    if path.is_symlink():
        raise SystemExit(f"runtime symlink is forbidden: {path}")
    if not path.is_file() or path.name == manifest_name:
        continue
    relative = path.relative_to(root).as_posix()
    executable = relative == "bin/qbittorrent-nox"
    path.chmod(0o755 if executable else 0o644)
    data = path.read_bytes()
    files.append({
        "path": relative,
        "size": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "executable": executable,
    })
payload = "".join(
    f"{entry['path']}\0{entry['size']}\0{entry['sha256']}\0{1 if entry['executable'] else 0}\n"
    for entry in files
).encode()
source_offer = json.loads(
    (root / "share" / "doc" / "buzzard-torrent" / "source-offer.json").read_text(
        encoding="utf-8"
    )
)
manifest = {
    "schema": 2,
    "component": "wildbuzzard-qbittorrent-runtime",
    "version": "5.2.3",
    "protocolVersion": 1,
    "wildbuzzardCommit": commit,
    "qbittorrentCommit": "0b63c3d17373f6132ea211c9dcd4241284ccdfaf",
    "libtorrentCommit": "aab2a10e2f60d9eac78e885a696736d043527794",
    "boostVersion": "1.88.0",
    "boostArchiveSha256": "46d9d2c06637b219270877c9e16155cbd015b6dc84349af064c088e9b5b12f7b",
    "qtVersion": "6.10.2",
    "qtSourceArchiveSha256": "aeb78d29291a2b5fd53cb55950f8f5065b4978c25fb1d77f627d695ab9adf21e",
    "platform": "linux-x64",
    "architecture": "x86_64",
    "externalSourceArtifacts": source_offer["correspondingSource"]["externalArtifacts"],
    "payloadSha256": hashlib.sha256(payload).hexdigest(),
    "files": files,
}
(root / manifest_name).write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
for path in root.rglob("*"):
    os.utime(path, (epoch, epoch), follow_symlinks=False)
PY

runtime_zip="${artifacts}/wildbuzzard-qbittorrent-runtime-linux-x64-${short_commit}.zip"
archive_list="${run_root}/runtime-files.txt"
(
  cd -- "${runtime}"
  LC_ALL=C find . -type f -printf '%P\n' | LC_ALL=C sort >"${archive_list}"
  TZ=UTC zip -X -q -9 "${runtime_zip}" -@ <"${archive_list}"
)
sha256sum "${runtime_zip}" >"${runtime_zip}.sha256"

boost_source_artifact="${artifacts}/wildbuzzard-qbittorrent-boost-1.88.0-source.tar.bz2"
core_source_artifact="${artifacts}/${source_name}"
qt_source_artifact="${artifacts}/wildbuzzard-qbittorrent-qtbase-6.10.2-source.tar.xz"
system_source_artifact="${artifacts}/wildbuzzard-qbittorrent-ubuntu-24.04-system-sources-${short_commit}.tar.xz"
for source_artifact in "${core_source_artifact}" "${boost_source_artifact}" "${qt_source_artifact}" "${system_source_artifact}"; do
  if [[ ! -f "${source_artifact}" || -L "${source_artifact}" ]]; then
    echo "Missing qBittorrent corresponding-source artifact: ${source_artifact}" >&2
    exit 1
  fi
done

{
  echo "wildbuzzard_commit=${commit}"
  echo "base_commit=${base_commit}"
  echo "working_tree=${include_working_tree}"
  echo "source_date_epoch=${source_date_epoch}"
  echo "qbittorrent_version=5.2.3"
  echo "libtorrent_version=2.0.14"
  echo "runtime_zip=${runtime_zip}"
  echo "runtime_sha256=$(sha256sum "${runtime_zip}" | awk '{print $1}')"
  echo "runtime_size=$(stat -c %s "${runtime_zip}")"
  echo "core_source=${core_source_artifact}"
  echo "core_source_sha256=$(sha256sum "${core_source_artifact}" | awk '{print $1}')"
  echo "boost_source=${boost_source_artifact}"
  echo "boost_source_sha256=$(sha256sum "${boost_source_artifact}" | awk '{print $1}')"
  echo "qt_source=${qt_source_artifact}"
  echo "qt_source_sha256=$(sha256sum "${qt_source_artifact}" | awk '{print $1}')"
  echo "system_source=${system_source_artifact}"
  echo "system_source_sha256=$(sha256sum "${system_source_artifact}" | awk '{print $1}')"
} >"${run_root}/build-manifest.txt"

echo "qBittorrent runtime built from ${commit}"
echo "Runtime: ${runtime_zip}"
echo "Logs: ${run_root}"
