---
"@jmfederico/pi-web": patch
---

Give the web UI's custom overlay dialogs (authentication, settings, session cleanup, command picker, action palette, project/machine dialogs, and the session tree navigator) a shared modal surface: dialogs now take focus when opened, Escape and backdrop presses close them consistently, Tab focus stays trapped inside the dialog, and focus returns to the element that was focused before the dialog opened—even when stacked dialogs close out of order. Global application shortcuts pause while a dialog is open. The authentication dialog also supports ArrowUp/ArrowDown/Enter navigation through its option lists, matching the action palette. In the session tree navigator's second step (continuing or forking from a selected entry), a backdrop press now steps back to the tree — matching Escape — instead of closing the dialog outright.
