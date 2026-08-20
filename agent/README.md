# Buzzard Agent integration

The browser, agent harness and web UI are independently packaged modules:

- `wildbuzzard` owns the browser and its direct native CLI;
- `buzzard-agent` owns the debranded Pi-compatible coding-agent harness;
- `buzzard-agent-web` owns the web UI, server and session daemon.

The browser invokes `/usr/bin/buzzard-agent-web` through its documented JSON
CLI and passes private browser-control and service-identity files. It does not
embed, extract, hash or supervise the web UI runtime. The package owns its
systemd user units and can continue serving active sessions when the browser is
closed.

`agent/integrations/buzzard-capabilities` connects to the independently
installed search and torrent services. Browser work uses `wildbuzzard`
directly; there is no browser MCP or agent-specific browser adapter.

The browser-control architecture, licensing and acceptance scope are documented
in [`BROWSER-CONTROL.md`](BROWSER-CONTROL.md).
