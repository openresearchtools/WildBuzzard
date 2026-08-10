#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
wildbuzzard_dir=$(cd -- "$script_dir/.." && pwd)
package_dir="$wildbuzzard_dir/third_party/gpl2/jackett"
source_archive="$package_dir/upstream/jackett-v0.24.2360.tar.gz"
source_sha256=3816fea39546b5fa440d3e33b856e73500ee6129e91b14d839fc0f04c7f9bd3e
source_directory_name=Jackett-0cd8622b735922a909a128d8d6943bb8565a640f
sdk_lock="$package_dir/packaging/dotnet-sdk-linux-x64.json"
source_date_epoch=1786253932
output_dir=
archive_path=
object_dir=
log_dir=
cache_dir=
keep_object=false
test_fixture_package=
production_manifest=
fixture_origin=

usage() {
  echo "usage: $0 --output DIR [--archive FILE] [--object-dir DIR] [--log-dir DIR] [--cache DIR] [--keep-object] [--test-fixture-package DIR --production-manifest FILE]" >&2
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
    --cache)
      cache_dir=${2:?}
      shift 2
      ;;
    --keep-object)
      keep_object=true
      shift
      ;;
    --test-fixture-package)
      test_fixture_package=${2:?}
      shift 2
      ;;
    --production-manifest)
      production_manifest=${2:?}
      shift 2
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
if [[ -z "$cache_dir" ]]; then
  cache_dir="$object_dir/download-cache"
else
  cache_dir=$(realpath -m -- "$cache_dir")
fi
mkdir -p -- "$log_dir"
mkdir -p -- "$cache_dir"

python3 "$wildbuzzard_dir/tests/original-services/jackett/boundary_scan.py" \
  --root "$wildbuzzard_dir/../browser" \
  --root "$wildbuzzard_dir/../agent" \
  --root "$wildbuzzard_dir/managed-services" \
  --root "$wildbuzzard_dir/torrent-runtime" \
  --output "$log_dir/process-boundary.json"

if [[ -n "$test_fixture_package" || -n "$production_manifest" ]]; then
  if [[ -z "$test_fixture_package" || -z "$production_manifest" ]]; then
    echo "test fixture builds require both --test-fixture-package and --production-manifest" >&2
    exit 2
  fi
  test_fixture_package=$(realpath -- "$test_fixture_package")
  production_manifest=$(realpath -- "$production_manifest")
fi

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
if [[ -n "$test_fixture_package" ]]; then
  test -f "$test_fixture_package/catalog.json"
  test -f "$test_fixture_package/fixture-binding.json"
  test -d "$test_fixture_package/Definitions"
  python3 - "$test_fixture_package/catalog.json" "$test_fixture_package/fixture-binding.json" "$production_manifest" <<'PY'
import json
import sys

catalog = json.load(open(sys.argv[1], encoding="utf-8"))
binding = json.load(open(sys.argv[2], encoding="utf-8"))
manifest = json.load(open(sys.argv[3], encoding="utf-8"))
if (
    binding.get("schemaVersion") != 1
    or binding.get("testFixture") is not True
    or binding.get("fixtureOrigin") != "http://127.0.0.1:18080"
    or catalog.get("enabledIndexerIds") != ["linuxtracker", "showrss"]
    or [entry.get("indexerId") for entry in catalog.get("entries", [])]
    != ["linuxtracker", "showrss"]
    or binding.get("shippingPolicySha256") != manifest.get("providerPolicySha256")
    or manifest.get("testFixture") is not False
):
    raise SystemExit("test fixture package is not bound to the production policy")
PY
  fixture_origin=http://127.0.0.1:18080
  find "$source_dir/src/Jackett.Mini/Definitions" -mindepth 1 -maxdepth 1 -type f -delete
  cp -- "$test_fixture_package"/Definitions/*.yml "$source_dir/src/Jackett.Mini/Definitions/"
  cp -- "$test_fixture_package/catalog.json" "$source_dir/src/Jackett.Mini/catalog.json"
fi
runtime_catalog="$source_dir/src/Jackett.Mini/catalog.json"
python3 "$package_dir/packaging/bind_catalog.py" \
  --source "$source_dir/src/Jackett.Mini/CatalogPolicy.cs" \
  --catalog "$runtime_catalog" > "$log_dir/catalog-binding.sha256"
python3 "$package_dir/packaging/bind_fixture_origin.py" \
  --source "$source_dir/src/Jackett.Mini/PublicNetworkPolicy.cs" \
  --origin "$fixture_origin"

toolchain_dir="$object_dir/dotnet-sdk"
python3 "$package_dir/packaging/prepare_dotnet_sdk.py" \
  --lock "$sdk_lock" \
  --cache "$cache_dir" \
  --output "$toolchain_dir" > "$log_dir/sdk-prepare.log" 2>&1
dotnet="$toolchain_dir/dotnet"
if [[ "$($dotnet --version)" != "9.0.304" ]]; then
  echo "the pinned .NET SDK version is unavailable" >&2
  exit 1
fi
$dotnet --info > "$log_dir/sdk-info.log"

mkdir -p -- "$object_dir/nuget" "$object_dir/dotnet-home" "$object_dir/publish"
dotnet_environment=(
  env -i
  HOME="$object_dir/dotnet-home"
  DOTNET_CLI_HOME="$object_dir/dotnet-home"
  DOTNET_NOLOGO=1
  DOTNET_ROOT="$toolchain_dir"
  DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1
  LANG=C.UTF-8
  LC_ALL=C.UTF-8
  NUGET_PACKAGES="$object_dir/nuget"
  PATH="$toolchain_dir:/usr/bin:/bin"
  SOURCE_DATE_EPOCH="$source_date_epoch"
  TZ=UTC
)
(
  cd -- "$source_dir"
  "${dotnet_environment[@]}" "$dotnet" restore \
    src/Jackett.Mini/Jackett.Mini.csproj \
    --runtime linux-x64 \
    --locked-mode \
    -p:JackettMiniBuild=true
) > "$log_dir/restore.log" 2>&1

(
  cd -- "$source_dir"
  "${dotnet_environment[@]}" "$dotnet" publish \
    src/Jackett.Mini/Jackett.Mini.csproj \
    --configuration Release \
    --framework net9.0 \
    --runtime linux-x64 \
    --self-contained true \
    --no-restore \
    --output "$object_dir/publish" \
    -p:JackettMiniBuild=true \
    -p:ContinuousIntegrationBuild=true \
    -p:DebugSymbols=false \
    -p:DebugType=None \
    -p:Deterministic=true \
    -p:PublishReadyToRun=false \
    -p:PublishSingleFile=false \
    -p:PublishTrimmed=false
) > "$log_dir/publish.log" 2>&1

(
  cd -- "$object_dir/publish"
  env -i \
    DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1 \
    HOME="$object_dir/dotnet-home" \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PATH=/usr/bin:/bin \
    TZ=UTC \
    ./jackett-mini --SecuritySelfTest
) > "$log_dir/security-self-test.log" 2>&1

mkdir -p -- "$object_dir/publish/licenses/jackett" "$object_dir/publish/licenses/dotnet"
cp -- "$package_dir/LICENSE" "$object_dir/publish/licenses/jackett/LICENSE"
cp -- "$package_dir/THIRD_PARTY_NOTICES.md" "$object_dir/publish/licenses/jackett/THIRD_PARTY_NOTICES.md"
cp -- "$toolchain_dir/LICENSE.txt" "$object_dir/publish/licenses/dotnet/LICENSE.txt"
cp -- "$toolchain_dir/ThirdPartyNotices.txt" "$object_dir/publish/licenses/dotnet/ThirdPartyNotices.txt"

for forbidden in Content Jackett.Updater JackettConsole jackett_updater FlareSolverrSharp.dll; do
  if [[ -e "$object_dir/publish/$forbidden" ]]; then
    echo "forbidden runtime path was published: $forbidden" >&2
    exit 1
  fi
done

expected_yaml=$(python3 -c 'import json,sys; print(sum(e["eligibility"] == "enabled-public" and e["sourceKind"] == "cardigann-yaml" for e in json.load(open(sys.argv[1]))["entries"]))' "$runtime_catalog")
actual_yaml=$(find "$object_dir/publish/Definitions" -maxdepth 1 -type f -name '*.yml' | wc -l)
if [[ "$actual_yaml" -ne "$expected_yaml" ]]; then
  echo "published provider definition set is incomplete" >&2
  exit 1
fi

cp -a -- "$object_dir/publish/." "$output_dir/"
mkdir -p -- "$output_dir/source/jackett"
cp -a -- "$package_dir/." "$output_dir/source/jackett/"
cp -- "$script_dir/build-jackett-mini.sh" "$output_dir/source/jackett/build-jackett-mini.sh"
if [[ -n "$test_fixture_package" ]]; then
  mkdir -p -- "$output_dir/source/jackett/test-fixture-input"
  cp -a -- "$test_fixture_package/." "$output_dir/source/jackett/test-fixture-input/"
fi
find "$output_dir" -type d -exec chmod 0755 -- {} +
find "$output_dir" -type f -exec chmod 0644 -- {} +
chmod 0755 -- "$output_dir/jackett-mini"
find "$output_dir" -type f -exec touch -d "@$source_date_epoch" -- {} +
metadata_args=()
if [[ -n "$test_fixture_package" ]]; then
  production_runtime_sha256=$(python3 - "$production_manifest" <<'PY'
import json
import sys

manifest = json.load(open(sys.argv[1], encoding="utf-8"))
digest = manifest.get("runtimeSha256", "")
if len(digest) != 64:
    raise SystemExit("production runtime manifest has no valid inventory digest")
print(digest)
PY
)
  metadata_args+=(--test-fixture --production-runtime-sha256 "$production_runtime_sha256")
fi
python3 "$package_dir/packaging/write_runtime_metadata.py" \
  --runtime "$output_dir" \
  --catalog "$runtime_catalog" \
  --source "$source_dir" \
  --source-sha256 "$source_sha256" \
  --sdk-lock "$sdk_lock" \
  --license-inventory "$package_dir/packaging/nuget-licenses.json" \
  --manifest "$output_dir/jackett-mini-runtime.json" \
  --sbom "$output_dir/jackett-mini.spdx.json" \
  "${metadata_args[@]}"

python3 "$wildbuzzard_dir/tests/original-services/jackett/boundary_scan.py" \
  --root "$wildbuzzard_dir/../browser" \
  --root "$wildbuzzard_dir/../agent" \
  --root "$wildbuzzard_dir/managed-services" \
  --root "$wildbuzzard_dir/torrent-runtime" \
  --runtime "$output_dir" \
  --catalog "$runtime_catalog" \
  --output "$log_dir/runtime-boundary.json"

if [[ -n "$archive_path" ]]; then
  python3 "$package_dir/packaging/create_runtime_zip.py" \
    --runtime "$output_dir" \
    --output "$archive_path" \
    --source-date-epoch "$source_date_epoch"
fi

echo "$output_dir"
