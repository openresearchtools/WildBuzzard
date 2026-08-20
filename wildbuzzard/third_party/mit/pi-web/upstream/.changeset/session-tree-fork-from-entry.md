---
"@jmfederico/pi-web": patch
---

Add a two-step session tree flow that first selects a history entry, then either continues from it in the same session or forks it into a separate session while leaving the original unchanged. Forking works for local and connected machines; user messages fork from before the entry and restore their text, when present, as the new session draft.
