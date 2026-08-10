/* SPDX-License-Identifier: AGPL-3.0-or-later */

"use strict";

const { TorrentManager } = ChromeUtils.importESModule(
  "resource:///modules/TorrentManager.sys.mjs"
);

const state = {
  status: null,
  selectedId: null,
  busy: false,
  summary: null,
  listItems: new Map(),
  listOrder: "",
  details: null,
  capabilities: "",
};

const elements = {};

function formatBytes(value, rate = false) {
  const number = Math.max(0, Number(value) || 0);
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = number
    ? Math.min(Math.floor(Math.log(number) / Math.log(1024)), 4)
    : 0;
  const formatted = new Intl.NumberFormat(undefined, {
    maximumFractionDigits: index ? 1 : 0,
  }).format(number / 1024 ** index);
  return `${formatted} ${units[index]}${rate ? "/s" : ""}`;
}

function formatPercent(value) {
  return new Intl.NumberFormat(undefined, {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(Number(value) || 0);
}

function formatETA(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    return "—";
  }
  const seconds = Math.ceil(milliseconds / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function l10n(element, id, args) {
  document.l10n.setAttributes(element, id, args);
  return element;
}

function button(id, action, className = "secondary") {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.dataset.action = action;
  return l10n(element, id);
}

function showToast(message, isError = false) {
  elements.toast.textContent = message;
  elements.toast.dataset.error = String(isError);
  elements.toast.setAttribute("role", isError ? "alert" : "status");
  elements.toast.setAttribute("aria-live", isError ? "assertive" : "polite");
  elements.toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    elements.toast.hidden = true;
  }, 5000);
}

async function localized(id, args) {
  return document.l10n.formatValue(id, args);
}

async function errorMessage(error) {
  const ids = {
    invalid: "wildbuzzard-torrents-file-invalid",
    "too-large": "wildbuzzard-torrents-file-too-large",
    unreadable: "wildbuzzard-torrents-file-unreadable",
    "wrong-type": "wildbuzzard-torrents-invalid-file",
  };
  const id = ids[error.torrentFileError];
  return id ? localized(id) : error.message;
}

async function run(task, successId, focusTarget = null) {
  if (state.busy) {
    return;
  }
  state.busy = true;
  try {
    const result = await task();
    if (successId && result !== null && result !== false) {
      showToast(await localized(successId));
    }
    if (result !== null && result !== false) {
      await refresh();
    }
  } catch (error) {
    showToast(await errorMessage(error), true);
  } finally {
    state.busy = false;
    focusTarget?.focus();
  }
}

function createSummary(labelId) {
  const item = document.createElement("div");
  item.className = "summary-item";
  const label = document.createElement("span");
  label.className = "summary-label";
  l10n(label, labelId);
  const output = document.createElement("strong");
  output.className = "summary-value";
  item.append(label, output);
  return { item, output };
}

function renderSummary() {
  const torrents = state.status.torrents;
  const active = torrents.filter(item =>
    ["metadata", "checking", "downloading", "seeding"].includes(item.state)
  );
  const downloadSpeed = torrents.reduce(
    (sum, item) => sum + item.downloadSpeed,
    0
  );
  const uploadSpeed = torrents.reduce((sum, item) => sum + item.uploadSpeed, 0);
  const peers = torrents.reduce((sum, item) => sum + item.numPeers, 0);
  if (!state.summary) {
    state.summary = [
      createSummary("wildbuzzard-torrents-summary-active"),
      createSummary("wildbuzzard-torrents-summary-down"),
      createSummary("wildbuzzard-torrents-summary-up"),
      createSummary("wildbuzzard-torrents-summary-peers"),
    ];
    elements.summary.append(...state.summary.map(item => item.item));
  }
  const values = [
    String(active.length),
    formatBytes(downloadSpeed, true),
    formatBytes(uploadSpeed, true),
    String(peers),
  ];
  state.summary.forEach((item, index) => {
    item.output.textContent = values[index];
  });
}

function stateBadge(record) {
  const badge = document.createElement("span");
  badge.className = "state-badge";
  l10n(badge, `wildbuzzard-torrents-state-${record.state}`);
  return badge;
}

function createListItem(record) {
  const root = document.createElement("button");
  root.type = "button";
  root.className = "torrent-item";
  root.dataset.id = record.id;
  const titleRow = document.createElement("div");
  titleRow.className = "torrent-title-row";
  const name = document.createElement("span");
  name.className = "torrent-name";
  const badge = stateBadge(record);
  titleRow.append(name, badge);
  const progress = document.createElement("progress");
  progress.max = 1;
  const meta = document.createElement("div");
  meta.className = "torrent-meta";
  const amount = document.createElement("span");
  const speed = document.createElement("span");
  meta.append(amount, speed);
  root.append(titleRow, progress, meta);
  return { root, name, badge, progress, amount, speed };
}

function renderList() {
  const torrents = state.status.torrents;
  elements.empty.hidden = torrents.length !== 0;
  elements.list.hidden = torrents.length === 0;
  const ids = new Set(torrents.map(record => record.id));
  for (const [id, item] of state.listItems) {
    if (!ids.has(id)) {
      item.root.remove();
      state.listItems.delete(id);
    }
  }
  const ordered = torrents.map(record => {
    let item = state.listItems.get(record.id);
    if (!item) {
      item = createListItem(record);
      state.listItems.set(record.id, item);
    }
    item.root.classList.toggle("selected", record.id === state.selectedId);
    item.root.setAttribute(
      "aria-current",
      record.id === state.selectedId ? "true" : "false"
    );
    item.name.textContent = record.name;
    l10n(item.badge, `wildbuzzard-torrents-state-${record.state}`);
    item.progress.value = record.progress;
    item.amount.textContent = `${formatBytes(record.downloaded)} / ${formatBytes(record.length)}`;
    item.speed.textContent =
      record.state === "seeding"
        ? `↑ ${formatBytes(record.uploadSpeed, true)}`
        : `↓ ${formatBytes(record.downloadSpeed, true)}`;
    return item.root;
  });
  const order = torrents.map(record => record.id).join("\n");
  if (order !== state.listOrder) {
    elements.list.append(...ordered);
    state.listOrder = order;
  }
}

function detailStat(labelId) {
  const item = document.createElement("div");
  item.className = "detail-stat";
  const label = document.createElement("span");
  l10n(label, labelId);
  const output = document.createElement("strong");
  item.append(label, output);
  return { item, output };
}

function createFiles() {
  const section = document.createElement("section");
  section.className = "files-section";
  const heading = document.createElement("h3");
  l10n(heading, "wildbuzzard-torrents-files-heading");
  const list = document.createElement("div");
  list.className = "file-list";
  section.append(heading, list);
  return { section, list, rows: new Map() };
}

function renderFiles(view, record) {
  const indexes = new Set(record.files.map(file => String(file.index)));
  for (const [index, row] of view.rows) {
    if (!indexes.has(index)) {
      row.root.remove();
      view.rows.delete(index);
    }
  }
  const ordered = [];
  for (const file of record.files) {
    const index = String(file.index);
    let item = view.rows.get(index);
    if (!item) {
      const root = document.createElement("label");
      root.className = "file-row";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.dataset.fileIndex = file.index;
      const name = document.createElement("span");
      name.className = "file-name";
      const size = document.createElement("span");
      size.className = "file-size";
      root.append(checkbox, name, size);
      item = { root, checkbox, name, size };
      view.rows.set(index, item);
    }
    item.checkbox.checked = file.selected;
    item.name.textContent = file.path;
    item.name.title = file.path;
    item.size.textContent = `${formatPercent(file.progress)} · ${formatBytes(file.length)}`;
    ordered.push(item.root);
  }
  const order = record.files.map(file => file.index).join(",");
  if (order !== view.order) {
    view.list.append(...ordered);
    view.order = order;
  }
}

function createConnections() {
  const section = document.createElement("section");
  section.className = "connections-section";
  const heading = document.createElement("h3");
  l10n(heading, "wildbuzzard-torrents-connections-heading");
  const empty = document.createElement("p");
  empty.className = "connections-empty";
  l10n(empty, "wildbuzzard-torrents-connections-empty");
  const scroll = document.createElement("div");
  scroll.className = "connections-scroll";
  const table = document.createElement("table");
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const id of [
    "address",
    "client",
    "transport",
    "source",
    "route",
    "down",
    "up",
    "downloaded",
    "uploaded",
    "status",
  ]) {
    const cell = document.createElement("th");
    cell.scope = "col";
    l10n(cell, `wildbuzzard-torrents-connection-${id}`);
    headRow.append(cell);
  }
  head.append(headRow);
  const body = document.createElement("tbody");
  table.append(head, body);
  scroll.append(table);
  section.append(heading, empty, scroll);
  return { section, empty, scroll, body, rows: new Map(), order: "" };
}

function createConnectionRow() {
  const root = document.createElement("tr");
  const cells = {};
  for (const name of [
    "address",
    "client",
    "transport",
    "source",
    "route",
    "down",
    "up",
    "downloaded",
    "uploaded",
    "status",
  ]) {
    const cell = document.createElement("td");
    cell.dataset.column = name;
    root.append(cell);
    cells[name] = cell;
  }
  return { root, cells };
}

function renderConnections(view, record) {
  const connections = record.connections || [];
  view.empty.hidden = connections.length !== 0;
  view.scroll.hidden = connections.length === 0;
  const ids = new Set(connections.map(connection => connection.id));
  for (const [id, row] of view.rows) {
    if (!ids.has(id)) {
      row.root.remove();
      view.rows.delete(id);
    }
  }
  const ordered = connections.map(connection => {
    let row = view.rows.get(connection.id);
    if (!row) {
      row = createConnectionRow();
      view.rows.set(connection.id, row);
    }
    row.cells.address.textContent = connection.address;
    row.cells.client.textContent = connection.client;
    row.cells.transport.textContent = connection.transport;
    row.cells.source.textContent = connection.source;
    row.cells.route.textContent = connection.route;
    row.cells.down.textContent = formatBytes(connection.downloadSpeed, true);
    row.cells.up.textContent = formatBytes(connection.uploadSpeed, true);
    row.cells.downloaded.textContent = formatBytes(connection.downloaded);
    row.cells.uploaded.textContent = formatBytes(connection.uploaded);
    row.cells.status.textContent = connection.status;
    return row.root;
  });
  const order = connections.map(connection => connection.id).join("\n");
  if (order !== view.order) {
    view.body.append(...ordered);
    view.order = order;
  }
}

function createDetails(record) {
  const header = document.createElement("div");
  header.className = "detail-header";
  const heading = document.createElement("h2");
  const badge = stateBadge(record);
  const progress = document.createElement("progress");
  progress.className = "detail-progress";
  progress.max = 1;
  const error = document.createElement("p");
  error.className = "error-message";
  const stats = document.createElement("div");
  stats.className = "detail-stat-row";
  const statIds = ["progress", "eta", "down", "up", "peers", "ratio"];
  const statViews = statIds.map(id =>
    detailStat(`wildbuzzard-torrents-detail-${id}`)
  );
  stats.append(...statViews.map(item => item.item));
  const actions = document.createElement("div");
  actions.className = "action-row";
  header.append(heading, badge, progress, error, stats, actions);
  const files = createFiles();
  const connections = createConnections();
  elements.detailsContent.append(header, connections.section, files.section);
  return {
    id: record.id,
    heading,
    badge,
    progress,
    error,
    statViews,
    actions,
    actionMode: "",
    files,
    connections,
  };
}

function renderActions(view, record) {
  const active = ["metadata", "checking", "downloading", "seeding"].includes(
    record.state
  );
  const mode = active ? "active" : "inactive";
  if (mode === view.actionMode) {
    return;
  }
  const actions = active
    ? [
        button("wildbuzzard-torrents-action-pause", "pause"),
        button("wildbuzzard-torrents-action-stop", "stop"),
      ]
    : [
        button("wildbuzzard-torrents-action-resume", "resume", "primary"),
        button("wildbuzzard-torrents-action-force", "force-start"),
      ];
  actions.push(
    button("wildbuzzard-torrents-action-reannounce", "reannounce"),
    button("wildbuzzard-torrents-action-show", "show"),
    button("wildbuzzard-torrents-action-remove", "remove", "secondary danger"),
    button("wildbuzzard-torrents-action-delete", "delete", "secondary danger")
  );
  view.actions.replaceChildren(...actions);
  view.actionMode = mode;
}

function renderDetails() {
  const record = state.status.torrents.find(
    item => item.id === state.selectedId
  );
  elements.detailsEmpty.hidden = Boolean(record);
  elements.detailsContent.hidden = !record;
  if (!record) {
    elements.detailsContent.replaceChildren();
    state.details = null;
    return;
  }
  if (state.details?.id !== record.id) {
    elements.detailsContent.replaceChildren();
    state.details = createDetails(record);
  }
  const view = state.details;
  view.heading.textContent = record.name;
  l10n(view.badge, `wildbuzzard-torrents-state-${record.state}`);
  view.progress.value = record.progress;
  view.error.hidden = !record.error;
  view.error.textContent = record.error || "";
  const values = [
    formatPercent(record.progress),
    formatETA(record.timeRemaining),
    formatBytes(record.downloadSpeed, true),
    formatBytes(record.uploadSpeed, true),
    String(record.numPeers),
    Number(record.ratio).toFixed(2),
  ];
  view.statViews.forEach((item, index) => {
    item.output.textContent = values[index];
  });
  renderActions(view, record);
  renderFiles(view.files, record);
  renderConnections(view.connections, record);
}

function renderCapabilities() {
  const labels = {
    tcp: "wildbuzzard-torrents-capability-tcp",
    udpTrackers: "wildbuzzard-torrents-capability-udp-trackers",
    dht: "wildbuzzard-torrents-capability-dht",
    utp: "wildbuzzard-torrents-capability-utp",
    pex: "wildbuzzard-torrents-capability-pex",
    lsd: "wildbuzzard-torrents-capability-lsd",
    inbound: "wildbuzzard-torrents-capability-inbound",
    tor: "wildbuzzard-torrents-capability-tor",
  };
  const enabled = Object.entries(state.status.capabilities)
    .filter(([, value]) => value)
    .map(([name]) => name);
  const signature = enabled.join(",");
  if (signature === state.capabilities) {
    return;
  }
  elements.capabilities.replaceChildren(
    ...enabled.map(name => {
      const item = document.createElement("span");
      item.className = "capability";
      return l10n(item, labels[name]);
    })
  );
  state.capabilities = signature;
}

function renderSettings() {
  const settings = state.status.settings;
  l10n(
    elements.torNotice,
    settings.torEnabled
      ? "wildbuzzard-torrents-tor-notice-on"
      : "wildbuzzard-torrents-tor-notice"
  );
  if (document.activeElement.closest?.("#settings-form")) {
    return;
  }
  elements.maxActive.value = settings.maxActive;
  elements.downloadLimit.value = settings.downloadLimit;
  elements.uploadLimit.value = settings.uploadLimit;
  elements.seedCompleted.checked = settings.seedCompleted;
  elements.torEnabled.checked = settings.torEnabled;
  elements.directory.textContent = settings.downloadDirectory;
  elements.directory.title = settings.downloadDirectory;
}

function render() {
  if (!state.status) {
    return;
  }
  if (
    state.selectedId &&
    !state.status.torrents.some(item => item.id === state.selectedId)
  ) {
    state.selectedId = null;
  }
  state.selectedId ||= state.status.torrents[0]?.id ?? null;
  renderCapabilities();
  renderSummary();
  renderList();
  renderDetails();
  renderSettings();
}

async function refresh() {
  state.status = await TorrentManager.getStatus();
  render();
}

async function addSource(source) {
  const value = source.trim();
  if (!value) {
    return;
  }
  await TorrentManager.addFromURL(value);
  elements.source.value = "";
}

async function handleAction(action) {
  const record = state.status.torrents.find(
    item => item.id === state.selectedId
  );
  if (!record) {
    return;
  }
  if (action === "show") {
    TorrentManager.reveal(record.downloadPath);
    return;
  }
  if (action === "remove" || action === "delete") {
    const message = await localized(
      action === "delete"
        ? "wildbuzzard-torrents-confirm-delete"
        : "wildbuzzard-torrents-confirm-remove",
      { name: record.name }
    );
    if (!confirm(message)) {
      return;
    }
    await TorrentManager.remove(record.id, action === "delete");
    return;
  }
  await TorrentManager.action(record.id, action);
}

async function handleTorrentFile(file) {
  return TorrentManager.addTorrentFile(file);
}

async function chooseTorrentFile(trigger) {
  return run(
    async () =>
      TorrentManager.chooseTorrentFile(
        window.browsingContext,
        await localized("wildbuzzard-torrents-picker-title"),
        await localized("wildbuzzard-torrents-picker-filter")
      ),
    "wildbuzzard-torrents-added",
    trigger
  );
}

async function initialize() {
  Object.assign(elements, {
    capabilities: document.getElementById("engine-capabilities"),
    summary: document.getElementById("summary"),
    list: document.getElementById("torrent-list"),
    empty: document.getElementById("empty-state"),
    detailsEmpty: document.getElementById("details-empty"),
    detailsContent: document.getElementById("details-content"),
    source: document.getElementById("torrent-source"),
    directory: document.getElementById("download-directory"),
    maxActive: document.getElementById("max-active"),
    downloadLimit: document.getElementById("download-limit"),
    uploadLimit: document.getElementById("upload-limit"),
    seedCompleted: document.getElementById("seed-completed"),
    torEnabled: document.getElementById("tor-enabled"),
    torNotice: document.getElementById("tor-notice"),
    toast: document.getElementById("toast"),
  });

  document.getElementById("add-form").addEventListener("submit", event => {
    event.preventDefault();
    run(() => addSource(elements.source.value), "wildbuzzard-torrents-added");
  });
  for (const trigger of document.querySelectorAll("[data-choose-torrent]")) {
    trigger.addEventListener("click", event => {
      if (isFilePickerActivation(event)) {
        chooseTorrentFile(trigger);
      }
    });
  }
  document.getElementById("choose-directory").addEventListener("click", () => {
    run(() => TorrentManager.chooseDownloadDirectory(window.browsingContext));
  });
  elements.list.addEventListener("click", event => {
    const item = event.target.closest(".torrent-item");
    if (item) {
      state.selectedId = item.dataset.id;
      render();
    }
  });
  elements.detailsContent.addEventListener("click", event => {
    const action = event.target.closest("button")?.dataset.action;
    if (action) {
      run(() => handleAction(action));
    }
  });
  elements.detailsContent.addEventListener("change", event => {
    if (!event.target.matches("input[data-file-index]")) {
      return;
    }
    const index = Number(event.target.dataset.fileIndex);
    run(() =>
      TorrentManager.update(state.selectedId, {
        files: [{ index, selected: event.target.checked }],
      })
    );
  });
  document.getElementById("settings-form").addEventListener("submit", event => {
    event.preventDefault();
    run(
      () =>
        TorrentManager.updateSettings({
          maxActive: Number(elements.maxActive.value),
          downloadLimit: Number(elements.downloadLimit.value),
          uploadLimit: Number(elements.uploadLimit.value),
          seedCompleted: elements.seedCompleted.checked,
          torEnabled: elements.torEnabled.checked,
        }),
      "wildbuzzard-torrents-settings-saved"
    );
  });
  const dropTarget = document.getElementById("drop-target");
  for (const type of ["dragenter", "dragover"]) {
    dropTarget.addEventListener(type, event => {
      event.preventDefault();
      dropTarget.classList.add("dragging");
    });
  }
  for (const type of ["dragleave", "drop"]) {
    dropTarget.addEventListener(type, event => {
      event.preventDefault();
      dropTarget.classList.remove("dragging");
    });
  }
  dropTarget.addEventListener("drop", event => {
    run(
      () => handleTorrentFile(event.dataTransfer.files[0]),
      "wildbuzzard-torrents-added"
    );
  });

  try {
    await TorrentManager.initialize();
    const source = new URL(location.href).searchParams.get("add");
    if (source) {
      history.replaceState(null, "", "about:torrents");
      await addSource(source);
    }
    await refresh();
    setInterval(() => refresh().catch(() => {}), 1000);
  } catch (error) {
    showToast(error.message, true);
  }
}

function isFilePickerActivation(
  event,
  handlingUserInput = window.windowUtils.isHandlingUserInput
) {
  return event.isTrusted && handlingUserInput;
}

addEventListener("DOMContentLoaded", initialize, { once: true });
