#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later

set -eu
umask 022

component_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
repository_dir=$(CDPATH= cd -- "$component_dir/../../.." && pwd -P)
source_dir=${BUZZARD_AGENT_SOURCE:-"${component_dir}/../../third_party/mit/pi/upstream"}
integration_dir=${BUZZARD_AGENT_INTEGRATION_SOURCE:-"${repository_dir}/agent/integrations/buzzard-capabilities"}
output_dir=${1:-"${component_dir}/dist"}
node_root=${BUZZARD_NODE_ROOT:-/opt/node}
work_dir=$(mktemp -d "${TMPDIR:-/tmp}/buzzard-agent-deb.XXXXXX")
trap 'rm -rf -- "$work_dir"' EXIT HUP INT TERM
stage="$work_dir/buzzard-agent"

if [ ! -x "$node_root/bin/node" ]; then
  echo "Set BUZZARD_NODE_ROOT to the pinned Node.js 22 runtime" >&2
  exit 2
fi
if [ -z "${SOURCE_DATE_EPOCH:-}" ]; then
  SOURCE_DATE_EPOCH=$(awk -F ' = ' '$1 == "source_date_epoch" { print $2; exit }' \
    "$component_dir/../../third_party/mit/pi/UPSTREAM.toml")
fi
case "$SOURCE_DATE_EPOCH" in
  ''|*[!0-9]*) echo "SOURCE_DATE_EPOCH must be an integer" >&2; exit 2 ;;
esac
export SOURCE_DATE_EPOCH TZ=UTC LC_ALL=C
mkdir -p "$stage/DEBIAN" "$stage/usr/bin" "$stage/usr/lib/buzzard-agent/node/bin" "$stage/usr/share/doc/buzzard-agent" "$output_dir"
"$component_dir/scripts/build-runtime.sh" "$source_dir" "$stage/usr/lib/buzzard-agent/app"
mkdir -p "$stage/usr/lib/buzzard-agent/app/extensions/buzzard-capabilities"
install -m 0755 "$component_dir/bin/buzzard-agent" "$stage/usr/bin/buzzard-agent"
install -m 0755 "$node_root/bin/node" "$stage/usr/lib/buzzard-agent/node/bin/node"
install -m 0644 "$integration_dir/index.ts" "$stage/usr/lib/buzzard-agent/app/extensions/buzzard-capabilities/index.ts"
install -m 0644 "$integration_dir/README.md" "$stage/usr/share/doc/buzzard-agent/capability-extension.md"
if [ -f "$node_root/LICENSE" ]; then
  install -m 0644 "$node_root/LICENSE" "$stage/usr/lib/buzzard-agent/node/LICENSE"
fi
install -m 0644 "$source_dir/LICENSE" "$stage/usr/share/doc/buzzard-agent/LICENSE.upstream"
install -m 0644 "$component_dir/NOTICE" "$stage/usr/share/doc/buzzard-agent/NOTICE"
install -m 0644 "$component_dir/debian/copyright" "$stage/usr/share/doc/buzzard-agent/copyright"
gzip -n -9 -c "$component_dir/debian/changelog" > "$stage/usr/share/doc/buzzard-agent/changelog.gz"
find "$stage" -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +

install -m 0644 "$component_dir/debian/binary-control" "$stage/DEBIAN/control"
touch -h -d "@$SOURCE_DATE_EPOCH" "$stage/DEBIAN/control"
dpkg-deb --root-owner-group --uniform-compression -Zzstd -z10 --build \
  "$stage" "$output_dir/buzzard-agent_0.84.1+wildbuzzard1_amd64.deb"
