/* SPDX-License-Identifier: AGPL-3.0-or-later */

"use strict";

{
  const MAX_PENDING_REQUESTS = 32;
  const REQUEST_TIMEOUT_MS = 30_000;
  const pending = new Map();
  let sequence = 0;

  addEventListener("WildBuzzardTorrentResponse", event => {
    const id = String(event.detail?.id);
    const entry = pending.get(id);
    if (!entry) {
      return;
    }
    pending.delete(id);
    clearTimeout(entry.timeout);
    entry.signal?.removeEventListener("abort", entry.onAbort);
    if (event.detail.error) {
      entry.reject(new Error(event.detail.error));
    } else {
      entry.resolve(event.detail.response);
    }
  });

  window.WildBuzzardTorrentCaptureUserActivation = (method, target) => {
    const detail = { method, target, token: null };
    document.dispatchEvent(
      new CustomEvent("WildBuzzardTorrentActivation", {
        bubbles: true,
        detail,
      })
    );
    return /^[A-Za-z0-9_-]{32}$/.test(detail.token || "") ? detail.token : null;
  };

  window.WildBuzzardTorrentRequest = (request, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException("The request was aborted", "AbortError"));
        return;
      }
      if (pending.size >= MAX_PENDING_REQUESTS) {
        reject(new Error("Too many pending torrent requests"));
        return;
      }
      const id = String(++sequence);
      const onAbort = () => {
        clearTimeout(entry.timeout);
        pending.delete(id);
        reject(new DOMException("The request was aborted", "AbortError"));
      };
      const entry = { onAbort, reject, resolve, signal, timeout: null };
      entry.timeout = setTimeout(() => {
        pending.delete(id);
        signal?.removeEventListener("abort", onAbort);
        reject(new Error("The torrent request timed out"));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, entry);
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        document.dispatchEvent(
          new CustomEvent("WildBuzzardTorrentRequest", {
            bubbles: true,
            detail: { id, request },
          })
        );
      } catch (error) {
        clearTimeout(entry.timeout);
        pending.delete(id);
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      }
    });
}
