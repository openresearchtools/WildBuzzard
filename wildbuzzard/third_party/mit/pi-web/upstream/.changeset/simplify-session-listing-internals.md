---
"@jmfederico/pi-web": patch
---

Keep cached session-list rows consistent with the transcript files they describe. When a session file has changed, its row is now rebuilt from a complete pass over that file instead of folding only the newly appended lines onto state kept from an earlier pass, so a row can no longer keep showing details that were overwritten earlier in the file. Unchanged files are still not re-read at all, and message bodies that cannot affect a row are still skipped without being decoded or parsed. This has a cost worth stating plainly: since 1.202608.0 a changed file was re-read only from its previous end, so refreshing a workspace while one of its sessions is actively being written now re-reads that whole transcript rather than just its new tail.
