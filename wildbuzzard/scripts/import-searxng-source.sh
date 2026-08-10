#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ROOT_DIR=$(cd -- "$SCRIPT_DIR/../.." && pwd)
SOURCE_ROOT="$ROOT_DIR/wildbuzzard/third_party/agpl/searxng"
DESTINATION="$SOURCE_ROOT/upstream"
COMMIT=b023a28bab8839dba9eac96e9a51cc91bbd0a267
TREE=d2dc5354fe2281abd59f6734851bd586e6806631
ARCHIVE_SHA256=f5ab68baa420f26ac0d6b3fed1a8e5754bbe1fd31357c41271449980d3df779e
ARCHIVE_SIZE=5984564
ARCHIVE_URL="https://codeload.github.com/searxng/searxng/tar.gz/$COMMIT"
MODE=check
ARCHIVE=

while (($#)); do
  case "$1" in
    --check)
      MODE=check
      ;;
    --import)
      MODE=import
      ;;
    --archive)
      shift
      ARCHIVE=${1:?--archive needs a path}
      ;;
    *)
      echo "usage: $0 [--check|--import] [--archive PATH]" >&2
      exit 2
      ;;
  esac
  shift
done

WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/wildbuzzard-searxng-import.XXXXXX")
trap 'rm -rf -- "$WORK_DIR"' EXIT

if [[ -z "$ARCHIVE" ]]; then
  ARCHIVE="$WORK_DIR/searxng.tar.gz"
  curl --fail --location --proto '=https' --tlsv1.2 --output "$ARCHIVE" "$ARCHIVE_URL"
fi

[[ $(stat -c '%s' "$ARCHIVE") == "$ARCHIVE_SIZE" ]]
echo "$ARCHIVE_SHA256  $ARCHIVE" | sha256sum --check --strict

PREFIX="searxng-$COMMIT/"
while IFS= read -r entry; do
  [[ "$entry" == "$PREFIX"* ]]
  relative=${entry#"$PREFIX"}
  [[ -z "$relative" || "$relative" != /* ]]
  IFS=/ read -r -a parts <<< "$relative"
  for part in "${parts[@]}"; do
    [[ "$part" != . && "$part" != .. ]]
  done
done < <(tar -tzf "$ARCHIVE")

tar -xzf "$ARCHIVE" -C "$WORK_DIR"
EXTRACTED="$WORK_DIR/searxng-$COMMIT"

[[ $(sha256sum "$EXTRACTED/LICENSE" | cut -d' ' -f1) == 57c8ff33c9c0cfc3ef00e650a1cc910d7ee479a8bc509f6c9209a7c2a11399d6 ]]
[[ $(sha256sum "$EXTRACTED/requirements.txt" | cut -d' ' -f1) == 221231dca45907be82ca9dae18327c17b6398def2c85385928a7ff3fb939c7f8 ]]
[[ $(sha256sum "$EXTRACTED/requirements-server.txt" | cut -d' ' -f1) == 5516fca313c4097662145a2db89cd9d2b662d6e71b30d85dfebf9f28e678a31f ]]

if [[ "$MODE" == check ]]; then
  diff --brief --recursive --no-dereference "$EXTRACTED" "$DESTINATION"
else
  rm -rf -- "$DESTINATION"
  mkdir -p -- "$DESTINATION"
  cp -a -- "$EXTRACTED/." "$DESTINATION/"
fi

printf 'verified SearXNG commit %s tree %s\n' "$COMMIT" "$TREE"
