#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later

set -eu

artifact=${1:-/artifact}
fake_systemctl=${2:-/fake-systemctl}
dpkg-deb -x "$artifact" /
ln -s /bin/true /usr/bin/buzzard-agent
export HOME=/tmp/home
export XDG_RUNTIME_DIR=/tmp/run
export BUZZARD_AGENT_WEB_PORT=18765
mkdir -p "$HOME/.buzzard-agent/agent" "$XDG_RUNTIME_DIR"
buzzard-agent-web endpoint --json
buzzard-agent-web version
buzzard-agent-web sessiond >/tmp/sessiond.log 2>&1 &
sessiond_pid=$!
buzzard-agent-web serve >/tmp/web.log 2>&1 &
web_pid=$!
trap 'kill "$web_pid" "$sessiond_pid" 2>/dev/null || true' EXIT
node=/usr/lib/buzzard-agent-web/node/bin/node
ready=0
attempt=1
while [ "$attempt" -le 60 ]; do
  if "$node" -e 'fetch("http://127.0.0.1:18765/api/machines/local/health").then(response => { if (!response.ok) process.exit(1); return response.json(); }).then(value => { if (value.machineId !== "local" || value.ok !== true) process.exit(1); }).catch(() => process.exit(1));' >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.25
  attempt=$((attempt + 1))
done
if [ "$ready" -ne 1 ]; then
  cat /tmp/sessiond.log /tmp/web.log >&2
  exit 1
fi
"$node" -e 'fetch("http://127.0.0.1:18765/").then(response => response.text()).then(text => { if (!text.includes("Agent — WildBuzzard") || /PI WEB|Pi Web/.test(text)) process.exit(1); }).catch(() => process.exit(1));'
status=$(BUZZARD_AGENT_WEB_SYSTEMCTL="$fake_systemctl" buzzard-agent-web start --json \
  --host 127.0.0.1 \
  --port 18765 \
  --config /tmp/config.json \
  --data-dir /tmp/data \
  --agent-dir /tmp/agent \
  --identity-file /tmp/identity.json \
  --local-only \
  --offline)
printf '%s\n' "$status" | "$node" -e 'let body = ""; process.stdin.on("data", chunk => { body += chunk; }); process.stdin.on("end", () => { const value = JSON.parse(body); if (value.schema !== 1 || value.service !== "buzzard-agent-web" || value.running !== true || value.ready !== true || value.url !== "http://127.0.0.1:18765" || value.port !== 18765 || value.configPath !== "/tmp/config.json" || value.dataDir !== "/tmp/data" || value.offline !== true) process.exit(1); });'
origin=$(BUZZARD_AGENT_WEB_SYSTEMCTL="$fake_systemctl" buzzard-agent-web endpoint --json --origin http://127.0.0.1:18765/)
printf '%s\n' "$origin" | "$node" -e 'let body = ""; process.stdin.on("data", chunk => { body += chunk; }); process.stdin.on("end", () => { const value = JSON.parse(body); if (value.url !== "http://127.0.0.1:18765" || value.healthUrl !== "http://127.0.0.1:18765/api/machines/local/health") process.exit(1); });'
grep -F 'BUZZARD_AGENT_WEB_OFFLINE="1"' "$XDG_RUNTIME_DIR/buzzard-agent-web/environment" >/dev/null
printf 'smoke-ok %s\n' "$(sed -n 's/^PRETTY_NAME=//p' /etc/os-release)"
