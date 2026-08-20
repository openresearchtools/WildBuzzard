#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later

set -eu
umask 022
SOURCE_DATE_EPOCH=1786372559
export SOURCE_DATE_EPOCH

component_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
source_dir=${BUZZARD_AGENT_WEB_SOURCE:-"$component_dir/../../third_party/mit/pi-web/upstream"}
provenance_dir=$(CDPATH= cd -- "$component_dir/../../third_party/mit/pi-web" && pwd -P)
build_root=${BUZZARD_AGENT_WEB_BUILD_ROOT:-"$component_dir/build"}
dist_root=${BUZZARD_AGENT_WEB_DIST_ROOT:-"$component_dir/dist"}

case "$build_root" in
  ''|/) echo "refusing unsafe build root: $build_root" >&2; exit 1 ;;
esac
if [ "$(uname -m)" != x86_64 ]; then
  echo 'buzzard-agent-web currently packages only x86-64' >&2
  exit 1
fi
for command in python3 dpkg-deb tar gzip; do
  command -v "$command" >/dev/null 2>&1 || { echo "$command is required" >&2; exit 1; }
done

node_root=$($component_dir/scripts/prepare-node.sh)
node="$node_root/bin/node"
npm="$node_root/lib/node_modules/npm/bin/npm-cli.js"

rm -rf "$build_root"
mkdir -p "$build_root" "$dist_root"
cp -a "$source_dir" "$build_root/source"
source="$build_root/source"
export PATH="$node_root/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export HOME="$build_root/home"
export LANG=C.UTF-8
export LC_ALL=C.UTF-8
export TZ=UTC
export npm_config_cache=${BUZZARD_AGENT_WEB_NPM_CACHE:-"$build_root/npm-cache"}
export npm_config_fund=false
export npm_config_update_notifier=false
export TMPDIR="$build_root/tmp"
mkdir -p "$HOME" "$npm_config_cache" "$TMPDIR"

cd "$source"
"$node" "$npm" ci
"$node" "$npm" run typecheck
"$node" "$npm" run lint
"$node" "$npm" run knip
"$node" "$npm" test -- --exclude src/server/dockerControlAssets.test.ts
python3 "$component_dir/scripts/prepare-source.py" "$source" "$component_dir/runtime-lock.json"
"$node" "$npm" run build
"$node" "$npm" rebuild node-pty --build-from-source
"$node" "$npm" prune --omit=dev --ignore-scripts
for package in @earendil-works/pi-agent-core @earendil-works/pi-ai @earendil-works/pi-coding-agent node-pty; do
  test -f "$source/node_modules/$package/package.json" || { echo "runtime dependency missing: $package" >&2; exit 1; }
done
if grep -R -E -n --include='*.js' --include='*.html' --include='*.webmanifest' 'PI WEB|Pi Web' "$source/dist"; then
  echo 'product-facing Pi Web branding remains in the downstream build' >&2
  exit 1
fi

pack_dir="$build_root/pack"
mkdir -p "$pack_dir"
"$node" "$npm" pack --ignore-scripts --pack-destination "$pack_dir" >/dev/null
package_archive=$(find "$pack_dir" -maxdepth 1 -type f -name '*.tgz' -print -quit)
test -n "$package_archive" || { echo 'Pi Web package archive was not produced' >&2; exit 1; }

package_root="$build_root/package"
runtime="$package_root/usr/lib/buzzard-agent-web"
documentation="$package_root/usr/share/doc/buzzard-agent-web"
install -d "$package_root/DEBIAN" "$package_root/usr/bin" "$runtime/node/bin" \
  "$runtime/app/node_modules/@jmfederico/pi-web" "$runtime/libexec" \
  "$package_root/usr/lib/systemd/user" "$documentation"
cp -a "$source/node_modules/." "$runtime/app/node_modules/"
rm -rf "$runtime/app/node_modules/.cache" "$runtime/app/node_modules/.vite" "$runtime/app/node_modules/.vite-temp"
rm -f \
  "$runtime/app/node_modules/node-pty/node-addon-api/node_addon_api.target.mk" \
  "$runtime/app/node_modules/node-pty/node-addon-api/node_addon_api_except.target.mk" \
  "$runtime/app/node_modules/node-pty/node-addon-api/node_addon_api_maybe.target.mk"
pty_binary="$runtime/app/node_modules/node-pty/build/Release/pty.node"
test -f "$pty_binary" || { echo 'node-pty native module was not built' >&2; exit 1; }
pty_copy="$build_root/pty.node"
cp "$pty_binary" "$pty_copy"
rm -rf "$runtime/app/node_modules/node-pty/build"
install -D -m 0755 "$pty_copy" "$pty_binary"
tar -xzf "$package_archive" --strip-components=1 -C "$runtime/app/node_modules/@jmfederico/pi-web"
rm -rf "$runtime/app/node_modules/@jmfederico/pi-web/docs"
rm -f "$runtime/app/node_modules/@jmfederico/pi-web/README.md" "$runtime/app/node_modules/@jmfederico/pi-web/install.sh"
install -m 0755 "$node_root/bin/node" "$runtime/node/bin/node"
install -m 0755 "$component_dir/bin/buzzard-agent-web" "$package_root/usr/bin/buzzard-agent-web"
install -m 0644 "$component_dir/libexec/control.mjs" "$runtime/libexec/control.mjs"
install -m 0644 "$component_dir/packaging/buzzard-agent-web.service" "$package_root/usr/lib/systemd/user/buzzard-agent-web.service"
install -m 0644 "$component_dir/packaging/buzzard-agent-web-sessiond.service" "$package_root/usr/lib/systemd/user/buzzard-agent-web-sessiond.service"
install -m 0644 "$component_dir/packaging/control" "$package_root/DEBIAN/control"
install -m 0644 "$component_dir/README.md" "$component_dir/NOTICE" "$component_dir/runtime-lock.json" "$component_dir/debian/copyright" "$documentation/"
install -m 0644 "$provenance_dir/LICENSE" "$documentation/LICENSE.pi-web"
install -m 0644 "$provenance_dir/UPSTREAM.toml" "$documentation/upstream.toml"
install -m 0644 "$source_dir/package-lock.json" "$documentation/package-lock.upstream.json"
install -m 0644 "$source/package-lock.json" "$documentation/package-lock.runtime.json"
if [ -f "$node_root/LICENSE" ]; then
  install -m 0644 "$node_root/LICENSE" "$documentation/LICENSE.node"
fi
gzip -n -9 -c "$component_dir/debian/changelog" > "$documentation/changelog.gz"
"$node" "$npm" ls --omit=dev --all --json > "$documentation/npm-runtime-tree.json"

find "$package_root" ! -type d -exec touch --no-dereference --date="@$SOURCE_DATE_EPOCH" {} +
find "$package_root" -depth -type d -exec touch --no-dereference --date="@$SOURCE_DATE_EPOCH" {} +

output="$dist_root/buzzard-agent-web_1.202608.0+wildbuzzard1_amd64.deb"
dpkg-deb --build --root-owner-group --uniform-compression --threads-max=1 -Zxz -z3 "$package_root" "$output"
printf '%s\n' "$output"
