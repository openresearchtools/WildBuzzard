#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail

if [[ $(id -u) -eq 0 ]]; then
  echo "run this comparison as an unprivileged user" >&2
  exit 1
fi

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
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
  echo "usage: $0 --oracle-image IMAGE@sha256:DIGEST --pristine-runtime DIR --pristine-build-record FILE --pristine-source DIR --mini-runtime DIR --mini-manifest FILE --mini-fixture-runtime DIR --mini-fixture-manifest FILE --artifact-root DIR" >&2
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

if [[ ! "$oracle_image" =~ @sha256:[0-9a-f]{64}$ ]] || [[ -z "$pristine_runtime" || -z "$pristine_build_record" || -z "$pristine_source" || -z "$mini_runtime" || -z "$mini_manifest" || -z "$mini_fixture_runtime" || -z "$mini_fixture_manifest" || -z "$artifact_root" ]]; then
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
if [[ -n "${JACKETT_ORACLE_OCI_RUNTIME:-}" ]]; then
  podman_args+=(--runtime "$JACKETT_ORACLE_OCI_RUNTIME")
fi
if [[ $(podman "${podman_args[@]}" info --format '{{.Host.Security.Rootless}}') != true ]]; then
  echo "the comparison requires rootless Podman" >&2
  exit 1
fi

podman "${podman_args[@]}" pull "$oracle_image" >/dev/null
platform=$(podman "${podman_args[@]}" image inspect "$oracle_image" --format '{{.Os}}/{{.Architecture}}')
oracle_image_id=$(podman "${podman_args[@]}" image inspect "$oracle_image" --format '{{.Id}}')
if [[ "$platform" != linux/amd64 || ! "$oracle_image_id" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "the pinned oracle image identity must be available for linux/amd64" >&2
  exit 1
fi

comparison_key_check=$(mktemp -d)
network_name="wildbuzzard-jackett-oracle-$$-${RANDOM}"
container_name="wildbuzzard-jackett-oracle-$$-${RANDOM}"
cleanup() {
  podman "${podman_args[@]}" rm -f "$container_name" >/dev/null 2>&1 || true
  podman "${podman_args[@]}" network rm -f "$network_name" >/dev/null 2>&1 || true
  rm -rf -- "$comparison_key_check"
}
trap cleanup EXIT

comparison_uid=$(id -u)
awk -v uid="$comparison_uid" '$1 == uid ":" { print }' /proc/key-users > "$comparison_key_check/before"
podman "${podman_args[@]}" network create --internal \
  --subnet 11.0.0.0/24 --gateway 11.0.0.1 "$network_name" >/dev/null
network_internal=$(podman "${podman_args[@]}" network inspect "$network_name" --format '{{.Internal}}')
if [[ "$network_internal" != true ]]; then
  echo "the comparison network is not internal" >&2
  exit 1
fi
image_digest=${oracle_image##*@}
python3 - "$comparison_key_check/oci-evidence.json" "$oracle_image" "$image_digest" "$oracle_image_id" "$platform" <<'PY'
import json
import sys

destination, image, digest, image_id, platform = sys.argv[1:]
document = {
    "schemaVersion": 1,
    "rootless": True,
    "image": image,
    "imageDigest": digest,
    "imageId": image_id,
    "platform": platform,
    "networkInternal": True,
    "readOnlyMounts": {
        name: True
        for name in (
            "comparisonSource",
            "pristineRuntime",
            "pristineBuildRecord",
            "pristineSource",
            "miniRuntime",
            "miniManifest",
            "miniFixtureRuntime",
            "miniFixtureManifest",
        )
    },
}
with open(destination, "x", encoding="utf-8") as stream:
    json.dump(document, stream, indent=2, sort_keys=True)
    stream.write("\n")
PY

set +e
comparison_output=$(podman "${podman_args[@]}" run --rm --name "$container_name" \
  --network "$network_name" \
  --ip 11.0.0.2 \
  --userns=keep-id \
  --cap-drop=all \
  --security-opt=no-new-privileges \
  --pids-limit=512 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=1g \
  -e PYTHONDONTWRITEBYTECODE=1 \
  -v "$script_dir:/oracle:ro,Z" \
  -v "$pristine_runtime:/inputs/pristine-runtime:ro,Z" \
  -v "$pristine_build_record:/inputs/pristine-build-record.json:ro,Z" \
  -v "$pristine_source:/inputs/pristine-source:ro,Z" \
  -v "$mini_runtime:/inputs/mini-runtime:ro,Z" \
  -v "$mini_manifest:/inputs/mini-manifest.json:ro,Z" \
  -v "$mini_fixture_runtime:/inputs/mini-fixture-runtime:ro,Z" \
  -v "$mini_fixture_manifest:/inputs/mini-fixture-manifest.json:ro,Z" \
  -v "$comparison_key_check/oci-evidence.json:/inputs/oci-evidence.json:ro,Z" \
  -v "$artifact_root:/artifacts:rw,Z" \
  "$oracle_image" \
  python3 /oracle/run-pristine-adversarial.py \
    --pristine-runtime /inputs/pristine-runtime \
    --pristine-build-record /inputs/pristine-build-record.json \
    --pristine-source /inputs/pristine-source \
    --mini-runtime /inputs/mini-runtime \
    --mini-manifest /inputs/mini-manifest.json \
    --mini-fixture-runtime /inputs/mini-fixture-runtime \
    --mini-fixture-manifest /inputs/mini-fixture-manifest.json \
    --oci-evidence /inputs/oci-evidence.json \
    --fixture-address 11.0.0.2 \
    --fixture-port 18080 \
    --artifact-root /artifacts)
comparison_status=$?
set -e
printf '%s\n' "$comparison_output"

awk -v uid="$comparison_uid" '$1 == uid ":" { print }' /proc/key-users > "$comparison_key_check/after"
comparison_unchanged=true
if ! cmp -s -- "$comparison_key_check/before" "$comparison_key_check/after"; then
  comparison_unchanged=false
fi
artifact_container_path=$(printf '%s\n' "$comparison_output" | sed -n '$p')
artifact_name=${artifact_container_path##*/}
if [[ "$artifact_container_path" == /artifacts/adversarial-comparison-* && -d "$artifact_root/$artifact_name" ]]; then
  python3 - "$artifact_root/$artifact_name/kernel-key-quota.json" "$comparison_key_check/before" "$comparison_key_check/after" "$comparison_unchanged" <<'PY'
import hashlib
import json
import pathlib
import sys

destination, before_path, after_path, unchanged = sys.argv[1:]
before = pathlib.Path(before_path).read_bytes()
after = pathlib.Path(after_path).read_bytes()
pathlib.Path(destination).write_text(
    json.dumps(
        {
            "schemaVersion": 1,
            "beforeSha256": hashlib.sha256(before).hexdigest(),
            "afterSha256": hashlib.sha256(after).hexdigest(),
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
if [[ "$comparison_unchanged" != true ]]; then
  echo "the OCI comparison changed the current user's kernel key quota" >&2
  exit 1
fi
exit "$comparison_status"
