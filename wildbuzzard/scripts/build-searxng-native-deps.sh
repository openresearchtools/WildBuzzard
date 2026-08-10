#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail

SOURCE_CACHE=
ZIG_ROOT=
WORK_ROOT=
JOBS=
SOURCE_DATE_EPOCH=
STRIP_TOOL=

while (($#)); do
  case "$1" in
    --source-cache)
      shift
      SOURCE_CACHE=${1:?--source-cache needs a directory}
      ;;
    --zig-root)
      shift
      ZIG_ROOT=${1:?--zig-root needs a directory}
      ;;
    --work)
      shift
      WORK_ROOT=${1:?--work needs a directory}
      ;;
    --jobs)
      shift
      JOBS=${1:?--jobs needs a count}
      ;;
    --source-date-epoch)
      shift
      SOURCE_DATE_EPOCH=${1:?--source-date-epoch needs a value}
      ;;
    --strip-tool)
      shift
      STRIP_TOOL=${1:?--strip-tool needs a file}
      ;;
    *)
      echo "usage: $0 --source-cache DIR --zig-root DIR --work DIR --jobs N --source-date-epoch EPOCH --strip-tool FILE" >&2
      exit 2
      ;;
  esac
  shift
done

[[ -n "$SOURCE_CACHE" && -n "$ZIG_ROOT" && -n "$WORK_ROOT" ]]
[[ -n "$JOBS" && -n "$SOURCE_DATE_EPOCH" && -x "$STRIP_TOOL" ]]
[[ -x "$ZIG_ROOT/zig" ]]

umask 022
unset AR ARFLAGS AS CC CFLAGS CPP CPPFLAGS CXX CXXFLAGS LD LDFLAGS
unset NM OBJCOPY OBJDUMP RANLIB STRIP
unset CPATH C_INCLUDE_PATH CPLUS_INCLUDE_PATH OBJC_INCLUDE_PATH
unset LIBRARY_PATH COMPILER_PATH GCC_EXEC_PREFIX CONFIG_SITE CONFIG_SHELL
unset ENV BASH_ENV
unset MAKEFLAGS MFLAGS MAKELEVEL PKG_CONFIG_PATH PKG_CONFIG_LIBDIR
unset PKG_CONFIG PKG_CONFIG_SYSROOT_DIR LD_LIBRARY_PATH LD_PRELOAD LD_AUDIT
unset TAR_OPTIONS XZ_OPT XZ_DEFAULTS GZIP BZIP2
export LC_ALL=C
export TZ=UTC
export PATH=/usr/bin:/bin

INSTALL_PREFIX=/opt/wildbuzzard-searxng-native
DESTDIR="$WORK_ROOT/destdir"
PREFIX="$DESTDIR$INSTALL_PREFIX"
TOOLS="$WORK_ROOT/tools"
SOURCES="$WORK_ROOT/sources"
mkdir -p -- "$PREFIX" "$TOOLS" "$SOURCES"
export ZIG_GLOBAL_CACHE_DIR="$WORK_ROOT/zig-global-cache"
export ZIG_LOCAL_CACHE_DIR="$WORK_ROOT/zig-local-cache"
export TMPDIR="$WORK_ROOT/tmp"
mkdir -p -- "$ZIG_GLOBAL_CACHE_DIR" "$ZIG_LOCAL_CACHE_DIR" "$TMPDIR"

cat > "$TOOLS/cc" <<EOF
#!/bin/bash
set -eu
args=()
for arg in "\$@"; do
  case "\$arg" in
    --target=x86_64-unknown-linux-gnu)
      ;;
    -Wl,-h*)
      args+=("-Wl,-soname,\${arg#-Wl,-h}")
      ;;
    *)
      args+=("\$arg")
      ;;
  esac
done
exec "$ZIG_ROOT/zig" cc -target x86_64-linux-gnu.2.28 "\${args[@]}"
EOF
cat > "$TOOLS/c++" <<EOF
#!/bin/bash
set -eu
args=()
for arg in "\$@"; do
  case "\$arg" in
    --target=x86_64-unknown-linux-gnu)
      ;;
    -Wl,-h*)
      args+=("-Wl,-soname,\${arg#-Wl,-h}")
      ;;
    *)
      args+=("\$arg")
      ;;
  esac
done
exec "$ZIG_ROOT/zig" c++ -target x86_64-linux-gnu.2.28 "\${args[@]}"
EOF
cat > "$TOOLS/ar" <<EOF
#!/bin/sh
exec "$ZIG_ROOT/zig" ar "\$@"
EOF
cat > "$TOOLS/ranlib" <<EOF
#!/bin/sh
exec "$ZIG_ROOT/zig" ranlib "\$@"
EOF
cat > "$TOOLS/ld" <<EOF
#!/bin/sh
exec "$ZIG_ROOT/zig" ld.lld "\$@"
EOF
chmod 755 "$TOOLS/cc" "$TOOLS/c++" "$TOOLS/ar" "$TOOLS/ranlib" "$TOOLS/ld"

export PATH="$TOOLS:/usr/bin:/bin"
export CC=cc
export CXX=c++
export AR=ar
export RANLIB=ranlib
export LD=ld
LLVM_TOOLS=$(dirname -- "$STRIP_TOOL")
export NM="$LLVM_TOOLS/llvm-nm"
export OBJCOPY="$LLVM_TOOLS/llvm-objcopy"
export OBJDUMP="$LLVM_TOOLS/llvm-objdump"
export STRIP="$STRIP_TOOL"
export CFLAGS="-O2 -fPIC -ffile-prefix-map=$WORK_ROOT=/usr/src/wildbuzzard-searxng/native -ffile-prefix-map=$ZIG_ROOT=/usr/src/wildbuzzard-searxng/toolchain/zig"
export CPPFLAGS="-I$PREFIX/include"
NATIVE_RPATH='-Wl,-rpath,\$$ORIGIN'
export LDFLAGS="-L$PREFIX/lib $NATIVE_RPATH"
export LD_LIBRARY_PATH="$PREFIX/lib"
export PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig:$PREFIX/share/pkgconfig"
export PKG_CONFIG_PATH=
export PKG_CONFIG_SYSROOT_DIR="$DESTDIR"
export SOURCE_DATE_EPOCH
export ZERO_AR_DATE=1

tar -xzf "$SOURCE_CACHE/zlib-1.3.1.tar.gz" -C "$SOURCES"
(
  cd "$SOURCES/zlib-1.3.1"
  ./configure --prefix="$INSTALL_PREFIX" --static
  make -j "$JOBS"
  make DESTDIR="$DESTDIR" install
)

tar -xzf "$SOURCE_CACHE/openssl-3.5.5.tar.gz" -C "$SOURCES"
(
  cd "$SOURCES/openssl-3.5.5"
  CFLAGS="-O2 -fPIC" CPPFLAGS= LDFLAGS="$NATIVE_RPATH" ./Configure linux-x86_64 \
    --prefix="$INSTALL_PREFIX" \
    --openssldir=/etc/ssl \
    --libdir=lib \
    shared no-tests no-docs
  make -j "$JOBS"
  make DESTDIR="$DESTDIR" install_sw
)

tar -xzf "$SOURCE_CACHE/libffi-3.5.2.tar.gz" -C "$SOURCES"
(
  cd "$SOURCES/libffi-3.5.2"
  ./configure --prefix="$INSTALL_PREFIX" --disable-static --enable-shared
  make -j "$JOBS"
  make DESTDIR="$DESTDIR" install
)

tar -xzf "$SOURCE_CACHE/sqlite-autoconf-3460100.tar.gz" -C "$SOURCES"
(
  cd "$SOURCES/sqlite-autoconf-3460100"
  ./configure --prefix="$INSTALL_PREFIX" --disable-static --enable-shared
  make -j "$JOBS"
  make DESTDIR="$DESTDIR" install
)

tar -xJf "$SOURCE_CACHE/expat-2.7.3.tar.xz" -C "$SOURCES"
(
  cd "$SOURCES/expat-2.7.3"
  ./configure \
    --prefix="$INSTALL_PREFIX" \
    --disable-static \
    --enable-shared \
    --without-xmlwf \
    --without-docbook \
    --without-tests \
    --without-examples
  make -j "$JOBS"
  make DESTDIR="$DESTDIR" install
)

tar -xzf "$SOURCE_CACHE/yaml-0.2.5.tar.gz" -C "$SOURCES"
(
  cd "$SOURCES/yaml-0.2.5"
  ./configure --prefix="$INSTALL_PREFIX" --enable-static --disable-shared
  make -j "$JOBS"
  make DESTDIR="$DESTDIR" install
)

tar -xJf "$SOURCE_CACHE/libxml2-2.15.2.tar.xz" -C "$SOURCES"
(
  cd "$SOURCES/libxml2-2.15.2"
  ./configure \
    --prefix="$INSTALL_PREFIX" \
    --enable-static \
    --disable-shared \
    --without-python \
    --without-lzma \
    --without-zstd \
    --without-readline
  make -j "$JOBS"
  make DESTDIR="$DESTDIR" install
)

tar -xJf "$SOURCE_CACHE/libxslt-1.1.45.tar.xz" -C "$SOURCES"
(
  cd "$SOURCES/libxslt-1.1.45"
  ./configure \
    --prefix="$INSTALL_PREFIX" \
    --enable-static \
    --disable-shared \
    --without-python
  make -j "$JOBS"
  make DESTDIR="$DESTDIR" install
)

for library in \
  libcrypto.so.3 \
  libexpat.so.1 \
  libffi.so.8 \
  libsqlite3.so.0 \
  libssl.so.3; do
  [[ -f "$PREFIX/lib/$library" ]]
done

for library in libcrypto.so.3 libexpat.so.1 libffi.so.8 libsqlite3.so.0 libssl.so.3; do
  "$STRIP_TOOL" --strip-debug "$PREFIX/lib/$library"
done

mkdir -p -- "$WORK_ROOT/licenses"
cp -- "$SOURCES/expat-2.7.3/COPYING" "$WORK_ROOT/licenses/expat-MIT.txt"
cp -- "$SOURCES/libffi-3.5.2/LICENSE" "$WORK_ROOT/licenses/libffi-MIT.txt"
cp -- "$SOURCES/libxml2-2.15.2/Copyright" "$WORK_ROOT/licenses/libxml2-MIT.txt"
cp -- "$SOURCES/libxslt-1.1.45/Copyright" "$WORK_ROOT/licenses/libxslt-MIT.txt"
cp -- "$SOURCES/openssl-3.5.5/LICENSE.txt" "$WORK_ROOT/licenses/OpenSSL-Apache-2.0.txt"
cp -- "$SOURCES/sqlite-autoconf-3460100/README.txt" "$WORK_ROOT/licenses/SQLite-public-domain.txt"
cp -- "$SOURCES/yaml-0.2.5/License" "$WORK_ROOT/licenses/libyaml-MIT.txt"
cp -- "$SOURCES/zlib-1.3.1/LICENSE" "$WORK_ROOT/licenses/zlib-Zlib.txt"

printf '%s\n' "$PREFIX"
