#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail

if [[ $(id -u) -eq 0 ]]; then
  echo "run this comparison as an unprivileged user" >&2
  exit 1
fi

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
comparison_key_check=$(mktemp -d)
trap 'rm -rf -- "$comparison_key_check"' EXIT
comparison_uid=$(id -u)
awk -v uid="$comparison_uid" '$1 == uid ":" { print }' /proc/key-users > "$comparison_key_check/before"

set +e
unshare --user --map-root-user --net bash -c '
  set -euo pipefail
  ip link set lo up
  ip address add 11.0.0.1/32 dev lo
  exec python3 "$1/run-comparison.py" --direct-rootless --fixture-address 11.0.0.1 "${@:2}"
' bash "$script_dir" "$@"
comparison_status=$?
set -e

awk -v uid="$comparison_uid" '$1 == uid ":" { print }' /proc/key-users > "$comparison_key_check/after"
if ! cmp -s -- "$comparison_key_check/before" "$comparison_key_check/after"; then
  echo "the side-by-side comparison changed the current user's kernel key quota" >&2
  diff -u -- "$comparison_key_check/before" "$comparison_key_check/after" >&2 || true
  exit 1
fi
exit "$comparison_status"
