# Wild Buzzard CLI

This source is bundled privately into the `wildbuzzard` Debian package. The
only public browser executable is `wildbuzzard`; browser launch arguments and
native control operations share that executable.

```bash
wildbuzzard open https://example.com
wildbuzzard tabs
wildbuzzard snapshot
wildbuzzard click @e2
wildbuzzard read
wildbuzzard screenshot
wildbuzzard run workflow.js
```

The installed executable is a small native launcher and Unix-socket client.
Every command is parsed and executed by privileged Gecko JavaScript inside the
running browser. There is no bundled Node.js runtime, MCP server, bearer token,
connection file, or second browser-automation daemon.
