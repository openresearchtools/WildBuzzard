#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later

set -eu

component_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
lock="$component_dir/runtime-lock.json"
cache=${BUZZARD_AGENT_WEB_CACHE_ROOT:-"$component_dir/.cache"}

eval "$(python3 - "$lock" <<'PY'
import json
import shlex
import sys

lock = json.load(open(sys.argv[1], encoding="utf-8"))
node = lock["node"]
for key, value in {
    "node_version": node["version"],
    "node_archive": node["archive"],
    "node_url": node["url"],
    "node_archive_sha256": node["archiveSha256"],
    "node_binary_sha256": node["binarySha256"],
}.items():
    print(f"{key}={shlex.quote(value)}")
PY
)"

node_root=${BUZZARD_NODE_ROOT:-}
if [ -z "$node_root" ]; then
  node_root="$cache/node-v$node_version-linux-x64"
  archive_path="$cache/$node_archive"
  mkdir -p "$cache"
  if [ ! -f "$archive_path" ]; then
    curl --fail --location --proto '=https' --tlsv1.2 --output "$archive_path.part" "$node_url"
    mv "$archive_path.part" "$archive_path"
  fi
  if [ "$(sha256sum "$archive_path" | awk '{print $1}')" != "$node_archive_sha256" ]; then
    echo 'pinned Node.js archive checksum mismatch' >&2
    exit 1
  fi
  if [ ! -x "$node_root/bin/node" ]; then
    tar -xJf "$archive_path" -C "$cache"
  fi
fi

if [ ! -x "$node_root/bin/node" ]; then
  echo "pinned Node.js runtime is missing: $node_root" >&2
  exit 1
fi
if [ "$($node_root/bin/node --version)" != "v$node_version" ]; then
  echo 'pinned Node.js version mismatch' >&2
  exit 1
fi
if [ "$(sha256sum "$node_root/bin/node" | awk '{print $1}')" != "$node_binary_sha256" ]; then
  echo 'pinned Node.js binary checksum mismatch' >&2
  exit 1
fi
npm_version=$($node_root/bin/node "$node_root/lib/node_modules/npm/bin/npm-cli.js" --version)
if [ "npm@$npm_version" != "npm@10.9.8" ]; then
  echo 'pinned npm version mismatch' >&2
  exit 1
fi
printf '%s\n' "$node_root"

