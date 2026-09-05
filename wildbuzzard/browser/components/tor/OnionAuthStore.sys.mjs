/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export function onionAddress(value) {
  const address = String(value)
    .trim()
    .toLowerCase()
    .replace(/\.onion\.?$/, "");
  if (!/^[a-z2-7]{56}$/.test(address)) {
    throw new Error("Enter a 56-character v3 onion address.");
  }
  return address;
}

export function onionPrivateKey(value) {
  let key = String(value).trim();
  let bytes = "";
  if (/^[a-z2-7]{52}$/i.test(key)) {
    let bits = 0;
    let accumulator = 0;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    for (const char of key.toUpperCase()) {
      accumulator = (accumulator << 5) | alphabet.indexOf(char);
      bits += 5;
      if (bits >= 8) {
        bits -= 8;
        bytes += String.fromCharCode((accumulator >> bits) & 255);
        accumulator &= (1 << bits) - 1;
      }
    }
    if (accumulator) {
      throw new Error("The private key has invalid base32 padding.");
    }
  } else if (/^[A-Za-z0-9+/]{43}=?$/.test(key)) {
    key = key.replace(/=$/, "") + "=";
    bytes = atob(key);
    if (btoa(bytes) != key) {
      throw new Error("The private key has invalid base64 padding.");
    }
  }
  if (bytes.length != 32) {
    throw new Error(
      "Enter a 52-character base32 or 44-character base64 private key."
    );
  }
  return btoa(bytes);
}

/**
 *
 */
export class OnionAuthStorage {
  constructor(
    path = PathUtils.join(PathUtils.profileDir, "onion-authorizations.json")
  ) {
    this.path = path;
    this._entries = null;
    this._queue = Promise.resolve();
  }

  get _crypto() {
    return Cc["@mozilla.org/login-manager/crypto/SDR;1"].getService(
      Ci.nsILoginManagerCrypto
    );
  }

  async load() {
    if (this._entries) {
      return this._entries;
    }
    let entries = [];
    if (await IOUtils.exists(this.path)) {
      const saved = await IOUtils.readJSON(this.path);
      if (
        saved.version != 1 ||
        typeof saved.encrypted != "string" ||
        saved.encrypted.length > 1024 * 1024
      ) {
        throw new Error("The saved onion authorizations could not be read.");
      }
      entries = JSON.parse(this._crypto.decrypt(saved.encrypted));
      if (!Array.isArray(entries) || entries.length > 1000) {
        throw new Error("The saved onion authorizations are invalid.");
      }
    }
    this._entries = new Map(
      entries.map(entry => [
        onionAddress(entry.address),
        {
          address: onionAddress(entry.address),
          key: entry.key == null ? null : onionPrivateKey(entry.key),
          name: String(entry.name || "").slice(0, 120),
          remember: entry.key != null,
          privateMode: entry.privateMode !== false,
        },
      ])
    );
    return this._entries;
  }

  async list() {
    return [...(await this.load()).values()].map(
      ({ address, name, remember, privateMode, key }) => ({
        address,
        name,
        remember,
        privateMode,
        hasKey: key != null,
      })
    );
  }

  usesPrivateMode(address) {
    return this._entries?.get(onionAddress(address))?.privateMode !== false;
  }

  update(address, value) {
    const task = this._queue.then(async () => {
      const entries = await this.load();
      address = onionAddress(address);
      const next = new Map(entries);
      if (value) {
        const privateMode =
          (value.privateMode ?? entries.get(address)?.privateMode) !== false;
        next.set(address, {
          address,
          key: value.key == null ? null : onionPrivateKey(value.key),
          name: String(value.name || "").slice(0, 120),
          remember:
            value.key != null && (!privateMode || value.remember === true),
          privateMode,
        });
      } else {
        next.delete(address);
      }
      const saved = [...next.values()]
        .filter(entry => entry.remember || !entry.privateMode)
        .map(entry => ({ ...entry, key: entry.remember ? entry.key : null }));
      if (saved.length) {
        const encrypted = this._crypto.encrypt(JSON.stringify(saved));
        await IOUtils.writeJSON(
          this.path,
          { version: 1, encrypted },
          { tmpPath: this.path + ".tmp" }
        );
        await IOUtils.setPermissions(this.path, 0o600);
      } else {
        await IOUtils.remove(this.path, { ignoreAbsent: true });
      }
      this._entries = next;
    });
    this._queue = task.catch(() => {});
    return task;
  }

  lock() {
    this._entries = null;
  }
}

export const OnionAuthStore = new OnionAuthStorage();
