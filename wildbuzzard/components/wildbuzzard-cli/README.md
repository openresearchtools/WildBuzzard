# Wild Buzzard CLI

The actual `wildbuzzard` browser executable handles both browser launch
arguments and native control commands. The Debian command is a symlink to that
executable; the release archive and AppImage expose the same commands.

```bash
wildbuzzard open https://example.com
wildbuzzard tabs
wildbuzzard snapshot
wildbuzzard click @e2
wildbuzzard read
wildbuzzard screenshot
wildbuzzard run workflow.js
wildbuzzard torrent-add --magnet 'magnet:?xt=urn:btih:...'
wildbuzzard torrent-add --file ./file.torrent
```

The executable's native entry point discovers the running browser's private
Unix socket and forwards the command. Every command is parsed and executed by
privileged Gecko JavaScript inside the running browser. There is no separate
Rust launcher, agent runtime, Node.js runtime, MCP server, bearer token,
connection file, or second browser-automation daemon. If necessary, a command
starts the same browser executable; `--no-start` disables automatic startup.

The Linux transport lives in `browser/app/WildBuzzardCommandLine.cpp`.
`WildBuzzardCommand.sys.mjs` owns the command catalog, argument parsing,
per-session current page, result formatting, and artifact output. Browser
actions and the `run` workflow SDK remain in `remote/wildbuzzard`.

Each running profile has its own private socket. The client discovers it when
one profile is running. With multiple profiles, set
`WILDBUZZARD_CONTROL_SOCKET` to one of the paths reported by the client; an
override must be an absolute path in an existing owner-private directory.
