#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail

real_crun=${CRUN_REAL_PATH:-/usr/bin/crun}
if [[ "$real_crun" != /* || ! -x "$real_crun" ]]; then
  echo "CRUN_REAL_PATH must name an absolute executable" >&2
  exit 1
fi

arguments=()
inserted=false
for argument in "$@"; do
  arguments+=("$argument")
  if [[ "$inserted" == false && ("$argument" == create || "$argument" == run) ]]; then
    arguments+=(--no-new-keyring)
    inserted=true
  fi
done

exec "$real_crun" "${arguments[@]}"
