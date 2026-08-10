/* SPDX-License-Identifier: AGPL-3.0-or-later */

export const WEB_TOOL_NAMES = [
  "web_search",
  "source_check",
  "fetch_content",
  "crawl_content",
  "get_search_content",
];

const WEB_CONTINUATION_TOOL_NAMES = ["fetch_content", "get_search_content"];
const ACTIVATION_PATTERN =
  /\b(search|research|source|citation|website|web|internet|online|current|latest|github|youtube|url|crawl|scrape)\b/i;

export function webToolsForPrompt(
  prompt: string,
  hasStoredResults = false
): string[] {
  if (ACTIVATION_PATTERN.test(prompt)) {
    return [...WEB_TOOL_NAMES];
  }
  return hasStoredResults ? [...WEB_CONTINUATION_TOOL_NAMES] : [];
}
