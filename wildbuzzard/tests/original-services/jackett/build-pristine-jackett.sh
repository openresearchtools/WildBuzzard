#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
wildbuzzard_dir=$(cd -- "$script_dir/../../.." && pwd)
package_dir="$wildbuzzard_dir/third_party/gpl2/jackett"
source_archive="$package_dir/upstream/jackett-v0.24.2360.tar.gz"
source_sha256=3816fea39546b5fa440d3e33b856e73500ee6129e91b14d839fc0f04c7f9bd3e
source_directory_name=Jackett-0cd8622b735922a909a128d8d6943bb8565a640f
release_lock="$script_dir/fixtures/pristine-release-linux-x64.json"
output_dir=
object_dir=
log_dir=
cache_dir=

usage() {
  echo "usage: $0 --output DIR --object-dir DIR --log-dir DIR [--cache DIR]" >&2
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
    --cache)
      cache_dir=${2:?}
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
if [[ -z "$cache_dir" ]]; then
  cache_dir="$object_dir/download-cache"
else
  cache_dir=$(realpath -m -- "$cache_dir")
fi
for directory in "$output_dir" "$object_dir"; do
  if [[ -e "$directory" ]] && [[ -n "$(find "$directory" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
    echo "directory must not exist or must be empty: $directory" >&2
    exit 1
  fi
done
mkdir -p -- "$output_dir" "$object_dir" "$log_dir" "$cache_dir"

if [[ "$(sha256sum "$source_archive" | cut -d ' ' -f 1)" != "$source_sha256" ]]; then
  echo "Jackett source archive digest mismatch" >&2
  exit 1
fi
tar -xzf "$source_archive" -C "$object_dir"
source_dir="$object_dir/$source_directory_name"
(cd "$source_dir" && sha256sum --check "$package_dir/upstream/SOURCE-MANIFEST.sha256") > "$log_dir/source-manifest.log" 2>&1

release_archive=$(python3 "$script_dir/prepare_pristine_release.py" \
  --lock "$release_lock" \
  --cache "$cache_dir" \
  --output "$output_dir")

test -x "$output_dir/jackett"
test -f "$output_dir/Content/index.html"
test "$(find "$output_dir/Definitions" -maxdepth 1 -type f -name '*.yml' | wc -l)" -eq 549
sha256sum "$release_archive" > "$log_dir/pristine-release-archive.sha256"
sha256sum "$output_dir/jackett" > "$log_dir/pristine-executable.sha256"
python3 "$script_dir/write-pristine-runtime-record.py" \
  --runtime "$output_dir" \
  --output "$log_dir/pristine-runtime-build-record.json" \
  --release-archive "$release_archive" \
  --release-lock "$release_lock"
echo "$output_dir"
