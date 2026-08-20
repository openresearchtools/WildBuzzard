# Unified browser control

Wild Buzzard exposes browser control directly through the `wildbuzzard`
executable. Its public command contract follows BrowserOS so humans and agents
can use the established `tabs`,
`navigate`, `snapshot`, `diff`, `act`, `read`, `screenshot`, and related tool
semantics without learning a second Firefox-specific API.

The implementation reuses and extends Gecko's privileged accessibility,
BrowsingContext, DevTools, WebDriver BiDi, and Marionette machinery inside the
browser. These are implementation details: websites must not see an automation
session, and CLI clients receive Wild Buzzard page IDs and stable `eN` references
rather than Marionette, BiDi, actor, or backend-node identifiers.

## Upstream references and licenses

- BrowserOS browser-core and MCP tool implementations are the source of the
  agent-facing contract. The pinned revision and AGPL attribution are recorded
  in `wildbuzzard/components/wildbuzzard-cli/NOTICE`.
- Mozilla Firefox DevTools MCP is an implementation and behavior reference for
  Firefox transport, console, script exceptions, network diagnostics,
  screenshots, downloads, input, and lifecycle handling. The pinned revision
  is recorded in `firefox-devtools-mcp-upstream.toml`. WildBuzzard elects its
  MIT license; the required notice is in
  `wildbuzzard/components/wildbuzzard-cli/MOZILLA-MCP-LICENSE`.

The BrowserOS core names remain the primary browsing API. Developer diagnostics
inspired by Mozilla's MCP are direct Wild Buzzard commands where BrowserOS has
no equivalent (`list_console_messages`, `clear_console_messages`,
`list_network_requests`, and `get_network_request`). They use the same
Wild Buzzard page IDs, working-directory policy, private local connection, and
Gecko process. There is no browser MCP server, selected-target adapter, or
public remote-control transport.

## Acceptance scope

The same tools must work for both:

1. arbitrary browsing, including opening and closing windows/tabs, navigation,
   compact page understanding, forms, pointer and keyboard interaction,
   uploads, downloads, screenshots, extraction, and cross-origin frames; and
2. development-site debugging, including console output, uncaught script
   exceptions, failed requests, status and timing data, DOM/accessibility
   state, screenshots, and changes caused by an action.

A tool name alone is not parity. Each tool needs end-to-end validation against
unrelated public sites and local development fixtures, with page-visible
automation identifiers remaining false.
