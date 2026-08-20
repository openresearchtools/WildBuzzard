---
"@jmfederico/pi-web": patch
---

Send a provider login prompt or selection only once: pressing Enter again, or choosing another option, while the previous response is still being sent no longer submits a duplicate response that could lose the race and report an expired login request. Cancelling the login stays available while a response is in flight.
