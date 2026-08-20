# Buzzard Agent Web

`buzzard-agent-web` is an independent Debian/Ubuntu package for the Wild
Buzzard agent web UI, HTTP API, and persistent-session daemon. It is usable by
Wild Buzzard or any other local application through its stable command and
endpoint contract.

The package owns its web runtime and pinned Node.js installation. It depends
on `/usr/bin/buzzard-agent` as its companion CLI, accepts another compatible
agent through `--agent-command`, and does not contain a browser, web-search,
torrent-search, or torrent implementation. The dependency direction is
`buzzard-agent-web` to `buzzard-agent`; the agent package does not depend on
this optional UI module.

## Commands

```text
buzzard-agent-web serve
buzzard-agent-web sessiond
buzzard-agent-web endpoint [--json]
buzzard-agent-web start|stop|restart|status
buzzard-agent-web enable|disable
buzzard-agent-web logs
buzzard-agent-web doctor
buzzard-agent-web version
```

`serve` and `sessiond` are foreground commands suitable for another service
manager. `enable` installs no files; it enables and starts the package's two
user units. The default endpoint is `http://127.0.0.1:8765`.

## Browser-facing contract

An embedding application starts or reconfigures the service with one command:

```text
buzzard-agent-web start --json \
  --host 127.0.0.1 --port 8765 \
  --config /absolute/config.json \
  --data-dir /absolute/data \
  --agent-dir /absolute/agent-profile \
  --identity-file /absolute/service-identity.json \
  --local-only --offline
```

`restart` accepts the same options. `status --json` and `stop --json` return
the current state. The package writes its own private environment file below
`$XDG_RUNTIME_DIR/buzzard-agent-web`; callers do not create or inspect systemd
units or files under `/usr/lib`.

The schema-1 status object contains:

- `service`: `buzzard-agent-web`
- `enabled`, `running`, and `ready`: booleans
- `url`, `host`, `port`, and `healthUrl`; `url` is an origin without a trailing
  slash
- `configPath`, `dataDir`, `agentDir`, and `agentCommand`
- `identityFile`, a path or `null`
- `offline`: boolean
- `services.web` and `services.sessiond`, each with `unit` and `active`

`start`, `restart`, and `enable` wait up to 15 seconds for the HTTP health
route before returning. They return nonzero if the units did not become ready.
`status --json` returns zero for both running and stopped states so a caller can
use the JSON booleans as the source of truth.

The public environment variables are:

- `BUZZARD_AGENT_WEB_HOST`
- `BUZZARD_AGENT_WEB_PORT`
- `BUZZARD_AGENT_WEB_ORIGIN`
- `BUZZARD_AGENT_WEB_DATA_DIR`
- `BUZZARD_AGENT_WEB_CONFIG`
- `BUZZARD_AGENT_WEB_AGENT_COMMAND`
- `BUZZARD_AGENT_WEB_IDENTITY_FILE`
- `BUZZARD_AGENT_WEB_LOCAL_ONLY`
- `BUZZARD_AGENT_WEB_OFFLINE`
- `BUZZARD_AGENT_DIR`

The complete, pristine upstream source and provenance are in
`../../third_party/mit/pi-web`. Product-facing relabeling happens only in the
temporary downstream build copy.

## Build

On an x86-64 Ubuntu 24.04 or newer builder:

```bash
./scripts/build-deb.sh
```

Set `BUZZARD_NODE_ROOT` to an already extracted pinned Node.js tree, such as
`/opt/node`, to reuse the builder cache. Otherwise the script downloads and
verifies the exact Node.js archive recorded in `runtime-lock.json`.
