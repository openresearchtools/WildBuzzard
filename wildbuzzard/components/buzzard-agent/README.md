# Buzzard Agent

Buzzard Agent is the independently installable Debian package for the coding
agent used by Wild Buzzard. It is built from the pristine, pinned source in
`wildbuzzard/third_party/mit/pi/upstream`, then receives deterministic
downstream identity changes in a temporary build tree.

The package installs `/usr/bin/buzzard-agent` and keeps its state under
`~/.buzzard-agent/agent`. It does not embed the browser UI, web search, torrent
search, torrent application, or quick-search implementation. Those are
separate Debian dependencies and can also be used by other applications.

Its default capability extension connects to those packages over their MCP
stdio interfaces. Pass `--no-extensions` to disable it, or set
`BUZZARD_AGENT_CAPABILITIES` to a comma-separated subset of `searx`,
`quick-search`, `torrent-search`, and `torrent`. Agents control the browser
directly with the `wildbuzzard` CLI when that package is installed.

Run `./build-deb.sh [output-directory]` with Node.js 22.19 or newer, npm,
Python 3, and `dpkg-deb` available. The build uses upstream's pinned npm
lockfiles and requires npm registry access unless the npm cache is already
complete.
