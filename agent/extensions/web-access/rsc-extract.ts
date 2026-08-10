/* SPDX-License-Identifier: AGPL-3.0-or-later */
/* Derived from pi-web-access. Copyright (c) 2025 Nico Bailon. */

import { parseHTML } from "linkedom";

const MAX_SCRIPTS = 256;
const MAX_CHUNKS = 4_096;
const MAX_DEPTH = 80;
const MAX_CONTENT = 2_000_000;

export interface RSCExtractResult {
  title: string;
  content: string;
}

export function extractRSCContent(html: string): RSCExtractResult | null {
  if (!html.includes("self.__next_f.push")) {
    return null;
  }
  const { document } = parseHTML(html);
  const chunks = new Map<string, string>();
  for (const script of [...document.querySelectorAll("script")].slice(0, MAX_SCRIPTS)) {
    const source = script.textContent?.trim() ?? "";
    const prefix = "self.__next_f.push(";
    if (!source.startsWith(prefix) || !source.endsWith(")")) {
      continue;
    }
    try {
      const message = JSON.parse(source.slice(prefix.length, -1)) as unknown;
      if (!Array.isArray(message) || message[0] !== 1 || typeof message[1] !== "string") {
        continue;
      }
      for (const line of message[1].split("\n")) {
        const match = /^([0-9a-f]{1,4}):(.+)$/i.exec(line);
        if (!match || chunks.size >= MAX_CHUNKS) {
          continue;
        }
        const current = chunks.get(match[1]);
        if (!current || match[2].length > current.length) {
          chunks.set(match[1], match[2]);
        }
      }
    } catch {}
  }
  if (!chunks.size) {
    return null;
  }

  const parsed = new Map<string, unknown>();
  const resolve = (id: string): unknown => {
    if (parsed.has(id)) {
      return parsed.get(id);
    }
    const source = chunks.get(id);
    let value: unknown = null;
    if (source?.startsWith("[")) {
      try {
        value = JSON.parse(source);
      } catch {}
    }
    parsed.set(id, value);
    return value;
  };

  const activeRefs = new Set<string>();
  const extract = (node: unknown, depth = 0, inCode = false): string => {
    if (depth > MAX_DEPTH || node === null || node === undefined) {
      return "";
    }
    if (typeof node === "number") {
      return String(node);
    }
    if (typeof node === "string") {
      const ref = /^\$L([0-9a-f]+)$/i.exec(node)?.[1];
      if (ref) {
        if (activeRefs.has(ref)) {
          return "";
        }
        activeRefs.add(ref);
        const content = extract(resolve(ref), depth + 1, inCode);
        activeRefs.delete(ref);
        return content;
      }
      return !inCode && (node === "$" || node === "$undefined" || /^\$[A-Z]/.test(node))
        ? ""
        : node;
    }
    if (!Array.isArray(node)) {
      return "";
    }
    if (node[0] !== "$" || typeof node[1] !== "string") {
      return node.map(value => extract(value, depth + 1, inCode)).join("");
    }
    const tag = node[1];
    const props =
      node[3] && typeof node[3] === "object"
        ? (node[3] as Record<string, unknown>)
        : {};
    if (["script", "style", "svg", "path", "link", "meta", "template", "button", "input", "nav", "footer", "aside"].includes(tag)) {
      return "";
    }
    const children = props.children;
    if (tag.startsWith("$L")) {
      return props.baseId && typeof children === "string"
        ? `## ${children}\n\n`
        : extract(children, depth + 1, inCode);
    }
    const content = extract(children, depth + 1, inCode);
    switch (tag) {
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6":
        return `${"#".repeat(Number(tag[1]))} ${content.trim()}\n\n`;
      case "p":
        return `${content.trim()}\n\n`;
      case "pre":
        return `\`\`\`\n${extract(children, depth + 1, true)}\n\`\`\`\n\n`;
      case "code":
        return inCode ? content : `\`${extract(children, depth + 1, true)}\``;
      case "strong":
      case "b":
        return `**${content}**`;
      case "em":
      case "i":
        return `*${content}*`;
      case "li":
        return `- ${content.trim()}\n`;
      case "ul":
      case "ol":
        return `${content}\n`;
      case "blockquote":
        return `> ${content.trim()}\n\n`;
      case "a": {
        const href = typeof props.href === "string" ? props.href : "";
        return href && !href.startsWith("#") ? `[${content}](${href})` : content;
      }
      default:
        return content;
    }
  };

  const candidates = ["23", ...[...chunks.keys()].filter(id => id !== "23")];
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const id of candidates) {
    activeRefs.clear();
    const content = extract(resolve(id)).replace(/\n{3,}/g, "\n\n").trim();
    const key = content.slice(0, 150);
    if (content.length > 50 && !seen.has(key)) {
      seen.add(key);
      parts.push(content);
    }
    if (parts.join("\n\n").length >= MAX_CONTENT) {
      break;
    }
  }
  const content = parts.join("\n\n").slice(0, MAX_CONTENT).trim();
  if (content.length <= 100) {
    return null;
  }
  return {
    title: (document.title?.split("|")[0]?.trim() ?? "").slice(0, 500),
    content,
  };
}
