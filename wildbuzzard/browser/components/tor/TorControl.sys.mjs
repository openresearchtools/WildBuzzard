/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";

/**
 *
 */
export class TorControl {
  constructor(port) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("Invalid Tor control port");
    }
    this._buffer = "";
    this._lines = [];
    this._queue = Promise.resolve();
    this._transport = Cc["@mozilla.org/network/socket-transport-service;1"]
      .getService(Ci.nsISocketTransportService)
      .createTransport([], "127.0.0.1", port, null, null);
    this._output = this._transport
      .openOutputStream(0, 0, 0)
      .QueryInterface(Ci.nsIAsyncOutputStream);
    this._pump = Cc["@mozilla.org/network/input-stream-pump;1"].createInstance(
      Ci.nsIInputStreamPump
    );
    this._pump.init(this._transport.openInputStream(0, 0, 0), 0, 0, true);
    this._pump.asyncRead(this);
  }

  send(command) {
    if (
      typeof command != "string" ||
      command.length > 4096 ||
      /[^\x20-\x7e]/.test(command)
    ) {
      return Promise.reject(new Error("Invalid Tor control command"));
    }
    const task = this._queue.then(
      () =>
        new Promise((resolve, reject) => {
          if (this._closed) {
            reject(new Error("Tor control connection is closed"));
            return;
          }
          const timer = setTimeout(() => this.close(), 20000);
          this._pending = {
            resolve: value => {
              clearTimeout(timer);
              resolve(value);
            },
            reject: () => {
              clearTimeout(timer);
              reject(new Error("Tor control request failed"));
            },
          };
          let remaining = command + "\r\n";
          const writer = {
            onOutputStreamReady: stream => {
              if (this._closed) {
                return;
              }
              try {
                while (remaining.length) {
                  const count = stream.write(remaining, remaining.length);
                  if (!count) {
                    break;
                  }
                  remaining = remaining.slice(count);
                }
              } catch (error) {
                if (error.result != Cr.NS_BASE_STREAM_WOULD_BLOCK) {
                  this.close();
                  return;
                }
              }
              if (remaining.length) {
                stream.asyncWait(writer, 0, 0, Services.tm.currentThread);
              }
            },
          };
          this._output.asyncWait(writer, 0, 0, Services.tm.currentThread);
        })
    );
    this._queue = task.catch(() => {});
    return task;
  }

  onStartRequest() {}

  onDataAvailable(_request, stream, _offset, count) {
    const input = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(
      Ci.nsIScriptableInputStream
    );
    input.init(stream);
    this._buffer += input.read(count);
    if (this._buffer.length > 65536) {
      this.close();
      return;
    }
    let end;
    while ((end = this._buffer.indexOf("\r\n")) >= 0) {
      const line = this._buffer.slice(0, end);
      this._buffer = this._buffer.slice(end + 2);
      const match = /^(\d{3})([ -])(.*)$/.exec(line);
      if (!match || !this._pending || this._lines.length > 128) {
        this.close();
        return;
      }
      this._lines.push(match[3]);
      if (match[2] == " ") {
        const pending = this._pending;
        this._pending = null;
        const lines = this._lines;
        this._lines = [];
        if (Number(match[1]) >= 250 && Number(match[1]) <= 252) {
          pending.resolve(lines);
        } else {
          pending.reject();
        }
      }
    }
  }

  onStopRequest() {
    this.close();
  }

  close() {
    if (this._closed) {
      return;
    }
    this._closed = true;
    this._pending?.reject();
    this._pending = null;
    this._buffer = "";
    this._lines = [];
    this._transport.close(Cr.NS_ERROR_ABORT);
  }

  QueryInterface = ChromeUtils.generateQI(["nsIStreamListener"]);
}
