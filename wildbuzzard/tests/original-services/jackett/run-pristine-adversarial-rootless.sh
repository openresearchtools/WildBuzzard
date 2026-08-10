#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail

if [[ $(id -u) -eq 0 ]]; then
  echo "run this oracle as an unprivileged user" >&2
  exit 1
fi

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
oracle_key_check=$(mktemp -d)
trap 'rm -rf -- "$oracle_key_check"' EXIT
oracle_uid=$(id -u)
awk -v uid="$oracle_uid" '$1 == uid ":" { print }' /proc/key-users > "$oracle_key_check/before"

set +e
unshare --user --map-root-user --net bash -c '
  set -euo pipefail
  ip link set lo up
  ip address add 11.0.0.1/32 dev lo
  exec python3 "$1/run-pristine-adversarial.py" --direct-rootless --fixture-address 11.0.0.1 "${@:2}"
' bash "$script_dir" "$@"
oracle_status=$?
set -e

awk -v uid="$oracle_uid" '$1 == uid ":" { print }' /proc/key-users > "$oracle_key_check/after"
if ! cmp -s -- "$oracle_key_check/before" "$oracle_key_check/after"; then
  echo "the pristine oracle changed the current user's kernel key quota" >&2
  diff -u -- "$oracle_key_check/before" "$oracle_key_check/after" >&2 || true
  exit 1
fi
exit "$oracle_status"
