/* SPDX-License-Identifier: AGPL-3.0-or-later */

export const WEB_TOOL_NAMES = [
  "web_search",
  "source_check",
  "fetch_content",
  "crawl_content",
  "get_search_content",
];

export function webToolsForPrompt(
  _prompt: string,
  _hasStoredResults = false
): string[] {
  return [...WEB_TOOL_NAMES];
}
