/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AsyncShutdown } from "resource://gre/modules/AsyncShutdown.sys.mjs";
import { TorControl } from "resource:///modules/TorControl.sys.mjs";
import {
  OnionAuthStore,
  onionAddress,
  onionPrivateKey,
} from "resource:///modules/OnionAuthStore.sys.mjs";
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
const PERSISTENT_CONTAINER_ID_PREF = "wildbuzzard.tor.persistentContainerId";
const STATE_EVENT = "WildBuzzardTorStateChange";
const BINARY_PREF = "wildbuzzard.tor.binary.path";
const TEST_PORT_PREF = "wildbuzzard.tor.test.socksPort";
const DEAD_PROXY_PORT = 9;
const PROXY_TIMEOUT_SECONDS = 10;
const START_ATTEMPTS = 120;
const START_INTERVAL_MS = 250;

async function readAll(pipe) {
  let output = "";
  for (let chunk; (chunk = await pipe.readString()); ) {
    output = (output + chunk).slice(-65536);
  }
  return output;
}

function quoteToml(value) {
  return JSON.stringify(value);
}

export const TorRouting = {
  _initialized: false,
  _windows: new WeakSet(),
  _isolationKeys: new WeakMap(),
  _pendingOnionNavigations: new WeakMap(),
  _navigationReplacements: new WeakMap(),
  _authorizationPrompts: new WeakMap(),
  _authorizationDialogs: new WeakMap(),
  _startTask: null,
  _authorizationUpdates: Promise.resolve(),
  _process: null,
  _port: 0,
  _busy: false,
  _busyCount: 0,
  _lastError: "",
  container: null,
  persistentContainer: null,

  init() {
    if (this._initialized) {
      return;
    }
    if (Services.appinfo.processType != Ci.nsIXULRuntime.PROCESS_TYPE_DEFAULT) {
      throw new Error("Tor belongs to the main browser process");
    }
    this._initialized = true;
    AsyncShutdown.profileBeforeChange.addBlocker("WildBuzzard: stop Tor", () =>
      this.stop()
    );
    this.container = this._ensureContainer();
    if (Services.prefs.getIntPref(PERSISTENT_CONTAINER_ID_PREF, 0)) {
      this.persistentContainer = this._ensureContainer(
        PERSISTENT_CONTAINER_ID_PREF
      );
    }
    if (!this.container) {
      this._lastError = "Could not create the Tor container";
      return;
    }
    lazy.PrivateTab.registerPrivateContainer(this.container);
    this.clearData();
    lazy.ProxyService.registerChannelFilter(this, 0);
    Services.obs.addObserver(this, "http-on-modify-request");
    Services.obs.addObserver(this, "wildbuzzard-onion-authorization-needed");
    Services.obs.addObserver(this, "quit-application-granted");
  },

  _ensureContainer(pref = CONTAINER_ID_PREF) {
    const identities = lazy.ContextualIdentityService.getPublicIdentities();
    const savedId = Services.prefs.getIntPref(pref, 0);
    let identity = identities.find(item => item.userContextId == savedId);
    if (!identity) {
      identity = lazy.ContextualIdentityService.create(
        CONTAINER_NAME,
        "fingerprint",
        "purple"
      );
      Services.prefs.setIntPref(pref, identity.userContextId);
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
    return this.isTorContext(tab?.userContextId);
  },

  isTorContext(id) {
    return (
      !!id &&
      (id == this.userContextId ||
        id == this.persistentContainer?.userContextId)
    );
  },

  serviceAddress(uri) {
    if (!this.isOnionURI(uri)) {
      return null;
    }
    try {
      return onionAddress(uri.host.replace(/\.$/, "").split(".").at(-2));
    } catch {
      return null;
    }
  },

  contextIdForURI(uri) {
    const address = this.serviceAddress(uri);
    if (address && !OnionAuthStore.usesPrivateMode(address)) {
      this.persistentContainer ??= this._ensureContainer(
        PERSISTENT_CONTAINER_ID_PREF
      );
      return this.persistentContainer.userContextId;
    }
    return this.userContextId;
  },

  navigationReplacement(browser) {
    return this._navigationReplacements.get(browser);
  },

  isOnionURI(uri) {
    if (!["http", "https"].includes(uri?.scheme)) {
      return false;
    }
    try {
      return uri.host.toLowerCase().replace(/\.$/, "").endsWith(".onion");
    } catch {
      return false;
    }
  },

  onionURI(url) {
    const value = String(url).trim();
    const normalized = /^[^:/?#\s]+\.onion(?::\d+)?(?:[/?#]|$)/i.test(value)
      ? `http://${value}`
      : value;
    try {
      const uri = Services.io.newURI(normalized);
      return this.isOnionURI(uri) ? uri : null;
    } catch {
      return null;
    }
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
    const menu = win.document.getElementById("menu_ToolsPopup");
    if (menu) {
      const item = win.document.createXULElement("menuitem");
      item.id = "wildbuzzard-onion-authorizations";
      win.document.l10n.setAttributes(item, "wildbuzzard-onion-auth-menu");
      item.addEventListener("command", () =>
        this.manageOnionAuthorizations(win)
      );
      menu.append(item);
    }
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
        if (!this._anyTorTabs(true)) {
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

  manageOnionAuthorizations(win) {
    return win.gDialogBox.open("chrome://browser/content/tor/onionAuth.xhtml", {
      manage: true,
    });
  },

  async promptOnionAuthorization(browser, uri, failed) {
    if (this._authorizationPrompts.has(browser)) {
      return this._authorizationPrompts.get(browser);
    }
    const task = (async () => {
      const win = browser.documentGlobal;
      const tab = win.gBrowser.getTabForBrowser(browser);
      if (!tab || tab.closing || !this.isTorTab(tab)) {
        return;
      }
      const address = onionAddress(
        uri.host.replace(/\.$/, "").split(".").at(-2)
      );
      const entries = await OnionAuthStore.load().catch(() => new Map());
      const info = {
        address,
        failed,
        accepted: false,
        remember: entries.get(address)?.remember === true,
        privateMode: entries.get(address)?.privateMode !== false,
      };
      const { closedPromise, dialog } = win.gBrowser
        .getTabDialogBox(browser)
        .open(
          "chrome://browser/content/tor/onionAuth.xhtml",
          { keepOpenSameOriginNav: true, hideContent: true },
          info
        );
      this._authorizationDialogs.set(browser, { info, dialog, closedPromise });
      await closedPromise;
      if (
        info.accepted &&
        !tab.closing &&
        this.isTorTab(tab) &&
        browser.currentURI.spec == uri.spec
      ) {
        const contextId = this.contextIdForURI(uri);
        if (contextId != tab.userContextId) {
          await this._reopenInContext(win, tab, contextId, uri.spec);
        } else {
          browser.reload();
        }
      }
    })();
    this._authorizationPrompts.set(browser, task);
    try {
      return await task;
    } finally {
      this._authorizationPrompts.delete(browser);
      this._authorizationDialogs.delete(browser);
    }
  },

  async completeOnionAuthorization(address) {
    address = onionAddress(address);
    const closed = [];
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      for (const tab of win.gBrowser.tabs) {
        const pending = this._authorizationDialogs.get(tab.linkedBrowser);
        if (pending?.info.address == address) {
          pending.info.accepted = true;
          closed.push(this._authorizationPrompts.get(tab.linkedBrowser));
          pending.dialog.close();
        }
      }
    }
    await Promise.all(closed);
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      for (const tab of [...win.gBrowser.tabs]) {
        const uri = tab.linkedBrowser.currentURI;
        if (this.isTorTab(tab) && this.serviceAddress(uri) == address) {
          const contextId = this.contextIdForURI(uri);
          if (tab.userContextId != contextId) {
            await this._reopenInContext(win, tab, contextId, uri.spec);
          }
        }
      }
    }
  },

  _anyTorTabs(privateOnly = false) {
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      if (
        !win.closed &&
        win.gBrowser?.tabs.some(
          tab =>
            !tab.closing &&
            this.isTorTab(tab) &&
            (!privateOnly || tab.userContextId == this.userContextId)
        )
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
    this._beginBusy();
    this._lastError = "";
    try {
      if (this.isTorTab(tab)) {
        return await this._reopenInContext(
          win,
          tab,
          lazy.PrivateTab.userContextId
        );
      }
      await this.ensureProxy();
      return await this._reopenInContext(
        win,
        tab,
        this.contextIdForURI(tab.linkedBrowser.currentURI)
      );
    } catch (error) {
      this._lastError = error.message;
      console.error("TorRouting toggle failed:", error);
      return null;
    } finally {
      this._endBusy();
    }
  },

  _beginBusy() {
    this._busyCount++;
    this._busy = true;
    this._notifyState();
  },

  _endBusy() {
    this._busyCount = Math.max(0, this._busyCount - 1);
    this._busy = this._busyCount > 0;
    this._notifyState();
  },

  async createTab(win, options = {}) {
    this.init();
    if (!this.container) {
      throw new Error(this._lastError || "Tor is unavailable");
    }
    if (lazy.PrivateBrowsingUtils.isWindowPrivate(win)) {
      throw new Error("Tor tabs must be opened in a normal browser window");
    }
    await this.ensureProxy();
    const { uri = null, ...tabOptions } = options;
    const tab = win.gBrowser.addTrustedTab(null, {
      ...tabOptions,
      skipLoad: true,
      userContextId: this.contextIdForURI(uri),
    });
    this._markTorTab(tab);
    return tab;
  },

  routeOnion(win, tab, url, { reloadIfSame = false } = {}) {
    this.init();
    const pending = this._pendingOnionNavigations.get(tab);
    if (pending) {
      pending.url = url;
      return pending.task;
    }
    const request = { url, task: null };
    request.task = (async () => {
      this._beginBusy();
      this._lastError = "";
      try {
        await this.ensureProxy();
        if (tab.closing || !tab.isConnected) {
          return null;
        }
        const contextId = this.contextIdForURI(Services.io.newURI(request.url));
        if (tab.userContextId == contextId) {
          if (reloadIfSame) {
            tab.linkedBrowser.loadURI(Services.io.newURI(request.url), {
              triggeringPrincipal:
                Services.scriptSecurityManager.getSystemPrincipal(),
            });
          }
          return tab;
        }
        return await this._reopenInContext(win, tab, contextId, request.url);
      } catch (error) {
        this._lastError = error.message;
        console.error("TorRouting onion navigation failed:", error);
        return null;
      } finally {
        this._pendingOnionNavigations.delete(tab);
        this._endBusy();
      }
    })();
    this._pendingOnionNavigations.set(tab, request);
    this._navigationReplacements.set(tab.linkedBrowser, request.task);
    return request.task;
  },

  async _reopenInContext(win, tab, userContextId, requestedURL = null) {
    const { gBrowser, gURLBar } = win;
    const selected = tab == gBrowser.selectedTab;
    const focusUrlbar = selected && gURLBar.focused;
    const pinned = tab.pinned;
    const url = requestedURL ?? this._reloadURL(tab.linkedBrowser.currentURI);
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
    Services.obs.notifyObservers(
      {
        wrappedJSObject: {
          oldBrowser: tab.linkedBrowser,
          newBrowser: newTab.linkedBrowser,
          newTab,
        },
      },
      "wildbuzzard-tab-replaced"
    );
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
    if (this._stopping) {
      throw new Error("Tor is shutting down");
    }
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
    const binaryName = AppConstants.platform == "win" ? "tor.exe" : "tor";
    const sourcePath = PathUtils.join(
      applicationDirectory,
      "runtime",
      "tor",
      binaryName
    );
    if (!(await IOUtils.exists(sourcePath))) {
      throw new Error("The bundled Tor runtime is not installed");
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
    const stateDirectory = PathUtils.join(root, "tor-state");
    const portInfoPath = PathUtils.join(root, "control-port");
    const cookiePath = PathUtils.join(root, "control-cookie");
    const configPath = PathUtils.join(root, "torrc");
    for (const path of [root, stateDirectory]) {
      await IOUtils.makeDirectory(path, {
        createAncestors: true,
        ignoreExisting: true,
        permissions: 0o700,
      });
      await IOUtils.setPermissions(path, 0o700);
    }
    await IOUtils.remove(portInfoPath, { ignoreAbsent: true });
    await IOUtils.remove(cookiePath, { ignoreAbsent: true });
    const config = [
      `DataDirectory ${quoteToml(stateDirectory)}`,
      "ClientOnly 1",
      "RunAsDaemon 0",
      "SocksPort 127.0.0.1:auto IsolateSOCKSAuth ExtendedErrors",
      "ControlPort 127.0.0.1:auto",
      `ControlPortWriteToFile ${quoteToml(portInfoPath)}`,
      "CookieAuthentication 1",
      `CookieAuthFile ${quoteToml(cookiePath)}`,
      "SafeLogging 1",
      "Log warn stderr",
      "",
    ].join("\n");
    await IOUtils.writeUTF8(configPath, config, {
      tmpPath: `${configPath}.tmp`,
    });
    await IOUtils.setPermissions(configPath, 0o600);
    const process = await Subprocess.call({
      command: binaryPath,
      arguments: [
        "-f",
        configPath,
        "--__OwningControllerProcess",
        String(Services.appinfo.processID),
      ],
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
        this._control?.close();
        this._control = null;
        this._process = null;
        this._port = 0;
        if (result.exitCode !== 0) {
          this._lastError =
            stderr.trim() ||
            stdout.trim() ||
            `Tor exited with ${result.exitCode}`;
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

    try {
      for (let attempt = 0; attempt < START_ATTEMPTS; attempt++) {
        if (this._stopping || this._process != process) {
          throw new Error("Tor exited during startup");
        }
        if (
          (await IOUtils.exists(portInfoPath)) &&
          (await IOUtils.exists(cookiePath))
        ) {
          const portInfo = await IOUtils.readUTF8(portInfoPath);
          const match = /^PORT=127\.0\.0\.1:(\d+)\s*$/.exec(portInfo);
          const cookie = await IOUtils.read(cookiePath);
          if (match && cookie.length == 32) {
            const control = new TorControl(Number(match[1]));
            this._control = control;
            await control.send(
              "AUTHENTICATE " +
                Array.from(cookie, byte =>
                  byte.toString(16).padStart(2, "0")
                ).join("")
            );
            await control.send("TAKEOWNERSHIP");
            await control.send("RESETCONF __OwningControllerProcess");
            const listeners = await control.send("GETINFO net/listeners/socks");
            const socks = /^net\/listeners\/socks="127\.0\.0\.1:(\d+)"$/.exec(
              listeners[0]
            );
            if (!socks) {
              throw new Error("Tor did not provide a local SOCKS listener");
            }
            await this._restoreAuthorizations();
            this._lastError = "";
            this._port = Number(socks[1]);
            this._notifyState();
            return this._port;
          }
        }
        await new Promise(resolve => setTimeout(resolve, START_INTERVAL_MS));
      }
      throw new Error("Tor did not open its control connection in time");
    } catch (error) {
      this._control?.close();
      this._control = null;
      await process.kill();
      throw error;
    }
  },

  async _restoreAuthorizations() {
    let entries;
    try {
      entries = await OnionAuthStore.load();
    } catch {
      // Cancelling Primary Password leaves public onion browsing available.
      return;
    }
    for (const entry of entries.values()) {
      if (!entry.key) {
        continue;
      }
      await this._control.send(
        `ONION_CLIENT_AUTH_ADD ${entry.address} x25519:${entry.key}`
      );
    }
  },

  _queueAuthorization(operation) {
    const task = this._authorizationUpdates.then(operation);
    this._authorizationUpdates = task.catch(() => {});
    return task;
  },

  setOnionAuthorization(address, value) {
    return this._queueAuthorization(async () => {
      address = onionAddress(address);
      const previous = (await OnionAuthStore.load()).get(address);
      const key = onionPrivateKey(value.key || previous?.key);
      await this.ensureProxy();
      await this._control.send(
        `ONION_CLIENT_AUTH_ADD ${address} x25519:${key}`
      );
      try {
        await OnionAuthStore.update(address, { ...value, key });
      } catch (error) {
        await this._control.send(
          previous?.key
            ? `ONION_CLIENT_AUTH_ADD ${address} x25519:${previous.key}`
            : `ONION_CLIENT_AUTH_REMOVE ${address}`
        );
        throw error;
      }
    });
  },

  removeOnionAuthorization(address) {
    return this._queueAuthorization(async () => {
      address = onionAddress(address);
      const entry = (await OnionAuthStore.load()).get(address);
      if (this._control && entry?.key) {
        await this._control.send(`ONION_CLIENT_AUTH_REMOVE ${address}`);
      }
      await OnionAuthStore.update(address, null);
      await this.completeOnionAuthorization(address);
    });
  },

  setOnionPrivacy(address, privateMode) {
    return this._queueAuthorization(async () => {
      address = onionAddress(address);
      if (typeof privateMode != "boolean") {
        throw new Error("Private mode must be true or false");
      }
      const entry = (await OnionAuthStore.load()).get(address);
      await OnionAuthStore.update(address, {
        ...entry,
        key: entry?.key ?? null,
        privateMode,
      });
      await this.completeOnionAuthorization(address);
    });
  },

  async stop() {
    this._stopping = true;
    this._control?.close();
    this._control = null;
    if (this._startTask) {
      await this._startTask.catch(() => {});
    }
    const process = this._process;
    if (process) {
      await process.kill(10000);
      await process.wait();
    }
    this._process = null;
    this._port = 0;
    await this._authorizationUpdates;
    OnionAuthStore.lock();
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
    if (!this.isTorContext(channel.loadInfo?.originAttributes.userContextId)) {
      callback.onProxyFilterResult(proxyInfo);
      return;
    }
    const applyTorProxy = () => {
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
    };
    if (this._port) {
      applyTorProxy();
    } else {
      this.ensureProxy().then(applyTorProxy, applyTorProxy);
    }
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

  _navigationTarget(loadInfo) {
    const context =
      loadInfo?.browsingContext ??
      BrowsingContext.get(loadInfo?.browsingContextID ?? 0);
    const topContext = context?.top ?? context;
    const browser = topContext?.embedderElement ?? null;
    let win = browser?.documentGlobal ?? null;
    let tab = win?.gBrowser?.getTabForBrowser(browser) ?? null;
    if (!tab && loadInfo?.browsingContextID) {
      for (const candidateWindow of Services.wm.getEnumerator(
        "navigator:browser"
      )) {
        const candidateTab = candidateWindow.gBrowser?.tabs.find(
          item =>
            item.linkedBrowser.browsingContext?.id == loadInfo.browsingContextID
        );
        if (candidateTab) {
          win = candidateWindow;
          tab = candidateTab;
          break;
        }
      }
    }
    return {
      tab,
      win,
      topLevel:
        loadInfo?.externalContentPolicyType ==
        Ci.nsIContentPolicy.TYPE_DOCUMENT,
    };
  },

  observe(subject, topic, data) {
    if (topic == "wildbuzzard-onion-authorization-needed") {
      const browser = subject;
      const uri = browser.currentURI;
      if (this.isOnionURI(uri)) {
        this.promptOnionAuthorization(
          browser,
          uri,
          data == "onionAuthFailed"
        ).catch(() =>
          console.error("Could not open onion authorization dialog")
        );
      }
      return;
    }
    if (topic == "http-on-modify-request") {
      const channel = subject.QueryInterface(Ci.nsIHttpChannel);
      const torContext = this.isTorContext(
        channel.loadInfo?.originAttributes.userContextId
      );
      if (!torContext && !this.isOnionURI(channel.URI)) {
        return;
      }
      const { tab, topLevel, win } = this._navigationTarget(channel.loadInfo);
      if (
        torContext &&
        (!topLevel ||
          !tab ||
          tab.userContextId == this.contextIdForURI(channel.URI))
      ) {
        return;
      }
      if (tab && topLevel) {
        this.routeOnion(win, tab, channel.URI.spec, { reloadIfSame: true });
      }
      channel.cancel(Cr.NS_BINDING_ABORTED);
      return;
    }
    if (topic != "quit-application-granted") {
      return;
    }
    Services.obs.removeObserver(this, "http-on-modify-request");
    Services.obs.removeObserver(this, "wildbuzzard-onion-authorization-needed");
    lazy.ProxyService.unregisterChannelFilter(this);
    this.clearData();
    this._stopping = true;
    this._control?.close();
    this._control = null;
  },

  QueryInterface: ChromeUtils.generateQI([
    Ci.nsIObserver,
    Ci.nsIProtocolProxyChannelFilter,
  ]),
};
