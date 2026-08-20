#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later

set -eu
umask 022

component_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
source_dir=${1:-"${component_dir}/../../third_party/mit/pi/upstream"}
output_dir=${2:-"${component_dir}/build/runtime"}
work_dir=$(mktemp -d "${TMPDIR:-/tmp}/buzzard-agent-build.XXXXXX")
trap 'rm -rf -- "$work_dir"' EXIT HUP INT TERM

node_major=$(node -p 'Number(process.versions.node.split(".")[0])')
if [ "$node_major" -lt 22 ]; then
  echo "Buzzard Agent requires Node.js 22 or newer" >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "Buzzard Agent requires npm" >&2
  exit 1
fi

if [ -e "$output_dir" ]; then
  echo "Runtime output already exists: $output_dir" >&2
  exit 1
fi
mkdir -p "$work_dir/source" "$work_dir/app" "$(dirname -- "$output_dir")"
cp -a "$source_dir/." "$work_dir/source/"
python3 "$component_dir/scripts/debrand.py" "$work_dir/source"

(
  cd "$work_dir/source"
  npm ci --ignore-scripts
)

cp "$work_dir/source/packages/coding-agent/install-lock/package.json" "$work_dir/app/package.json"
cp "$work_dir/source/packages/coding-agent/install-lock/package-lock.json" "$work_dir/app/package-lock.json"
(
  cd "$work_dir/app"
  npm ci --omit=dev --ignore-scripts
)

mkdir -p "$work_dir/source/packages/ai/src/providers/data"
cp -R "$work_dir/app/node_modules/@earendil-works/pi-ai/dist/providers/data/." "$work_dir/source/packages/ai/src/providers/data/"
(
  cd "$work_dir/source"
  npm run check
  npm run build:offline
)

agent_dir="$work_dir/app/node_modules/@earendil-works/pi-coding-agent"
cp -R "$work_dir/source/packages/coding-agent/dist/." "$agent_dir/dist/"
cp -R "$work_dir/source/packages/coding-agent/docs/." "$agent_dir/docs/"
cp -R "$work_dir/source/packages/coding-agent/examples/." "$agent_dir/examples/"
cp "$component_dir/runtime-package.json" "$agent_dir/package.json"
for legacy_bin in pi pi-ai; do
  if [ -L "$work_dir/app/node_modules/.bin/$legacy_bin" ]; then
    unlink "$work_dir/app/node_modules/.bin/$legacy_bin"
  fi
done
cp "$component_dir/runtime-package.json" "$work_dir/app/package.json"
cp "$source_dir/LICENSE" "$agent_dir/LICENSE.upstream"
cp "$source_dir/README.md" "$agent_dir/README.upstream.md"

mkdir "$output_dir"
cp -R "$work_dir/app/." "$output_dir/"
