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
comparison_output=$(unshare --user --map-root-user --net bash -c '
  set -euo pipefail
  ip link set lo up
  ip address add 11.0.0.1/32 dev lo
  exec python3 "$1/run-pristine-adversarial.py" --direct-rootless --fixture-address 11.0.0.1 "${@:2}"
' bash "$script_dir" "$@")
comparison_status=$?
set -e
printf '%s\n' "$comparison_output"

awk -v uid="$comparison_uid" '$1 == uid ":" { print }' /proc/key-users > "$comparison_key_check/after"
comparison_unchanged=true
if ! cmp -s -- "$comparison_key_check/before" "$comparison_key_check/after"; then
  comparison_unchanged=false
fi
artifact_path=$(printf '%s\n' "$comparison_output" | tail -n 1)
if [[ -d "$artifact_path" && $(basename -- "$artifact_path") == adversarial-comparison-* ]]; then
  python3 - "$artifact_path/kernel-key-quota.json" "$comparison_key_check/before" "$comparison_key_check/after" "$comparison_unchanged" <<'PY'
import hashlib
import json
import os
import pathlib
import sys

destination, before_path, after_path, unchanged = sys.argv[1:]
before = pathlib.Path(before_path).read_bytes()
after = pathlib.Path(after_path).read_bytes()
value = {
    "schemaVersion": 1,
    "beforeSha256": hashlib.sha256(before).hexdigest(),
    "afterSha256": hashlib.sha256(after).hexdigest(),
    "unchanged": unchanged == "true",
}
descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
    json.dump(value, stream, indent=2, sort_keys=True)
    stream.write("\n")
PY
fi
if [[ $comparison_unchanged != true ]]; then
  echo "the adversarial comparison changed the current user's kernel key quota" >&2
  diff -u -- "$comparison_key_check/before" "$comparison_key_check/after" >&2 || true
  exit 1
fi
exit "$comparison_status"
