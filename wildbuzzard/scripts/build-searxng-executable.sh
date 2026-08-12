#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail

export LC_ALL=C
export TZ=UTC
export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL=/dev/null
umask 022

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ROOT_DIR=$(cd -- "$SCRIPT_DIR/../.." && pwd)
SOURCE_ROOT="$ROOT_DIR/wildbuzzard/third_party/agpl/searxng"
LAUNCHER_ROOT="$ROOT_DIR/wildbuzzard/managed-services/searxng-executable"
TOOL_LOCK="$SOURCE_ROOT/executable-tools.lock"
RUNTIME_NAME=wildbuzzard-searxng-2026.8.6+b023a28ba-linux-x86_64.zip
ARTIFACT_NAME=wildbuzzard-searxng-2026.8.6+b023a28ba-linux-x86_64.AppImage
OUTPUT_DIR=
CACHE_DIR=
RUNTIME_ARCHIVE=
APPIMAGETOOL=
JOBS=
OFFLINE=0

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
    --runtime-archive)
      shift
      RUNTIME_ARCHIVE=${1:?--runtime-archive needs a file}
      ;;
    --appimagetool)
      shift
      APPIMAGETOOL=${1:?--appimagetool needs a file}
      ;;
    --jobs)
      shift
      JOBS=${1:?--jobs needs a count}
      ;;
    --offline)
      OFFLINE=1
      ;;
    *)
      echo "usage: $0 --output DIR [--cache DIR] [--runtime-archive FILE] [--appimagetool FILE] [--jobs N] [--offline]" >&2
      exit 2
      ;;
  esac
  shift
done

[[ -n "$OUTPUT_DIR" ]]
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]]
OUTPUT_DIR=$(realpath -m -- "$OUTPUT_DIR")
CACHE_DIR=$(realpath -m -- "${CACHE_DIR:-$OUTPUT_DIR/cache}")
case "$OUTPUT_DIR/" in
  "$ROOT_DIR/"*)
    echo "SearXNG executable output must be outside the source checkout" >&2
    exit 2
    ;;
esac
mkdir -p -- "$OUTPUT_DIR" "$CACHE_DIR/tools"
if [[ -e "$OUTPUT_DIR/$ARTIFACT_NAME" ]]; then
  echo "SearXNG executable already exists: $OUTPUT_DIR/$ARTIFACT_NAME" >&2
  exit 1
fi
WORK_DIR=$(mktemp -d "$OUTPUT_DIR/.searxng-executable.XXXXXX")
trap 'rm -rf -- "$WORK_DIR"' EXIT

IFS=$'\t' read -r tool_name tool_version tool_filename tool_digest tool_size _tool_license tool_url _tool_source < <(
  awk -F '\t' '$1 == "appimagetool" { print $0 }' "$TOOL_LOCK"
)
IFS=$'\t' read -r runtime_name runtime_version runtime_filename runtime_digest runtime_size _runtime_license runtime_derivation _runtime_source < <(
  awk -F '\t' '$1 == "appimage-runtime" { print $0 }' "$TOOL_LOCK"
)
[[ "$tool_name" == appimagetool && "$tool_version" == 5735cc5 ]]
[[ "$runtime_name" == appimage-runtime && "$runtime_version" == 5735cc5 ]]
[[ "$runtime_derivation" == "derived:$tool_filename:0:$runtime_size" ]]
if [[ -z "$APPIMAGETOOL" ]]; then
  APPIMAGETOOL="$CACHE_DIR/tools/$tool_filename"
  if [[ ! -f "$APPIMAGETOOL" ]]; then
    if [[ "$OFFLINE" == 1 ]]; then
      echo "missing offline appimagetool: $APPIMAGETOOL" >&2
      exit 1
    fi
    curl --disable --fail --location --proto '=https' --tlsv1.2 \
      --output "$APPIMAGETOOL.part" "$tool_url"
    mv -- "$APPIMAGETOOL.part" "$APPIMAGETOOL"
  fi
fi
APPIMAGETOOL=$(realpath -- "$APPIMAGETOOL")
echo "$tool_digest  $APPIMAGETOOL" | sha256sum --check --strict
[[ $(stat -c '%s' "$APPIMAGETOOL") == "$tool_size" ]]
chmod u+x "$APPIMAGETOOL"
APPIMAGE_RUNTIME="$WORK_DIR/$runtime_filename"
cp -- "$APPIMAGETOOL" "$APPIMAGE_RUNTIME"
truncate -s "$runtime_size" "$APPIMAGE_RUNTIME"
echo "$runtime_digest  $APPIMAGE_RUNTIME" | sha256sum --check --strict
chmod 755 "$APPIMAGE_RUNTIME"

if [[ -z "$RUNTIME_ARCHIVE" ]]; then
  RUNTIME_BUILD="$WORK_DIR/runtime-build"
  runtime_args=(--output "$RUNTIME_BUILD" --cache "$CACHE_DIR/runtime")
  [[ -z "$JOBS" ]] || runtime_args+=(--jobs "$JOBS")
  [[ "$OFFLINE" == 0 ]] || runtime_args+=(--offline)
  "$SCRIPT_DIR/build-searxng-runtime.sh" "${runtime_args[@]}"
  RUNTIME_ARCHIVE="$RUNTIME_BUILD/$RUNTIME_NAME"
fi
RUNTIME_ARCHIVE=$(realpath -- "$RUNTIME_ARCHIVE")

CATALOG="$WORK_DIR/engine-catalog.json"
python3 -I -B "$SCRIPT_DIR/derive-searxng-engine-catalog.py" \
  --source-root "$SOURCE_ROOT" \
  --output "$CATALOG"

APP_DIR="$WORK_DIR/WildBuzzardSearXNG.AppDir"
python3 -I -B "$SCRIPT_DIR/prepare-searxng-executable.py" \
  --runtime-archive "$RUNTIME_ARCHIVE" \
  --catalog "$CATALOG" \
  --launcher-root "$LAUNCHER_ROOT" \
  --app-dir "$APP_DIR" \
  --appimagetool-sha256 "$tool_digest" \
  --appimage-runtime-sha256 "$runtime_digest"

RUNTIME_ROOT="$APP_DIR/usr/lib/wildbuzzard-searxng"
SORT_FILE="$WORK_DIR/squashfs-sort"
find "$APP_DIR" -mindepth 1 -printf '%P\n' | LC_ALL=C sort | \
  awk '{ printf "%s %d\n", $0, 32767 - NR }' > "$SORT_FILE"
LD_LIBRARY_PATH="$RUNTIME_ROOT/python/lib" \
OPENSSL_MODULES="$RUNTIME_ROOT/python/lib" \
  "$RUNTIME_ROOT/python/bin/python3" -I -B \
    "$RUNTIME_ROOT/libexec/searxng_executable.py" \
    --runtime-root "$RUNTIME_ROOT" catalog

ARTIFACT="$OUTPUT_DIR/$ARTIFACT_NAME"
ARCH=x86_64 APPIMAGE_EXTRACT_AND_RUN=1 \
  "$APPIMAGETOOL" --comp xz --runtime-file "$APPIMAGE_RUNTIME" \
    --mksquashfs-opt=-processors --mksquashfs-opt=1 \
    --mksquashfs-opt=-sort --mksquashfs-opt="$SORT_FILE" \
    --mksquashfs-opt=-no-exports \
    --mksquashfs-opt=-all-time --mksquashfs-opt=1786030997 \
    "$APP_DIR" "$ARTIFACT"
chmod 755 "$ARTIFACT"
artifact_size=$(stat -c '%s' "$ARTIFACT")
if ((artifact_size >= 2 * 1024 * 1024 * 1024)); then
  echo "SearXNG executable exceeds the 2 GiB gate" >&2
  exit 1
fi
artifact_digest=$(sha256sum "$ARTIFACT" | cut -d' ' -f1)
printf '%s  %s\n' "$artifact_digest" "$ARTIFACT_NAME" > "$ARTIFACT.sha256"
cp -- "$RUNTIME_ROOT/wildbuzzard-executable.json" \
  "$OUTPUT_DIR/wildbuzzard-searxng-2026.8.6+b023a28ba-manifest.json"
ARTIFACT_NAME="$ARTIFACT_NAME" \
ARTIFACT_SIZE="$artifact_size" \
ARTIFACT_SHA256="$artifact_digest" \
RUNTIME_ARCHIVE_SHA256=$(sha256sum "$RUNTIME_ARCHIVE" | cut -d' ' -f1) \
TOOL_SHA256="$tool_digest" \
RUNTIME_SHA256="$runtime_digest" \
OUTPUT="$OUTPUT_DIR/wildbuzzard-searxng-2026.8.6+b023a28ba-build.json" \
  python3 -I -B - <<'PY'
import json
import os
from pathlib import Path

value = {
    "schema": 1,
    "artifact": os.environ["ARTIFACT_NAME"],
    "artifactBytes": int(os.environ["ARTIFACT_SIZE"]),
    "artifactSha256": os.environ["ARTIFACT_SHA256"],
    "runtimeArchiveSha256": os.environ["RUNTIME_ARCHIVE_SHA256"],
    "appImageToolSha256": os.environ["TOOL_SHA256"],
    "appImageRuntimeSha256": os.environ["RUNTIME_SHA256"],
    "upstreamCommit": "b023a28bab8839dba9eac96e9a51cc91bbd0a267",
    "sourceDateEpoch": 1786030997,
}
Path(os.environ["OUTPUT"]).write_text(
    json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n",
    encoding="utf-8",
)
PY
APPIMAGE_EXTRACT_AND_RUN=1 "$ARTIFACT" catalog
echo "SearXNG executable: $ARTIFACT ($artifact_size bytes, sha256 $artifact_digest)"
