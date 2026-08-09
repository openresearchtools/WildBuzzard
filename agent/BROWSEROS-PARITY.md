# BrowserOS browser-tool parity

This document tracks behavioral parity against BrowserOS, not merely matching
tool names. The reference source is pinned in `agent/browseros-upstream.toml`
and the contract is the Rust `browseros-mcp` implementation at commit
`5a4a9ef8f64522a9f20ccc212642ee4bba35ad49`.

Status meanings:

- **Verified**: exercised through the packaged Pi extension and a built
  WildBuzzard browser.
- **Implemented**: the contract is present but its full edge-case matrix has
  not yet been exercised.
- **Partial**: useful behavior exists, but a known BrowserOS contract or
  arbitrary-site behavior is missing.

| Tool | BrowserOS contract | WildBuzzard status | Evidence and scope |
|---|---|---|---|
| `tabs` | list, active, new, close; background new tab; snapshot on new | Verified | New tabs wait for navigation and actor attachment, return the BrowserOS `[Page N snapshot]` auto-context with an untrusted boundary, preserve background focus, and enforce ownership across windows. Gecko lazy session-restored tabs are materialized on demand without selecting them or stealing focus. Raw BrowserOS tab creation defaults to foreground and does not implicitly create a session group. Private tabs are an intentional WildBuzzard extension. |
| `tab_groups` | list, create, update, ungroup, close with argument validation | Verified | Create/add/update/ungroup/close, color/collapsed state, automatic per-session groups, cleanup, validation, and response rendering are exercised in the built browser. |
| `history` | recent entries, default 100, visit and typed counts, RFC3339 time | Verified | Real Places entries, RFC3339 rendering, typed/visit counts, singular/plural output, result limits, and invalid limits are exercised. |
| `navigate` | URL, back, forward, reload; new snapshot; old refs invalid | Verified | URL/back/forward/reload return a freshly formatted snapshot and invalidate old refs. Invalid URLs error, while `file:`, `javascript:`, and `data:` return the BrowserOS `scheme-refused` class. |
| `snapshot` | full/interactive, depth 1..100, stable refs, full baseline, frames to depth 5 | Verified | Snapshot output has the BrowserOS page header, per-call untrusted boundary, 15,000-token spill threshold, 5,000-token excerpt, stable refs, and a live-DOM fallback when Gecko's accessibility cache omits newly inserted actionables. Semantic accessibility, cursor-pointer and tabindex-only controls, open shadow roots, same-origin frames and cross-origin frames are covered. A 5,021-ref dynamic fixture spilled at an estimated 88,149 tokens. |
| `diff` | compact added/removed change set from full committed baseline | Verified | Five formatter tests cover no-change, additions/removals, duplicate lines and oversized output. Built-browser checks cover URL changes, post-action changes, 10,000-token spill, full-baseline commits and untrusted boundaries. |
| `act` | all 17 BrowserOS kinds, native input, post-action diff, console signals, dialogs | Verified | The built-browser matrix covers ref/coordinate click and type, exact canvas coordinates, append/clear and multi-field fill, BrowserOS key aliases, focus, check/uncheck, semantic select, 120 px/notch scroll, raw pointer drag, native HTML5 drag/drop, hover, covered-target diagnostics, shadow-DOM hit testing, dialog accept/dismiss/prompt text and chained dialogs. Nested and cross-origin frame targets scroll into view automatically. Ref numbers never alias newly snapshotted nodes after navigation. |
| `download` | subscribe before click, wait for completion/cancel, unique output | Verified | Success, duplicate-name handling, timeout/cancellation and work-directory confinement are exercised. WildBuzzard subscribes before click, serializes its process-global Firefox download-preference window and restores the previous preferences. |
| `upload` | one or many local files to a ref | Verified | Single/nested and multi-file paths are resolved inside the Agent directory, installed through Gecko's privileged file-input path, and observed by page `input`/`change` handlers with content-accessible names. Outside/missing path rejection remains defense-in-depth coverage, not a known contract gap. |
| `read` | markdown/text/links/console, selectors/options, 5,000-char inline limit, full output file, untrusted boundary | Verified | The packaged SDK matrix covers content, selector and output handling. The converter handles headings, tables, lists, links, images, forms and frame content. `network` is an intentional WildBuzzard development-debugging extension. |
| `grep` | default accessibility tree, content option, case-insensitive regex, 0..200 matches, 500-char lines, output file, untrusted boundary | Verified | Content/tree search, regular expressions, limits, truncation, invalid patterns, output spill and untrusted boundaries are exercised. |
| `screenshot` | jpeg/png/webp, quality, scaled viewport, full page, temporary numbered annotations and annotation metadata | Verified | PNG/JPEG/WebP signatures, quality/scaling, viewport/full-page capture, raw clip geometry, transparent non-blocking overlays, nested-frame projection, labels and returned boxes are exercised. A post-build full-page fixture is 1000x2871; a raw 200x100 clip at scale 0.5 is exactly 100x50. |
| `pdf` | landscape/background/CSS page size, output file | Verified | Portrait/landscape, background, CSS page size, valid PDF output and the raw `Page.printToPDF` base64 path are exercised. Gecko's print job was extended so CSS-page-size behavior is available to the in-process Agent path. |
| `wait` | text/selector/time, 2s defaults, 30s cap, signal validation | Verified | Text, selector, time, timeout, cancellation, argument validation and invalid-selector behavior are exercised. |
| `windows` | list, create, close | Verified | List/create/close, startup readiness, cleanup, response field names, and required `windowId` validation are exercised. Private windows are an intentional WildBuzzard extension. |
| `evaluate` | async body, 30s cap, by-value result, exceptions, untrusted boundary, large output file | Verified | Async values, exceptions, timeout semantics, non-serializable/circular results and the BrowserOS 5,000-character output spill are covered. Evaluation runs with Gecko's native user-input state, matching BrowserOS `userGesture: true`, while `navigator.webdriver` remains false. |
| `run` | bounded JavaScript runtime; 64 MiB heap; 512 KiB stack; 30s cap; log/value caps; complete browser SDK | Verified | The source-built QuickJS runner is process-isolated from Pi, applies BrowserOS heap/stack/time/log/value limits, interrupts infinite loops, contains out-of-memory failures, exposes no Node/Bun/network globals and preserves concurrent SDK calls. The packaged SDK matrix exercises pages, snapshots/diffs/refs, all SDK input helpers, navigation, evaluate/read/grep/wait, annotated screenshots, upload/download/PDF, groups, windows and raw compatibility calls. “Raw compatibility” means the BrowserOS SDK/CDP methods used by these tools; it does not claim that Gecko implements every unrelated Chromium CDP domain. |

## Gecko-side acceptance

Parity requires all of the following without starting a WebDriver session or
exposing automation state to page content:

- a complete, stable accessibility snapshot and ref layer across browsing
  contexts;
- native mouse, keyboard, wheel, drag/drop, dialog, upload and download
  operations;
- viewport and full-page image capture with non-obstructing numbered overlays;
- browser chrome control for tabs, groups, windows and private contexts;
- Console API, JavaScript exception, failed-request, response and source/runtime
  debugging data useful for fixing a development build;
- download and generated-output paths constrained to the selected Agent working
  directory;
- `navigator.webdriver === false` in ordinary and agent-controlled pages.

The implementation may reuse Marionette, WebDriver BiDi and Firefox DevTools
internals, but those transports and their identifiers are not part of the
model-facing tool contract.

The default build does not start the Marionette or WebDriver BiDi listeners.
Those modules are called in-process where useful; the only listener used by the
Agent is the authenticated loopback bridge. Remote UI access is separately
scoped to Agent sessions and does not publish tab-control transport.

The current post-build identity check returns
`navigator.userActivation.isActive === true` during Agent evaluation and
`navigator.webdriver === false`. The browser reports its ordinary
Firefox-compatible user agent rather than an automation user agent.

## Raw BrowserOS compatibility surface

The Pi `run` SDK uses a Gecko adapter for the BrowserOS/Chromium calls its
public helpers require. Implemented domains include browser windows, tabs and
groups; page navigation, frame trees, layout, dialogs, screenshots and PDF;
accessibility full/partial/query trees; DOM query/describe/resolve/geometry,
attributes, file inputs and frame owners; runtime evaluation, function calls,
properties and object lifetimes; native mouse, key and text input; and recent
history.

Public model-facing refs remain BrowserOS-style `eN` values. Gecko
`BrowsingContext`, accessibility and DevTools identifiers stay private to the
adapter except for the documented raw `{ backendNodeId, sessionId }` escape
hatch. No Marionette, WebDriver BiDi or DevTools socket is opened.

## Validation gates

- Gecko parent/child lint: 0 errors and 0 warnings.
- Incremental Firefox build: successful with 0 compiler warnings.
- Snapshot/diff TypeScript tests: 5/5 passing.
- Packaged Pi TypeScript validation: passing.
- Packaged BrowserOS SDK end-to-end matrix: passing.
- Widevine/GMP endpoint and policy xpcshell test: 55/55 passing.

## Unified developer diagnostics

BrowserOS does not define separate source-debugging tools, so the same Pi
extension also exposes the useful developer subset from the pinned Mozilla
Firefox DevTools MCP contract. These calls use WildBuzzard page IDs and the
same in-process Gecko bridge; they do not open another MCP/BiDi transport.

| Tool | Status | Verified behavior |
|---|---|---|
| `list_console_messages` | Verified | Levels, text/source/time filters, structured locations and stacks across page frames. |
| `clear_console_messages` | Verified | Clears all live frame actor buffers for the page. |
| `list_network_requests` | Verified | Gecko-native request/status/header/timing records with filters and stable request IDs. |
| `get_network_request` | Verified | Request and response bodies, including a 5.4 KB fixture document body. |
| `enable_debugger` | Verified | SpiderMonkey Debugger attaches in-process without a WebDriver session or content-visible automation state. |
| `list_scripts` | Verified | Loaded inline sources across same- and cross-origin frames, including executable line ranges. |
| `get_script_source` | Verified | Actual debugger source text rather than a second network fetch. |
| `set_logpoint` | Verified | Non-pausing logpoint installed at an executable source line. |
| `get_logpoint_results` | Verified | Captured the live same-origin frame callback value after a native ref click. |
| `remove_logpoint` | Implemented | Removes every internal live breakpoint behind the public opaque logpoint ID. |
