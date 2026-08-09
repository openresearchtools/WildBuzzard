/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { BROWSER_TOOL_CATALOG } from "./catalog.ts";

const BASE_TOOLS = ["tabs", "run"];
const INTERACTION_TOOLS = [
  "navigate",
  "snapshot",
  "diff",
  "act",
  "read",
  "grep",
  "wait",
];
const BROWSER_INTENT =
  /https?:\/\/|www\.|\b(browser|browse|web(?:site|page)?|site|page|link|click|form|search online|youtube|github|duck\.ai|screenshot|bookmark|history|tab|window|download|upload|console|network|debug)\b/i;

export const BROWSER_TOOL_NAMES = BROWSER_TOOL_CATALOG.map(tool => tool.name);

export function browserToolsForPrompt(prompt: string): string[] {
  const selected = new Set(BASE_TOOLS);
  if (BROWSER_INTENT.test(prompt)) {
    for (const tool of INTERACTION_TOOLS) {
      selected.add(tool);
    }
  }
  if (/\b(bookmark|favorite|favourite)\b/i.test(prompt)) {
    selected.add("bookmarks");
  }
  if (/\bhistory\b/i.test(prompt)) {
    selected.add("history");
  }
  if (/\b(download|save (?:the )?file)\b/i.test(prompt)) {
    selected.add("download");
  }
  if (/\b(upload|attach (?:the )?file|file input)\b/i.test(prompt)) {
    selected.add("upload");
  }
  if (/\b(screenshot|screen shot|capture|image)\b/i.test(prompt)) {
    selected.add("screenshot");
  }
  if (/\b(pdf|print)\b/i.test(prompt)) {
    selected.add("pdf");
  }
  if (/\b(tab group|group tabs?)\b/i.test(prompt)) {
    selected.add("tab_groups");
  }
  if (/\b(window|private browsing|incognito)\b/i.test(prompt)) {
    selected.add("windows");
  }
  if (
    /\b(console|network|request|response|debug|script|logpoint)\b/i.test(prompt)
  ) {
    for (const tool of [
      "list_console_messages",
      "clear_console_messages",
      "list_network_requests",
      "get_network_request",
      "enable_debugger",
      "list_scripts",
      "get_script_source",
      "set_logpoint",
      "remove_logpoint",
      "get_logpoint_results",
      "evaluate",
    ]) {
      selected.add(tool);
    }
  }
  return BROWSER_TOOL_NAMES.filter(name => selected.has(name));
}
