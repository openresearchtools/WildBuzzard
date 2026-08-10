/* SPDX-License-Identifier: AGPL-3.0-or-later */

function validSessionId(sessionId: string): void {
  if (
    typeof sessionId !== "string" ||
    !sessionId ||
    sessionId.length > 512 ||
    /[\0-\x1f\x7f]/.test(sessionId)
  ) {
    throw new Error("Pi session identity is invalid");
  }
}

export class SessionGeneration {
  #sessionId = "";
  #generation = 0;

  get sessionId(): string {
    return this.#sessionId;
  }

  select(sessionId: string): void {
    validSessionId(sessionId);
    if (sessionId !== this.#sessionId) {
      this.#sessionId = sessionId;
      this.#generation++;
    }
  }

  begin(sessionId: string): { sessionId: string; assertCurrent(): void } {
    validSessionId(sessionId);
    const generation = this.#generation;
    if (sessionId !== this.#sessionId) {
      throw new Error("Pi session changed before the web operation started");
    }
    return {
      sessionId,
      assertCurrent: () => {
        if (this.#sessionId !== sessionId || this.#generation !== generation) {
          throw new Error(
            "Pi session changed while the web operation was running"
          );
        }
      },
    };
  }
}
