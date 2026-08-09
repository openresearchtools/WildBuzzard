/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { Subprocess } from "resource://gre/modules/Subprocess.sys.mjs";
import { setTimeout } from "resource://gre/modules/Timer.sys.mjs";
import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  ContextualIdentityService:
    "resource://gre/modules/ContextualIdentityService.sys.mjs",
  PrivateTab: "resource:///modules/PrivateTab.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
});

XPCOMUtils.defineLazyServiceGetter(
  lazy,
  "ProxyService",
  "@mozilla.org/network/protocol-proxy-service;1",
  Ci.nsIProtocolProxyService
);

const CONTAINER_NAME = "Tor";
const CONTAINER_ID_PREF = "wildbuzzard.tor.containerId";
const STATE_EVENT = "WildBuzzardTorStateChange";
const BINARY_PREF = "wildbuzzard.tor.arti.path";
const TEST_PORT_PREF = "wildbuzzard.tor.test.socksPort";
const DEAD_PROXY_PORT = 9;
const PROXY_TIMEOUT_SECONDS = 10;
const START_ATTEMPTS = 120;
const START_INTERVAL_MS = 250;

async function readAll(pipe) {
  const chunks = [];
  for (let chunk; (chunk = await pipe.readString()); ) {
    chunks.push(chunk);
  }
  return chunks.join("");
}

function quoteToml(value) {
  return JSON.stringify(value);
}

export const TorRouting = {
  _initialized: false,
  _windows: new WeakSet(),
  _isolationKeys: new WeakMap(),
  _startTask: null,
  _process: null,
  _port: 0,
  _busy: false,
  _lastError: "",
  container: null,

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;
    this.container = this._ensureContainer();
    if (!this.container) {
      this._lastError = "Could not create the Tor container";
      return;
    }
    lazy.PrivateTab.registerPrivateContainer(this.container);
    this.clearData();
    lazy.ProxyService.registerChannelFilter(this, 0);
    Services.obs.addObserver(this, "quit-application-granted");
  },

  _ensureContainer() {
    const identities = lazy.ContextualIdentityService.getPublicIdentities();
    const savedId = Services.prefs.getIntPref(CONTAINER_ID_PREF, 0);
    let identity = identities.find(item => item.userContextId == savedId);
    if (!identity) {
      identity = lazy.ContextualIdentityService.create(
        CONTAINER_NAME,
        "fingerprint",
        "purple"
      );
      Services.prefs.setIntPref(CONTAINER_ID_PREF, identity.userContextId);
    }
    return identity ?? null;
  },

  get userContextId() {
    return this.container?.userContextId;
  },

  get stateEvent() {
    return STATE_EVENT;
  },

  get busy() {
    return this._busy;
  },

  get lastError() {
    return this._lastError;
  },

  isTorTab(tab) {
    return !!this.container && tab?.userContextId == this.userContextId;
  },

  statusForTab(tab) {
    return {
      active: this.isTorTab(tab),
      busy: this._busy,
      error: this._lastError,
      running: this._port > 0,
    };
  },

  onWindowOpened(win) {
    if (
      !this.container ||
      this._windows.has(win) ||
      lazy.PrivateBrowsingUtils.isWindowPrivate(win)
    ) {
      return;
    }
    this._windows.add(win);
    for (const tab of win.gBrowser.tabs) {
      this._markTorTab(tab);
    }
    win.gBrowser.tabContainer.addEventListener("TabOpen", event => {
      this._markTorTab(event.target);
    });
    win.gBrowser.tabContainer.addEventListener("TabClose", event => {
      if (!this.isTorTab(event.target)) {
        return;
      }
      Services.tm.dispatchToMainThread(() => {
        if (!this._anyTorTabs()) {
          this.clearData();
        }
        this._notifyState();
      });
    });
    win.addEventListener("TabSelect", () => this._notifyState(win));
  },

  _markTorTab(tab) {
    if (!this.isTorTab(tab)) {
      return;
    }
    tab.toggleAttribute("wildbuzzard-tor", true);
    lazy.PrivateTab.markPrivateTab(tab);
  },

  _anyTorTabs() {
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      if (
        !win.closed &&
        win.gBrowser?.tabs.some(tab => !tab.closing && this.isTorTab(tab))
      ) {
        return true;
      }
    }
    return false;
  },

  clearData() {
    if (!this.container) {
      return;
    }
    try {
      Services.clearData.deleteDataFromOriginAttributesPattern({
        userContextId: this.userContextId,
      });
    } catch (error) {
      console.error("TorRouting failed to clear container data:", error);
    }
  },

  async toggle(win, tab = win.gBrowser.selectedTab) {
    if (
      !this.container ||
      !tab ||
      this._busy ||
      lazy.PrivateBrowsingUtils.isWindowPrivate(win)
    ) {
      return null;
    }
    this._busy = true;
    this._lastError = "";
    this._notifyState();
    try {
      if (this.isTorTab(tab)) {
        return await this._reopenInContext(
          win,
          tab,
          lazy.PrivateTab.userContextId
        );
      }
      await this.ensureProxy();
      return await this._reopenInContext(win, tab, this.userContextId);
    } catch (error) {
      this._lastError = error.message;
      console.error("TorRouting toggle failed:", error);
      return null;
    } finally {
      this._busy = false;
      this._notifyState();
    }
  },

  async _reopenInContext(win, tab, userContextId) {
    const { gBrowser, gURLBar } = win;
    const selected = tab == gBrowser.selectedTab;
    const focusUrlbar = selected && gURLBar.focused;
    const pinned = tab.pinned;
    const url = this._reloadURL(tab.linkedBrowser.currentURI);
    const newTab = gBrowser.addTrustedTab(null, {
      skipLoad: true,
      tabGroup: tab.group ?? undefined,
      tabIndex: tab._tPos + 1,
      userContextId,
    });
    lazy.PrivateTab.markPrivateTab(newTab);
    this._markTorTab(newTab);
    if (pinned) {
      gBrowser.pinTab(newTab);
    }
    if (selected) {
      gBrowser.selectedTab = newTab;
    }
    gBrowser.removeTab(tab, { skipPermitUnload: true });

    const triggeringPrincipal =
      Services.scriptSecurityManager.getSystemPrincipal();
    newTab.linkedBrowser.loadURI(Services.io.newURI(url), {
      loadFlags: Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_CACHE,
      triggeringPrincipal,
    });
    if (selected && (focusUrlbar || url == "about:blank")) {
      gURLBar.focus();
    }
    return newTab;
  },

  _reloadURL(uri) {
    if (!uri || !["http", "https"].includes(uri.scheme)) {
      return "about:blank";
    }
    const host = uri.host.toLowerCase();
    if (
      host == "localhost" ||
      host == "::1" ||
      host.startsWith("127.") ||
      host.endsWith(".localhost")
    ) {
      return "about:blank";
    }
    return uri.spec;
  },

  async ensureProxy() {
    const testPort = Services.prefs.getIntPref(TEST_PORT_PREF, 0);
    if (testPort > 0) {
      this._port = testPort;
      return testPort;
    }
    if (this._port > 0 && this._process) {
      return this._port;
    }
    if (!this._startTask) {
      this._startTask = this._startProxy().finally(() => {
        this._startTask = null;
      });
    }
    return this._startTask;
  },

  async _binaryPath(root) {
    const configured = Services.prefs.getStringPref(BINARY_PREF, "");
    if (configured) {
      return configured;
    }
    const applicationDirectory = Services.dirsvc.get("GreD", Ci.nsIFile).path;
    const binaryName = AppConstants.platform == "win" ? "arti.exe" : "arti";
    const sourcePath = PathUtils.join(
      applicationDirectory,
      "runtime",
      "tor",
      binaryName
    );
    if (!(await IOUtils.exists(sourcePath))) {
      throw new Error("The bundled Arti runtime is not installed");
    }

    const runtimeDirectory = PathUtils.join(
      root,
      "runtime",
      Services.appinfo.appBuildID
    );
    const destinationPath = PathUtils.join(runtimeDirectory, binaryName);
    await IOUtils.makeDirectory(runtimeDirectory, {
      createAncestors: true,
      ignoreExisting: true,
      permissions: 0o700,
    });
    await IOUtils.setPermissions(runtimeDirectory, 0o700);
    if (!(await IOUtils.exists(destinationPath))) {
      await IOUtils.copy(sourcePath, destinationPath);
    }
    await IOUtils.setPermissions(destinationPath, 0o700);
    return destinationPath;
  },

  async _startProxy() {
    const root = PathUtils.join(PathUtils.profileDir, "wildbuzzard-tor");
    const binaryPath = await this._binaryPath(root);
    const cacheDirectory = PathUtils.join(root, "cache");
    const stateDirectory = PathUtils.join(root, "state");
    const publicDirectory = PathUtils.join(root, "public");
    const portInfoPath = PathUtils.join(publicDirectory, "port_info.json");
    const configPath = PathUtils.join(root, "arti.toml");
    for (const path of [
      root,
      cacheDirectory,
      stateDirectory,
      publicDirectory,
    ]) {
      await IOUtils.makeDirectory(path, {
        createAncestors: true,
        ignoreExisting: true,
        permissions: 0o700,
      });
      await IOUtils.setPermissions(path, 0o700);
    }
    await IOUtils.remove(portInfoPath, { ignoreAbsent: true });
    const config = [
      "[proxy]",
      'socks_listen = "127.0.0.1:auto"',
      "",
      "[storage]",
      `cache_dir = ${quoteToml(cacheDirectory)}`,
      `state_dir = ${quoteToml(stateDirectory)}`,
      `port_info_file = ${quoteToml(portInfoPath)}`,
      "",
    ].join("\n");
    await IOUtils.writeUTF8(configPath, config, {
      tmpPath: `${configPath}.tmp`,
    });
    await IOUtils.setPermissions(configPath, 0o600);

    const process = await Subprocess.call({
      command: binaryPath,
      arguments: ["proxy", "-c", configPath, "--log-level", "warn"],
      environmentAppend: true,
      stdout: "pipe",
      stderr: "pipe",
    });
    this._process = process;
    const stdoutTask = readAll(process.stdout);
    const stderrTask = readAll(process.stderr);
    process
      .wait()
      .then(async result => {
        const [stdout, stderr] = await Promise.all([stdoutTask, stderrTask]);
        if (this._process != process) {
          return;
        }
        this._process = null;
        this._port = 0;
        if (result.exitCode !== 0) {
          this._lastError =
            stderr.trim() ||
            stdout.trim() ||
            `Arti exited with ${result.exitCode}`;
        }
        this._notifyState();
      })
      .catch(error => {
        if (this._process == process) {
          this._process = null;
          this._port = 0;
          this._lastError = error.message;
          this._notifyState();
        }
      });

    for (let attempt = 0; attempt < START_ATTEMPTS; attempt++) {
      const port = await this._readSocksPort(portInfoPath);
      if (port) {
        this._port = port;
        this._notifyState();
        return port;
      }
      if (this._process != process) {
        throw new Error(this._lastError || "Arti exited during startup");
      }
      await new Promise(resolve => setTimeout(resolve, START_INTERVAL_MS));
    }
    await process.kill();
    throw new Error("Arti did not open its SOCKS proxy in time");
  },

  async _readSocksPort(portInfoPath) {
    if (!(await IOUtils.exists(portInfoPath))) {
      return 0;
    }
    const portInfo = await IOUtils.readJSON(portInfoPath).catch(() => null);
    const entry = portInfo?.ports?.find(
      item =>
        item.protocol == "socks" && /^inet:127\.0\.0\.1:\d+$/.test(item.address)
    );
    return entry ? Number(entry.address.split(":").at(-1)) : 0;
  },

  _isolationKey(channel) {
    const browser =
      channel.loadInfo?.browsingContext?.top?.embedderElement ?? null;
    const permanentKey = browser?.permanentKey;
    if (!permanentKey) {
      return `container-${this.userContextId}`;
    }
    let key = this._isolationKeys.get(permanentKey);
    if (!key) {
      key = Services.uuid.generateUUID().toString().slice(1, -1);
      this._isolationKeys.set(permanentKey, key);
    }
    return key;
  },

  applyFilter(channel, proxyInfo, callback) {
    if (
      channel.loadInfo?.originAttributes.userContextId != this.userContextId
    ) {
      callback.onProxyFilterResult(proxyInfo);
      return;
    }
    const isolationKey = this._isolationKey(channel);
    const torProxy = lazy.ProxyService.newProxyInfoWithAuth(
      "socks",
      "127.0.0.1",
      this._port || DEAD_PROXY_PORT,
      `wildbuzzard-${isolationKey}`,
      isolationKey,
      "",
      isolationKey,
      Ci.nsIProxyInfo.TRANSPARENT_PROXY_RESOLVES_HOST,
      PROXY_TIMEOUT_SECONDS,
      null
    );
    callback.onProxyFilterResult(torProxy);
  },

  _notifyState(targetWindow = null) {
    const windows = targetWindow
      ? [targetWindow]
      : Services.wm.getEnumerator("navigator:browser");
    for (const win of windows) {
      if (!win.closed) {
        win.dispatchEvent(new win.CustomEvent(STATE_EVENT));
      }
    }
  },

  observe(_subject, topic) {
    if (topic != "quit-application-granted") {
      return;
    }
    lazy.ProxyService.unregisterChannelFilter(this);
    this.clearData();
    this._process?.kill();
    this._process = null;
  },

  QueryInterface: ChromeUtils.generateQI([
    Ci.nsIObserver,
    Ci.nsIProtocolProxyChannelFilter,
  ]),
};
