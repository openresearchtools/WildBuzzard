/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ContentDOMReference } from "resource://gre/modules/ContentDOMReference.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  actions: "chrome://remote/content/shared/webdriver/Actions.sys.mjs",
  addDebuggerToGlobal: "resource://gre/modules/jsdebugger.sys.mjs",
  ConsoleAPIListener:
    "chrome://remote/content/shared/listeners/ConsoleAPIListener.sys.mjs",
  ConsoleListener:
    "chrome://remote/content/shared/listeners/ConsoleListener.sys.mjs",
  evaluate: "chrome://remote/content/marionette/evaluate.sys.mjs",
  event: "chrome://remote/content/shared/webdriver/Event.sys.mjs",
  interaction: "chrome://remote/content/marionette/interaction.sys.mjs",
  keyData: "chrome://remote/content/shared/webdriver/KeyData.sys.mjs",
  sandbox: "chrome://remote/content/marionette/evaluate.sys.mjs",
});

const MAX_CONSOLE_MESSAGES = 1000;
const MAX_CONSOLE_MESSAGE_BYTES = 64 * 1024;
const MAX_CONSOLE_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_CHILD_TEXT_CHARS = 2 * 1024 * 1024;
const MAX_SNAPSHOT_NODES = 10000;
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const MAX_SNAPSHOT_FIELD_CHARS = 4000;
const TEXT_CONTENT_ROLES = new Set([
  "alert",
  "log",
  "paragraph",
  "status",
  "timer",
]);
const INTERACTIVE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textarea",
  "textbox",
  "treeitem",
  "DisclosureTriangle",
]);

function stringRole(accessible, service) {
  return (
    accessible.computedARIARole ||
    service.getStringRole(accessible.role) ||
    "generic"
  );
}

function statesFor(accessible) {
  const state = {};
  const extraState = {};
  accessible.getState(state, extraState);
  const value = state.value;
  const states = [];
  if (value & Ci.nsIAccessibleStates.STATE_MIXED) {
    states.push("indeterminate");
  } else if (value & Ci.nsIAccessibleStates.STATE_CHECKED) {
    states.push("checked");
  }
  if (value & Ci.nsIAccessibleStates.STATE_UNAVAILABLE) {
    states.push("disabled");
  }
  if (value & Ci.nsIAccessibleStates.STATE_EXPANDED) {
    states.push("expanded");
  } else if (value & Ci.nsIAccessibleStates.STATE_COLLAPSED) {
    states.push("collapsed");
  }
  if (value & Ci.nsIAccessibleStates.STATE_REQUIRED) {
    states.push("required");
  }
  if (value & Ci.nsIAccessibleStates.STATE_SELECTED) {
    states.push("selected");
  }
  if (accessible.role === Ci.nsIAccessibleRole.ROLE_HEADING) {
    const level = {};
    accessible.groupPosition(level, {}, {});
    if (level.value > 0) {
      states.push(`level=${level.value}`);
    }
  }
  return states;
}

function snapshotText(value, budget, maximum = MAX_SNAPSHOT_FIELD_CHARS) {
  const text = String(value ?? "");
  const remaining = Math.max(
    0,
    Math.floor((MAX_SNAPSHOT_BYTES - budget.bytes) / 3)
  );
  const limit = Math.min(maximum, remaining);
  const bounded = text.slice(0, limit);
  budget.bytes += bounded.length * 3;
  if (bounded.length !== text.length) {
    budget.truncated = true;
  }
  return bounded;
}

function takeSnapshotNode(budget) {
  if (
    budget.nodes >= MAX_SNAPSHOT_NODES ||
    budget.bytes >= MAX_SNAPSHOT_BYTES
  ) {
    budget.truncated = true;
    return false;
  }
  budget.nodes++;
  return true;
}

function attributesFor(accessible, budget) {
  const attributes = {};
  if (accessible.attributes) {
    let count = 0;
    for (const { key, value } of accessible.attributes.enumerate()) {
      if (count++ >= 50) {
        budget.truncated = true;
        break;
      }
      attributes[snapshotText(key, budget, 256)] = snapshotText(
        value,
        budget,
        1000
      );
    }
  }
  return attributes;
}

function boundsFor(node) {
  if (!node?.getBoundingClientRect) {
    return null;
  }
  const rect = node.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    return null;
  }
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  };
}

function isInteractive(node, role) {
  if (!node) {
    return false;
  }
  if (
    INTERACTIVE_ROLES.has(role) ||
    node.isContentEditable ||
    node.hasAttribute?.("onclick") ||
    typeof node.onclick === "function" ||
    (node.hasAttribute?.("tabindex") && node.getAttribute("tabindex") !== "-1")
  ) {
    return true;
  }
  try {
    const window = node.documentGlobal;
    if (window.getComputedStyle(node).cursor !== "pointer") {
      return false;
    }
    const parent = node.parentElement;
    return !parent || window.getComputedStyle(parent).cursor !== "pointer";
  } catch {
    return false;
  }
}

function referenceNode(node) {
  if (!node) {
    return node;
  }
  try {
    if (node.localName === "input" && node.type === "file") {
      return node;
    }
    const host = node.getRootNode?.()?.host;
    if (host?.localName === "input" && host.type === "file") {
      return host;
    }
  } catch {}
  return node;
}

function snapshotAccessible(accessible, service, depth, maxDepth, budget) {
  if (!accessible || depth > maxDepth || !takeSnapshotNode(budget)) {
    return null;
  }
  const node = referenceNode(accessible.DOMNode);
  const actions = [];
  for (let index = 0; index < Math.min(accessible.actionCount, 20); index++) {
    actions.push(accessible.getActionDescription(index));
  }
  if (accessible.actionCount > 20) {
    budget.truncated = true;
  }
  const role = snapshotText(stringRole(accessible, service), budget, 128);
  const reference =
    node?.nodeType === node.ELEMENT_NODE ? ContentDOMReference.get(node) : null;
  const interactive = isInteractive(node, role);
  const children = [];
  if (role !== "internal frame") {
    for (let child = accessible.firstChild; child; child = child.nextSibling) {
      const item = snapshotAccessible(
        child,
        service,
        depth + 1,
        maxDepth,
        budget
      );
      if (item) {
        children.push(item);
      }
      if (budget.truncated && budget.bytes >= MAX_SNAPSHOT_BYTES) {
        break;
      }
    }
  }
  let name = accessible.name || "";
  if (!name && TEXT_CONTENT_ROLES.has(role)) {
    name = children
      .map(child => child.name)
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 500);
  }
  if (!name && interactive) {
    name = (node?.innerText ?? node?.textContent ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 500);
  }
  name = snapshotText(name, budget);
  return {
    role,
    name,
    value: snapshotText(accessible.value, budget),
    description: snapshotText(accessible.description, budget, 2000),
    states: statesFor(accessible),
    actions: actions
      .slice(0, 20)
      .map(action => snapshotText(action, budget, 256)),
    attributes: attributesFor(accessible, budget),
    tag: node?.tagName?.toLowerCase() ?? null,
    reference,
    bounds: boundsFor(node),
    interactive,
    children,
  };
}

function isAccessibleStale(accessible) {
  if (!accessible) {
    return true;
  }
  const extraState = {};
  accessible.getState({}, extraState);
  return Boolean(extraState.value & Ci.nsIAccessibleStates.EXT_STATE_STALE);
}

// eslint-disable-next-line complexity
function snapshotDom(node, depth, maxDepth, budget) {
  if (
    depth > maxDepth ||
    node.nodeType !== node.ELEMENT_NODE ||
    !takeSnapshotNode(budget)
  ) {
    return null;
  }
  if (
    ["HEAD", "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(
      node.tagName
    ) ||
    node.hidden ||
    node.closest?.("[inert]")
  ) {
    return null;
  }
  const style = node.documentGlobal.getComputedStyle(node);
  if (style.display === "none" || style.visibility === "hidden") {
    return null;
  }
  const role = snapshotText(
    node.getAttribute("role") ||
      {
        A: "link",
        BUTTON: "button",
        DETAILS: "group",
        FORM: "form",
        H1: "heading",
        H2: "heading",
        H3: "heading",
        H4: "heading",
        H5: "heading",
        H6: "heading",
        HTML: "document",
        IMG: "img",
        INPUT:
          {
            button: "button",
            checkbox: "checkbox",
            file: "button",
            radio: "radio",
            range: "slider",
            submit: "button",
          }[node.type] || "textbox",
        LABEL: "label",
        LI: "listitem",
        OL: "list",
        OPTION: "option",
        OUTPUT: "status",
        P: "paragraph",
        SELECT: "combobox",
        SUMMARY: "button",
        TEXTAREA: "textbox",
        UL: "list",
      }[node.tagName] ||
      "generic",
    budget,
    128
  );
  const explicitName =
    node.getAttribute("aria-label") ||
    node.getAttribute("alt") ||
    node.getAttribute("title") ||
    "";
  const associatedLabel =
    node.labels?.length > 0
      ? [...node.labels]
          .map(label => label.innerText?.trim())
          .filter(Boolean)
          .join(" ")
      : "";
  const interactive = isInteractive(node, role);
  const canUseInnerText = role !== "generic" || interactive;
  const name =
    explicitName ||
    associatedLabel ||
    (canUseInnerText ? node.innerText?.trim().slice(0, 500) : "") ||
    "";
  const children = [];
  const childElements = [
    ...(node.shadowRoot?.children ?? []),
    ...node.children,
  ];
  for (const child of childElements) {
    const item = snapshotDom(child, depth + 1, maxDepth, budget);
    if (item) {
      children.push(item);
    }
    if (budget.truncated && budget.bytes >= MAX_SNAPSHOT_BYTES) {
      break;
    }
  }
  return {
    role,
    name: snapshotText(name, budget),
    value: snapshotText("value" in node ? node.value : "", budget),
    description: snapshotText(
      node.getAttribute("aria-description"),
      budget,
      2000
    ),
    states: [
      node.disabled ? "disabled" : null,
      node.checked ? "checked" : null,
      node.required ? "required" : null,
      /^H[1-6]$/.test(node.tagName)
        ? `level=${Number(node.tagName.slice(1))}`
        : null,
      node.getAttribute("aria-expanded") === "true" ? "expanded" : null,
      node.getAttribute("aria-expanded") === "false" ? "collapsed" : null,
    ].filter(Boolean),
    actions: [],
    attributes: {},
    tag: node.tagName.toLowerCase(),
    reference: ContentDOMReference.get(node),
    bounds: boundsFor(node),
    interactive,
    children,
  };
}

function countSnapshotInteractives(node) {
  if (!node) {
    return 0;
  }
  return (
    (node.interactive ? 1 : 0) +
    (node.children ?? []).reduce(
      (total, child) => total + countSnapshotInteractives(child),
      0
    )
  );
}

function countDomInteractives(node, budget = { nodes: 0 }) {
  if (
    !node ||
    node.nodeType !== node.ELEMENT_NODE ||
    budget.nodes++ >= MAX_SNAPSHOT_NODES
  ) {
    return 0;
  }
  if (
    ["HEAD", "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(
      node.tagName
    ) ||
    node.hidden ||
    node.closest?.("[inert]")
  ) {
    return 0;
  }
  const style = node.documentGlobal.getComputedStyle(node);
  if (style.display === "none" || style.visibility === "hidden") {
    return 0;
  }
  const role =
    node.getAttribute("role") ||
    {
      A: "link",
      BUTTON: "button",
      INPUT: node.type === "hidden" ? "generic" : "textbox",
      OPTION: "option",
      SELECT: "combobox",
      SUMMARY: "button",
      TEXTAREA: "textbox",
    }[node.tagName] ||
    "generic";
  return (
    (isInteractive(node, role) ? 1 : 0) +
    [...(node.shadowRoot?.children ?? []), ...node.children].reduce(
      (total, child) => total + countDomInteractives(child, budget),
      0
    )
  );
}

function resolveTarget(reference) {
  const target = ContentDOMReference.resolve(reference);
  if (!target || !target.isConnected) {
    throw new Error("The element reference is stale; take a new snapshot");
  }
  return target;
}

async function mouseAt(win, x, y, type, button = 0, clickCount = 1) {
  await lazy.event.synthesizeMouseAtPoint(
    x,
    y,
    {
      type,
      button,
      clickCount,
      allowToHandleDragDrop: true,
    },
    win
  );
}

async function withUserInput(win, callback) {
  const handling = win.windowUtils.setHandlingUserInput(true);
  try {
    return await callback();
  } finally {
    handling.destruct();
  }
}

async function performPointerDrag(win, start, end) {
  const state = new lazy.actions.State();
  const context = { isContent: false };
  const options = {
    context,
    isElementOrigin: () => false,
    getElementOrigin: () => {
      throw new Error("Element pointer origins are not used by browser tools");
    },
    assertInViewPort: ([x, y]) => {
      if (x < 0 || y < 0 || x > win.innerWidth || y > win.innerHeight) {
        throw new Error(
          `Pointer target (${x}, ${y}) is outside the ${win.innerWidth}x${win.innerHeight} viewport`
        );
      }
    },
    dispatchEvent: async (eventName, _context, details) => {
      if (eventName !== "synthesizeMouseAtPoint") {
        throw new Error(`Unsupported pointer event dispatcher: ${eventName}`);
      }
      await lazy.event.synthesizeMouseAtPoint(
        details.x,
        details.y,
        details.eventData,
        win
      );
    },
    getClientRects: element => element.getClientRects(),
    getInViewCentrePoint: rect => ({
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
    }),
    toBrowserWindowCoordinates: coordinates => coordinates,
  };
  const chain = await lazy.actions.Chain.fromJSON(
    state,
    [
      {
        type: "pointer",
        id: "wildbuzzard-mouse",
        parameters: { pointerType: "mouse" },
        actions: [
          {
            type: "pointerMove",
            origin: "viewport",
            x: start.x,
            y: start.y,
            duration: 0,
          },
          { type: "pointerDown", button: 0 },
          {
            type: "pointerMove",
            origin: "viewport",
            x: end.x,
            y: end.y,
            duration: 500,
          },
        ],
      },
    ],
    options
  );
  await state.enqueueAction(() => chain.dispatch(state, options));
  lazy.event.synthesizeDropAtPoint(end.x, end.y, win);
  await mouseAt(win, end.x, end.y, "mouseup");
}

function centerOf(target) {
  const rect = target.getBoundingClientRect();
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  };
}

function elementAtTargetPoint(target, x, y) {
  const root = target.getRootNode();
  return (
    root.elementFromPoint?.(x, y) ?? target.ownerDocument.elementFromPoint(x, y)
  );
}

function buttonNumber(button) {
  return { left: 0, middle: 1, right: 2 }[button] ?? 0;
}

function armDownloadClickCapture(win, browsingContextId) {
  let value = null;
  const listener = event => {
    if (value || event.defaultPrevented || event.button !== 0) {
      return;
    }
    const eventTarget = event
      .composedPath()
      .find(candidate => win.Element.isInstance(candidate));
    const link = eventTarget?.closest?.("a[href], area[href]");
    let url;
    try {
      url = new win.URL(link?.href ?? "");
    } catch {
      return;
    }
    if (!["http:", "https:"].includes(url.protocol)) {
      return;
    }
    event.preventDefault();
    value = {
      url: url.href,
      filename:
        link && win.HTMLAnchorElement.isInstance(link) ? link.download : "",
      documentUrl: win.document.URL,
      browsingContextId,
    };
  };
  win.addEventListener("click", listener);
  return {
    get value() {
      return value;
    },
    stop() {
      win.removeEventListener("click", listener);
    },
  };
}

const NAMED_KEYS = new Set([
  "Backspace",
  "Tab",
  "Enter",
  "Escape",
  "Space",
  "PageUp",
  "PageDown",
  "End",
  "Home",
  "ArrowLeft",
  "ArrowUp",
  "ArrowRight",
  "ArrowDown",
  "Insert",
  "Delete",
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "F1",
  "F2",
  "F3",
  "F4",
  "F5",
  "F6",
  "F7",
  "F8",
  "F9",
  "F10",
  "F11",
  "F12",
]);
const KEY_ALIASES = new Map([
  ["return", "Enter"],
  ["esc", "Escape"],
  ["del", "Delete"],
  ["ctrl", "Control"],
  ["cmd", "Meta"],
  ["command", "Meta"],
  ["option", "Alt"],
  ["left", "ArrowLeft"],
  ["right", "ArrowRight"],
  ["up", "ArrowUp"],
  ["down", "ArrowDown"],
]);

function normalizeKey(key) {
  return NAMED_KEYS.has(key)
    ? key
    : (KEY_ALIASES.get(key.toLowerCase()) ?? key);
}

function parseKeyCombo(input) {
  const parts = [];
  let current = "";
  for (const character of input) {
    if (character === "+" && current) {
      parts.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  if (current) {
    parts.push(current);
  }
  if (!parts.length) {
    throw new Error("Empty key input");
  }
  const key = normalizeKey(parts.pop());
  const modifiers = parts.map(normalizeKey);
  for (const value of [key, ...modifiers]) {
    if (!NAMED_KEYS.has(value) && [...value].length !== 1) {
      throw new Error(
        `Unknown key: "${value}". Valid keys: Backspace, Tab, Enter, Escape, Space, PageUp, PageDown, End, Home, ArrowLeft, ArrowUp, ArrowRight, ArrowDown, Insert, Delete, Shift, Control, Alt, Meta, F1, F2, F3, F4, F5, F6, F7, F8, F9, F10, F11, F12, single characters (a-z, A-Z, 0-9, symbols). Aliases: Return → Enter, Esc → Escape, Del → Delete, Ctrl → Control, Cmd → Meta, Command → Meta, Option → Alt, Left → ArrowLeft, Right → ArrowRight, Up → ArrowUp, Down → ArrowDown`
      );
    }
  }
  return { key, modifiers };
}

function sendKey(win, key, modifiers = 0) {
  const special = {
    ArrowDown: "\uE015",
    ArrowLeft: "\uE012",
    ArrowRight: "\uE014",
    ArrowUp: "\uE013",
    Alt: "\uE00A",
    Backspace: "\uE003",
    Control: "\uE009",
    Delete: "\uE017",
    End: "\uE010",
    Enter: "\uE006",
    Escape: "\uE00C",
    Home: "\uE011",
    Insert: "\uE016",
    PageDown: "\uE00F",
    PageUp: "\uE00E",
    Space: " ",
    Shift: "\uE008",
    Tab: "\uE004",
    F1: "\uE031",
    F2: "\uE032",
    F3: "\uE033",
    F4: "\uE034",
    F5: "\uE035",
    F6: "\uE036",
    F7: "\uE037",
    F8: "\uE038",
    F9: "\uE039",
    F10: "\uE03A",
    F11: "\uE03B",
    F12: "\uE03C",
    Meta: "\uE03D",
  };
  const sequence = [];
  const modifierKeys = [
    [Ci.nsIDOMWindowUtils.MODIFIER_CONTROL, "\uE009"],
    [Ci.nsIDOMWindowUtils.MODIFIER_ALT, "\uE00A"],
    [Ci.nsIDOMWindowUtils.MODIFIER_SHIFT, "\uE008"],
    [Ci.nsIDOMWindowUtils.MODIFIER_META, "\uE03D"],
  ];
  for (const [flag, value] of modifierKeys) {
    if (modifiers & flag) {
      sequence.push(value);
    }
  }
  sequence.push(special[key] ?? key);
  for (const [flag, value] of modifierKeys.reverse()) {
    if (modifiers & flag) {
      sequence.push(value);
    }
  }
  lazy.event.sendKeys(sequence.join(""), win);
}

function clearFocusedField(win, target) {
  try {
    lazy.interaction.clearElement(target);
  } catch {
    sendKey(win, "a", Ci.nsIDOMWindowUtils.MODIFIER_CONTROL);
    sendKey(win, "Backspace");
  }
}

function textFrom(root) {
  return root?.innerText ?? "";
}

function readElementHidden(element) {
  if (element.hidden || element.getAttribute("aria-hidden") === "true") {
    return true;
  }
  const style = element.documentGlobal.getComputedStyle(element);
  return style.display === "none" || style.visibility === "hidden";
}

function readElementOutsideViewport(element, options) {
  if (!options.viewportOnly) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  const window = element.documentGlobal;
  return (
    rect.bottom <= 0 ||
    rect.top >= window.innerHeight ||
    rect.right <= 0 ||
    rect.left >= window.innerWidth
  );
}

function markdownChildren(element, options, context) {
  let text = "";
  for (const child of element.childNodes) {
    text += markdownNode(child, options, context);
  }
  return text;
}

function markdownTable(table, options, context) {
  const rows = [];
  let separatorAfter = 0;
  const cellContext = { ...context, tableDepth: context.tableDepth + 1 };
  const appendRow = (row, inHead) => {
    const cells = [];
    let header = inHead;
    for (const cell of row.children) {
      if (!["TH", "TD"].includes(cell.tagName)) {
        continue;
      }
      cells.push(
        markdownNode(cell, options, cellContext)
          .trim()
          .replace(/\n+/g, " ")
          .replace(/ {2,}/g, " ")
          .replaceAll("|", "\\|")
      );
      header ||= cell.tagName === "TH";
    }
    if (cells.length) {
      if (header) {
        separatorAfter = rows.length;
      }
      rows.push(cells);
    }
  };
  for (const section of table.children) {
    if (["THEAD", "TBODY", "TFOOT"].includes(section.tagName)) {
      for (const row of section.children) {
        if (row.tagName === "TR") {
          appendRow(row, section.tagName === "THEAD");
        }
      }
    } else if (section.tagName === "TR") {
      appendRow(section, false);
    }
  }
  if (!rows.length) {
    return "";
  }
  const columns = Math.max(...rows.map(row => row.length));
  for (const row of rows) {
    while (row.length < columns) {
      row.push("");
    }
  }
  const lines = rows
    .slice(0, separatorAfter + 1)
    .map(row => `| ${row.join(" | ")} |`);
  lines.push(`| ${Array(columns).fill("---").join(" | ")} |`);
  lines.push(
    ...rows.slice(separatorAfter + 1).map(row => `| ${row.join(" | ")} |`)
  );
  return `\n\n${lines.join("\n")}\n\n`;
}

// eslint-disable-next-line complexity
function markdownNode(node, options, context) {
  if (node.nodeType === node.TEXT_NODE) {
    return context.pre
      ? (node.textContent ?? "")
      : (node.textContent ?? "").replace(/[\t\n\r]+/g, " ");
  }
  if (node.nodeType !== node.ELEMENT_NODE) {
    return "";
  }
  const element = node;
  const tag = element.tagName;
  if (
    [
      "SCRIPT",
      "STYLE",
      "NOSCRIPT",
      "SVG",
      "TEMPLATE",
      "CANVAS",
      "VIDEO",
      "AUDIO",
      "OBJECT",
      "EMBED",
      "INPUT",
      "SELECT",
      "TEXTAREA",
      "BUTTON",
    ].includes(tag) ||
    readElementHidden(element)
  ) {
    return "";
  }
  const children = nextContext =>
    markdownChildren(element, options, nextContext ?? context);
  let text;
  if (/^H[1-6]$/.test(tag)) {
    if (readElementOutsideViewport(element, options)) {
      return "";
    }
    text = children().trim();
    return text ? `\n\n${"#".repeat(Number(tag.slice(1)))} ${text}\n\n` : "";
  }
  switch (tag) {
    case "P":
      if (readElementOutsideViewport(element, options)) {
        return "";
      }
      text = children().trim();
      return text ? `\n\n${text}\n\n` : "";
    case "A":
      text = children().trim().replace(/\n+/g, " ");
      if (!text) {
        text = element.querySelector("img")?.alt ?? "";
      }
      if (
        !text ||
        options.includeLinks === false ||
        !element.href ||
        element.href.startsWith("javascript:")
      ) {
        return text;
      }
      return `[${text}](${element.href})`;
    case "IMG":
      if (
        !options.includeImages ||
        readElementOutsideViewport(element, options)
      ) {
        return "";
      }
      return element.currentSrc || element.src
        ? `![${element.alt || ""}](${element.currentSrc || element.src})`
        : "";
    case "STRONG":
    case "B":
      text = children().trim();
      return text ? `**${text}**` : "";
    case "EM":
    case "I":
      text = children().trim();
      return text ? `*${text}*` : "";
    case "DEL":
    case "S":
      text = children().trim();
      return text ? `~~${text}~~` : "";
    case "CODE":
      if (context.pre) {
        return children();
      }
      text = (element.textContent ?? "").trim();
      return text ? `\`${text}\`` : "";
    case "PRE": {
      if (readElementOutsideViewport(element, options)) {
        return "";
      }
      const code = element.querySelector("code");
      const language =
        code?.className.match(/(?:language|lang)-(\w+)/)?.[1] ?? "";
      text = element.textContent ?? "";
      if (text.endsWith("\n")) {
        text = text.slice(0, -1);
      }
      return `\n\n\`\`\`${language}\n${text}\n\`\`\`\n\n`;
    }
    case "BLOCKQUOTE":
      if (readElementOutsideViewport(element, options)) {
        return "";
      }
      text = children().trim();
      return text
        ? `\n\n${text
            .split("\n")
            .map(line => `> ${line}`)
            .join("\n")}\n\n`
        : "";
    case "UL":
    case "OL": {
      const inner = children({
        ...context,
        listDepth: context.listDepth + 1,
        listType: tag === "OL" ? "ol" : "ul",
      }).trimEnd();
      return context.listDepth === 0 ? `\n\n${inner}\n\n` : `\n${inner}\n`;
    }
    case "LI":
      if (readElementOutsideViewport(element, options)) {
        return "";
      }
      text = children().replace(/^\s+/, "").trimEnd();
      return text
        ? `${"  ".repeat(Math.max(0, context.listDepth - 1))}${
            context.listType === "ol" ? "1. " : "- "
          }${text}\n`
        : "";
    case "DL":
      return `\n\n${children().trimEnd()}\n\n`;
    case "DT":
      text = children().trim();
      return text ? `\n**${text}**\n` : "";
    case "DD":
      text = children().trim();
      return text ? `: ${text}\n` : "";
    case "TABLE":
      if (readElementOutsideViewport(element, options)) {
        return "";
      }
      return context.tableDepth
        ? children()
        : markdownTable(element, options, context);
    case "BR":
      return "\n";
    case "HR":
      return readElementOutsideViewport(element, options) ? "" : "\n\n---\n\n";
    case "SUMMARY":
      text = children().trim();
      return text ? `\n**${text}**\n` : "";
    case "FIGCAPTION":
      text = children().trim();
      return text ? `\n*${text}*\n` : "";
    case "IFRAME":
      try {
        if (element.contentDocument?.body) {
          return markdownNode(element.contentDocument.body, options, context);
        }
      } catch {}
      return element.src || element.getAttribute("src")
        ? `\n\n[iframe: ${element.src || element.getAttribute("src")}]\n\n`
        : "";
    default:
      return children();
  }
}

function markdownFor(root, options) {
  return markdownNode(root, options, {
    pre: false,
    listDepth: 0,
    listType: "ul",
    tableDepth: 0,
  })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function consoleArgumentText(value) {
  const unwrapped = Cu.waiveXrays(value);
  if (typeof unwrapped === "string") {
    return unwrapped.slice(0, 16000);
  }
  if (unwrapped === undefined) {
    return "undefined";
  }
  if (unwrapped === null || typeof unwrapped !== "object") {
    return String(unwrapped).slice(0, 16000);
  }
  return Object.prototype.toString.call(unwrapped).slice(0, 16000);
}

function boundedConsoleMessage(message) {
  const text = String(message.text ?? "").slice(0, 16000);
  const source = message.source ?? {};
  const stack = (message.stack ?? []).slice(0, 20).map(frame => ({
    filename: String(frame.filename ?? "").slice(0, 2000),
    functionName: String(frame.functionName ?? "").slice(0, 1000),
    lineNumber: frame.lineNumber ?? null,
    columnNumber: frame.columnNumber ?? null,
  }));
  const value = {
    ...message,
    type: String(message.type ?? "console").slice(0, 64),
    level: String(message.level ?? "info").slice(0, 64),
    method: String(message.method ?? "").slice(0, 64),
    text,
    source: {
      url: String(source.url ?? "").slice(0, 4000),
      line: source.line ?? null,
      column: source.column ?? null,
      functionName: String(source.functionName ?? "").slice(0, 1000),
    },
    stack,
  };
  let bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (bytes > MAX_CONSOLE_MESSAGE_BYTES) {
    value.text = value.text.slice(0, 4000);
    value.stack = value.stack.slice(0, 5);
    bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  }
  return { value, bytes };
}

/**
 * Executes content-process portions of WildBuzzard browser tools.
 */
export class WildBuzzardBrowserControlChild extends JSWindowActorChild {
  #consoleAPIListener;
  #consoleListener;
  #consoleMessages = [];
  #consoleMessageBytes = [];
  #consoleTotalBytes = 0;
  #debugger;
  #debuggerLogpoints = new Map();
  #overlay;
  #rawObjectGroupById = new Map();
  #rawObjectGroups = new Map();
  #rawObjects = new Map();

  actorCreated() {
    this.#consoleAPIListener = new lazy.ConsoleAPIListener(
      this.manager.innerWindowId
    );
    this.#consoleAPIListener.on("message", this.#onConsoleAPIMessage);
    this.#consoleAPIListener.startListening();

    this.#consoleListener = new lazy.ConsoleListener(
      this.manager.innerWindowId
    );
    for (const level of ["error", "warn", "info"]) {
      this.#consoleListener.on(level, this.#onJavaScriptMessage);
    }
    this.#consoleListener.startListening();
  }

  didDestroy() {
    if (this.#consoleAPIListener) {
      this.#consoleAPIListener.off("message", this.#onConsoleAPIMessage);
      this.#consoleAPIListener.destroy();
      this.#consoleAPIListener = null;
    }
    if (this.#consoleListener) {
      for (const level of ["error", "warn", "info"]) {
        this.#consoleListener.off(level, this.#onJavaScriptMessage);
      }
      this.#consoleListener.destroy();
      this.#consoleListener = null;
    }
    this.#consoleMessages = [];
    this.#consoleMessageBytes = [];
    this.#consoleTotalBytes = 0;
    this.#rawObjectGroupById.clear();
    this.#rawObjectGroups.clear();
    this.#rawObjects.clear();
    this.#destroyDebugger();
    this.#clearOverlay();
  }

  #appendConsoleMessage(message) {
    const bounded = boundedConsoleMessage(message);
    this.#consoleMessages.push(bounded.value);
    this.#consoleMessageBytes.push(bounded.bytes);
    this.#consoleTotalBytes += bounded.bytes;
    while (
      this.#consoleMessages.length > MAX_CONSOLE_MESSAGES ||
      this.#consoleTotalBytes > MAX_CONSOLE_TOTAL_BYTES
    ) {
      this.#consoleMessages.shift();
      this.#consoleTotalBytes -= this.#consoleMessageBytes.shift() ?? 0;
    }
  }

  #onConsoleAPIMessage = (_eventName, data = {}) => {
    const args = (data.arguments ?? []).map(consoleArgumentText);
    this.#appendConsoleMessage({
      type: "console",
      level: ["error", "warn"].includes(data.level) ? data.level : "info",
      method: data.level ?? "log",
      text: args.join(" "),
      timestamp: data.timeStamp || Date.now(),
      source: {
        url: data.filename ?? this.contentWindow.document.URL,
        line: data.lineNumber ?? null,
        column: data.columnNumber ?? null,
        functionName: data.functionName ?? null,
      },
      stack: data.stacktrace ?? [],
    });
  };

  #onJavaScriptMessage = (_eventName, data = {}) => {
    this.#appendConsoleMessage({
      type: "javascript",
      level: data.level ?? "error",
      text: data.message ?? "",
      timestamp: data.timeStamp || Date.now(),
      source: {
        url: data.stacktrace?.[0]?.filename ?? this.contentWindow.document.URL,
        line: data.stacktrace?.[0]?.lineNumber ?? null,
        column: data.stacktrace?.[0]?.columnNumber ?? null,
        functionName: data.stacktrace?.[0]?.functionName ?? null,
      },
      stack: data.stacktrace ?? [],
    });
  };

  async receiveMessage(message) {
    switch (message.name) {
      case "snapshot":
        return this.#snapshot(message.data);
      case "act":
        return this.#act(message.data);
      case "read":
        return this.#read(message.data);
      case "downloadInfo":
        return this.#downloadInfo(message.data);
      case "console":
        return this.#consoleMessages;
      case "clearConsole": {
        const count = this.#consoleMessages.length;
        this.#consoleMessages = [];
        this.#consoleMessageBytes = [];
        this.#consoleTotalBytes = 0;
        return count;
      }
      case "debuggerEnable":
        return this.#enableDebugger();
      case "debuggerListScripts":
        return this.#listScripts();
      case "debuggerGetScriptSource":
        return this.#getScriptSource(message.data);
      case "debuggerSetLogpoint":
        return this.#setLogpoint(message.data);
      case "debuggerRemoveLogpoint":
        return this.#removeLogpoint(message.data);
      case "debuggerGetLogpointResults":
        return this.#getLogpointResults(message.data);
      case "evaluate":
        return this.#evaluate(message.data);
      case "wait":
        return this.#wait(message.data);
      case "upload":
        return this.#upload(message.data);
      case "overlay":
        return this.#showOverlay(message.data);
      case "frameBounds":
        return this.#frameBounds(message.data);
      case "scrollFrameIntoView":
        return this.#scrollFrameIntoView(message.data);
      case "clearOverlay":
        return this.#clearOverlay();
      case "viewport":
        return this.#viewport();
      case "resolveRef":
        return this.#resolveRef(message.data);
      case "rawNode":
        return this.#rawNode(message.data);
      case "rawInput":
        return this.#rawInput(message.data);
      case "rawRuntime":
        return this.#rawRuntime(message.data);
      default:
        throw new Error(`Unknown WildBuzzard content command: ${message.name}`);
    }
  }

  #enableDebugger() {
    if (this.#debugger) {
      return { enabled: true };
    }
    if (!("Debugger" in globalThis)) {
      // eslint-disable-next-line mozilla/reject-globalThis-modification
      lazy.addDebuggerToGlobal(globalThis);
    }
    this.#debugger = new Debugger();
    this.#debugger.onNewScript = this.#onNewDebuggerScript;
    this.#debugger.addDebuggee(this.contentWindow);
    return { enabled: true };
  }

  #destroyDebugger() {
    if (!this.#debugger) {
      return;
    }
    for (const logpoint of this.#debuggerLogpoints.values()) {
      this.#clearLiveLogpoint(logpoint);
    }
    this.#debuggerLogpoints.clear();
    this.#debugger.onNewScript = undefined;
    this.#debugger.removeAllDebuggees();
    this.#debugger = null;
  }

  #onNewDebuggerScript = script => {
    for (const logpoint of this.#debuggerLogpoints.values()) {
      if (script.url === logpoint.url) {
        this.#installLogpointOnScript(script, logpoint);
      }
    }
  };

  #serializeDebuggerValue(value) {
    if (value?.optimizedOut) {
      return { type: "optimizedOut" };
    }
    if (value?.uninitialized) {
      return { type: "uninitialized" };
    }
    if (value?.missingArguments) {
      return { type: "missingArguments" };
    }
    if (value instanceof Debugger.Object) {
      try {
        const raw = Cu.waiveXrays(value.unsafeDereference());
        return JSON.parse(JSON.stringify(raw));
      } catch {
        return {
          type: "object",
          class: value.class,
          name: value.name ?? null,
        };
      }
    }
    if (typeof value === "bigint") {
      return { type: "bigint", value: String(value) };
    }
    if (typeof value === "symbol") {
      return { type: "symbol", value: String(value) };
    }
    return value;
  }

  #installLogpointOnScript(script, logpoint) {
    const positions = script
      .getPossibleBreakpoints()
      .filter(position => position.lineNumber === logpoint.line);
    if (!positions.length) {
      return;
    }
    for (const { offset } of positions) {
      const handler = {
        hit: frame => {
          const result = {
            timestamp: Date.now(),
          };
          try {
            const completion = frame.eval(logpoint.expression);
            if (completion?.throw !== undefined) {
              result.error = String(
                this.#serializeDebuggerValue(completion.throw)
              );
            } else {
              result.value = this.#serializeDebuggerValue(completion?.return);
            }
          } catch (error) {
            result.error = String(error);
          }
          logpoint.results.push(result);
          if (logpoint.results.length > 100) {
            logpoint.results.splice(0, logpoint.results.length - 100);
          }
          return undefined;
        },
      };
      try {
        script.setBreakpoint(offset, handler);
        logpoint.live.push({ handler, offset, script });
      } catch {
        // A script can be collected between discovery and installation.
      }
    }
  }

  #clearLiveLogpoint(logpoint) {
    for (const { handler, offset, script } of logpoint.live) {
      try {
        script.clearBreakpoint(handler, offset);
      } catch {}
    }
    logpoint.live = [];
  }

  #listScripts() {
    this.#enableDebugger();
    const scripts = new Map();
    for (const script of this.#debugger.findScripts()) {
      if (!script.url) {
        continue;
      }
      const possibleLines = [
        ...new Set(
          script.getPossibleBreakpoints().map(position => position.lineNumber)
        ),
      ].sort((left, right) => left - right);
      const existing = scripts.get(script.url);
      if (existing) {
        existing.possibleLines = [
          ...new Set([...existing.possibleLines, ...possibleLines]),
        ].sort((left, right) => left - right);
      } else {
        scripts.set(script.url, {
          url: script.url,
          startLine: script.startLine ?? possibleLines[0] ?? null,
          possibleLines,
        });
      }
    }
    return [...scripts.values()];
  }

  #getScriptSource({ scriptUrl }) {
    this.#enableDebugger();
    const scripts = this.#debugger.findScripts({ url: scriptUrl });
    if (!scripts.length) {
      throw new Error(`No script found with URL: ${scriptUrl}`);
    }
    const source = scripts.find(script => script.source?.text)?.source?.text;
    if (!source || source === "[no source]") {
      throw new Error(`Source text not available for script: ${scriptUrl}`);
    }
    const possibleLines = [
      ...new Set(
        scripts.flatMap(script =>
          script.getPossibleBreakpoints().map(position => position.lineNumber)
        )
      ),
    ].sort((left, right) => left - right);
    return {
      source: source.slice(0, MAX_CHILD_TEXT_CHARS),
      truncated: source.length > MAX_CHILD_TEXT_CHARS,
      startLine: scripts[0].startLine ?? possibleLines[0] ?? null,
      possibleLines,
    };
  }

  #setLogpoint({ url, line, expression }) {
    this.#enableDebugger();
    const id = crypto.randomUUID();
    const logpoint = {
      expression,
      id,
      line,
      live: [],
      results: [],
      url,
    };
    this.#debuggerLogpoints.set(id, logpoint);
    for (const script of this.#debugger.findScripts({ url })) {
      this.#installLogpointOnScript(script, logpoint);
    }
    return { id, installed: logpoint.live.length };
  }

  #removeLogpoint({ id }) {
    const logpoint = this.#debuggerLogpoints.get(id);
    if (!logpoint) {
      return false;
    }
    this.#clearLiveLogpoint(logpoint);
    this.#debuggerLogpoints.delete(id);
    return true;
  }

  #getLogpointResults({ id }) {
    const logpoint = this.#debuggerLogpoints.get(id);
    return logpoint ? structuredClone(logpoint.results) : null;
  }

  async #snapshot({ depth = 100 } = {}) {
    const document = this.contentWindow.document;
    let root;
    let budget = { nodes: 0, bytes: 0, truncated: false };
    const domSnapshot = () => {
      budget = { nodes: 0, bytes: 0, truncated: false };
      return snapshotDom(document.documentElement, 0, depth, budget);
    };
    try {
      const service = Cc["@mozilla.org/accessibilityService;1"].getService(
        Ci.nsIAccessibilityService
      );
      let accessible = service.getAccessibleFor(document);
      const deadline = Date.now() + 2000;
      while (isAccessibleStale(accessible) && Date.now() < deadline) {
        await new Promise(resolve =>
          this.contentWindow.setTimeout(resolve, 50)
        );
        accessible = service.getAccessibleFor(document);
      }
      root = isAccessibleStale(accessible)
        ? domSnapshot()
        : snapshotAccessible(accessible, service, 0, depth, budget);
      root ??= domSnapshot();
      if (
        countDomInteractives(document.documentElement) >
        countSnapshotInteractives(root)
      ) {
        root = domSnapshot();
      }
    } catch {
      root = domSnapshot();
    }
    return {
      url: snapshotText(document.URL, budget, 8000),
      title: snapshotText(document.title, budget, 4000),
      documentId: snapshotText(
        document.nodePrincipal.originNoSuffix + ":" + document.documentURI,
        budget,
        16000
      ),
      browsingContextId: this.browsingContext.id,
      truncated: budget.truncated,
      root,
    };
  }

  // eslint-disable-next-line complexity
  async #act(args) {
    const win = this.contentWindow;
    let selectedValues;
    let target = args.target ? resolveTarget(args.target) : null;
    if (!target && Number.isFinite(args.x) && Number.isFinite(args.y)) {
      target = win.document.elementFromPoint(args.x, args.y);
    }
    if (args.target && target) {
      target.scrollIntoView({
        block: "center",
        inline: "center",
        behavior: "instant",
      });
    }
    let point = { x: args.x, y: args.y };
    if (target && !["click_at", "type_at", "hover_at"].includes(args.kind)) {
      point = centerOf(target);
    }
    const button = buttonNumber(args.button);
    const activationLink =
      args.kind === "click" && button === 0 && (args.clickCount ?? 1) === 1
        ? target?.closest?.("a[href], area[href]")
        : null;
    const activation = activationLink
      ? {
          beforeUrl: win.document.URL,
          download: activationLink.hasAttribute("download"),
          href: activationLink.href,
          target: activationLink.getAttribute("target") ?? "",
        }
      : null;
    const downloadCapture =
      args.captureDownload &&
      ["click", "click_at"].includes(args.kind) &&
      button === 0
        ? armDownloadClickCapture(win, this.browsingContext.id)
        : null;

    try {
      switch (args.kind) {
        case "click":
        case "click_at":
          if (args.kind === "click" && !target) {
            throw new Error("click requires a target");
          }
          if (args.kind === "click") {
            const hit = elementAtTargetPoint(target, point.x, point.y);
            if (hit && hit !== target && !target.contains(hit)) {
              throw new Error(
                `Target is covered by ${hit.tagName.toLowerCase()}${hit.id ? `#${hit.id}` : ""}`
              );
            }
          }
          if (
            args.kind === "click" &&
            button === 0 &&
            (args.clickCount ?? 1) === 1
          ) {
            await lazy.interaction.clickElement(target, false, true);
          } else {
            await mouseAt(
              win,
              point.x,
              point.y,
              "mousedown",
              button,
              args.clickCount ?? 1
            );
            await mouseAt(
              win,
              point.x,
              point.y,
              "mouseup",
              button,
              args.clickCount ?? 1
            );
          }
          break;
        case "hover":
        case "hover_at":
          await mouseAt(win, point.x, point.y, "mousemove");
          break;
        case "focus":
          target.focus();
          break;
        case "fill":
          for (const field of args.fields ?? [
            { target: args.target, value: args.value },
          ]) {
            const fieldTarget = field.target
              ? resolveTarget(field.target)
              : target;
            fieldTarget.scrollIntoView({
              block: "center",
              inline: "center",
              behavior: "instant",
            });
            const fieldPoint = centerOf(fieldTarget);
            await mouseAt(win, fieldPoint.x, fieldPoint.y, "mousedown");
            await mouseAt(win, fieldPoint.x, fieldPoint.y, "mouseup");
            if (args.clear) {
              clearFocusedField(win, fieldTarget);
            }
            await lazy.interaction.sendKeysToElement(
              fieldTarget,
              field.value ?? "",
              { webdriverClick: true }
            );
          }
          break;
        case "type":
        case "type_at":
          if (args.kind === "type_at") {
            await mouseAt(win, point.x, point.y, "mousedown");
            await mouseAt(win, point.x, point.y, "mouseup");
          }
          {
            const active = win.document.activeElement;
            if (args.clear) {
              clearFocusedField(win, active);
            }
            await lazy.interaction.sendKeysToElement(active, args.text ?? "", {
              webdriverClick: true,
            });
          }
          break;
        case "press":
          {
            const { key, modifiers: pressedModifiers } = parseKeyCombo(
              args.key
            );
            const modifiers =
              (pressedModifiers.includes("Control")
                ? Ci.nsIDOMWindowUtils.MODIFIER_CONTROL
                : 0) |
              (pressedModifiers.includes("Alt")
                ? Ci.nsIDOMWindowUtils.MODIFIER_ALT
                : 0) |
              (pressedModifiers.includes("Shift")
                ? Ci.nsIDOMWindowUtils.MODIFIER_SHIFT
                : 0) |
              (pressedModifiers.includes("Meta")
                ? Ci.nsIDOMWindowUtils.MODIFIER_META
                : 0);
            sendKey(win, key, modifiers);
          }
          break;
        case "check":
        case "uncheck":
          {
            const desired = args.kind === "check";
            const checked =
              "checked" in target
                ? Boolean(target.checked)
                : target.getAttribute("aria-checked") === "true";
            if (checked !== desired) {
              await lazy.interaction.clickElement(target, false, true);
            }
            const updated =
              "checked" in target
                ? Boolean(target.checked)
                : target.getAttribute("aria-checked") === "true";
            if (updated !== desired) {
              throw new Error(
                `${args.kind} did not change the target's checked state`
              );
            }
          }
          break;
        case "select":
          {
            let select = null;
            if (target.localName === "select") {
              select = target;
            } else if (target.localName === "option") {
              select = target.parentElement;
            }
            if (!select || select.localName !== "select") {
              throw new Error("select requires a <select> or <option> target");
            }
            const option =
              target.localName === "option"
                ? target
                : [...select.options].find(
                    item =>
                      item.value === args.value ||
                      item.textContent.trim() === args.value
                  );
            if (!option) {
              throw new Error(`select option not found: ${args.value}`);
            }
            if (!option.selected || select.multiple) {
              lazy.interaction.selectOption(option);
            }
            selectedValues = [...select.selectedOptions].map(
              item => item.value
            );
            if (!selectedValues.includes(option.value)) {
              throw new Error(`select option was not selected: ${args.value}`);
            }
          }
          break;
        case "scroll":
          {
            const amount = Math.round(args.amount ?? 3) * 120;
            let x = 0;
            let y = 0;
            const direction = args.direction ?? "down";
            if (direction === "left") {
              x = -amount;
            } else if (direction === "right") {
              x = amount;
            } else if (direction === "up") {
              y = -amount;
            } else if (direction === "down") {
              y = amount;
            }
            if (target) {
              const origin = centerOf(target);
              await lazy.event.synthesizeWheelAtPoint(
                origin.x,
                origin.y,
                {
                  deltaX: x,
                  deltaY: y,
                  deltaZ: 0,
                  deltaMode: win.WheelEvent.DOM_DELTA_PIXEL,
                },
                win
              );
            } else {
              win.scrollBy(x, y);
            }
          }
          break;
        case "drag":
        case "drag_at":
          {
            const start = target
              ? centerOf(target)
              : { x: args.startX, y: args.startY };
            const endTarget = args.targetTarget
              ? resolveTarget(args.targetTarget)
              : null;
            const end = endTarget
              ? centerOf(endTarget)
              : { x: args.endX, y: args.endY };
            await performPointerDrag(win, start, end);
          }
          break;
        default:
          throw new Error(`Unsupported content action: ${args.kind}`);
      }
    } catch (error) {
      downloadCapture?.stop();
      throw error;
    }
    downloadCapture?.stop();
    return {
      ok: true,
      url: win.document.URL,
      ...(activation ? { activation } : {}),
      ...(selectedValues ? { selectedValues } : {}),
      ...(downloadCapture?.value
        ? { downloadInfo: downloadCapture.value }
        : {}),
    };
  }

  #read(options) {
    const document = this.contentWindow.document;
    const root = options.selector
      ? document.querySelector(options.selector)
      : (document.body ?? document.documentElement);
    if (!root) {
      throw new Error(`Selector did not match: ${options.selector}`);
    }
    if (options.format === "links") {
      return [...root.querySelectorAll("a[href]")].slice(0, 5000).map(link => ({
        text: link.innerText.trim().slice(0, 4000),
        href: link.href.slice(0, 8000),
      }));
    }
    if (options.format === "text") {
      return textFrom(root).slice(0, MAX_CHILD_TEXT_CHARS);
    }
    return markdownFor(root, options).slice(0, MAX_CHILD_TEXT_CHARS);
  }

  #downloadInfo({ target }) {
    const node = resolveTarget(target);
    const link = node.closest?.("a[href], area[href]") ?? null;
    return {
      url: typeof link?.href === "string" ? link.href : null,
      filename:
        link && this.contentWindow.HTMLAnchorElement.isInstance(link)
          ? link.download
          : "",
      documentUrl: this.contentWindow.document.URL,
      browsingContextId: this.browsingContext.id,
    };
  }

  async #evaluate({ code, timeout = 30000 }) {
    const sandbox = lazy.sandbox.createMutable(this.contentWindow);
    const requestedTimeout = Number(timeout);
    const timeoutMs =
      Number.isFinite(requestedTimeout) && requestedTimeout > 0
        ? Math.min(Math.round(requestedTimeout), 30000)
        : 30000;
    const value = await withUserInput(this.contentWindow, () =>
      lazy.evaluate.sandbox(
        sandbox,
        `return (async () => {\n${code}\n})();`,
        [],
        { timeout: timeoutMs }
      )
    );
    if (value === undefined) {
      return { hasValue: false, description: "undefined" };
    }
    if (
      typeof value === "symbol" ||
      typeof value === "function" ||
      (typeof value === "number" && !Number.isFinite(value))
    ) {
      return { hasValue: false, description: String(value) };
    }
    if (typeof value === "bigint") {
      return { hasValue: false, description: `${value}n` };
    }
    try {
      const serialized = JSON.stringify(value);
      if (serialized.length > MAX_CHILD_TEXT_CHARS) {
        return {
          hasValue: false,
          description: `Evaluation result exceeded ${MAX_CHILD_TEXT_CHARS} characters`,
        };
      }
      return { hasValue: true, value: JSON.parse(serialized) };
    } catch {
      const description =
        typeof value === "object" && value !== null
          ? Object.prototype.toString.call(value).slice(8, -1)
          : String(value);
      return { hasValue: false, description };
    }
  }

  async #wait({ for: waitFor = "time", value, timeout = 2000 }) {
    if (waitFor === "time") {
      await new Promise(resolve =>
        this.contentWindow.setTimeout(resolve, Number(value ?? 2000))
      );
      return { matched: true };
    }
    const deadline = Date.now() + Math.min(Number(timeout), 30000);
    while (Date.now() < deadline) {
      const matched =
        waitFor === "selector"
          ? Boolean(this.contentWindow.document.querySelector(String(value)))
          : textFrom(this.contentWindow.document.body).includes(String(value));
      if (matched) {
        return { matched: true };
      }
      await new Promise(resolve => this.contentWindow.setTimeout(resolve, 200));
    }
    return { matched: false };
  }

  async #upload({ target, fileObjects }) {
    const input = resolveTarget(target);
    if (
      input.localName !== "input" ||
      input.type !== "file" ||
      input.disabled
    ) {
      throw new Error(
        "upload requires an enabled <input type=file> element; take a fresh snapshot"
      );
    }
    if (fileObjects.length > 1 && !input.multiple) {
      throw new Error("upload input does not accept multiple files");
    }
    try {
      input.mozSetFileArray(fileObjects);
    } catch (error) {
      throw new Error(`upload could not set the file input: ${error}`);
    }
    lazy.event.input(input);
    lazy.event.change(input);
    return { count: fileObjects.length };
  }

  #showOverlay({ items, fullPage = false }) {
    this.#clearOverlay();
    const document = this.contentWindow.document;
    const root = document.createElement("div");
    root.style.cssText = fullPage
      ? "position:absolute;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;font:11px sans-serif"
      : "position:fixed;inset:0;z-index:2147483647;pointer-events:none;font:11px sans-serif";
    for (const item of items) {
      const target = resolveTarget(item.target);
      const rect = target.getBoundingClientRect();
      if (
        rect.width <= 0 ||
        rect.height <= 0 ||
        (!fullPage &&
          (rect.bottom < 0 ||
            rect.right < 0 ||
            rect.top > this.contentWindow.innerHeight ||
            rect.left > this.contentWindow.innerWidth))
      ) {
        continue;
      }
      const box = document.createElement("div");
      const color = "#ff3b30";
      const background = item.active ? "rgba(255,59,48,.10)" : "transparent";
      const left = rect.left + (fullPage ? this.contentWindow.scrollX : 0);
      const top = rect.top + (fullPage ? this.contentWindow.scrollY : 0);
      box.style.cssText = `position:absolute;left:${left}px;top:${top}px;width:${rect.width}px;height:${rect.height}px;border:2px solid ${color};background:${background};box-sizing:border-box;pointer-events:none`;
      const label = document.createElement("span");
      label.textContent = item.ref.replace(/^e/, "");
      const labelTop = top < 16 ? "0" : "-16px";
      label.style.cssText = `position:absolute;left:-2px;top:${labelTop};padding:1px 4px;background:${color};color:white;border-radius:2px;font:bold 11px/14px monospace;white-space:nowrap`;
      box.append(label);
      root.append(box);
    }
    this.#overlay = document.insertAnonymousContent();
    this.#overlay.root.appendChild(root);
    return { count: items.length };
  }

  #frameBounds({ childBrowsingContextId }) {
    for (const frame of this.contentWindow.document.querySelectorAll(
      "iframe, frame"
    )) {
      if (frame.browsingContext?.id !== childBrowsingContextId) {
        continue;
      }
      const rect = frame.getBoundingClientRect();
      return {
        x: rect.x + (frame.clientLeft || 0),
        y: rect.y + (frame.clientTop || 0),
        width: frame.clientWidth,
        height: frame.clientHeight,
      };
    }
    throw new Error(
      `Could not resolve the embedder for browsing context ${childBrowsingContextId}`
    );
  }

  #scrollFrameIntoView({ childBrowsingContextId }) {
    const frame = [
      ...this.contentWindow.document.querySelectorAll("iframe,frame"),
    ].find(element => element.browsingContext?.id === childBrowsingContextId);
    if (!frame) {
      throw new Error(
        `No frame element owns browsing context ${childBrowsingContextId}`
      );
    }
    frame.scrollIntoView({
      block: "center",
      inline: "center",
      behavior: "instant",
    });
    return boundsFor(frame);
  }

  #clearOverlay() {
    if (this.#overlay) {
      this.contentWindow.document.removeAnonymousContent(this.#overlay);
      this.#overlay = null;
    }
    return { cleared: true };
  }

  #viewport() {
    const win = this.contentWindow;
    const document = win.document.documentElement;
    return {
      width: win.innerWidth,
      height: win.innerHeight,
      scrollX: win.scrollX,
      scrollY: win.scrollY,
      fullWidth: Math.max(document.scrollWidth, document.clientWidth),
      fullHeight: Math.max(document.scrollHeight, document.clientHeight),
      devicePixelRatio: win.devicePixelRatio,
    };
  }

  #resolveRef({ target }) {
    const node = resolveTarget(target);
    return {
      reference: target,
      tag: node.tagName?.toLowerCase() ?? null,
      bounds: boundsFor(node),
    };
  }

  #storeRawObject(value, objectGroup) {
    const objectId = `gecko-object-${this.browsingContext.id}-${crypto.randomUUID()}`;
    this.#rawObjects.set(objectId, value);
    if (objectGroup) {
      const ids = this.#rawObjectGroups.get(objectGroup) ?? new Set();
      ids.add(objectId);
      this.#rawObjectGroups.set(objectGroup, ids);
      this.#rawObjectGroupById.set(objectId, objectGroup);
    }
    return objectId;
  }

  #rawRemoteObject(value, { returnByValue = false, objectGroup } = {}) {
    if (value === undefined) {
      return { type: "undefined" };
    }
    if (value === null) {
      return { type: "object", subtype: "null", value: null };
    }
    const type = typeof value;
    if (type === "number" && !Number.isFinite(value)) {
      return {
        type,
        unserializableValue: String(value),
        description: String(value),
      };
    }
    if (type === "bigint") {
      return {
        type,
        unserializableValue: `${value}n`,
        description: `${value}n`,
      };
    }
    if (!["object", "function", "symbol"].includes(type)) {
      return { type, value, description: String(value) };
    }
    const unwrapped = Cu.waiveXrays(value);
    const className =
      unwrapped?.constructor?.name ??
      Object.prototype.toString.call(unwrapped).slice(8, -1);
    let subtype;
    if (unwrapped?.nodeType) {
      subtype = "node";
    } else if (Array.isArray(unwrapped)) {
      subtype = "array";
    }
    if (returnByValue) {
      try {
        const cloned = JSON.parse(JSON.stringify(unwrapped));
        return {
          type: type === "function" ? "function" : "object",
          ...(subtype ? { subtype } : {}),
          value: cloned,
          description: className,
        };
      } catch {}
    }
    return {
      type: type === "function" ? "function" : "object",
      ...(subtype ? { subtype } : {}),
      className,
      description: className,
      objectId: this.#storeRawObject(value, objectGroup),
    };
  }

  #rawCallArgument(argument) {
    if (argument?.objectId) {
      if (!this.#rawObjects.has(argument.objectId)) {
        throw new Error(`Unknown Gecko runtime object ${argument.objectId}`);
      }
      return this.#rawObjects.get(argument.objectId);
    }
    if (argument?.unserializableValue === "NaN") {
      return Number.NaN;
    }
    if (argument?.unserializableValue === "Infinity") {
      return Number.POSITIVE_INFINITY;
    }
    if (argument?.unserializableValue === "-Infinity") {
      return Number.NEGATIVE_INFINITY;
    }
    if (String(argument?.unserializableValue ?? "").endsWith("n")) {
      return BigInt(String(argument.unserializableValue).slice(0, -1));
    }
    return argument?.value;
  }

  async #rawRuntime({
    operation,
    expression,
    functionDeclaration,
    objectId,
    objectGroup,
    arguments: callArguments = [],
    returnByValue = false,
    userGesture = false,
    timeout = 30000,
  }) {
    if (operation === "releaseObject") {
      this.#rawObjects.delete(objectId);
      this.#rawObjectGroupById.delete(objectId);
      for (const ids of this.#rawObjectGroups.values()) {
        ids.delete(objectId);
      }
      return {};
    }
    if (operation === "releaseObjectGroup") {
      for (const id of this.#rawObjectGroups.get(objectGroup) ?? []) {
        this.#rawObjects.delete(id);
        this.#rawObjectGroupById.delete(id);
      }
      this.#rawObjectGroups.delete(objectGroup);
      return {};
    }
    if (operation === "getProperties") {
      if (!this.#rawObjects.has(objectId)) {
        throw new Error(`Unknown Gecko runtime object ${objectId}`);
      }
      const value = Cu.waiveXrays(this.#rawObjects.get(objectId));
      const propertyObjectGroup =
        objectGroup ?? this.#rawObjectGroupById.get(objectId);
      const result = Object.getOwnPropertyNames(value).map(name => {
        let propertyValue;
        try {
          propertyValue = value[name];
        } catch (error) {
          propertyValue = String(error);
        }
        return {
          name,
          value: this.#rawRemoteObject(propertyValue, {
            objectGroup: propertyObjectGroup,
          }),
          writable: true,
          configurable: true,
          enumerable: Object.prototype.propertyIsEnumerable.call(value, name),
          isOwn: true,
        };
      });
      return { result, internalProperties: [] };
    }
    const sandbox = lazy.sandbox.createMutable(this.contentWindow);
    let value;
    const run = callback =>
      userGesture ? withUserInput(this.contentWindow, callback) : callback();
    if (operation === "evaluate") {
      value = await run(() =>
        lazy.evaluate.sandbox(sandbox, `return (${expression});`, [], {
          timeout,
        })
      );
    } else if (operation === "callFunctionOn") {
      if (!this.#rawObjects.has(objectId)) {
        throw new Error(`Unknown Gecko runtime object ${objectId}`);
      }
      const thisValue = this.#rawObjects.get(objectId);
      const values = callArguments.map(argument =>
        this.#rawCallArgument(argument)
      );
      value = await run(() =>
        lazy.evaluate.sandbox(
          sandbox,
          `const callable = (${functionDeclaration});
         return callable.apply(arguments[0], Array.prototype.slice.call(arguments, 1));`,
          [thisValue, ...values],
          { timeout }
        )
      );
    } else {
      throw new Error(`Unsupported raw runtime operation: ${operation}`);
    }
    return {
      result: this.#rawRemoteObject(value, {
        returnByValue,
        objectGroup,
      }),
    };
  }

  async #rawNode({
    operation,
    target,
    selector,
    name,
    value,
    fileObjects,
    frameId,
  }) {
    const document = this.contentWindow.document;
    const node = target ? resolveTarget(target) : document;
    const attributes = element => {
      if (!element?.attributes) {
        return [];
      }
      return [...element.attributes].flatMap(attribute => [
        attribute.name,
        attribute.value,
      ]);
    };
    const describe = item => ({
      nodeId: 0,
      backendNodeId: 0,
      nodeType: item.nodeType,
      nodeName: item.nodeName,
      localName: item.localName ?? "",
      nodeValue: item.nodeValue ?? "",
      childNodeCount: item.childNodes?.length ?? 0,
      attributes: attributes(item),
      documentURL: item.ownerDocument?.URL ?? document.URL,
      baseURL: item.ownerDocument?.baseURI ?? document.baseURI,
      reference:
        item.nodeType === item.ELEMENT_NODE
          ? ContentDOMReference.get(item)
          : null,
    });
    if (operation === "getDocument") {
      return describe(document.documentElement);
    }
    if (operation === "querySelector") {
      const match = node.querySelector(String(selector));
      return match ? describe(match) : null;
    }
    if (operation === "querySelectorAll") {
      return [...node.querySelectorAll(String(selector))].map(describe);
    }
    if (operation === "describe") {
      return describe(node);
    }
    if (operation === "resolveObject") {
      return this.#rawRemoteObject(node, {
        objectGroup: value,
      });
    }
    if (operation === "getContentQuads") {
      return [...node.getClientRects()].map(rect => [
        rect.left,
        rect.top,
        rect.right,
        rect.top,
        rect.right,
        rect.bottom,
        rect.left,
        rect.bottom,
      ]);
    }
    if (operation === "getFrameOwner") {
      const owner = [...document.querySelectorAll("iframe,frame")].find(
        frame =>
          frame.browsingContext?.id === frameId ||
          frame.contentWindow?.browsingContext?.id === frameId
      );
      return owner ? describe(owner) : null;
    }
    if (operation === "getAttributes") {
      return attributes(node);
    }
    if (operation === "getOuterHTML") {
      return node.outerHTML ?? "";
    }
    if (operation === "setAttribute") {
      node.setAttribute(String(name), String(value));
      return {};
    }
    if (operation === "removeAttribute") {
      node.removeAttribute(String(name));
      return {};
    }
    if (operation === "removeNode") {
      node.remove();
      return {};
    }
    if (operation === "focus") {
      node.focus();
      return {};
    }
    if (operation === "scrollIntoView") {
      node.scrollIntoView({ block: "center", inline: "center" });
      return {};
    }
    if (operation === "setFileInputFiles") {
      return this.#upload({ target, fileObjects });
    }
    throw new Error(`Unsupported raw DOM operation: ${operation}`);
  }

  async #rawInput({ source, params }) {
    const win = this.contentWindow;
    if (source === "mouse") {
      const x = Number(params.x ?? 0);
      const y = Number(params.y ?? 0);
      if (params.type === "mouseWheel") {
        await lazy.event.synthesizeWheelAtPoint(
          x,
          y,
          {
            deltaX: Number(params.deltaX ?? 0),
            deltaY: Number(params.deltaY ?? 0),
            deltaZ: 0,
            deltaMode: win.WheelEvent.DOM_DELTA_PIXEL,
          },
          win
        );
        return {};
      }
      const type = {
        mouseMoved: "mousemove",
        mousePressed: "mousedown",
        mouseReleased: "mouseup",
      }[params.type];
      if (!type) {
        throw new Error(`Unsupported raw mouse event: ${params.type}`);
      }
      await mouseAt(
        win,
        x,
        y,
        type,
        buttonNumber(params.button),
        Number(params.clickCount ?? 1)
      );
      return {};
    }
    if (source === "text") {
      lazy.event.sendKeys(String(params.text ?? ""), win);
      return {};
    }
    if (source === "key") {
      const key = params.key ?? params.code ?? params.text;
      if (!key) {
        throw new Error("Raw key event requires key, code, or text");
      }
      const cdpModifiers = Number(params.modifiers ?? 0);
      const keyValues = {
        Alt: "\uE00A",
        ArrowDown: "\uE015",
        ArrowLeft: "\uE012",
        ArrowRight: "\uE014",
        ArrowUp: "\uE013",
        Backspace: "\uE003",
        Control: "\uE009",
        Delete: "\uE017",
        End: "\uE010",
        Enter: "\uE006",
        Escape: "\uE00C",
        Home: "\uE011",
        Insert: "\uE016",
        Meta: "\uE03D",
        PageDown: "\uE00F",
        PageUp: "\uE00E",
        Shift: "\uE008",
        Tab: "\uE004",
      };
      const value = keyValues[key] ?? String(params.text ?? key);
      const data = {
        ...lazy.keyData.getData(value),
        ...(params.code ? { code: params.code } : {}),
        altKey: Boolean(cdpModifiers & 1) || key === "Alt",
        ctrlKey: Boolean(cdpModifiers & 2) || key === "Control",
        metaKey: Boolean(cdpModifiers & 4) || key === "Meta",
        shiftKey: Boolean(cdpModifiers & 8) || key === "Shift",
      };
      const type = {
        char: "keypress",
        keyDown: "keydown",
        rawKeyDown: "keydown",
        keyUp: "keyup",
      }[params.type];
      if (!type) {
        throw new Error(`Unsupported raw key event: ${params.type}`);
      }
      lazy.event.sendSingleKey(data, win, type);
      return {};
    }
    throw new Error(`Unsupported raw input source: ${source}`);
  }
}
