#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail

if [[ $(id -u) -eq 0 ]]; then
  echo "run this comparison as an unprivileged user" >&2
  exit 1
fi

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
exec unshare --user --map-root-user --net bash -c '
  set -euo pipefail
  ip link set lo up
  ip address add 11.0.0.1/32 dev lo
  exec python3 "$1/run-comparison.py" --direct-rootless --fixture-address 11.0.0.1 "${@:2}"
' bash "$script_dir" "$@"
