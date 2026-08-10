#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
wildbuzzard_dir=$(cd -- "$script_dir/../../.." && pwd)
package_dir="$wildbuzzard_dir/third_party/gpl2/jackett"
source_archive="$package_dir/upstream/jackett-v0.24.2360.tar.gz"
source_sha256=3816fea39546b5fa440d3e33b856e73500ee6129e91b14d839fc0f04c7f9bd3e
source_directory_name=Jackett-0cd8622b735922a909a128d8d6943bb8565a640f
sdk_image=mcr.microsoft.com/dotnet/sdk@sha256:6e6542a43b6bf3c5ecfa80dd33c79c9fd09d58f95f4ebacd14fa056275b25164
output_dir=
object_dir=
log_dir=

oci_runtime=${JACKETT_COMPARISON_OCI_RUNTIME:-}

usage() {
  echo "usage: $0 --output DIR --object-dir DIR --log-dir DIR [--oci-runtime PATH]" >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output)
      output_dir=${2:?}
      shift 2
      ;;
    --object-dir)
      object_dir=${2:?}
      shift 2
      ;;
    --log-dir)
      log_dir=${2:?}
      shift 2
      ;;
    --oci-runtime)
      oci_runtime=${2:?}
      shift 2
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

if [[ -z "$output_dir" || -z "$object_dir" || -z "$log_dir" ]]; then
  usage
  exit 2
fi

output_dir=$(realpath -m -- "$output_dir")
object_dir=$(realpath -m -- "$object_dir")
log_dir=$(realpath -m -- "$log_dir")
for directory in "$output_dir" "$object_dir"; do
  if [[ -e "$directory" ]] && [[ -n "$(find "$directory" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
    echo "directory must not exist or must be empty: $directory" >&2
    exit 1
  fi
done
mkdir -p -- "$output_dir" "$object_dir" "$log_dir"

if [[ "$(sha256sum "$source_archive" | cut -d ' ' -f 1)" != "$source_sha256" ]]; then
  echo "Jackett source archive digest mismatch" >&2
  exit 1
fi
tar -xzf "$source_archive" -C "$object_dir"
source_dir="$object_dir/$source_directory_name"
(cd "$source_dir" && sha256sum --check "$package_dir/upstream/SOURCE-MANIFEST.sha256") > "$log_dir/source-manifest.log" 2>&1

podman_args=()
if [[ -n "$oci_runtime" ]]; then
  oci_runtime=$(realpath -- "$oci_runtime")
  if [[ ! -x "$oci_runtime" ]]; then
    echo "OCI runtime must be executable: $oci_runtime" >&2
    exit 1
  fi
  podman_args+=(--runtime "$oci_runtime")
fi
if [[ "$(podman "${podman_args[@]}" info --format '{{.Host.Security.Rootless}}')" != "true" ]]; then
  echo "the pristine Jackett build requires rootless Podman" >&2
  exit 1
fi
podman "${podman_args[@]}" pull "$sdk_image" > "$log_dir/sdk-pull.log" 2>&1
podman "${podman_args[@]}" image inspect "$sdk_image" > "$log_dir/sdk-image-inspect.json"

mkdir -p -- "$object_dir/nuget" "$object_dir/dotnet-home" "$object_dir/publish"
podman "${podman_args[@]}" run --rm --userns=keep-id \
  -e DOTNET_CLI_HOME=/dotnet-home \
  -e DOTNET_NOLOGO=1 \
  -e DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1 \
  -e NUGET_PACKAGES=/nuget \
  -e SOURCE_DATE_EPOCH=1786253932 \
  -v "$source_dir:/src:Z" \
  -v "$object_dir/nuget:/nuget:Z" \
  -v "$object_dir/dotnet-home:/dotnet-home:Z" \
  -v "$object_dir/publish:/output:Z" \
  -w /src \
  "$sdk_image" \
  dotnet publish src/Jackett.Server/Jackett.Server.csproj \
    --configuration Release \
    --framework net9.0 \
    --runtime linux-x64 \
    --self-contained true \
    --output /output \
    -p:Version=0.24.2360 \
    -p:ContinuousIntegrationBuild=true \
    -p:DebugSymbols=false \
    -p:DebugType=None \
    -p:Deterministic=true \
    -p:PublishReadyToRun=false \
    -p:PublishSingleFile=false \
    -p:PublishTrimmed=false > "$log_dir/publish.log" 2>&1

cp -a -- "$object_dir/publish/." "$output_dir/"
test -x "$output_dir/jackett"
test -f "$output_dir/Content/index.html"
test "$(find "$output_dir/Definitions" -maxdepth 1 -type f -name '*.yml' | wc -l)" -eq 549
sha256sum "$output_dir/jackett" > "$log_dir/pristine-executable.sha256"
python3 "$script_dir/write-pristine-runtime-record.py" \
  --runtime "$output_dir" \
  --output "$log_dir/pristine-runtime-build-record.json" \
  --sdk-image-inspect "$log_dir/sdk-image-inspect.json"
echo "$output_dir"
