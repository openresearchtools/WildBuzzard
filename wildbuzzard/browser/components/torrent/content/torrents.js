/* SPDX-License-Identifier: AGPL-3.0-or-later */

"use strict";

const { TorrentManager } = ChromeUtils.importESModule(
  "resource:///modules/TorrentManager.sys.mjs"
);

const state = {
  status: null,
  selectedId: null,
  busy: false,
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
  elements.toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    elements.toast.hidden = true;
  }, 5000);
}

async function localized(id, args) {
  return document.l10n.formatValue(id, args);
}

async function run(task, successId) {
  if (state.busy) {
    return;
  }
  state.busy = true;
  try {
    const result = await task();
    if (successId && result !== null && result !== false) {
      showToast(await localized(successId));
    }
    await refresh();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    state.busy = false;
  }
}

function createSummary(labelId, value) {
  const item = document.createElement("div");
  item.className = "summary-item";
  const label = document.createElement("span");
  label.className = "summary-label";
  l10n(label, labelId);
  const output = document.createElement("strong");
  output.className = "summary-value";
  output.textContent = value;
  item.append(label, output);
  return item;
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
  elements.summary.replaceChildren(
    createSummary("wildbuzzard-torrents-summary-active", String(active.length)),
    createSummary(
      "wildbuzzard-torrents-summary-down",
      formatBytes(downloadSpeed, true)
    ),
    createSummary(
      "wildbuzzard-torrents-summary-up",
      formatBytes(uploadSpeed, true)
    ),
    createSummary("wildbuzzard-torrents-summary-peers", String(peers))
  );
}

function stateBadge(record) {
  const badge = document.createElement("span");
  badge.className = "state-badge";
  l10n(badge, `wildbuzzard-torrents-state-${record.state}`);
  return badge;
}

function renderList() {
  const torrents = state.status.torrents;
  elements.empty.hidden = torrents.length !== 0;
  elements.list.hidden = torrents.length === 0;
  const items = torrents.map(record => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "torrent-item";
    item.dataset.id = record.id;
    if (record.id === state.selectedId) {
      item.classList.add("selected");
    }
    const titleRow = document.createElement("div");
    titleRow.className = "torrent-title-row";
    const name = document.createElement("span");
    name.className = "torrent-name";
    name.textContent = record.name;
    titleRow.append(name, stateBadge(record));
    const progress = document.createElement("progress");
    progress.max = 1;
    progress.value = record.progress;
    const meta = document.createElement("div");
    meta.className = "torrent-meta";
    const amount = document.createElement("span");
    amount.textContent = `${formatBytes(record.downloaded)} / ${formatBytes(record.length)}`;
    const speed = document.createElement("span");
    speed.textContent =
      record.state === "seeding"
        ? `↑ ${formatBytes(record.uploadSpeed, true)}`
        : `↓ ${formatBytes(record.downloadSpeed, true)}`;
    meta.append(amount, speed);
    item.append(titleRow, progress, meta);
    return item;
  });
  elements.list.replaceChildren(...items);
}

function detailStat(labelId, value) {
  const item = document.createElement("div");
  item.className = "detail-stat";
  const label = document.createElement("span");
  l10n(label, labelId);
  const output = document.createElement("strong");
  output.textContent = value;
  item.append(label, output);
  return item;
}

function renderFiles(record) {
  const section = document.createElement("section");
  section.className = "files-section";
  const heading = document.createElement("h3");
  l10n(heading, "wildbuzzard-torrents-files-heading");
  const list = document.createElement("div");
  list.className = "file-list";
  for (const file of record.files) {
    const row = document.createElement("label");
    row.className = "file-row";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = file.selected;
    checkbox.dataset.fileIndex = file.index;
    const name = document.createElement("span");
    name.className = "file-name";
    name.textContent = file.path;
    name.title = file.path;
    const size = document.createElement("span");
    size.className = "file-size";
    size.textContent = `${formatPercent(file.progress)} · ${formatBytes(file.length)}`;
    row.append(checkbox, name, size);
    list.append(row);
  }
  section.append(heading, list);
  return section;
}

function renderDetails() {
  const record = state.status.torrents.find(
    item => item.id === state.selectedId
  );
  elements.detailsEmpty.hidden = Boolean(record);
  elements.detailsContent.hidden = !record;
  if (!record) {
    elements.detailsContent.replaceChildren();
    return;
  }
  const header = document.createElement("div");
  header.className = "detail-header";
  const heading = document.createElement("h2");
  heading.textContent = record.name;
  const status = stateBadge(record);
  const progress = document.createElement("progress");
  progress.className = "detail-progress";
  progress.max = 1;
  progress.value = record.progress;
  const stats = document.createElement("div");
  stats.className = "detail-stat-row";
  stats.append(
    detailStat(
      "wildbuzzard-torrents-detail-progress",
      formatPercent(record.progress)
    ),
    detailStat(
      "wildbuzzard-torrents-detail-eta",
      formatETA(record.timeRemaining)
    ),
    detailStat(
      "wildbuzzard-torrents-detail-down",
      formatBytes(record.downloadSpeed, true)
    ),
    detailStat(
      "wildbuzzard-torrents-detail-up",
      formatBytes(record.uploadSpeed, true)
    ),
    detailStat("wildbuzzard-torrents-detail-peers", String(record.numPeers)),
    detailStat(
      "wildbuzzard-torrents-detail-ratio",
      Number(record.ratio).toFixed(2)
    )
  );
  const actions = document.createElement("div");
  actions.className = "action-row";
  if (
    ["metadata", "checking", "downloading", "seeding"].includes(record.state)
  ) {
    actions.append(
      button("wildbuzzard-torrents-action-pause", "pause"),
      button("wildbuzzard-torrents-action-stop", "stop")
    );
  } else {
    actions.append(
      button("wildbuzzard-torrents-action-resume", "resume", "primary"),
      button("wildbuzzard-torrents-action-force", "force-start")
    );
  }
  actions.append(
    button("wildbuzzard-torrents-action-reannounce", "reannounce"),
    button("wildbuzzard-torrents-action-show", "show"),
    button("wildbuzzard-torrents-action-remove", "remove", "secondary danger"),
    button("wildbuzzard-torrents-action-delete", "delete", "secondary danger")
  );
  if (record.error) {
    const error = document.createElement("p");
    error.className = "error-message";
    error.textContent = record.error;
    header.append(heading, status, progress, error, stats, actions);
  } else {
    header.append(heading, status, progress, stats, actions);
  }
  elements.detailsContent.replaceChildren(header, renderFiles(record));
}

function renderCapabilities() {
  const labels = {
    tcp: "TCP",
    udpTrackers: "UDP trackers",
    dht: "DHT",
    utp: "µTP",
    pex: "PEX",
    lsd: "LSD",
  };
  elements.capabilities.replaceChildren(
    ...Object.entries(state.status.capabilities)
      .filter(([, enabled]) => enabled)
      .map(([name]) => {
        const item = document.createElement("span");
        item.className = "capability";
        item.textContent = labels[name];
        return item;
      })
  );
}

function renderSettings() {
  const settings = state.status.settings;
  if (document.activeElement.closest?.("#settings-form")) {
    return;
  }
  elements.maxActive.value = settings.maxActive;
  elements.downloadLimit.value = settings.downloadLimit;
  elements.uploadLimit.value = settings.uploadLimit;
  elements.seedCompleted.checked = settings.seedCompleted;
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
  if (!file?.name.toLowerCase().endsWith(".torrent")) {
    throw new Error(await localized("wildbuzzard-torrents-invalid-file"));
  }
  await TorrentManager.addTorrentBytes(
    new Uint8Array(await file.arrayBuffer())
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
    toast: document.getElementById("toast"),
  });

  document.getElementById("add-form").addEventListener("submit", event => {
    event.preventDefault();
    run(() => addSource(elements.source.value), "wildbuzzard-torrents-added");
  });
  document.getElementById("choose-torrent").addEventListener("click", () => {
    run(() => TorrentManager.chooseTorrentFile(), "wildbuzzard-torrents-added");
  });
  document.getElementById("choose-directory").addEventListener("click", () => {
    run(() => TorrentManager.chooseDownloadDirectory());
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

addEventListener("DOMContentLoaded", initialize, { once: true });
