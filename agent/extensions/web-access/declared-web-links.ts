/* SPDX-License-Identifier: AGPL-3.0-or-later */
/* Derived from pi-web-access. Copyright (c) 2025 Nico Bailon. */

const MAX_LINKS = 20;
const MAX_URL_LENGTH = 4_096;
const RELATIONS = new Set([
  "api-catalog",
  "describedby",
  "service-desc",
  "service-doc",
  "service-meta",
]);

export interface DeclaredWebLink {
  url: string;
  relations: string[];
  type?: string;
}

export function discoverDeclaredWebLinks(
  document: Document,
  responseUrl: string,
  linkHeader: string | null = null
): DeclaredWebLink[] {
  const links = new Map<string, DeclaredWebLink>();
  for (const entry of splitOutside(linkHeader ?? "", ",", true) ?? []) {
    const target = /^\s*<([^>]*)>/.exec(entry);
    if (!target) {
      continue;
    }
    const parameters = parseParameters(entry.slice(target[0].length));
    if (!parameters || parameters.has("anchor")) {
      continue;
    }
    addLink(links, target[1], parameters.get("rel"), parameters.get("type"), responseUrl);
  }

  const baseValue = document.querySelector("base[href]")?.getAttribute("href");
  const baseUrl = resolveHttpUrl(baseValue, responseUrl) ?? responseUrl;
  for (const element of document.querySelectorAll("link[rel][href], a[rel][href]")) {
    addLink(
      links,
      element.getAttribute("href"),
      element.getAttribute("rel"),
      element.getAttribute("type"),
      baseUrl
    );
    if (links.size >= MAX_LINKS) {
      break;
    }
  }
  return [...links.values()];
}

export function appendDeclaredWebLinks(
  content: string,
  links: DeclaredWebLink[]
): string {
  if (!links.length) {
    return content;
  }
  const rows = links.map(link => {
    const type = link.type ? `; \`${link.type.replaceAll("`", "'")}\`` : "";
    return `- \`${link.relations.join("`, `")}\`${type}: <${link.url}>`;
  });
  const section = ["## Declared links", "", ...rows].join("\n");
  return content.trim() ? `${content.trim()}\n\n${section}` : section;
}

function addLink(
  links: Map<string, DeclaredWebLink>,
  value: string | null | undefined,
  relValue: string | null | undefined,
  typeValue: string | null | undefined,
  baseUrl: string
): void {
  if (links.size >= MAX_LINKS) {
    return;
  }
  const url = resolveHttpUrl(value, baseUrl);
  const relations = declaredRelations(relValue);
  if (!url || !relations.length) {
    return;
  }
  const existing = links.get(url);
  if (existing) {
    existing.relations = [...new Set([...existing.relations, ...relations])];
    return;
  }
  const type = typeValue?.replace(/\s+/g, " ").trim().slice(0, 160);
  links.set(url, { url, relations, ...(type ? { type } : {}) });
}

function declaredRelations(value: string | null | undefined): string[] {
  return [
    ...new Set(
      (value ?? "")
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .filter(relation => RELATIONS.has(relation))
    ),
  ];
}

function resolveHttpUrl(
  value: string | null | undefined,
  baseUrl: string
): string | null {
  if (!value || value.length > MAX_URL_LENGTH) {
    return null;
  }
  try {
    const url = new URL(value, baseUrl);
    return url.href.length <= MAX_URL_LENGTH && ["http:", "https:"].includes(url.protocol)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function splitOutside(
  input: string,
  separator: string,
  protectTargets: boolean
): string[] | null {
  const parts: string[] = [];
  let start = 0;
  let inTarget = false;
  let inQuotes = false;
  let escaped = false;
  for (let index = 0; index < input.length; index++) {
    const character = input[index];
    if (inQuotes) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inQuotes = false;
      }
    } else if (character === '"' && !inTarget) {
      inQuotes = true;
    } else if (protectTargets && character === "<") {
      inTarget = true;
    } else if (protectTargets && character === ">") {
      inTarget = false;
    } else if (character === separator && !inTarget) {
      parts.push(input.slice(start, index));
      start = index + 1;
    }
  }
  if (inQuotes || inTarget) {
    return null;
  }
  parts.push(input.slice(start));
  return parts;
}

function parseParameters(input: string): Map<string, string> | null {
  const parts = splitOutside(input, ";", false);
  if (!parts || parts.shift()?.trim()) {
    return null;
  }
  const parameters = new Map<string, string>();
  for (const part of parts) {
    const match = /^\s*([!#$%&'*+\-.^_`|~A-Za-z0-9]+)(?:\s*=\s*(?:"((?:\\.|[^"])*)"|(\S+)))?\s*$/.exec(
      part
    );
    if (!match) {
      return null;
    }
    const name = match[1].toLowerCase();
    const value =
      match[2] === undefined
        ? (match[3] ?? "")
        : match[2].replace(/\\(.)/g, "$1");
    if (!parameters.has(name)) {
      parameters.set(name, value);
    }
  }
  return parameters;
}
