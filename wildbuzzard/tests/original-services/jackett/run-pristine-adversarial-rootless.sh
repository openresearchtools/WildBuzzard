#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail

if [[ $(id -u) -eq 0 ]]; then
  echo "run this comparison as an unprivileged user" >&2
  exit 1
fi

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
pinned_oracle_image=mcr.microsoft.com/dotnet/sdk@sha256:6e6542a43b6bf3c5ecfa80dd33c79c9fd09d58f95f4ebacd14fa056275b25164
oracle_image=
pristine_runtime=
pristine_build_record=
pristine_source=
mini_runtime=
mini_manifest=
mini_fixture_runtime=
mini_fixture_manifest=
artifact_root=

usage() {
  echo "usage: $0 --oracle-image $pinned_oracle_image --pristine-runtime DIR --pristine-build-record FILE --pristine-source DIR --mini-runtime DIR --mini-manifest FILE --mini-fixture-runtime DIR --mini-fixture-manifest FILE --artifact-root DIR" >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --oracle-image) oracle_image=${2:?}; shift 2 ;;
    --pristine-runtime) pristine_runtime=${2:?}; shift 2 ;;
    --pristine-build-record) pristine_build_record=${2:?}; shift 2 ;;
    --pristine-source) pristine_source=${2:?}; shift 2 ;;
    --mini-runtime) mini_runtime=${2:?}; shift 2 ;;
    --mini-manifest) mini_manifest=${2:?}; shift 2 ;;
    --mini-fixture-runtime) mini_fixture_runtime=${2:?}; shift 2 ;;
    --mini-fixture-manifest) mini_fixture_manifest=${2:?}; shift 2 ;;
    --artifact-root) artifact_root=${2:?}; shift 2 ;;
    *) usage; exit 2 ;;
  esac
done

if [[ "$oracle_image" != "$pinned_oracle_image" ]] || [[ -z "$pristine_runtime" || -z "$pristine_build_record" || -z "$pristine_source" || -z "$mini_runtime" || -z "$mini_manifest" || -z "$mini_fixture_runtime" || -z "$mini_fixture_manifest" || -z "$artifact_root" ]]; then
  usage
  exit 2
fi

pristine_runtime=$(realpath -- "$pristine_runtime")
pristine_build_record=$(realpath -- "$pristine_build_record")
pristine_source=$(realpath -- "$pristine_source")
mini_runtime=$(realpath -- "$mini_runtime")
mini_manifest=$(realpath -- "$mini_manifest")
mini_fixture_runtime=$(realpath -- "$mini_fixture_runtime")
mini_fixture_manifest=$(realpath -- "$mini_fixture_manifest")
artifact_root=$(realpath -m -- "$artifact_root")
mkdir -p -- "$artifact_root"

podman_args=()
python_oci_args=()
if [[ -n "${JACKETT_ORACLE_OCI_RUNTIME:-}" ]]; then
  oci_runtime=$(realpath -- "$JACKETT_ORACLE_OCI_RUNTIME")
  if [[ ! -x "$oci_runtime" ]]; then
    echo "the selected OCI runtime is not executable" >&2
    exit 1
  fi
  podman_args+=(--runtime "$oci_runtime")
  python_oci_args+=(--oci-runtime "$oci_runtime")
fi
if [[ $(podman "${podman_args[@]}" info --format '{{.Host.Security.Rootless}}') != true ]]; then
  echo "the pristine oracle requires rootless Podman" >&2
  exit 1
fi

run_token=$(python3 -c 'import secrets; print(secrets.token_hex(16))')
container_name="wildbuzzard-jackett-pristine-$run_token"
comparison_key_check=$(mktemp -d)
cleanup() {
  if podman "${podman_args[@]}" container exists "$container_name"; then
    owner=$(podman "${podman_args[@]}" container inspect \
      --format '{{ index .Config.Labels "org.wildbuzzard.jackett-oracle-run" }}' \
      "$container_name" 2>/dev/null || true)
    if [[ "$owner" == "$run_token" ]]; then
      podman "${podman_args[@]}" rm -f "$container_name" >/dev/null 2>&1 || true
    fi
  fi
  find "$comparison_key_check" -depth -delete >/dev/null 2>&1 || true
}
trap cleanup EXIT

comparison_uid=$(id -u)
awk -v uid="$comparison_uid" '$1 == uid ":" { print }' /proc/key-users > "$comparison_key_check/before"
set +e
comparison_output=$(python3 "$script_dir/run-pristine-adversarial.py" \
  --pristine-runtime "$pristine_runtime" \
  --pristine-build-record "$pristine_build_record" \
  --pristine-source "$pristine_source" \
  --mini-runtime "$mini_runtime" \
  --mini-manifest "$mini_manifest" \
  --mini-fixture-runtime "$mini_fixture_runtime" \
  --mini-fixture-manifest "$mini_fixture_manifest" \
  --oracle-image "$oracle_image" \
  --container-name "$container_name" \
  --run-token "$run_token" \
  --fixture-address 127.0.0.1 \
  --fixture-port 18080 \
  --artifact-root "$artifact_root" \
  "${python_oci_args[@]}")
comparison_status=$?
set -e
printf '%s\n' "$comparison_output"

awk -v uid="$comparison_uid" '$1 == uid ":" { print }' /proc/key-users > "$comparison_key_check/after"
comparison_unchanged=true
if ! cmp -s -- "$comparison_key_check/before" "$comparison_key_check/after"; then
  comparison_unchanged=false
fi
container_absent=true
if podman "${podman_args[@]}" container exists "$container_name"; then
  container_absent=false
fi
artifact_path=$(printf '%s\n' "$comparison_output" | sed -n '$p')
case "$artifact_path" in
  "$artifact_root"/adversarial-comparison-*)
    if [[ -d "$artifact_path" ]]; then
      python3 - "$artifact_path/kernel-key-quota.json" "$comparison_key_check/before" "$comparison_key_check/after" "$comparison_unchanged" "$container_absent" <<'PY'
import hashlib
import json
import pathlib
import sys

destination, before_path, after_path, unchanged, container_absent = sys.argv[1:]
before = pathlib.Path(before_path).read_bytes()
after = pathlib.Path(after_path).read_bytes()
pathlib.Path(destination).write_text(
    json.dumps(
        {
            "afterSha256": hashlib.sha256(after).hexdigest(),
            "beforeSha256": hashlib.sha256(before).hexdigest(),
            "pristineContainerAbsent": container_absent == "true",
            "schemaVersion": 1,
            "unchanged": unchanged == "true",
        },
        indent=2,
        sort_keys=True,
    )
    + "\n",
    encoding="utf-8",
)
PY
    fi
    ;;
esac
if [[ "$comparison_unchanged" != true ]]; then
  echo "the OCI comparison changed the current user's kernel key quota" >&2
  exit 1
fi
if [[ "$container_absent" != true ]]; then
  echo "the pristine oracle container survived comparison cleanup" >&2
  exit 1
fi
exit "$comparison_status"
