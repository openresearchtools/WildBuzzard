---
"@jmfederico/pi-web": patch
---

Tracked subsessions (beta) now always run in the working directory of the session that spawned them, so a tracked child always appears in its parent's session tree instead of possibly landing in a workspace where you would not see it. `spawn_subsession` no longer takes a `cwd` parameter, and a request to start a tracked child in a different directory is refused with an explanatory error rather than quietly started somewhere else. To get work done in another workspace, either tell the child to work there, or use `spawn_session`, which can still start an independent session in any project workspace.
