/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { BrowserControl } from "chrome://remote/content/wildbuzzard/BrowserControl.sys.mjs";
import { handleWildBuzzardCommand } from "resource:///modules/WildBuzzardCommand.sys.mjs";
import { NetUtil } from "resource://gre/modules/NetUtil.sys.mjs";
import { clearTimeout, setTimeout } from "resource://gre/modules/Timer.sys.mjs";

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const CONTROL_SOCKET_ENV = "WILDBUZZARD_CONTROL_SOCKET";
const LocalFile = Components.Constructor(
  "@mozilla.org/file/local;1",
  "nsIFile",
  "initWithPath"
);
const UnixServerSocket = Components.Constructor(
  "@mozilla.org/network/server-socket;1",
  "nsIServerSocket",
  "initWithFilename"
);

function bytesFromBinaryString(source) {
  return Uint8Array.from(source, character => character.charCodeAt(0));
}

function writeResponse(output, value) {
  const input = Cc["@mozilla.org/io/string-input-stream;1"].createInstance(
    Ci.nsIStringInputStream
  );
  input.setUTF8Data(`${JSON.stringify(value)}\n`);
  return new Promise((resolve, reject) => {
    NetUtil.asyncCopy(input, output, status => {
      if (Components.isSuccessCode(status)) {
        resolve();
      } else {
        reject(Components.Exception("Wild Buzzard response failed", status));
      }
    });
  });
}

function profileSocketId(path) {
  const bytes = new TextEncoder().encode(path);
  const hash = Cc["@mozilla.org/security/hash;1"].createInstance(
    Ci.nsICryptoHash
  );
  hash.init(hash.SHA256);
  hash.update(bytes, bytes.length);
  return [...hash.finish(false)]
    .slice(0, 12)
    .map(character => character.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("");
}

function validatedOverridePath() {
  const value = Services.env.get(CONTROL_SOCKET_ENV);
  if (!value) {
    return null;
  }
  const hasControlCharacter = [...value].some(character => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (
    !PathUtils.isAbsolute(value) ||
    value.includes("//") ||
    value.split("/").some(part => part === "." || part === "..") ||
    value.endsWith("/") ||
    !PathUtils.filename(value) ||
    hasControlCharacter
  ) {
    throw new Error(`${CONTROL_SOCKET_ENV} must be a normalized absolute path`);
  }
  return value;
}

function defaultSocketDirectory() {
  const runtimeDirectory = Services.env.get("XDG_RUNTIME_DIR");
  if (runtimeDirectory && PathUtils.isAbsolute(runtimeDirectory)) {
    return PathUtils.join(runtimeDirectory, "wildbuzzard", "profiles");
  }
  const homeDirectory = Services.dirsvc.get("Home", Ci.nsIFile).path;
  const stateDirectory = Services.env.get("XDG_STATE_HOME");
  const base =
    stateDirectory && PathUtils.isAbsolute(stateDirectory)
      ? stateDirectory
      : PathUtils.join(homeDirectory, ".local", "state");
  return PathUtils.join(base, "wildbuzzard", "run", "profiles");
}

export function wildBuzzardControlSocketPath({
  instanceId = ChromeUtils.base64URLEncode(
    crypto.getRandomValues(new Uint8Array(9)),
    { pad: false }
  ),
  profilePath,
} = {}) {
  const override = validatedOverridePath();
  if (override) {
    return override;
  }
  profilePath ??= Services.dirsvc.get("ProfD", Ci.nsIFile).path;
  if (!/^[A-Za-z0-9_-]{12}$/.test(instanceId)) {
    throw new Error("Invalid Wild Buzzard control socket instance ID");
  }
  return PathUtils.join(
    defaultSocketDirectory(),
    `control-${profileSocketId(profilePath)}-${instanceId}.sock`
  );
}

async function prepareDirectory(path, create) {
  if (create) {
    await IOUtils.makeDirectory(path, {
      createAncestors: true,
      ignoreExisting: true,
      permissions: 0o700,
    });
  }
  const directory = new LocalFile(path);
  if (!directory.isDirectory() || directory.isSymlink()) {
    throw new Error("Unsafe Wild Buzzard runtime directory");
  }
  if (create) {
    await IOUtils.setPermissions(path, 0o700, false);
  }
  if ((directory.permissions & 0o077) !== 0) {
    throw new Error("Insecure Wild Buzzard runtime directory permissions");
  }
}

async function ensureSocketPathUnused(path) {
  if (await IOUtils.exists(path)) {
    throw new Error("Wild Buzzard control socket path already exists");
  }
}

/** Handles one native command connection. */
class CommandConnection {
  constructor(transport, socketPath, onClose) {
    this.transport = transport;
    this.socketPath = socketPath;
    this.onClose = onClose;
    this.controller = new AbortController();
    this.decoder = new TextDecoder();
    this.source = "";
    this.received = 0;
    this.handled = false;
  }

  start() {
    this.input = this.transport.openInputStream(0, 0, 0);
    this.output = this.transport
      .openOutputStream(0, 0, 0)
      .QueryInterface(Ci.nsIAsyncOutputStream);
    this.pump = Cc["@mozilla.org/network/input-stream-pump;1"].createInstance(
      Ci.nsIInputStreamPump
    );
    this.pump.init(this.input, 0, 0, false);
    this.pump.asyncRead(this);
  }

  onStartRequest() {}

  onDataAvailable(request, stream, _offset, count) {
    if (this.handled) {
      request.cancel(Cr.NS_ERROR_UNEXPECTED);
      return;
    }
    const reader = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(
      Ci.nsIScriptableInputStream
    );
    reader.init(stream);
    const chunk = reader.readBytes(count);
    this.received += chunk.length;
    if (this.received > MAX_REQUEST_BYTES) {
      request.cancel(Cr.NS_ERROR_FILE_TOO_BIG);
      this.fail(new Error("Wild Buzzard command request is too large"));
      return;
    }
    this.source += this.decoder.decode(bytesFromBinaryString(chunk), {
      stream: true,
    });
    const newline = this.source.indexOf("\n");
    if (newline < 0) {
      return;
    }
    if (this.source.slice(newline + 1).trim()) {
      request.cancel(Cr.NS_ERROR_UNEXPECTED);
      this.fail(new Error("Wild Buzzard accepts one command per connection"));
      return;
    }
    let command;
    try {
      command = JSON.parse(this.source.slice(0, newline));
    } catch {
      this.fail(new Error("Invalid Wild Buzzard command JSON"));
      return;
    }
    this.handled = true;
    handleWildBuzzardCommand(
      { ...command, socketPath: this.socketPath },
      this.controller.signal
    ).then(
      response => this.respond(response),
      error =>
        this.respond({
          exitCode: 1,
          stdout: "",
          stderr: `wildbuzzard: ${error?.message || String(error)}\n`,
        })
    );
  }

  onStopRequest(_request, status) {
    if (this.handled) {
      if (!this.responded) {
        this.controller.abort();
      }
      this.close();
      return;
    }
    if (!this.handled && Components.isSuccessCode(status)) {
      this.fail(new Error("Incomplete Wild Buzzard command request"));
    } else if (!Components.isSuccessCode(status) && !this.handled) {
      this.close();
    }
  }

  async respond(value) {
    try {
      await writeResponse(this.output, value);
      this.responded = true;
      this.output = null;
      this.closeTimer = setTimeout(() => this.close(), 1000);
      return;
    } catch (error) {
      console.error("Wild Buzzard command response failed", error);
    }
    this.close();
  }

  fail(error) {
    if (this.handled) {
      return;
    }
    this.handled = true;
    this.respond({
      exitCode: 1,
      stdout: "",
      stderr: `wildbuzzard: ${error.message}\n`,
    });
  }

  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    clearTimeout(this.closeTimer);
    this.controller.abort();
    try {
      this.input?.close();
    } catch {}
    try {
      this.output?.close();
    } catch {}
    try {
      this.transport.close(Cr.NS_OK);
    } catch {}
    this.onClose(this);
  }
}

export const WildBuzzardControlStartup = {
  init() {
    if (this.task) {
      return this.task;
    }
    this.connections = new Set();
    try {
      this.customPath = Boolean(validatedOverridePath());
      this.path = wildBuzzardControlSocketPath();
    } catch (error) {
      console.error("Wild Buzzard control startup failed", error);
      this.task = Promise.resolve(null);
      return this.task;
    }
    this.ownsSocket = false;
    BrowserControl.start();
    this.task = this.listen().catch(async error => {
      await this.closeSocket();
      BrowserControl.stop();
      console.error("Wild Buzzard control startup failed", error);
      return null;
    });
    return this.task;
  },

  async listen() {
    await prepareDirectory(PathUtils.parent(this.path), !this.customPath);
    await ensureSocketPathUnused(this.path);
    const socketFile = new LocalFile(this.path);
    this.server = new UnixServerSocket(socketFile, 0o600, 16);
    this.ownsSocket = true;
    this.server.asyncListen({
      onSocketAccepted: (_server, transport) => {
        const connection = new CommandConnection(transport, this.path, value =>
          this.connections.delete(value)
        );
        this.connections.add(connection);
        connection.start();
      },
      onStopListening() {},
    });
    await IOUtils.setPermissions(this.path, 0o600, false);
    const socket = new LocalFile(this.path);
    if (
      !socket.isSpecial() ||
      socket.isSymlink() ||
      (socket.permissions & 0o777) !== 0o600
    ) {
      throw new Error("Insecure Wild Buzzard control socket");
    }
    return { socketPath: this.path, browserPid: Services.appinfo.processID };
  },

  async closeSocket() {
    try {
      this.server?.close();
    } catch {}
    if (this.path && this.ownsSocket) {
      try {
        const socket = new LocalFile(this.path);
        if (socket.exists() && socket.isSpecial() && !socket.isSymlink()) {
          await IOUtils.remove(this.path, { ignoreAbsent: true });
        }
      } catch {}
    }
    this.server = null;
    this.ownsSocket = false;
  },

  async uninit() {
    await this.task?.catch(() => {});
    await this.closeSocket();
    for (const connection of this.connections ?? []) {
      connection.close();
    }
    this.connections?.clear();
    BrowserControl.stop();
    this.task = null;
    this.path = null;
    this.server = null;
    this.customPath = false;
    this.ownsSocket = false;
  },
};

export const WildBuzzardControlStartupTestUtils = Object.freeze({
  defaultSocketDirectory,
  ensureSocketPathUnused,
  prepareDirectory,
  profileSocketId,
  validatedOverridePath,
});
