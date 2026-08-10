#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
wildbuzzard_dir=$(cd -- "$script_dir/.." && pwd)
package_dir="$wildbuzzard_dir/third_party/gpl2/jackett"
source_archive="$package_dir/upstream/jackett-v0.24.2360.tar.gz"
source_sha256=3816fea39546b5fa440d3e33b856e73500ee6129e91b14d839fc0f04c7f9bd3e
source_directory_name=Jackett-0cd8622b735922a909a128d8d6943bb8565a640f
sdk_image=mcr.microsoft.com/dotnet/sdk@sha256:6e6542a43b6bf3c5ecfa80dd33c79c9fd09d58f95f4ebacd14fa056275b25164
source_date_epoch=1786253932
output_dir=
archive_path=
object_dir=
log_dir=
keep_object=false

usage() {
  echo "usage: $0 --output DIR [--archive FILE] [--object-dir DIR] [--log-dir DIR] [--keep-object]" >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output)
      output_dir=${2:?}
      shift 2
      ;;
    --archive)
      archive_path=${2:?}
      shift 2
      ;;
    --object-dir)
      object_dir=${2:?}
      keep_object=true
      shift 2
      ;;
    --log-dir)
      log_dir=${2:?}
      shift 2
      ;;
    --keep-object)
      keep_object=true
      shift
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

if [[ -z "$output_dir" ]]; then
  usage
  exit 2
fi

output_dir=$(realpath -m -- "$output_dir")
if [[ -n "$archive_path" ]]; then
  archive_path=$(realpath -m -- "$archive_path")
fi
if [[ -e "$output_dir" ]] && [[ -n "$(find "$output_dir" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  echo "output directory must not exist or must be empty: $output_dir" >&2
  exit 1
fi
mkdir -p -- "$output_dir"

if [[ -z "$object_dir" ]]; then
  object_dir=$(mktemp -d "${TMPDIR:-/tmp}/jackett-mini-build.XXXXXX")
else
  object_dir=$(realpath -m -- "$object_dir")
  if [[ -e "$object_dir" ]] && [[ -n "$(find "$object_dir" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
    echo "object directory must not exist or must be empty: $object_dir" >&2
    exit 1
  fi
  mkdir -p -- "$object_dir"
fi

if [[ -z "$log_dir" ]]; then
  log_dir="$object_dir/logs"
else
  log_dir=$(realpath -m -- "$log_dir")
fi
mkdir -p -- "$log_dir"

cleanup() {
  if [[ "$keep_object" == false ]] && [[ "$object_dir" == "${TMPDIR:-/tmp}"/jackett-mini-build.* ]]; then
    rm -rf -- "$object_dir"
  fi
}
trap cleanup EXIT

actual_source_sha256=$(sha256sum "$source_archive" | cut -d ' ' -f 1)
if [[ "$actual_source_sha256" != "$source_sha256" ]]; then
  echo "Jackett source archive digest mismatch" >&2
  exit 1
fi

tar -xzf "$source_archive" -C "$object_dir"
source_dir="$object_dir/$source_directory_name"
if [[ ! -d "$source_dir/src/Jackett.Common" ]]; then
  echo "Jackett source archive layout mismatch" >&2
  exit 1
fi
(cd "$source_dir" && sha256sum --check "$package_dir/upstream/SOURCE-MANIFEST.sha256") > "$log_dir/source-manifest.log" 2>&1

while IFS= read -r patch_name; do
  [[ -z "$patch_name" ]] && continue
  patch --batch --fuzz=0 -d "$source_dir" -p1 < "$package_dir/patches/$patch_name"
done < "$package_dir/patches/series"

python3 "$package_dir/provider-policy/generate_catalog.py" \
  --source "$source_dir" \
  --review "$package_dir/provider-policy/reviewed-definitions.json" \
  --output "$package_dir/provider-policy/catalog.json" \
  --check \
  --stage-definitions "$source_dir/src/Jackett.Mini/Definitions"
cp -- "$package_dir/provider-policy/catalog.json" "$source_dir/src/Jackett.Mini/catalog.json"

podman_args=()
if [[ -n "${JACKETT_MINI_OCI_RUNTIME:-}" ]]; then
  podman_args+=(--runtime "$JACKETT_MINI_OCI_RUNTIME")
fi
if [[ "$(podman "${podman_args[@]}" info --format '{{.Host.Security.Rootless}}')" != "true" ]]; then
  echo "the Jackett build requires rootless Podman" >&2
  exit 1
fi
podman "${podman_args[@]}" pull "$sdk_image" > "$log_dir/sdk-pull.log" 2>&1

mkdir -p -- "$object_dir/nuget" "$object_dir/dotnet-home" "$object_dir/publish"
podman "${podman_args[@]}" run --rm --userns=keep-id \
  -e DOTNET_CLI_HOME=/dotnet-home \
  -e DOTNET_NOLOGO=1 \
  -e DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1 \
  -e NUGET_PACKAGES=/nuget \
  -e SOURCE_DATE_EPOCH="$source_date_epoch" \
  -v "$source_dir:/src:Z" \
  -v "$object_dir/nuget:/nuget:Z" \
  -v "$object_dir/dotnet-home:/dotnet-home:Z" \
  -v "$object_dir/publish:/output:Z" \
  -w /src \
  "$sdk_image" \
  dotnet restore src/Jackett.Mini/Jackett.Mini.csproj \
    --runtime linux-x64 \
    --locked-mode \
    -p:JackettMiniBuild=true > "$log_dir/restore.log" 2>&1

podman "${podman_args[@]}" run --rm --userns=keep-id \
  -e DOTNET_CLI_HOME=/dotnet-home \
  -e DOTNET_NOLOGO=1 \
  -e DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1 \
  -e NUGET_PACKAGES=/nuget \
  -e SOURCE_DATE_EPOCH="$source_date_epoch" \
  -v "$source_dir:/src:Z" \
  -v "$object_dir/nuget:/nuget:Z" \
  -v "$object_dir/dotnet-home:/dotnet-home:Z" \
  -v "$object_dir/publish:/output:Z" \
  -w /src \
  "$sdk_image" \
  dotnet publish src/Jackett.Mini/Jackett.Mini.csproj \
    --configuration Release \
    --framework net9.0 \
    --runtime linux-x64 \
    --self-contained true \
    --no-restore \
    --output /output \
    -p:JackettMiniBuild=true \
    -p:ContinuousIntegrationBuild=true \
    -p:DebugSymbols=false \
    -p:DebugType=None \
    -p:Deterministic=true \
    -p:PublishReadyToRun=false \
    -p:PublishSingleFile=false \
    -p:PublishTrimmed=false > "$log_dir/publish.log" 2>&1

podman "${podman_args[@]}" run --rm --userns=keep-id \
  -e DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1 \
  -v "$object_dir/publish:/runtime:Z" \
  -w /runtime \
  "$sdk_image" \
  ./jackett-mini --SecuritySelfTest > "$log_dir/security-self-test.log" 2>&1

mkdir -p -- "$object_dir/publish/licenses/jackett" "$object_dir/publish/licenses/dotnet"
cp -- "$package_dir/LICENSE" "$object_dir/publish/licenses/jackett/LICENSE"
cp -- "$package_dir/THIRD_PARTY_NOTICES.md" "$object_dir/publish/licenses/jackett/THIRD_PARTY_NOTICES.md"
podman "${podman_args[@]}" run --rm --userns=keep-id \
  -v "$object_dir/publish/licenses/dotnet:/licenses:Z" \
  "$sdk_image" \
  sh -c 'cp /usr/share/dotnet/LICENSE.txt /licenses/LICENSE.txt && cp /usr/share/dotnet/ThirdPartyNotices.txt /licenses/ThirdPartyNotices.txt'

for forbidden in Content Jackett.Updater JackettConsole jackett_updater FlareSolverrSharp.dll; do
  if [[ -e "$object_dir/publish/$forbidden" ]]; then
    echo "forbidden runtime path was published: $forbidden" >&2
    exit 1
  fi
done

expected_yaml=$(python3 -c 'import json,sys; print(sum(e["eligibility"] == "enabled-public" and e["sourceKind"] == "cardigann-yaml" for e in json.load(open(sys.argv[1]))["entries"]))' "$package_dir/provider-policy/catalog.json")
actual_yaml=$(find "$object_dir/publish/Definitions" -maxdepth 1 -type f -name '*.yml' | wc -l)
if [[ "$actual_yaml" -ne "$expected_yaml" ]]; then
  echo "published provider definition set is incomplete" >&2
  exit 1
fi

cp -a -- "$object_dir/publish/." "$output_dir/"
mkdir -p -- "$output_dir/source/jackett"
cp -a -- "$package_dir/." "$output_dir/source/jackett/"
cp -- "$script_dir/build-jackett-mini.sh" "$output_dir/source/jackett/build-jackett-mini.sh"
find "$output_dir" -type d -exec chmod 0755 -- {} +
find "$output_dir" -type f -exec chmod 0644 -- {} +
chmod 0755 -- "$output_dir/jackett-mini"
find "$output_dir" -type f -exec touch -d "@$source_date_epoch" -- {} +
python3 "$package_dir/packaging/write_runtime_metadata.py" \
  --runtime "$output_dir" \
  --catalog "$package_dir/provider-policy/catalog.json" \
  --source "$source_dir" \
  --source-sha256 "$source_sha256" \
  --sdk-image "$sdk_image" \
  --license-inventory "$package_dir/packaging/nuget-licenses.json" \
  --manifest "$output_dir/jackett-mini-runtime.json" \
  --sbom "$output_dir/jackett-mini.spdx.json"

if [[ -n "$archive_path" ]]; then
  python3 "$package_dir/packaging/create_runtime_zip.py" \
    --runtime "$output_dir" \
    --output "$archive_path" \
    --source-date-epoch "$source_date_epoch"
fi

echo "$output_dir"
