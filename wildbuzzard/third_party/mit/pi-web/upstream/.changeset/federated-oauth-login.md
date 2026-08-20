---
"@jmfederico/pi-web": patch
---

Allow subscription (OAuth) login and logout for federated remote machines from the gateway web UI. The login flow now runs on the selected remote machine instead of being refused, and the dialog explains that the provider's redirect page will not load in your browser so you can paste the full redirect URL back to complete the login.
