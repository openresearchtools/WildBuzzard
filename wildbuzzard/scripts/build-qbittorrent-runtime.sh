#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

set -Eeuo pipefail
umask 022

usage() {
  echo "Usage: $0 --boost-archive FILE [options]"
  echo
  echo "Options:"
  echo "  --boost-archive FILE  pinned Boost 1.88.0 source archive"
  echo "  --build-root DIR      external build root"
  echo "  --lrelease FILE       Qt 6 lrelease executable"
  echo "  --ref REF             committed WildBuzzard ref (default: HEAD)"
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source_repo="$(cd -- "${script_dir}/../.." && pwd -P)"
build_root="$(dirname -- "${source_repo}")/wildbuzzard-qbittorrent-builds"
build_ref="HEAD"
boost_archive=""
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
    --lrelease)
      lrelease="${2:?--lrelease requires a file}"
      shift 2
      ;;
    --ref)
      build_ref="${2:?--ref requires a ref}"
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

if [[ -z "${boost_archive}" || ! -f "${boost_archive}" ]]; then
  echo "--boost-archive must name the pinned Boost source archive" >&2
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

commit="$(git -C "${source_repo}" rev-parse --verify "${build_ref}^{commit}")"
short_commit="${commit:0:12}"
source_date_epoch="$(git -C "${source_repo}" show -s --format=%ct "${commit}")"
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

qbt_source="${work}/qbittorrent"
libtorrent_source="${work}/libtorrent"
boost_source="${work}/boost"
cp -a -- "${checkout}/wildbuzzard/third_party/gpl2/qbittorrent/upstream" "${qbt_source}"
cp -a -- "${checkout}/wildbuzzard/third_party/bsd3/libtorrent/upstream" "${libtorrent_source}"
patch --batch --forward --fuzz=0 -d "${qbt_source}" -p1 < "${checkout}/wildbuzzard/third_party/gpl2/qbittorrent/patches/0001-add-private-wildbuzzard-runtime.patch"
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

cp -- "${checkout}/wildbuzzard/third_party/gpl2/qbittorrent/upstream/COPYING" "${runtime}/licenses/qbittorrent-GPL-2.0.txt"
cp -- "${checkout}/wildbuzzard/third_party/bsd3/libtorrent/upstream/COPYING" "${runtime}/licenses/libtorrent-BSD-3-Clause.txt"
cp -- "${boost_source}/LICENSE_1_0.txt" "${runtime}/licenses/boost-BSL-1.0.txt"
cp -- /usr/share/common-licenses/LGPL-3 "${runtime}/licenses/qt-LGPL-3.0.txt"
cp -- /usr/share/common-licenses/GPL-2 "${runtime}/licenses/qt-GPL-2.0.txt"
cp -- /usr/share/common-licenses/GPL-3 "${runtime}/licenses/qt-GPL-3.0.txt"
package_owner() {
  local target="$1"
  local owner
  owner="$(dpkg-query -S "${target}" 2>/dev/null | head -n 1 | sed 's/: \/.*//' || true)"
  if [[ -z "${owner}" && "${target}" == /lib/* ]]; then
    owner="$(dpkg-query -S "/usr${target}" 2>/dev/null | head -n 1 | sed 's/: \/.*//' || true)"
  fi
  owner="${owner%%:*}"
  printf '%s' "${owner}"
}

declare -A system_packages=()
for system_input in "${libraries[@]}" "${qt_plugins[@]}"; do
  package="$(package_owner "${system_input}")"
  [[ -n "${package}" ]] && system_packages["${package}"]=1
done
for package in $(printf '%s\n' "${!system_packages[@]}" | LC_ALL=C sort); do
  copyright="/usr/share/doc/${package}/copyright"
  [[ -f "${copyright}" ]] && install -m 644 -- "${copyright}" "${runtime}/licenses/system-${package}.copyright"
done

source_name="wildbuzzard-qbittorrent-runtime-${short_commit}-source.tar.xz"
source_path="${runtime}/share/wildbuzzard/qbittorrent/${source_name}"
mkdir -p -- "$(dirname -- "${source_path}")"
git -C "${checkout}" archive --format=tar --prefix="wildbuzzard-qbittorrent-runtime-${commit}/" "${commit}" -- \
  COPYING \
  wildbuzzard/scripts/build-qbittorrent-runtime.sh \
  wildbuzzard/third_party/bsd3/libtorrent \
  wildbuzzard/third_party/gpl2/qbittorrent \
  wildbuzzard/upstreams.toml | xz --threads=1 --check=crc64 -9e >"${source_path}"

component_inputs="${run_root}/component-inputs.tsv"
: >"${component_inputs}"
for plugin in "${qt_plugins[@]}"; do
  relative="plugins/${plugin#"${qt_plugin_root}/"}"
  printf '%s\t%s\t%s\t%s\n' "${relative}" "$(basename -- "${plugin}")" "Qt" "6.10.2" >>"${component_inputs}"
done
for soname in $(printf '%s\n' "${!libraries[@]}" | LC_ALL=C sort); do
  source_library="${libraries[${soname}]}"
  if [[ "${source_library}/" == "${qt_prefix}/"* ]]; then
    component="Qt"
    component_version="6.10.2"
  else
    owner="$(package_owner "${source_library}")"
    component="${owner:-system-library}"
    component_version="$(dpkg-query -W -f='${Version}' "${owner}" 2>/dev/null || echo unknown)"
  fi
  printf '%s\t%s\t%s\t%s\n' "lib/${soname}" "${soname}" "${component}" "${component_version}" >>"${component_inputs}"
done

python3 - "${runtime}" "${component_inputs}" "${commit}" "${source_date_epoch}" "${qt_lrelease_sha256}" <<'PY'
import datetime
import hashlib
import json
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1])
inputs = pathlib.Path(sys.argv[2])
commit = sys.argv[3]
epoch = int(sys.argv[4])
lrelease_sha256 = sys.argv[5]

components = []
for line in inputs.read_text(encoding="utf-8").splitlines():
    relative, soname, component, version = line.split("\t")
    target = root / relative
    components.append(
        {
            "path": relative,
            "soname": soname,
            "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
            "size": target.stat().st_size,
            "component": component,
            "componentVersion": version,
        }
    )
components.sort(key=lambda entry: entry["path"])

inventory = {
    "schema": 1,
    "component": "buzzard-torrent-runtime",
    "platform": "linux-x64",
    "qt": {
        "version": "6.10.2",
        "lreleaseSha256": lrelease_sha256,
        "plugins": [entry for entry in components if entry["path"].startswith("plugins/")],
    },
    "runtimeLibraries": [entry for entry in components if entry["path"].startswith("lib/")],
}
inventory_path = root / "share" / "doc" / "buzzard-torrent" / "runtime-component-inventory.json"
inventory_path.parent.mkdir(parents=True, exist_ok=True)
inventory_path.write_text(json.dumps(inventory, indent=2, sort_keys=True) + "\n", encoding="utf-8")

def spdx_id(name):
    return "SPDXRef-Package-" + re.sub(r"[^A-Za-z0-9.-]", "-", name)

packages = [
    {
        "name": "qBittorrent",
        "SPDXID": "SPDXRef-Package-qBittorrent",
        "versionInfo": "5.2.3",
        "downloadLocation": "git+https://github.com/qbittorrent/qBittorrent.git@0b63c3d17373f6132ea211c9dcd4241284ccdfaf",
        "filesAnalyzed": False,
        "licenseConcluded": "GPL-3.0-or-later",
        "licenseDeclared": "GPL-3.0-or-later",
        "copyrightText": "NOASSERTION",
    },
    {
        "name": "libtorrent",
        "SPDXID": "SPDXRef-Package-libtorrent",
        "versionInfo": "2.0.14",
        "downloadLocation": "git+https://github.com/arvidn/libtorrent.git@aab2a10e2f60d9eac78e885a696736d043527794",
        "filesAnalyzed": False,
        "licenseConcluded": "BSD-3-Clause",
        "licenseDeclared": "BSD-3-Clause",
        "copyrightText": "NOASSERTION",
    },
    {
        "name": "Boost",
        "SPDXID": "SPDXRef-Package-Boost",
        "versionInfo": "1.88.0",
        "downloadLocation": "https://archives.boost.io/release/1.88.0/source/boost_1_88_0.tar.bz2",
        "filesAnalyzed": False,
        "licenseConcluded": "BSL-1.0",
        "licenseDeclared": "BSL-1.0",
        "copyrightText": "NOASSERTION",
        "checksums": [{"algorithm": "SHA256", "checksumValue": "46d9d2c06637b219270877c9e16155cbd015b6dc84349af064c088e9b5b12f7b"}],
    },
    {
        "name": "Qt",
        "SPDXID": "SPDXRef-Package-Qt",
        "versionInfo": "6.10.2",
        "downloadLocation": "https://download.qt.io/official_releases/qt/6.10/6.10.2/",
        "filesAnalyzed": False,
        "licenseConcluded": "NOASSERTION",
        "licenseDeclared": "LGPL-3.0-only OR GPL-2.0-only OR GPL-3.0-only",
        "copyrightText": "Copyright (C) The Qt Company Ltd. and other contributors",
    },
]
seen = {package["name"] for package in packages}
for component in sorted({entry["component"] for entry in components} - seen):
    version = next(entry["componentVersion"] for entry in components if entry["component"] == component)
    packages.append(
        {
            "name": component,
            "SPDXID": spdx_id(component),
            "versionInfo": version,
            "downloadLocation": "NOASSERTION",
            "filesAnalyzed": False,
            "licenseConcluded": "NOASSERTION",
            "licenseDeclared": "NOASSERTION",
            "copyrightText": "NOASSERTION",
        }
    )

created = datetime.datetime.fromtimestamp(epoch, datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
sbom = {
    "spdxVersion": "SPDX-2.3",
    "dataLicense": "CC0-1.0",
    "SPDXID": "SPDXRef-DOCUMENT",
    "name": f"buzzard-torrent-runtime-{commit[:12]}",
    "documentNamespace": f"https://github.com/openresearchtools/wildbuzzard/sbom/buzzard-torrent/{commit}",
    "creationInfo": {
        "created": created,
        "creators": ["Organization: Open Research Tools", "Tool: build-qbittorrent-runtime.sh"],
    },
    "packages": packages,
    "relationships": [
        {"spdxElementId": "SPDXRef-DOCUMENT", "relationshipType": "DESCRIBES", "relatedSpdxElement": package["SPDXID"]}
        for package in packages
    ],
}
sbom_path = root / "share" / "doc" / "buzzard-torrent" / "sbom.spdx.json"
sbom_path.write_text(json.dumps(sbom, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY

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
source = next(entry for entry in files if entry["path"].endswith("-source.tar.xz"))
manifest = {
    "schema": 1,
    "component": "wildbuzzard-qbittorrent-runtime",
    "version": "5.2.3",
    "protocolVersion": 1,
    "wildbuzzardCommit": commit,
    "qbittorrentCommit": "0b63c3d17373f6132ea211c9dcd4241284ccdfaf",
    "libtorrentCommit": "aab2a10e2f60d9eac78e885a696736d043527794",
    "boostVersion": "1.88.0",
    "boostArchiveSha256": "46d9d2c06637b219270877c9e16155cbd015b6dc84349af064c088e9b5b12f7b",
    "platform": "linux-x64",
    "architecture": "x86_64",
    "correspondingSource": source["path"],
    "sourceSha256": source["sha256"],
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

{
  echo "wildbuzzard_commit=${commit}"
  echo "qbittorrent_version=5.2.3"
  echo "libtorrent_version=2.0.14"
  echo "runtime_zip=${runtime_zip}"
  echo "runtime_sha256=$(sha256sum "${runtime_zip}" | awk '{print $1}')"
  echo "runtime_size=$(stat -c %s "${runtime_zip}")"
} >"${run_root}/build-manifest.txt"

echo "qBittorrent runtime built from ${commit}"
echo "Runtime: ${runtime_zip}"
echo "Logs: ${run_root}"
