#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail

umask 022
for environment_name in $(compgen -e); do
  case "$environment_name" in
    AR|ARFLAGS|AS|CC|CFLAGS|CPP|CPPFLAGS|CXX|CXXFLAGS|LD|LDFLAGS|NM|OBJCOPY|OBJDUMP|RANLIB|STRIP|\
    CARGO_*|RUST*|ZIG_*|\
    PIP_*|PYTHON*|VIRTUAL_ENV|__PYVENV_LAUNCHER__|\
    CPATH|C_INCLUDE_PATH|CPLUS_INCLUDE_PATH|OBJC_INCLUDE_PATH|LIBRARY_PATH|COMPILER_PATH|GCC_EXEC_PREFIX|\
    CONFIG_SITE|CONFIG_SHELL|ENV|BASH_ENV|MAKEFLAGS|MFLAGS|MAKELEVEL|\
    PKG_CONFIG|PKG_CONFIG_PATH|PKG_CONFIG_LIBDIR|PKG_CONFIG_SYSROOT_DIR|\
    LD_LIBRARY_PATH|LD_PRELOAD|LD_AUDIT|\
    SOURCE_DATE_EPOCH|TMPDIR|TMP|TEMP|\
    TAR_OPTIONS|XZ_OPT|XZ_DEFAULTS|GZIP|BZIP2|\
    PERL5LIB|PERL5OPT|PERL_LOCAL_LIB_ROOT|PERL_MB_OPT|PERL_MM_OPT|\
    CMAKE_*|MESON_*|NINJAFLAGS|HATCH_*|SETUPTOOLS_*|PDM_*|POETRY_*|FLIT_*|\
    PYO3_*|MATURIN_*|PYYAML_*|LXML_*|STATIC|DIST_EXTRA_CONFIG|XDG_*|\
    CCACHE_*|DISTCC_*|ICECC_*|\
    INSTALL|INSTALL_PROGRAM|INSTALL_SCRIPT|INSTALL_DATA|DESTDIR|\
    LANG|LANGUAGE|LC_*|TZ)
      unset "$environment_name"
      ;;
  esac
done
export LC_ALL=C
export TZ=UTC
export PATH=/usr/bin:/bin
export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL=/dev/null

ARCHIVE_SCANNER_PYTHON=$(readlink -f -- /usr/bin/python3)
[[ "$ARCHIVE_SCANNER_PYTHON" == /* && -x "$ARCHIVE_SCANNER_PYTHON" ]]
ARCHIVE_SCANNER_VERSION=$(
  "$ARCHIVE_SCANNER_PYTHON" --version 2>&1
)
ARCHIVE_SCANNER_SHA256=$(sha256sum "$ARCHIVE_SCANNER_PYTHON" | cut -d' ' -f1)
"$ARCHIVE_SCANNER_PYTHON" -I -B -c 'import lzma, tarfile, zipfile'

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ROOT_DIR=$(cd -- "$SCRIPT_DIR/../.." && pwd)
SOURCE_ROOT="$ROOT_DIR/wildbuzzard/third_party/agpl/searxng"
MANAGED_ROOT="$ROOT_DIR/wildbuzzard/managed-services/searxng"
RUNTIME_LOCK="$SOURCE_ROOT/runtime-requirements.lock"
BUILD_LOCK="$SOURCE_ROOT/build-tools.lock"
BUILD_SOURCE_LOCK="$SOURCE_ROOT/build-tool-sources.lock"
NATIVE_LOCK="$SOURCE_ROOT/native-sources.lock"
TOOLCHAIN_LOCK="$SOURCE_ROOT/toolchain.lock"
CARGO_VENDOR_LOCK="$SOURCE_ROOT/granian-cargo-vendor.lock"
CARGO_COMPONENTS_LOCK="$SOURCE_ROOT/granian-cargo-components.lock"
CARGO_VENDOR_ARCHIVE="$SOURCE_ROOT/granian-2.7.9-cargo-vendor.tar.xz"
POLICY="$SOURCE_ROOT/engine-policy.json"
SEARXNG_ARCHIVE=searxng-b023a28bab8839dba9eac96e9a51cc91bbd0a267.tar.gz
SEARXNG_URL=https://codeload.github.com/searxng/searxng/tar.gz/b023a28bab8839dba9eac96e9a51cc91bbd0a267
SEARXNG_SHA256=f5ab68baa420f26ac0d6b3fed1a8e5754bbe1fd31357c41271449980d3df779e
SEARXNG_SIZE=5984564
PYTHON_VERSION=3.14.6
PYTHON_ARCHIVE="Python-$PYTHON_VERSION.tar.xz"
PYTHON_URL="https://www.python.org/ftp/python/$PYTHON_VERSION/$PYTHON_ARCHIVE"
PYTHON_SHA256=143b1dddefaec3bd2e21e3b839b34a2b7fb9842272883c576420d605e9f30c63
PYTHON_SIZE=23921184
SOURCE_DATE_EPOCH=1786030997
RUNTIME_VERSION=2026.8.6+b023a28ba
OUTPUT_DIR=
CACHE_DIR=
JOBS=
OFFLINE=0
KEEP_WORK=0
PREPARE_ONLY=0

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
    --prepare-only)
      PREPARE_ONLY=1
      ;;
    *)
      echo "usage: $0 --output DIR [--cache DIR] [--jobs N] [--offline] [--keep-work] [--prepare-only]" >&2
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
mkdir -p -- \
  "$OUTPUT_DIR" \
  "$CACHE_DIR/sources" \
  "$CACHE_DIR/build-tools" \
  "$CACHE_DIR/build-tool-sources" \
  "$CACHE_DIR/native-sources" \
  "$CACHE_DIR/toolchain" \
  "$CACHE_DIR/toolchain-sources"
WORK_DIR=$(mktemp -d "$OUTPUT_DIR/.searxng-build.XXXXXX")
if [[ "$KEEP_WORK" == 0 ]]; then
  trap 'rm -rf -- "$WORK_DIR"' EXIT
fi
if [[ -n ${HOME:-} && -e "$HOME/.pydistutils.cfg" ]]; then
  echo "refusing host distutils configuration: $HOME/.pydistutils.cfg" >&2
  exit 1
fi
export PIP_CONFIG_FILE=/dev/null
export XDG_CACHE_HOME="$WORK_DIR/xdg-cache"
export XDG_CONFIG_HOME="$WORK_DIR/xdg-config"
export XDG_DATA_HOME="$WORK_DIR/xdg-data"
mkdir -p -- "$XDG_CACHE_HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME"

[[ $(awk -F '\t' '$1 !~ /^#/ && NF == 5 { count++ } END { print count + 0 }' "$RUNTIME_LOCK") == 41 ]]
[[ $(awk -F '\t' '$1 !~ /^#/ && NF == 5 { count++ } END { print count + 0 }' "$CARGO_COMPONENTS_LOCK") == 199 ]]

download_locked() {
  local destination=$1
  local expected=$2
  local url=$3
  if [[ ! -f "$destination" ]]; then
    if [[ "$OFFLINE" == 1 ]]; then
      echo "missing offline input: $destination" >&2
      exit 1
    fi
    curl --disable --fail --location --proto '=https' --tlsv1.2 --output "$destination.part" "$url"
    mv -- "$destination.part" "$destination"
  fi
  echo "$expected  $destination" | sha256sum --check --strict
}

download_lock() {
  local lock=$1
  local destination=$2
  while IFS=$'\t' read -r _name _version filename digest url; do
    [[ -n "$url" && ${_name:0:1} != '#' ]] || continue
    download_locked "$destination/$filename" "$digest" "$url"
  done < "$lock"
}

download_locked "$CACHE_DIR/sources/$SEARXNG_ARCHIVE" "$SEARXNG_SHA256" "$SEARXNG_URL"
[[ $(stat -c '%s' "$CACHE_DIR/sources/$SEARXNG_ARCHIVE") == "$SEARXNG_SIZE" ]]
"$SCRIPT_DIR/import-searxng-source.sh" \
  --check \
  --archive "$CACHE_DIR/sources/$SEARXNG_ARCHIVE"
download_locked "$CACHE_DIR/sources/$PYTHON_ARCHIVE" "$PYTHON_SHA256" "$PYTHON_URL"
[[ $(stat -c '%s' "$CACHE_DIR/sources/$PYTHON_ARCHIVE") == "$PYTHON_SIZE" ]]
download_lock "$RUNTIME_LOCK" "$CACHE_DIR/sources"
download_lock "$BUILD_LOCK" "$CACHE_DIR/build-tools"
download_lock "$BUILD_SOURCE_LOCK" "$CACHE_DIR/build-tool-sources"

while IFS=$'\t' read -r _name _version filename digest size _license url; do
  [[ -n "$url" && ${_name:0:1} != '#' ]] || continue
  download_locked "$CACHE_DIR/native-sources/$filename" "$digest" "$url"
  [[ $(stat -c '%s' "$CACHE_DIR/native-sources/$filename") == "$size" ]]
done < "$NATIVE_LOCK"

while IFS=$'\t' read -r _name _version binary binary_digest binary_size source source_digest source_size _license binary_url source_url; do
  [[ -n "$binary_url" && ${_name:0:1} != '#' ]] || continue
  download_locked "$CACHE_DIR/toolchain/$binary" "$binary_digest" "$binary_url"
  [[ $(stat -c '%s' "$CACHE_DIR/toolchain/$binary") == "$binary_size" ]]
  download_locked "$CACHE_DIR/toolchain-sources/$source" "$source_digest" "$source_url"
  [[ $(stat -c '%s' "$CACHE_DIR/toolchain-sources/$source") == "$source_size" ]]
done < "$TOOLCHAIN_LOCK"

echo "1aad25bfcb3f0f8753363d27e73199ea6ba30beee179a84f01a4e8ae213da1a8  $CARGO_VENDOR_ARCHIVE" |
  sha256sum --check --strict
[[ $(stat -c '%s' "$CARGO_VENDOR_ARCHIVE") == 30147144 ]]

if [[ "$PREPARE_ONLY" == 1 ]]; then
  echo "SearXNG build inputs are complete: $CACHE_DIR"
  exit 0
fi

LOCKED_BUILD_TOOLS="$WORK_DIR/locked-build-tools"
mkdir -p -- "$LOCKED_BUILD_TOOLS"
while IFS=$'\t' read -r _name _version filename _digest _url; do
  [[ -n "$filename" && ${_name:0:1} != '#' ]] || continue
  cp -- "$CACHE_DIR/build-tools/$filename" "$LOCKED_BUILD_TOOLS/$filename"
done < "$BUILD_LOCK"
chmod 644 "$LOCKED_BUILD_TOOLS"/*

TOOLCHAIN_ROOT="$WORK_DIR/toolchain"
mkdir -p -- "$TOOLCHAIN_ROOT"
tar -xJf "$CACHE_DIR/toolchain/zig-x86_64-linux-0.15.2.tar.xz" -C "$TOOLCHAIN_ROOT"
ZIG_ROOT="$TOOLCHAIN_ROOT/zig-x86_64-linux-0.15.2"
tar -xJf "$CACHE_DIR/toolchain/rust-1.96.0-x86_64-unknown-linux-gnu.tar.xz" -C "$TOOLCHAIN_ROOT"
RUST_DISTRIBUTION="$TOOLCHAIN_ROOT/rust-1.96.0-x86_64-unknown-linux-gnu"
RUST_PREFIX="$TOOLCHAIN_ROOT/rust-prefix"
mkdir -p -- "$RUST_PREFIX"
"$RUST_DISTRIBUTION/install.sh" \
  --prefix="$RUST_PREFIX" \
  --disable-ldconfig
[[ $("$RUST_PREFIX/bin/rustc" --version) == "rustc 1.96.0 (ac68faa20 2026-05-25)" ]]
[[ $("$RUST_PREFIX/bin/cargo" --version) == "cargo 1.96.0 (30a34c682 2026-05-25)" ]]
[[ $("$ZIG_ROOT/zig" version) == 0.15.2 ]]
STRIP_TOOL="$RUST_PREFIX/lib/rustlib/x86_64-unknown-linux-gnu/bin/llvm-strip"
[[ -x "$STRIP_TOOL" ]]
LLVM_TOOLS=$(dirname -- "$STRIP_TOOL")
export ZIG_GLOBAL_CACHE_DIR="$WORK_DIR/zig-global-cache"
export ZIG_LOCAL_CACHE_DIR="$WORK_DIR/zig-local-cache"
export TMPDIR="$WORK_DIR/tmp"
mkdir -p -- "$ZIG_GLOBAL_CACHE_DIR" "$ZIG_LOCAL_CACHE_DIR" "$TMPDIR"

NATIVE_WORK="$WORK_DIR/native"
"$SCRIPT_DIR/build-searxng-native-deps.sh" \
  --source-cache "$CACHE_DIR/native-sources" \
  --zig-root "$ZIG_ROOT" \
  --work "$NATIVE_WORK" \
  --jobs "$JOBS" \
  --source-date-epoch "$SOURCE_DATE_EPOCH" \
  --strip-tool "$STRIP_TOOL"
NATIVE_PREFIX="$NATIVE_WORK/destdir/opt/wildbuzzard-searxng-native"
TOOLS="$NATIVE_WORK/tools"

export PATH="$TOOLS:$RUST_PREFIX/bin:/usr/bin:/bin"
export CC=cc
export CXX=c++
export AR=ar
export RANLIB=ranlib
export LD=ld
export NM="$LLVM_TOOLS/llvm-nm"
export OBJCOPY="$LLVM_TOOLS/llvm-objcopy"
export OBJDUMP="$LLVM_TOOLS/llvm-objdump"
export STRIP="$STRIP_TOOL"
export CARGO="$RUST_PREFIX/bin/cargo"
export RUSTC="$RUST_PREFIX/bin/rustc"
export CARGO_HOME="$WORK_DIR/cargo-home"
export CARGO_NET_OFFLINE=true
export CARGO_NET_GIT_FETCH_WITH_CLI=false
export CARGO_INCREMENTAL=0
export PIP_NO_CACHE_DIR=1
export PYTHONHASHSEED=0
export PYTHONNOUSERSITE=1
export SOURCE_DATE_EPOCH
export ZERO_AR_DATE=1
export CFLAGS="-O2 -fPIC -Wno-error=date-time -ffile-prefix-map=$WORK_DIR=/usr/src/wildbuzzard-searxng -ffile-prefix-map=$ZIG_ROOT=/usr/src/wildbuzzard-searxng/toolchain/zig"
export CPPFLAGS="-I$NATIVE_PREFIX/include"
PYTHON_BINARY_RPATH='-Wl,-rpath,\$$ORIGIN/../lib'
PYTHON_MODULE_RPATH='-Wl,-rpath,\$$ORIGIN/../..'
export LDFLAGS="-L$NATIVE_PREFIX/lib"
export LD_LIBRARY_PATH="$NATIVE_PREFIX/lib"
export PKG_CONFIG_LIBDIR="$NATIVE_PREFIX/lib/pkgconfig:$NATIVE_PREFIX/share/pkgconfig"
export PKG_CONFIG_PATH=
export PKG_CONFIG_SYSROOT_DIR="$NATIVE_WORK/destdir"
export XML2_CONFIG="$NATIVE_PREFIX/bin/xml2-config"
export XSLT_CONFIG="$NATIVE_PREFIX/bin/xslt-config"

tar -xJf "$CACHE_DIR/sources/$PYTHON_ARCHIVE" -C "$WORK_DIR"
PYTHON_SOURCE="$WORK_DIR/Python-$PYTHON_VERSION"
PYTHON_INSTALL_PREFIX=/opt/wildbuzzard-searxng/python
PYTHON_DEST="$WORK_DIR/python-destdir"
PYTHON_PREFIX="$PYTHON_DEST$PYTHON_INSTALL_PREFIX"
PYTHON_BUILD="$WORK_DIR/python-build"
mkdir -p -- "$PYTHON_BUILD"
(
  cd -- "$PYTHON_BUILD"
  BLDSHARED="$TOOLS/cc -shared $PYTHON_MODULE_RPATH" \
    "$PYTHON_SOURCE/configure" \
      --prefix="$PYTHON_INSTALL_PREFIX" \
      --enable-shared \
      --disable-test-modules \
      --with-ensurepip=install \
      --with-openssl="$NATIVE_PREFIX" \
      --with-openssl-rpath=no \
      --with-system-expat \
      --without-static-libpython
  make -j "$JOBS" PY3LIBRARY=
  make DESTDIR="$PYTHON_DEST" install PY3LIBRARY=
  unlink Modules/getpath.o
  make --eval="vpath % $PYTHON_SOURCE" Modules/getpath.o \
    PY3LIBRARY= \
    VPATH=/usr/src/wildbuzzard-searxng/Python-3.14.6
  unlink libpython3.14.so
  unlink libpython3.14.so.1.0
  make --assume-old=Modules/getpath.o libpython3.14.so \
    BLDSHARED="$TOOLS/cc -shared -L$NATIVE_PREFIX/lib"
  unlink python
  make --assume-old=Modules/getpath.o python \
    PY3LIBRARY= \
    LDFLAGS="-L$NATIVE_PREFIX/lib $PYTHON_BINARY_RPATH"
  install -m 755 libpython3.14.so.1.0 \
    "$PYTHON_PREFIX/lib/libpython3.14.so.1.0"
  unlink "$PYTHON_PREFIX/lib/libpython3.14.so"
  ln "$PYTHON_PREFIX/lib/libpython3.14.so.1.0" \
    "$PYTHON_PREFIX/lib/libpython3.14.so"
  install -m 755 python "$PYTHON_PREFIX/bin/python3.14"
)

for library in libcrypto.so.3 libexpat.so.1 libffi.so.8 libsqlite3.so.0 libssl.so.3; do
  cp -L -- "$NATIVE_PREFIX/lib/$library" "$PYTHON_PREFIX/lib/$library"
done
install -m 755 \
  "$NATIVE_PREFIX/lib/ossl-modules/legacy.so" \
  "$PYTHON_PREFIX/lib/legacy.so"

PYTHON="$PYTHON_PREFIX/bin/python3"
env -u LD_LIBRARY_PATH "$PYTHON" -I -B -m ensurepip --version |
  grep -F 'pip 26.1.2' >/dev/null
OPENSSL_MODULES="$PYTHON_PREFIX/lib" \
  env -u LD_LIBRARY_PATH "$PYTHON" -I -B - <<'PY'
import _ctypes
import _elementtree
import pyexpat
import sqlite3
import ssl
import sys
import zlib

assert "Aug  6 2026, 15:43:17" in sys.version
assert ssl.OPENSSL_VERSION == "OpenSSL 3.5.5 27 Jan 2026"
assert sqlite3.sqlite_version == "3.46.1"
assert zlib.ZLIB_VERSION == "1.3.1"
assert pyexpat.EXPAT_VERSION == "expat_2.7.3"
PY
export LD_LIBRARY_PATH="$PYTHON_PREFIX/lib:$NATIVE_PREFIX/lib"
readelf -d "$PYTHON" > "$WORK_DIR/python-runpath.txt"
grep -F '$ORIGIN/../lib' "$WORK_DIR/python-runpath.txt" >/dev/null

BUILD_VENV="$WORK_DIR/build-venv"
"$PYTHON" -m venv "$BUILD_VENV"
WHEELHOUSE="$WORK_DIR/wheels"
mkdir -p -- "$WHEELHOUSE" "$CARGO_HOME"

while IFS=$'\t' read -r name version filename _digest _url; do
  [[ -n "$filename" && ${name:0:1} != '#' ]] || continue
  wheel_input="$CACHE_DIR/sources/$filename"
  pip_extra=()
  case "$name" in
    granian)
      GRANIAN_SOURCE="$WORK_DIR/granian-source"
      mkdir -p -- "$GRANIAN_SOURCE"
      tar -xzf "$wheel_input" -C "$GRANIAN_SOURCE" --strip-components=1
      cp -- "$GRANIAN_SOURCE/Cargo.lock" "$WORK_DIR/granian-Cargo.lock"
      tar -xJf "$CARGO_VENDOR_ARCHIVE" -C "$GRANIAN_SOURCE"
      cmp -- "$GRANIAN_SOURCE/Cargo.lock" "$WORK_DIR/granian-Cargo.lock"
      mkdir -p -- "$GRANIAN_SOURCE/.cargo"
      cp -- "$GRANIAN_SOURCE/cargo-vendor-config.toml" "$GRANIAN_SOURCE/.cargo/config.toml"
      cat >> "$GRANIAN_SOURCE/.cargo/config.toml" <<'EOF'

[net]
offline = true
EOF
      GRANIAN_PYPROJECT="$GRANIAN_SOURCE/pyproject.toml" \
        "$PYTHON" -I -B - <<'PY'
import os
from pathlib import Path

path = Path(os.environ["GRANIAN_PYPROJECT"])
text = path.read_text(encoding="utf-8")
marker = "[tool.maturin]\n"
if text.count(marker) != 1:
    raise SystemExit("Granian pyproject has no unique tool.maturin table")
path.write_text(text.replace(marker, marker + "locked = true\n"), encoding="utf-8")
PY
      wheel_input="$GRANIAN_SOURCE"
      ;;
    PyYAML)
      export PYYAML_FORCE_LIBYAML=1
      ;;
  esac
  if [[ "$name" == lxml ]]; then
    STATIC=true \
    LXML_STATIC_INCLUDE_DIRS="$NATIVE_PREFIX/include:$NATIVE_PREFIX/include/libxml2" \
    LXML_STATIC_LIBRARY_DIRS="$NATIVE_PREFIX/lib" \
    LXML_STATIC_BINARIES="$NATIVE_PREFIX/lib/libxslt.a:$NATIVE_PREFIX/lib/libexslt.a:$NATIVE_PREFIX/lib/libxml2.a:$NATIVE_PREFIX/lib/libz.a" \
      PIP_NO_INDEX=1 PIP_FIND_LINKS="$LOCKED_BUILD_TOOLS" \
      "$BUILD_VENV/bin/python" -m pip wheel \
        --disable-pip-version-check \
        --no-deps \
        --wheel-dir "$WHEELHOUSE" \
        "${pip_extra[@]}" \
        "$wheel_input"
  else
    RUSTFLAGS="--remap-path-prefix=$WORK_DIR=/usr/src/wildbuzzard-searxng -C linker=$TOOLS/cc -C link-arg=-Wl,-rpath,\$ORIGIN/../../.." \
    CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER="$TOOLS/cc" \
    PIP_NO_INDEX=1 \
    PIP_FIND_LINKS="$LOCKED_BUILD_TOOLS" \
      "$BUILD_VENV/bin/python" -m pip wheel \
        --disable-pip-version-check \
        --no-deps \
        --wheel-dir "$WHEELHOUSE" \
        "${pip_extra[@]}" \
        "$wheel_input"
  fi
  if [[ "$name" == granian ]]; then
    cmp -- "$GRANIAN_SOURCE/Cargo.lock" "$WORK_DIR/granian-Cargo.lock"
  fi
  normalized_name=$(printf '%s' "$name" | tr '[:upper:]-' '[:lower:]_')
  compgen -G "$WHEELHOUSE/$normalized_name-$version-*.whl" >/dev/null
done < "$RUNTIME_LOCK"

PIP_NO_INDEX=1 PIP_FIND_LINKS="$LOCKED_BUILD_TOOLS" \
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
PIP_FIND_LINKS="$LOCKED_BUILD_TOOLS" \
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
mkdir -p -- \
  "$RUNTIME_STAGE/python" \
  "$RUNTIME_STAGE/libexec" \
  "$RUNTIME_STAGE/share/licenses" \
  "$RUNTIME_STAGE/share/wildbuzzard/searxng"
cp -aL -- "$PYTHON_PREFIX/." "$RUNTIME_STAGE/python/"
find "$RUNTIME_STAGE/python/bin" -maxdepth 1 -type f \
  ! -name python3 ! -name python3.14 -delete
find "$RUNTIME_STAGE/python/lib/python3.14/site-packages" -maxdepth 1 \
  \( -name pip -o -name 'pip-*.dist-info' \) -exec rm -rf -- {} +
find "$RUNTIME_STAGE/python/lib/python3.14" -maxdepth 1 \
  \( -name ensurepip -o -name idlelib -o -name tkinter -o -name test \) \
  -exec rm -rf -- {} +
find "$RUNTIME_STAGE/python/lib/python3.14/site-packages" -depth -type d \
  \( -name test -o -name tests \) -exec rm -rf -- {} +
if [[ -d "$RUNTIME_STAGE/python/lib/python3.14/test" ]]; then
  find "$RUNTIME_STAGE/python/lib/python3.14/test" -depth -delete
fi
find "$RUNTIME_STAGE/python" -type d -name __pycache__ -prune -exec rm -rf -- {} +
find "$RUNTIME_STAGE/python" -type f \( -name '*.a' -o -name '*.la' \) -delete
find "$RUNTIME_STAGE/python/include" -depth -delete
find "$RUNTIME_STAGE/python/lib" -maxdepth 1 -type d -name pkgconfig -exec rm -rf -- {} +
find "$RUNTIME_STAGE/python/lib/python3.14" -maxdepth 1 -type d -name 'config-*' -exec rm -rf -- {} +
RUNTIME_STAGE=$RUNTIME_STAGE "$PYTHON" -I -B - <<'PY'
import json
import os
from pathlib import Path

root = Path(os.environ["RUNTIME_STAGE"])
paths = list((root / "python" / "lib" / "python3.14").glob("_sysconfig_vars__*.json"))
if len(paths) != 1:
    raise SystemExit(f"expected one staged sysconfig variables file, found {len(paths)}")
path = paths[0]
value = json.loads(path.read_text(encoding="utf-8"))
userbase = value.pop("userbase", None)
if not isinstance(userbase, str) or not userbase:
    raise SystemExit("staged sysconfig variables have no build-time userbase")
path.write_text(
    json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n",
    encoding="utf-8",
)
PY
for searxng_user_home in \
  "$WORK_DIR/sysconfig-user-home-a" \
  "$WORK_DIR/sysconfig-user-home-b"; do
  env -u LD_LIBRARY_PATH HOME="$searxng_user_home" \
    "$RUNTIME_STAGE/python/bin/python3" -I -B - <<'PY'
import os
from pathlib import Path
import site
import sysconfig

expected = str(Path(os.environ["HOME"]) / ".local")
assert sysconfig.get_config_var("userbase") == expected
assert site.USER_BASE == expected
PY
done
cp -- "$MANAGED_ROOT/searxng_service.py" "$RUNTIME_STAGE/libexec/searxng_service.py"
cp -- "$POLICY" "$RUNTIME_STAGE/share/wildbuzzard/searxng/engine-policy.json"
cp -- "$SOURCE_ROOT/LICENSE" "$RUNTIME_STAGE/share/wildbuzzard/searxng/LICENSE"
cp -- "$SOURCE_ROOT/UPSTREAM.toml" "$RUNTIME_STAGE/share/wildbuzzard/searxng/UPSTREAM.toml"
cp -- \
  "$RUNTIME_LOCK" \
  "$BUILD_LOCK" \
  "$BUILD_SOURCE_LOCK" \
  "$NATIVE_LOCK" \
  "$TOOLCHAIN_LOCK" \
  "$CARGO_VENDOR_LOCK" \
  "$CARGO_COMPONENTS_LOCK" \
  "$RUNTIME_STAGE/share/wildbuzzard/searxng/"
cp -- "$PYTHON_SOURCE/LICENSE" "$RUNTIME_STAGE/share/licenses/CPython-PSF-2.0.txt"
cp -- "$NATIVE_WORK/licenses/"* "$RUNTIME_STAGE/share/licenses/"
mkdir -p -- \
  "$RUNTIME_STAGE/share/licenses/Rust-1.96.0" \
  "$RUNTIME_STAGE/share/licenses/Zig-0.15.2" \
  "$RUNTIME_STAGE/share/licenses/Granian-Cargo/granian-2.7.9"
cp -- \
  "$RUST_DISTRIBUTION/LICENSE-APACHE" \
  "$RUST_DISTRIBUTION/LICENSE-MIT" \
  "$RUST_DISTRIBUTION/COPYRIGHT" \
  "$RUNTIME_STAGE/share/licenses/Rust-1.96.0/"
cp -- \
  "$ZIG_ROOT/LICENSE" \
  "$ZIG_ROOT/lib/libc/glibc/LICENSES" \
  "$RUNTIME_STAGE/share/licenses/Zig-0.15.2/"
cp -- "$GRANIAN_SOURCE/LICENSE" \
  "$RUNTIME_STAGE/share/licenses/Granian-Cargo/granian-2.7.9/"
while IFS= read -r -d '' license_file; do
  relative=${license_file#"$GRANIAN_SOURCE/vendor/"}
  target="$RUNTIME_STAGE/share/licenses/Granian-Cargo/$relative"
  mkdir -p -- "$(dirname -- "$target")"
  cp -- "$license_file" "$target"
done < <(
  find "$GRANIAN_SOURCE/vendor" -mindepth 2 -maxdepth 2 -type f \
    \( -iname 'LICENSE*' -o -iname 'COPYING*' -o -iname 'NOTICE*' -o -iname 'UNLICENSE*' \) \
    -print0
)
unset LD_LIBRARY_PATH

while IFS= read -r -d '' binary; do
  if [[ $(od -An -tx1 -N4 "$binary" | tr -d ' \n') == 7f454c46 ]]; then
    "$STRIP_TOOL" --strip-debug "$binary"
  fi
done < <(find "$RUNTIME_STAGE/python" -type f -print0)

WORK_DIR=$WORK_DIR RUNTIME_STAGE=$RUNTIME_STAGE "$PYTHON" - <<'PY'
import os
from pathlib import Path
import re

needle = os.environ["WORK_DIR"].encode()
replacement = b"/usr/src/wildbuzzard-searxng"
for path in sorted(Path(os.environ["RUNTIME_STAGE"]).rglob("*")):
    if not path.is_file():
        continue
    data = path.read_bytes()
    if needle not in data:
        continue
    if data.startswith(b"\x7fELF"):
        matches = set()
        for value in re.findall(rb"[ -~]{4,}", data):
            offset = value.find(needle)
            if offset < 0:
                continue
            start = max(0, offset - 120)
            end = min(len(value), offset + len(needle) + 120)
            matches.add(value[start:end].decode("ascii", errors="replace"))
        details = "\n".join(sorted(matches))
        raise SystemExit(f"ELF retains build path: {path}\n{details}")
    path.write_bytes(data.replace(needle, replacement))
PY

RUNTIME_LOCK=$RUNTIME_LOCK \
NATIVE_LOCK=$NATIVE_LOCK \
CARGO_COMPONENTS_LOCK=$CARGO_COMPONENTS_LOCK \
SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH \
SBOM="$RUNTIME_STAGE/share/wildbuzzard/searxng/sbom.cdx.json" \
SITE_PACKAGES="$RUNTIME_STAGE/python/lib/python3.14/site-packages" \
  "$RUNTIME_STAGE/python/bin/python3" -I -B - <<'PY'
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import uuid

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
        "licenses": [{"license": {"id": "PSF-2.0"}}],
        "purl": "pkg:generic/cpython@3.14.6",
        "hashes": [
            {
                "alg": "SHA-256",
                "content": "143b1dddefaec3bd2e21e3b839b34a2b7fb9842272883c576420d605e9f30c63",
            }
        ],
    },
    {
        "type": "library",
        "name": "Rust standard library",
        "version": "1.96.0",
        "licenses": [{"expression": "Apache-2.0 OR MIT"}],
        "purl": "pkg:generic/rust-std@1.96.0?arch=x86_64-unknown-linux-gnu",
        "hashes": [
            {
                "alg": "SHA-256",
                "content": "b99ce16cdf0ecfc761b585ac84d131b46733465a02f8ecd0ff2de9713c62ee09",
            }
        ],
        "properties": [
            {"name": "wildbuzzard:linkage", "value": "static"}
        ],
    },
    {
        "type": "library",
        "name": "Zig compiler runtime",
        "version": "0.15.2",
        "licenses": [{"license": {"id": "MIT"}}],
        "purl": "pkg:generic/zig-compiler-rt@0.15.2",
        "hashes": [
            {
                "alg": "SHA-256",
                "content": "d9b30c7aa983fcff5eed2084d54ae83eaafe7ff3a84d8fb754d854165a6e521c",
            }
        ],
        "properties": [
            {"name": "wildbuzzard:linkage", "value": "static"}
        ],
    },
    {
        "type": "library",
        "name": "Zig glibc CRT and ABI stubs",
        "version": "0.15.2+gnu.2.28",
        "licenses": [{"expression": "LGPL-2.1-or-later"}],
        "purl": "pkg:generic/zig-glibc-crt@0.15.2?abi=2.28",
        "hashes": [
            {
                "alg": "SHA-256",
                "content": "d9b30c7aa983fcff5eed2084d54ae83eaafe7ff3a84d8fb754d854165a6e521c",
            }
        ],
        "properties": [
            {"name": "wildbuzzard:linkage", "value": "static"},
            {"name": "wildbuzzard:target", "value": "x86_64-linux-gnu.2.28"},
        ],
    },
]
metadata_by_name = {
    distribution.metadata["Name"].lower().replace("_", "-"): distribution.metadata
    for distribution in importlib.metadata.distributions(
        path=[os.environ["SITE_PACKAGES"]]
    )
}
legacy_expressions = {
    "Apache 2": "Apache-2.0",
    "Apache-2.0": "Apache-2.0",
    "BSD-3-Clause": "BSD-3-Clause",
    "Dual License": "BSD-3-Clause OR Apache-2.0",
    "ISC License": "ISC",
    "MIT": "MIT",
}
classifier_expressions = {
    "Apache Software License": "Apache-2.0",
    "BSD License": "BSD-3-Clause",
    "ISC License (ISCL)": "ISC",
    "MIT License": "MIT",
    "Mozilla Public License 2.0 (MPL 2.0)": "MPL-2.0",
    "Python Software Foundation License": "PSF-2.0",
}
for line in Path(os.environ["RUNTIME_LOCK"]).read_text(encoding="utf-8").splitlines():
    if not line or line.startswith("#"):
        continue
    name, version, filename, digest, url = line.split("\t")
    component = {
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
    package_metadata = metadata_by_name.get(name.lower().replace("_", "-"))
    if package_metadata:
        expression = package_metadata.get("License-Expression")
        if expression:
            component["licenses"] = [{"expression": expression}]
        else:
            legacy = " ".join((package_metadata.get("License") or "").split())
            classifiers = [
                value.rsplit(" :: ", 1)[-1]
                for value in package_metadata.get_all("Classifier", [])
                if value.startswith("License :: OSI Approved :: ")
            ]
            mapped_classifiers = [
                classifier_expressions[value]
                for value in classifiers
                if value in classifier_expressions
            ]
            if legacy in legacy_expressions:
                component["licenses"] = [{
                    "expression": legacy_expressions[legacy]
                }]
            elif mapped_classifiers:
                component["licenses"] = [{
                    "expression": " OR ".join(dict.fromkeys(mapped_classifiers))
                }]
            elif legacy and legacy.upper() != "UNKNOWN" and len(legacy) <= 160:
                license_name = legacy
                component["licenses"] = [{"license": {"name": license_name}}]
            else:
                component["licenses"] = [{
                    "license": {"name": "NOASSERTION"}
                }]
    else:
        component["licenses"] = [{"license": {"name": "NOASSERTION"}}]
    components.append(component)
for line in Path(os.environ["NATIVE_LOCK"]).read_text(encoding="utf-8").splitlines():
    if not line or line.startswith("#"):
        continue
    name, version, filename, digest, _size, license_id, url = line.split("\t")
    native_license = (
        {"name": "SQLite Public Domain"}
        if license_id == "LicenseRef-SQLite-Public-Domain"
        else {"id": license_id}
    )
    components.append({
        "type": "library",
        "name": name,
        "version": version,
        "licenses": [{"license": native_license}],
        "purl": f"pkg:generic/{name}@{version}",
        "hashes": [{"alg": "SHA-256", "content": digest}],
        "externalReferences": [{"type": "distribution", "url": url}],
        "properties": [{"name": "wildbuzzard:source-filename", "value": filename}],
    })
for line in Path(os.environ["CARGO_COMPONENTS_LOCK"]).read_text(encoding="utf-8").splitlines():
    if not line or line.startswith("#"):
        continue
    fields = line.split("\t")
    if len(fields) == 4:
        fields.append("")
    name, version, license_expression, source, checksum = fields
    component = {
        "type": "library",
        "name": name,
        "version": version,
        "licenses": [{"expression": license_expression}],
        "purl": f"pkg:cargo/{name}@{version}",
        "properties": [{"name": "wildbuzzard:cargo-source", "value": source}],
        "scope": "required",
    }
    if checksum:
        component["hashes"] = [{"alg": "SHA-256", "content": checksum}]
    components.append(component)
serial_material = "\n".join(
    f"{item['name']}@{item['version']}" for item in components
).encode()
serial = bytearray(hashlib.sha256(serial_material).digest()[:16])
serial[6] = (serial[6] & 0x0F) | 0x50
serial[8] = (serial[8] & 0x3F) | 0x80
sbom = {
    "bomFormat": "CycloneDX",
    "specVersion": "1.6",
    "serialNumber": f"urn:uuid:{uuid.UUID(bytes=bytes(serial))}",
    "version": 1,
    "metadata": {
        "timestamp": "2026-08-06T15:43:17Z",
        "component": components[0],
        "tools": {"components": [
            {
                "type": "application",
                "name": "Zig",
                "version": "0.15.2",
                "licenses": [{"license": {"id": "MIT"}}],
                "hashes": [{"alg": "SHA-256", "content": "02aa270f183da276e5b5920b1dac44a63f1a49e55050ebde3aecc9eb82f93239"}],
            },
            {
                "type": "application",
                "name": "Rust",
                "version": "1.96.0",
                "licenses": [{"expression": "Apache-2.0 OR MIT"}],
                "hashes": [{"alg": "SHA-256", "content": "c295047583a56238ea06b43f849f4b877fa12bfd4c7103f8d9a74c94c9c4e108"}],
            },
        ]},
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
OPENSSL_MODULES="$runtime_root/python/lib"
export LD_LIBRARY_PATH
export OPENSSL_MODULES
exec "$runtime_root/python/bin/python3" -I -B "$runtime_root/libexec/searxng_service.py" --runtime-root "$runtime_root" "$@"
EOF
chmod 755 "$RUNTIME_STAGE/bin/searxng-service"

RUNTIME_STAGE=$RUNTIME_STAGE READ_ELF=$(command -v readelf) \
  "$RUNTIME_STAGE/python/bin/python3" -I -B - <<'PY'
import json
import os
from pathlib import Path
import re
import subprocess

root = Path(os.environ["RUNTIME_STAGE"])
bundled = {path.name for path in (root / "python" / "lib").glob("lib*.so*")}
system = {
    "ld-linux-x86-64.so.2",
    "libc.so.6",
    "libdl.so.2",
    "libm.so.6",
    "libpthread.so.0",
    "librt.so.1",
    "libutil.so.1",
}
records = []
for path in sorted((root / "python").rglob("*")):
    if not path.is_file() or path.read_bytes()[:4] != b"\x7fELF":
        continue
    result = subprocess.run(
        [os.environ["READ_ELF"], "-d", "--version-info", str(path)],
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    ).stdout
    needed = re.findall(r"\(NEEDED\).*?\[(.*?)\]", result)
    runpaths = re.findall(r"\((?:RUNPATH|RPATH)\).*?\[(.*?)\]", result)
    glibc_versions = sorted({
        tuple(map(int, match))
        for match in re.findall(r"GLIBC_(\d+)\.(\d+)", result)
    })
    unknown = sorted(set(needed) - system - bundled)
    if unknown:
        raise SystemExit(f"unbundled ELF dependencies for {path}: {unknown}")
    if glibc_versions and glibc_versions[-1] > (2, 28):
        raise SystemExit(
            f"GLIBC symbol version exceeds 2.28 for {path}: {glibc_versions[-1]}"
        )
    for runpath in runpaths:
        for item in runpath.split(":"):
            if not item or not (
                item == "$ORIGIN" or item.startswith("$ORIGIN/")
            ):
                raise SystemExit(f"unsafe ELF runpath for {path}: {runpaths}")
            target = (path.parent / item.removeprefix("$ORIGIN").lstrip("/")).resolve()
            if target != (root / "python" / "lib").resolve():
                raise SystemExit(f"ELF runpath escapes bundled lib for {path}: {item}")
    records.append({
        "path": path.relative_to(root).as_posix(),
        "needed": needed,
        "runpaths": runpaths,
        "glibcVersions": [f"{major}.{minor}" for major, minor in glibc_versions],
    })
(root / "share" / "wildbuzzard" / "searxng" / "elf-dependencies.json").write_text(
    json.dumps(records, sort_keys=True, separators=(",", ":")) + "\n",
    encoding="utf-8",
)
PY

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
for path in sorted((root / "python" / "lib").rglob("*.so*")):
    if not path.is_file() or path.read_bytes()[:4] != b"\x7fELF":
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

RUNTIME_LOCK="$RUNTIME_STAGE/share/wildbuzzard/searxng/runtime-requirements.lock" \
OPENSSL_MODULES="$RUNTIME_STAGE/python/lib" \
  env -u LD_LIBRARY_PATH "$RUNTIME_STAGE/python/bin/python3" -I -B - <<'PY'
import importlib.metadata
import granian
import granian._granian
import lxml.etree
import markupsafe._speedups
import msgspec._core
from pathlib import Path
import pyexpat
import searx
import setproctitle
import sqlite3
import ssl
import yaml
import yaml._yaml
import zlib

assert yaml.__with_libyaml__
assert yaml._yaml.get_version_string() == "0.2.5"
assert lxml.etree.LIBXML_VERSION == (2, 15, 2)
assert lxml.etree.LIBXSLT_VERSION == (1, 1, 45)
assert ssl.OPENSSL_VERSION == "OpenSSL 3.5.5 27 Jan 2026"
assert sqlite3.sqlite_version == "3.46.1"
assert zlib.ZLIB_VERSION == "1.3.1"
assert pyexpat.EXPAT_VERSION == "expat_2.7.3"
for line in Path(__import__("os").environ["RUNTIME_LOCK"]).read_text(
    encoding="utf-8"
).splitlines():
    if not line or line.startswith("#"):
        continue
    name, version, *_rest = line.split("\t")
    assert importlib.metadata.version(name) == version
assert importlib.metadata.version("searxng") == "2026.8.6+b023a28ba"
PY
[[ "$RUNTIME_STAGE/python" != "$PYTHON_PREFIX" ]]
echo "Relocated CPython smoke test passed: $RUNTIME_STAGE/python"

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
if find "$RUNTIME_STAGE/python/lib/python3.14/site-packages" -type d \
  \( -name test -o -name tests \) -print -quit | grep -q .; then
  echo "runtime contains a package test directory" >&2
  exit 1
fi
if find "$RUNTIME_STAGE/python/lib/python3.14/site-packages" -type f \
  \( -path '*/test/*.pyc' -o -path '*/tests/*.pyc' \) \
  -print -quit | grep -q .; then
  echo "runtime contains compiled package test remnants" >&2
  exit 1
fi
SITE_PACKAGES="$RUNTIME_STAGE/python/lib/python3.14/site-packages" \
  "$RUNTIME_STAGE/python/bin/python3" -I -B - <<'PY'
import json
import os
from pathlib import Path
import re

site_packages = Path(os.environ["SITE_PACKAGES"])
records = sorted(site_packages.glob("*.dist-info/direct_url.json"))
if len(records) != 42:
    raise SystemExit("unexpected direct URL record inventory")
for path in records:
    value = json.loads(path.read_text(encoding="utf-8"))
    if set(value) != {"archive_info", "url"}:
        raise SystemExit("unexpected direct URL record fields")
    archive = value["archive_info"]
    if not isinstance(archive, dict) or set(archive) != {"hash", "hashes"}:
        raise SystemExit("unexpected direct URL archive fields")
    hashes = archive["hashes"]
    if not isinstance(hashes, dict) or set(hashes) != {"sha256"}:
        raise SystemExit("unexpected direct URL digest fields")
    digest = hashes["sha256"]
    if (
        not isinstance(digest, str)
        or not re.fullmatch(r"[0-9a-f]{64}", digest)
        or archive["hash"] != f"sha256={digest}"
        or not value["url"].startswith(
            "file:///usr/src/wildbuzzard-searxng/wheels/"
        )
        or not value["url"].endswith(".whl")
    ):
        raise SystemExit("unexpected direct URL record identity")
for path in records:
    path.unlink()
if list(site_packages.glob("*.dist-info/direct_url.json")):
    raise SystemExit("direct URL records remain in runtime")
PY
RUNTIME_STAGE=$RUNTIME_STAGE \
  "$RUNTIME_STAGE/python/bin/python3" -I -B - <<'PY'
import base64
import csv
import hashlib
import os
from pathlib import Path

root = Path(os.environ["RUNTIME_STAGE"]).resolve()
python_root = root / "python"
site_packages = python_root / "lib" / "python3.14" / "site-packages"
for record in sorted(site_packages.glob("*.dist-info/RECORD")):
    entries = {}
    with record.open(encoding="utf-8", newline="") as stream:
        for relative, _digest, _size in csv.reader(stream):
            if relative in entries:
                raise SystemExit(f"duplicate RECORD path in {record}: {relative}")
            target = (site_packages / relative).resolve()
            try:
                target.relative_to(python_root)
            except ValueError as error:
                raise SystemExit(f"RECORD path escapes runtime: {relative}") from error
            if not target.is_file():
                continue
            entries[relative] = target
    record_relative = record.relative_to(site_packages).as_posix()
    entries[record_relative] = record
    rows = []
    for relative, target in sorted(entries.items()):
        if target == record:
            rows.append((relative, "", ""))
            continue
        data = target.read_bytes()
        digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=")
        rows.append((relative, f"sha256={digest.decode()}", str(len(data))))
    with record.open("w", encoding="utf-8", newline="") as stream:
        csv.writer(stream, lineterminator="\n").writerows(rows)
PY
find "$RUNTIME_STAGE" -exec touch -h --date="@$SOURCE_DATE_EPOCH" {} +

SOURCE_STAGE="$WORK_DIR/corresponding-source"
BUNDLE_SOURCE_ROOT="$SOURCE_STAGE/wildbuzzard/third_party/agpl/searxng"
BUNDLE_CACHE="$SOURCE_STAGE/cache"
mkdir -p -- \
  "$BUNDLE_SOURCE_ROOT" \
  "$BUNDLE_CACHE/sources" \
  "$BUNDLE_CACHE/build-tools" \
  "$BUNDLE_CACHE/build-tool-sources" \
  "$BUNDLE_CACHE/native-sources" \
  "$BUNDLE_CACHE/toolchain" \
  "$BUNDLE_CACHE/toolchain-sources" \
  "$SOURCE_STAGE/wildbuzzard/managed-services/searxng" \
  "$SOURCE_STAGE/wildbuzzard/scripts"
cp -a -- "$SOURCE_ROOT/upstream" "$BUNDLE_SOURCE_ROOT/upstream"
cp -- \
  "$SOURCE_ROOT/README.md" \
  "$SOURCE_ROOT/UPSTREAM.toml" \
  "$SOURCE_ROOT/LICENSE" \
  "$RUNTIME_LOCK" \
  "$BUILD_LOCK" \
  "$BUILD_SOURCE_LOCK" \
  "$NATIVE_LOCK" \
  "$TOOLCHAIN_LOCK" \
  "$CARGO_VENDOR_LOCK" \
  "$CARGO_COMPONENTS_LOCK" \
  "$POLICY" \
  "$CARGO_VENDOR_ARCHIVE" \
  "$BUNDLE_SOURCE_ROOT/"
cp -- \
  "$CACHE_DIR/sources/$SEARXNG_ARCHIVE" \
  "$CACHE_DIR/sources/$PYTHON_ARCHIVE" \
  "$BUNDLE_CACHE/sources/"
while IFS=$'\t' read -r _name _version filename _digest _url; do
  [[ -n "$filename" && ${_name:0:1} != '#' ]] || continue
  cp -- "$CACHE_DIR/sources/$filename" "$BUNDLE_CACHE/sources/"
done < "$RUNTIME_LOCK"
while IFS=$'\t' read -r _name _version filename _digest _url; do
  [[ -n "$filename" && ${_name:0:1} != '#' ]] || continue
  cp -- "$CACHE_DIR/build-tools/$filename" "$BUNDLE_CACHE/build-tools/"
done < "$BUILD_LOCK"
while IFS=$'\t' read -r _name _version filename _digest _url; do
  [[ -n "$filename" && ${_name:0:1} != '#' ]] || continue
  cp -- "$CACHE_DIR/build-tool-sources/$filename" "$BUNDLE_CACHE/build-tool-sources/"
done < "$BUILD_SOURCE_LOCK"
while IFS=$'\t' read -r _name _version filename _digest _size _license _url; do
  [[ -n "$filename" && ${_name:0:1} != '#' ]] || continue
  cp -- "$CACHE_DIR/native-sources/$filename" "$BUNDLE_CACHE/native-sources/"
done < "$NATIVE_LOCK"
while IFS=$'\t' read -r _name _version binary _binary_digest _binary_size source _source_digest _source_size _license _binary_url _source_url; do
  [[ -n "$binary" && ${_name:0:1} != '#' ]] || continue
  cp -- "$CACHE_DIR/toolchain/$binary" "$BUNDLE_CACHE/toolchain/"
  cp -- "$CACHE_DIR/toolchain-sources/$source" "$BUNDLE_CACHE/toolchain-sources/"
done < "$TOOLCHAIN_LOCK"
cp -- \
  "$MANAGED_ROOT/README.md" \
  "$MANAGED_ROOT/searxng_service.py" \
  "$MANAGED_ROOT/test_searxng_service.py" \
  "$SOURCE_STAGE/wildbuzzard/managed-services/searxng/"
cp -- \
  "$SCRIPT_DIR/build-searxng-runtime.sh" \
  "$SCRIPT_DIR/build-searxng-native-deps.sh" \
  "$SCRIPT_DIR/import-searxng-source.sh" \
  "$SOURCE_STAGE/wildbuzzard/scripts/"
cat > "$SOURCE_STAGE/BUILDING.md" <<'EOF'
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Building the SearXNG runtime

This archive contains the repository-relative source tree and a complete
verified cache. From the archive root, build without network access with:

```sh
./wildbuzzard/scripts/build-searxng-runtime.sh \
  --output /absolute/path/outside-this-tree \
  --cache "$PWD/cache" \
  --offline
```
EOF
find "$SOURCE_STAGE" -type d -exec chmod 755 {} +
find "$SOURCE_STAGE" \
  -path "$BUNDLE_SOURCE_ROOT/upstream" -prune -o \
  -type f -exec chmod 644 {} +
find "$SOURCE_STAGE/wildbuzzard/scripts" -type f -exec chmod 755 {} +
SOURCE_ARCHIVE="$OUTPUT_DIR/wildbuzzard-searxng-$RUNTIME_VERSION-source.tar.xz"
tar --sort=name \
  --mtime="@$SOURCE_DATE_EPOCH" \
  --owner=0 --group=0 --numeric-owner \
  --mode='u+rwX,go+rX,go-w' \
  -cJf "$SOURCE_ARCHIVE" \
  -C "$SOURCE_STAGE" .
SOURCE_SHA256=$(sha256sum "$SOURCE_ARCHIVE" | cut -d' ' -f1)

RUNTIME_LOCK_SHA256=$(sha256sum "$RUNTIME_LOCK" | cut -d' ' -f1)
BUILD_LOCK_SHA256=$(sha256sum "$BUILD_LOCK" | cut -d' ' -f1)
BUILD_SOURCE_LOCK_SHA256=$(sha256sum "$BUILD_SOURCE_LOCK" | cut -d' ' -f1)
NATIVE_LOCK_SHA256=$(sha256sum "$NATIVE_LOCK" | cut -d' ' -f1)
TOOLCHAIN_LOCK_SHA256=$(sha256sum "$TOOLCHAIN_LOCK" | cut -d' ' -f1)
CARGO_VENDOR_LOCK_SHA256=$(sha256sum "$CARGO_VENDOR_LOCK" | cut -d' ' -f1)
CARGO_COMPONENTS_LOCK_SHA256=$(sha256sum "$CARGO_COMPONENTS_LOCK" | cut -d' ' -f1)
POLICY_SHA256=$(sha256sum "$POLICY" | cut -d' ' -f1)
RUNTIME_MANIFEST="$RUNTIME_STAGE/wildbuzzard-runtime.json"
SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH \
RUNTIME_STAGE=$RUNTIME_STAGE \
RUNTIME_MANIFEST=$RUNTIME_MANIFEST \
CORRESPONDING_SOURCE_SHA256=$SOURCE_SHA256 \
RUNTIME_LOCK_SHA256=$RUNTIME_LOCK_SHA256 \
BUILD_LOCK_SHA256=$BUILD_LOCK_SHA256 \
BUILD_SOURCE_LOCK_SHA256=$BUILD_SOURCE_LOCK_SHA256 \
NATIVE_LOCK_SHA256=$NATIVE_LOCK_SHA256 \
TOOLCHAIN_LOCK_SHA256=$TOOLCHAIN_LOCK_SHA256 \
CARGO_VENDOR_LOCK_SHA256=$CARGO_VENDOR_LOCK_SHA256 \
CARGO_COMPONENTS_LOCK_SHA256=$CARGO_COMPONENTS_LOCK_SHA256 \
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
if any(entry["path"].endswith("/direct_url.json") for entry in files):
    raise SystemExit("runtime manifest contains a direct URL record")
manifest = {
    "schema": 1,
    "component": "searxng",
    "runtimeVersion": "2026.8.6+b023a28ba",
    "upstreamCommit": "b023a28bab8839dba9eac96e9a51cc91bbd0a267",
    "upstreamTree": "d2dc5354fe2281abd59f6734851bd586e6806631",
    "upstreamSourceArchiveSha256": "f5ab68baa420f26ac0d6b3fed1a8e5754bbe1fd31357c41271449980d3df779e",
    "pythonVersion": "3.14.6",
    "pythonSourceSha256": "143b1dddefaec3bd2e21e3b839b34a2b7fb9842272883c576420d605e9f30c63",
    "dependencyLockSha256": os.environ["RUNTIME_LOCK_SHA256"],
    "buildToolsLockSha256": os.environ["BUILD_LOCK_SHA256"],
    "buildToolSourcesLockSha256": os.environ["BUILD_SOURCE_LOCK_SHA256"],
    "nativeSourcesLockSha256": os.environ["NATIVE_LOCK_SHA256"],
    "toolchainLockSha256": os.environ["TOOLCHAIN_LOCK_SHA256"],
    "granianCargoVendorLockSha256": os.environ["CARGO_VENDOR_LOCK_SHA256"],
    "granianCargoComponentsLockSha256": os.environ["CARGO_COMPONENTS_LOCK_SHA256"],
    "compiler": "Zig 0.15.2",
    "compilerTarget": "x86_64-linux-gnu.2.28",
    "rustToolchain": "Rust 1.96.0 (ac68faa20)",
    "providerPolicySha256": os.environ["POLICY_SHA256"],
    "protocolVersion": 1,
    "platform": "linux",
    "architecture": "x86_64",
    "license": "AGPL-3.0-or-later",
    "correspondingSource": "wildbuzzard-searxng-2026.8.6+b023a28ba-source.tar.xz",
    "correspondingSourceSha256": os.environ["CORRESPONDING_SOURCE_SHA256"],
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

RUNTIME_SHA256=$(sha256sum "$RUNTIME_ARCHIVE" | cut -d' ' -f1)
BUILD_ENVIRONMENT="$OUTPUT_DIR/wildbuzzard-searxng-$RUNTIME_VERSION-build-environment.json"
ZIG="$ZIG_ROOT/zig" RUSTC="$RUST_PREFIX/bin/rustc" CARGO="$RUST_PREFIX/bin/cargo" \
STRIP_TOOL="$STRIP_TOOL" \
ARCHIVE_SCANNER_PYTHON=$ARCHIVE_SCANNER_PYTHON \
ARCHIVE_SCANNER_VERSION=$ARCHIVE_SCANNER_VERSION \
ARCHIVE_SCANNER_SHA256=$ARCHIVE_SCANNER_SHA256 \
BUILD_ENVIRONMENT=$BUILD_ENVIRONMENT \
  "$RUNTIME_STAGE/python/bin/python3" -I -B - <<'PY'
import json
import os
import subprocess
from pathlib import Path

def version(command):
    lines = subprocess.run(
        command,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    ).stdout.splitlines()
    return next(line for line in lines if line.strip())

record = {
    "schema": 1,
    "compiler": version([os.environ["ZIG"], "version"]),
    "compilerTarget": "x86_64-linux-gnu.2.28",
    "linker": version([os.environ["ZIG"], "ld.lld", "--version"]),
    "strip": version([os.environ["STRIP_TOOL"], "--version"]),
    "rustc": version([os.environ["RUSTC"], "--version"]),
    "cargo": version([os.environ["CARGO"], "--version"]),
    "orchestrationTools": {
        "archiveScanner": {
            "path": os.environ["ARCHIVE_SCANNER_PYTHON"],
            "sha256": os.environ["ARCHIVE_SCANNER_SHA256"],
            "version": os.environ["ARCHIVE_SCANNER_VERSION"],
        },
        "bash": version(["bash", "--version"]),
        "make": version(["make", "--version"]),
        "perl": version(["perl", "--version"]),
        "pkg-config": version(["pkg-config", "--version"]),
        "readelf": version(["readelf", "--version"]),
        "tar": version(["tar", "--version"]),
        "xz": version(["xz", "--version"]),
    },
    "sourceDateEpoch": 1786030997,
    "toolchainSource": {
        "rustc": "b99ce16cdf0ecfc761b585ac84d131b46733465a02f8ecd0ff2de9713c62ee09",
        "zig": "d9b30c7aa983fcff5eed2084d54ae83eaafe7ff3a84d8fb754d854165a6e521c",
    },
}
Path(os.environ["BUILD_ENVIRONMENT"]).write_text(
    json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n",
    encoding="utf-8",
)
PY
BUILD_ENVIRONMENT_SHA256=$(sha256sum "$BUILD_ENVIRONMENT" | cut -d' ' -f1)
cat > "$OUTPUT_DIR/wildbuzzard-searxng-$RUNTIME_VERSION-build.json" <<EOF
{"buildEnvironment":"$(basename -- "$BUILD_ENVIRONMENT")","buildEnvironmentSha256":"$BUILD_ENVIRONMENT_SHA256","runtimeArchive":"$(basename -- "$RUNTIME_ARCHIVE")","runtimeArchiveSha256":"$RUNTIME_SHA256","schema":1,"sourceArchive":"$(basename -- "$SOURCE_ARCHIVE")","sourceArchiveSha256":"$SOURCE_SHA256","sourceDateEpoch":$SOURCE_DATE_EPOCH}
EOF
touch --date="@$SOURCE_DATE_EPOCH" \
  "$RUNTIME_ARCHIVE" \
  "$SOURCE_ARCHIVE" \
  "$BUILD_ENVIRONMENT" \
  "$OUTPUT_DIR/wildbuzzard-searxng-$RUNTIME_VERSION-build.json"
WORK_DIR=$WORK_DIR \
ROOT_DIR=$ROOT_DIR \
OUTPUT_DIR=$OUTPUT_DIR \
CACHE_DIR=$CACHE_DIR \
SOURCE_STAGE=$SOURCE_STAGE \
RUNTIME_STAGE=$RUNTIME_STAGE \
RUNTIME_ARCHIVE=$RUNTIME_ARCHIVE \
SOURCE_ARCHIVE=$SOURCE_ARCHIVE \
BUILD_ENVIRONMENT=$BUILD_ENVIRONMENT \
BUILD_RECORD="$OUTPUT_DIR/wildbuzzard-searxng-$RUNTIME_VERSION-build.json" \
  "$ARCHIVE_SCANNER_PYTHON" -I -B - <<'PY'
import json
import os
from pathlib import Path, PurePosixPath
import tarfile
import zipfile

labels = {
    "work": os.environ["WORK_DIR"],
    "repository": os.environ["ROOT_DIR"],
    "output": os.environ["OUTPUT_DIR"],
    "cache": os.environ["CACHE_DIR"],
    "home": str(Path.home()),
    "corresponding-source": os.environ["SOURCE_STAGE"],
}
needles = {
    label: value.encode()
    for label, value in labels.items()
    if value and value != "/"
}
maximum = max(map(len, needles.values()))


def scan(stream, name):
    previous = b""
    while block := stream.read(1024 * 1024):
        payload = previous + block
        for label, needle in needles.items():
            if needle in payload:
                raise SystemExit(f"{label} path remains in release payload: {name}")
        previous = payload[-(maximum - 1) :]


runtime_root = Path(os.environ["RUNTIME_STAGE"])
for path in sorted(runtime_root.rglob("*")):
    if path.is_symlink():
        raise SystemExit(f"runtime contains a symlink: {path.relative_to(runtime_root)}")
    if path.is_file():
        with path.open("rb") as stream:
            scan(stream, path.relative_to(runtime_root).as_posix())

sysconfig_paths = list(
    (runtime_root / "python" / "lib" / "python3.14").glob(
        "_sysconfig_vars__*.json"
    )
)
if len(sysconfig_paths) != 1:
    raise SystemExit("release runtime has an unexpected sysconfig variables inventory")
if "userbase" in json.loads(sysconfig_paths[0].read_text(encoding="utf-8")):
    raise SystemExit("release sysconfig variables retain a build-time userbase")

with zipfile.ZipFile(os.environ["RUNTIME_ARCHIVE"]) as archive:
    for info in archive.infolist():
        path = PurePosixPath(info.filename)
        if path.is_absolute() or ".." in path.parts:
            raise SystemExit(f"unsafe runtime archive member: {info.filename}")
        with archive.open(info) as stream:
            scan(stream, f"runtime:{info.filename}")

with tarfile.open(os.environ["SOURCE_ARCHIVE"], "r:xz") as archive:
    for member in archive:
        path = PurePosixPath(member.name)
        if path.is_absolute() or ".." in path.parts:
            raise SystemExit(f"unsafe source archive member: {member.name}")
        if not member.isfile():
            continue
        stream = archive.extractfile(member)
        if stream is None:
            raise SystemExit(f"cannot read source archive member: {member.name}")
        with stream:
            scan(stream, f"source:{member.name}")

for name in ("BUILD_ENVIRONMENT", "BUILD_RECORD"):
    path = Path(os.environ[name])
    with path.open("rb") as stream:
        scan(stream, path.name)
PY
sha256sum \
  "$RUNTIME_ARCHIVE" \
  "$SOURCE_ARCHIVE" \
  "$BUILD_ENVIRONMENT" \
  "$OUTPUT_DIR/wildbuzzard-searxng-$RUNTIME_VERSION-build.json"
