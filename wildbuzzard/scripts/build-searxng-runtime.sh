#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ROOT_DIR=$(cd -- "$SCRIPT_DIR/../.." && pwd)
SOURCE_ROOT="$ROOT_DIR/wildbuzzard/third_party/agpl/searxng"
MANAGED_ROOT="$ROOT_DIR/wildbuzzard/managed-services/searxng"
RUNTIME_LOCK="$SOURCE_ROOT/runtime-requirements.lock"
BUILD_LOCK="$SOURCE_ROOT/build-tools.lock"
POLICY="$SOURCE_ROOT/engine-policy.json"
SEARXNG_ARCHIVE=searxng-b023a28bab8839dba9eac96e9a51cc91bbd0a267.tar.gz
SEARXNG_URL=https://codeload.github.com/searxng/searxng/tar.gz/b023a28bab8839dba9eac96e9a51cc91bbd0a267
SEARXNG_SHA256=f5ab68baa420f26ac0d6b3fed1a8e5754bbe1fd31357c41271449980d3df779e
SEARXNG_SIZE=5984564
PYTHON_VERSION=3.14.6
PYTHON_ARCHIVE="Python-$PYTHON_VERSION.tar.xz"
PYTHON_URL="https://www.python.org/ftp/python/$PYTHON_VERSION/$PYTHON_ARCHIVE"
PYTHON_SHA256=143b1dddefaec3bd2e21e3b839b34a2b7fb9842272883c576420d605e9f30c63
SOURCE_DATE_EPOCH=1786030997
RUNTIME_VERSION=2026.8.6+b023a28ba
OUTPUT_DIR=
CACHE_DIR=
JOBS=
OFFLINE=0
KEEP_WORK=0

while (($#)); do
  case "$1" in
    --output)
      shift
      OUTPUT_DIR=${1:?--output needs a directory}
      ;;
    --cache)
      shift
      CACHE_DIR=${1:?--cache needs a directory}
      ;;
    --jobs)
      shift
      JOBS=${1:?--jobs needs a count}
      ;;
    --offline)
      OFFLINE=1
      ;;
    --keep-work)
      KEEP_WORK=1
      ;;
    *)
      echo "usage: $0 --output DIR [--cache DIR] [--jobs N] [--offline] [--keep-work]" >&2
      exit 2
      ;;
  esac
  shift
done

[[ -n "$OUTPUT_DIR" ]]
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]]
OUTPUT_DIR=$(realpath -m -- "$OUTPUT_DIR")
case "$OUTPUT_DIR/" in
  "$ROOT_DIR/"*)
    echo "SearXNG output must be outside the source checkout" >&2
    exit 2
    ;;
esac
CACHE_DIR=$(realpath -m -- "${CACHE_DIR:-$OUTPUT_DIR/cache}")
JOBS=${JOBS:-$(getconf _NPROCESSORS_ONLN)}
mkdir -p -- "$OUTPUT_DIR" "$CACHE_DIR/sources" "$CACHE_DIR/build-tools"
WORK_DIR=$(mktemp -d "$OUTPUT_DIR/.searxng-build.XXXXXX")
if [[ "$KEEP_WORK" == 0 ]]; then
  trap 'rm -rf -- "$WORK_DIR"' EXIT
fi

[[ $(awk -F '\t' '$1 !~ /^#/ && NF == 5 { count++ } END { print count + 0 }' "$RUNTIME_LOCK") == 41 ]]

download_locked() {
  local destination=$1
  local expected=$2
  local url=$3
  if [[ ! -f "$destination" ]]; then
    if [[ "$OFFLINE" == 1 ]]; then
      echo "missing offline input: $destination" >&2
      exit 1
    fi
    curl --fail --location --proto '=https' --tlsv1.2 --output "$destination.part" "$url"
    mv -- "$destination.part" "$destination"
  fi
  echo "$expected  $destination" | sha256sum --check --strict
}

download_lock() {
  local lock=$1
  local destination=$2
  while IFS=$'\t' read -r _name _version filename digest url; do
    [[ -n "$url" && ${url:0:1} != '#' ]] || continue
    download_locked "$destination/$filename" "$digest" "$url"
  done < "$lock"
}

download_locked "$CACHE_DIR/sources/$SEARXNG_ARCHIVE" "$SEARXNG_SHA256" "$SEARXNG_URL"
[[ $(stat -c '%s' "$CACHE_DIR/sources/$SEARXNG_ARCHIVE") == "$SEARXNG_SIZE" ]]
"$SCRIPT_DIR/import-searxng-source.sh" \
  --check \
  --archive "$CACHE_DIR/sources/$SEARXNG_ARCHIVE"
download_locked "$CACHE_DIR/sources/$PYTHON_ARCHIVE" "$PYTHON_SHA256" "$PYTHON_URL"
download_lock "$RUNTIME_LOCK" "$CACHE_DIR/sources"
download_lock "$BUILD_LOCK" "$CACHE_DIR/build-tools"

tar -xJf "$CACHE_DIR/sources/$PYTHON_ARCHIVE" -C "$WORK_DIR"
PYTHON_SOURCE="$WORK_DIR/Python-$PYTHON_VERSION"
PYTHON_PREFIX="$WORK_DIR/python-prefix"
PYTHON_BUILD="$WORK_DIR/python-build"
mkdir -p -- "$PYTHON_BUILD"
(
  cd -- "$PYTHON_BUILD"
  CFLAGS="-O2 -ffile-prefix-map=$WORK_DIR=/usr/src/wildbuzzard-searxng" \
  LDFLAGS='-Wl,-rpath,\$$ORIGIN/../lib' \
    "$PYTHON_SOURCE/configure" \
      --prefix="$PYTHON_PREFIX" \
      --enable-shared \
      --with-ensurepip=no \
      --without-static-libpython
  make -j "$JOBS"
  make install
)
readelf -d "$PYTHON_PREFIX/bin/python3" > "$WORK_DIR/python-runpath.txt"
grep -F '$ORIGIN/../lib' "$WORK_DIR/python-runpath.txt" >/dev/null

PYTHON="$PYTHON_PREFIX/bin/python3"
BUILD_VENV="$WORK_DIR/build-venv"
"$PYTHON" -m venv "$BUILD_VENV"
WHEELHOUSE="$WORK_DIR/wheels"
mkdir -p -- "$WHEELHOUSE"

while IFS=$'\t' read -r name version filename _digest _url; do
  [[ -n "$filename" && ${filename:0:1} != '#' ]] || continue
  PIP_NO_INDEX=1 \
  PIP_FIND_LINKS="$CACHE_DIR/build-tools" \
  SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH \
  CARGO_NET_GIT_FETCH_WITH_CLI=false \
    "$BUILD_VENV/bin/python" -m pip wheel \
      --disable-pip-version-check \
      --no-deps \
      --wheel-dir "$WHEELHOUSE" \
      "$CACHE_DIR/sources/$filename"
  normalized_name=$(printf '%s' "$name" | tr '[:upper:]-' '[:lower:]_')
  compgen -G "$WHEELHOUSE/$normalized_name-$version-*.whl" >/dev/null
done < "$RUNTIME_LOCK"

PIP_NO_INDEX=1 PIP_FIND_LINKS="$CACHE_DIR/build-tools" \
  "$BUILD_VENV/bin/python" -m pip install \
    --disable-pip-version-check \
    setuptools==84.0.0 \
    wheel==0.47.0
"$BUILD_VENV/bin/python" -m pip install \
  --disable-pip-version-check \
  --no-index \
  --no-deps \
  "$WHEELHOUSE"/*.whl

SEARXNG_BUILD_SOURCE="$WORK_DIR/searxng-source"
cp -a -- "$SOURCE_ROOT/upstream" "$SEARXNG_BUILD_SOURCE"
cat > "$SEARXNG_BUILD_SOURCE/searx/version_frozen.py" <<'EOF'
# SPDX-License-Identifier: AGPL-3.0-or-later
# pylint: disable=missing-module-docstring
VERSION_STRING = "2026.8.6+b023a28ba"
VERSION_TAG = "2026.8.6+b023a28ba"
DOCKER_TAG = "2026.8.6-b023a28ba"
GIT_URL = "https://github.com/searxng/searxng"
GIT_BRANCH = "b023a28bab8839dba9eac96e9a51cc91bbd0a267"
EOF
PIP_NO_INDEX=1 \
PIP_FIND_LINKS="$CACHE_DIR/build-tools" \
SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH \
  "$BUILD_VENV/bin/python" -m pip wheel \
    --disable-pip-version-check \
    --no-build-isolation \
    --no-deps \
    --wheel-dir "$WHEELHOUSE" \
    "$SEARXNG_BUILD_SOURCE"

while IFS=$'\t' read -r name version _filename _digest _url; do
  [[ -n "$version" && ${name:0:1} != '#' ]] || continue
  wheel=$(find "$WHEELHOUSE" -maxdepth 1 -type f -iname "${name//-/_}-$version-*.whl" -print -quit)
  [[ -n "$wheel" ]]
  "$BUILD_VENV/bin/python" -m pip install \
    --disable-pip-version-check \
    --ignore-installed \
    --no-index \
    --no-deps \
    --prefix "$PYTHON_PREFIX" \
    "$wheel"
done < "$RUNTIME_LOCK"
SEARXNG_WHEEL=$(find "$WHEELHOUSE" -maxdepth 1 -type f -name 'searxng-*.whl' -print -quit)
[[ -n "$SEARXNG_WHEEL" ]]
"$BUILD_VENV/bin/python" -m pip install \
  --disable-pip-version-check \
  --ignore-installed \
  --no-index \
  --no-deps \
  --prefix "$PYTHON_PREFIX" \
  "$SEARXNG_WHEEL"

RUNTIME_STAGE="$WORK_DIR/runtime-stage"
mkdir -p -- "$RUNTIME_STAGE/python" "$RUNTIME_STAGE/libexec" "$RUNTIME_STAGE/share/wildbuzzard/searxng"
cp -aL -- "$PYTHON_PREFIX/." "$RUNTIME_STAGE/python/"
find "$RUNTIME_STAGE/python/bin" -maxdepth 1 -type f -name 'pip*' -delete
find "$RUNTIME_STAGE/python/lib/python3.14/site-packages" -maxdepth 1 \
  \( -name pip -o -name 'pip-*.dist-info' \) -exec rm -rf -- {} +
if [[ -d "$RUNTIME_STAGE/python/lib/python3.14/test" ]]; then
  find "$RUNTIME_STAGE/python/lib/python3.14/test" -depth -delete
fi
cp -- "$MANAGED_ROOT/searxng_service.py" "$RUNTIME_STAGE/libexec/searxng_service.py"
cp -- "$POLICY" "$RUNTIME_STAGE/share/wildbuzzard/searxng/engine-policy.json"
cp -- "$SOURCE_ROOT/LICENSE" "$RUNTIME_STAGE/share/wildbuzzard/searxng/LICENSE"
cp -- "$SOURCE_ROOT/UPSTREAM.toml" "$RUNTIME_STAGE/share/wildbuzzard/searxng/UPSTREAM.toml"
cp -- "$RUNTIME_LOCK" "$RUNTIME_STAGE/share/wildbuzzard/searxng/runtime-requirements.lock"

RUNTIME_LOCK=$RUNTIME_LOCK \
SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH \
SBOM="$RUNTIME_STAGE/share/wildbuzzard/searxng/sbom.cdx.json" \
  "$PYTHON" - <<'PY'
import hashlib
import json
import os
from pathlib import Path

components = [
    {
        "type": "application",
        "name": "SearXNG",
        "version": "2026.8.6+b023a28ba",
        "licenses": [{"license": {"id": "AGPL-3.0-or-later"}}],
        "purl": "pkg:github/searxng/searxng@b023a28bab8839dba9eac96e9a51cc91bbd0a267",
        "hashes": [
            {
                "alg": "SHA-256",
                "content": "f5ab68baa420f26ac0d6b3fed1a8e5754bbe1fd31357c41271449980d3df779e",
            }
        ],
    },
    {
        "type": "framework",
        "name": "CPython",
        "version": "3.14.6",
        "purl": "pkg:generic/cpython@3.14.6",
        "hashes": [
            {
                "alg": "SHA-256",
                "content": "143b1dddefaec3bd2e21e3b839b34a2b7fb9842272883c576420d605e9f30c63",
            }
        ],
    },
]
for line in Path(os.environ["RUNTIME_LOCK"]).read_text(encoding="utf-8").splitlines():
    if not line or line.startswith("#"):
        continue
    name, version, filename, digest, url = line.split("\t")
    components.append(
        {
            "type": "library",
            "name": name,
            "version": version,
            "purl": f"pkg:pypi/{name.lower().replace('_', '-')}@{version}",
            "hashes": [{"alg": "SHA-256", "content": digest}],
            "externalReferences": [{"type": "distribution", "url": url}],
            "properties": [
                {"name": "wildbuzzard:source-filename", "value": filename}
            ],
        }
    )
serial_material = "\n".join(
    f"{item['name']}@{item['version']}" for item in components
).encode()
serial = hashlib.sha256(serial_material).hexdigest()
sbom = {
    "bomFormat": "CycloneDX",
    "specVersion": "1.6",
    "serialNumber": (
        f"urn:uuid:{serial[:8]}-{serial[8:12]}-{serial[12:16]}-"
        f"{serial[16:20]}-{serial[20:32]}"
    ),
    "version": 1,
    "metadata": {
        "timestamp": "2026-08-06T15:43:17Z",
        "component": components[0],
        "properties": [
            {
                "name": "wildbuzzard:source-date-epoch",
                "value": os.environ["SOURCE_DATE_EPOCH"],
            }
        ],
    },
    "components": components[1:],
}
Path(os.environ["SBOM"]).write_text(
    json.dumps(sbom, sort_keys=True, separators=(",", ":")) + "\n",
    encoding="utf-8",
)
PY

mkdir -p -- "$RUNTIME_STAGE/bin"
cat > "$RUNTIME_STAGE/bin/searxng-service" <<'EOF'
#!/bin/sh
set -eu
runtime_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
LD_LIBRARY_PATH="$runtime_root/python/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export LD_LIBRARY_PATH
exec "$runtime_root/python/bin/python3" -I -B "$runtime_root/libexec/searxng_service.py" --runtime-root "$runtime_root" "$@"
EOF
chmod 755 "$RUNTIME_STAGE/bin/searxng-service"

while IFS= read -r dependency; do
  case "$(basename -- "$dependency")" in
    ld-linux-*|libc.so.*|libdl.so.*|libm.so.*|libpthread.so.*|libpython*.so*|librt.so.*)
      continue
      ;;
  esac
  target="$RUNTIME_STAGE/python/lib/$(basename -- "$dependency")"
  if [[ -e "$target" ]]; then
    [[ $(sha256sum "$target" | cut -d' ' -f1) == $(sha256sum "$dependency" | cut -d' ' -f1) ]]
  else
    cp -L -- "$dependency" "$target"
  fi
done < <(
  while IFS= read -r -d '' binary; do
    ldd "$binary" 2>/dev/null || true
  done < <(
    find "$RUNTIME_STAGE/python" -type f \
      \( -perm -0100 -o -name '*.so' -o -name '*.so.*' \) -print0
  ) |
    sed -n 's/^[[:space:]]*[^ ]*[[:space:]]*=>[[:space:]]*\(\/[^ ]*\).*/\1/p; s/^[[:space:]]*\(\/[^ ]*\)[[:space:]].*/\1/p' |
    LC_ALL=C sort -u
)

RUNTIME_STAGE=$RUNTIME_STAGE \
SBOM="$RUNTIME_STAGE/share/wildbuzzard/searxng/sbom.cdx.json" \
  "$PYTHON" - <<'PY'
import hashlib
import json
import os
from pathlib import Path

root = Path(os.environ["RUNTIME_STAGE"])
sbom_path = Path(os.environ["SBOM"])
sbom = json.loads(sbom_path.read_text(encoding="utf-8"))
sbom["components"] = [
    component
    for component in sbom["components"]
    if component.get("type") != "file"
]
for path in sorted((root / "python" / "lib").glob("lib*.so*")):
    if not path.is_file():
        continue
    relative = path.relative_to(root).as_posix()
    sbom["components"].append({
        "type": "file",
        "name": path.name,
        "hashes": [{
            "alg": "SHA-256",
            "content": hashlib.sha256(path.read_bytes()).hexdigest(),
        }],
        "properties": [{"name": "wildbuzzard:runtime-path", "value": relative}],
    })
sbom_path.write_text(
    json.dumps(sbom, sort_keys=True, separators=(",", ":")) + "\n",
    encoding="utf-8",
)
PY

find "$RUNTIME_STAGE" -type d -exec chmod 755 {} +
find "$RUNTIME_STAGE" -type f -exec chmod 644 {} +
find "$RUNTIME_STAGE/python/bin" "$RUNTIME_STAGE/bin" -type f -exec chmod 755 {} +
find "$RUNTIME_STAGE/python" -type f \( -name '*.so' -o -name '*.so.*' \) -exec chmod 755 {} +
if find "$RUNTIME_STAGE" -type l -print -quit | grep -q .; then
  echo "runtime contains a symlink" >&2
  exit 1
fi

"$RUNTIME_STAGE/python/bin/python3" -m compileall \
  --invalidation-mode unchecked-hash \
  -q \
  -f \
  -s "$RUNTIME_STAGE" \
  -p /wildbuzzard-searxng \
  -x '/python3\.14/test/' \
  "$RUNTIME_STAGE/python/lib/python3.14"
find "$RUNTIME_STAGE" -exec touch -h --date="@$SOURCE_DATE_EPOCH" {} +

RUNTIME_LOCK_SHA256=$(sha256sum "$RUNTIME_LOCK" | cut -d' ' -f1)
BUILD_LOCK_SHA256=$(sha256sum "$BUILD_LOCK" | cut -d' ' -f1)
POLICY_SHA256=$(sha256sum "$POLICY" | cut -d' ' -f1)
RUNTIME_MANIFEST="$RUNTIME_STAGE/wildbuzzard-runtime.json"
SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH \
RUNTIME_STAGE=$RUNTIME_STAGE \
RUNTIME_MANIFEST=$RUNTIME_MANIFEST \
RUNTIME_LOCK_SHA256=$RUNTIME_LOCK_SHA256 \
BUILD_LOCK_SHA256=$BUILD_LOCK_SHA256 \
POLICY_SHA256=$POLICY_SHA256 \
  "$RUNTIME_STAGE/python/bin/python3" - <<'PY'
import hashlib
import json
import os
from pathlib import Path

root = Path(os.environ["RUNTIME_STAGE"])
manifest_path = Path(os.environ["RUNTIME_MANIFEST"])
files = []
for path in sorted(root.rglob("*")):
    if not path.is_file() or path == manifest_path:
        continue
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    files.append({"path": path.relative_to(root).as_posix(), "sha256": digest, "size": path.stat().st_size})
manifest = {
    "schema": 1,
    "component": "searxng",
    "runtimeVersion": "2026.8.6+b023a28ba",
    "upstreamCommit": "b023a28bab8839dba9eac96e9a51cc91bbd0a267",
    "upstreamTree": "d2dc5354fe2281abd59f6734851bd586e6806631",
    "sourceArchiveSha256": "f5ab68baa420f26ac0d6b3fed1a8e5754bbe1fd31357c41271449980d3df779e",
    "pythonVersion": "3.14.6",
    "pythonSourceSha256": "143b1dddefaec3bd2e21e3b839b34a2b7fb9842272883c576420d605e9f30c63",
    "dependencyLockSha256": os.environ["RUNTIME_LOCK_SHA256"],
    "buildToolsLockSha256": os.environ["BUILD_LOCK_SHA256"],
    "providerPolicySha256": os.environ["POLICY_SHA256"],
    "protocolVersion": 1,
    "platform": "linux",
    "architecture": "x86_64",
    "license": "AGPL-3.0-or-later",
    "correspondingSource": "wildbuzzard-searxng-2026.8.6+b023a28ba-source.tar.xz",
    "files": files,
}
manifest_path.write_text(json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
os.utime(manifest_path, (int(os.environ["SOURCE_DATE_EPOCH"]),) * 2)
PY

RUNTIME_ARCHIVE="$OUTPUT_DIR/wildbuzzard-searxng-$RUNTIME_VERSION-linux-x86_64.zip"
RUNTIME_STAGE=$RUNTIME_STAGE \
RUNTIME_ARCHIVE=$RUNTIME_ARCHIVE \
SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH \
  "$RUNTIME_STAGE/python/bin/python3" - <<'PY'
import datetime
import os
import stat
import zipfile
from pathlib import Path

root = Path(os.environ["RUNTIME_STAGE"])
archive = Path(os.environ["RUNTIME_ARCHIVE"])
timestamp = datetime.datetime.fromtimestamp(int(os.environ["SOURCE_DATE_EPOCH"]), datetime.timezone.utc)
date_time = (timestamp.year, timestamp.month, timestamp.day, timestamp.hour, timestamp.minute, timestamp.second)
with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_STORED, strict_timestamps=True) as output:
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        relative = path.relative_to(root).as_posix()
        info = zipfile.ZipInfo(relative, date_time=date_time)
        mode = 0o755 if os.access(path, os.X_OK) else 0o644
        info.external_attr = (stat.S_IFREG | mode) << 16
        info.create_system = 3
        output.writestr(info, path.read_bytes())
PY

SOURCE_STAGE="$WORK_DIR/corresponding-source"
mkdir -p -- \
  "$SOURCE_STAGE/searxng" \
  "$SOURCE_STAGE/python" \
  "$SOURCE_STAGE/python-sdists" \
  "$SOURCE_STAGE/build-tools" \
  "$SOURCE_STAGE/wildbuzzard/managed-services/searxng" \
  "$SOURCE_STAGE/wildbuzzard/scripts"
cp -a -- "$SOURCE_ROOT/upstream" "$SOURCE_STAGE/searxng/upstream"
cp -- "$SOURCE_ROOT/UPSTREAM.toml" "$SOURCE_ROOT/LICENSE" "$RUNTIME_LOCK" "$BUILD_LOCK" "$POLICY" "$SOURCE_STAGE/searxng/"
cp -- "$CACHE_DIR/sources/$SEARXNG_ARCHIVE" "$SOURCE_STAGE/searxng/"
cp -- "$CACHE_DIR/sources/$PYTHON_ARCHIVE" "$SOURCE_STAGE/python/"
while IFS=$'\t' read -r _name _version filename _digest _url; do
  [[ -n "$filename" && ${filename:0:1} != '#' ]] || continue
  cp -- "$CACHE_DIR/sources/$filename" "$SOURCE_STAGE/python-sdists/"
done < "$RUNTIME_LOCK"
while IFS=$'\t' read -r _name _version filename _digest _url; do
  [[ -n "$filename" && ${filename:0:1} != '#' ]] || continue
  cp -- "$CACHE_DIR/build-tools/$filename" "$SOURCE_STAGE/build-tools/"
done < "$BUILD_LOCK"
cp -- \
  "$MANAGED_ROOT/searxng_service.py" \
  "$SOURCE_STAGE/wildbuzzard/managed-services/searxng/"
cp -- \
  "$SCRIPT_DIR/build-searxng-runtime.sh" \
  "$SCRIPT_DIR/import-searxng-source.sh" \
  "$SOURCE_STAGE/wildbuzzard/scripts/"
SOURCE_ARCHIVE="$OUTPUT_DIR/wildbuzzard-searxng-$RUNTIME_VERSION-source.tar.xz"
tar --sort=name \
  --mtime="@$SOURCE_DATE_EPOCH" \
  --owner=0 --group=0 --numeric-owner \
  -cJf "$SOURCE_ARCHIVE" \
  -C "$SOURCE_STAGE" .

RUNTIME_SHA256=$(sha256sum "$RUNTIME_ARCHIVE" | cut -d' ' -f1)
SOURCE_SHA256=$(sha256sum "$SOURCE_ARCHIVE" | cut -d' ' -f1)
cat > "$OUTPUT_DIR/wildbuzzard-searxng-$RUNTIME_VERSION-build.json" <<EOF
{"schema":1,"runtimeArchive":"$(basename -- "$RUNTIME_ARCHIVE")","runtimeArchiveSha256":"$RUNTIME_SHA256","sourceArchive":"$(basename -- "$SOURCE_ARCHIVE")","sourceArchiveSha256":"$SOURCE_SHA256","sourceDateEpoch":$SOURCE_DATE_EPOCH}
EOF
touch --date="@$SOURCE_DATE_EPOCH" \
  "$RUNTIME_ARCHIVE" \
  "$SOURCE_ARCHIVE" \
  "$OUTPUT_DIR/wildbuzzard-searxng-$RUNTIME_VERSION-build.json"
sha256sum "$RUNTIME_ARCHIVE" "$SOURCE_ARCHIVE" "$OUTPUT_DIR/wildbuzzard-searxng-$RUNTIME_VERSION-build.json"
