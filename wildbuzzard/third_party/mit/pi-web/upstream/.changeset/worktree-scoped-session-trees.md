---
"@jmfederico/pi-web": patch
---

Session trees now cover only the workspace you are viewing. Opening a workspace's session list no longer reads session files from your other worktrees, so listing stays fast no matter how many sibling worktrees exist or how busy they are. Three things go away with it: a session's row no longer counts child sessions started in other workspaces, a session whose parent lives in another workspace no longer names that workspace, and it no longer offers "Go to parent session". Such a session now appears as an ordinary top-level row with a dimmed `↳` marker (hover text: "Parent session is not available in this workspace"). Parents and children in the same workspace are untouched — they still nest, indent, and detach exactly as before.
