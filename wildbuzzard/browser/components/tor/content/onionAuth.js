/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { TorRouting } = ChromeUtils.importESModule(
  "resource:///modules/TorRouting.sys.mjs"
);
const { OnionAuthStore } = ChromeUtils.importESModule(
  "resource:///modules/OnionAuthStore.sys.mjs"
);
const parameters = window.arguments[0];
let saving = false;

function updateRememberKey() {
  const remember = document.getElementById("remember-key");
  remember.disabled = !document.getElementById("private-mode").checked;
  if (remember.disabled) {
    remember.checked = true;
  }
}

document.subDialogSetDefaultFocus = () => {
  document
    .getElementById(parameters.manage ? "onion-address" : "private-key")
    .focus();
};

async function refreshAuthorizations() {
  const list = document.getElementById("saved-keys");
  list.replaceChildren();
  for (const entry of await OnionAuthStore.list()) {
    const row = document.createElementNS("http://www.w3.org/1999/xhtml", "li");
    const label = document.createElementNS("http://www.w3.org/1999/xhtml", "p");
    label.textContent = `${entry.name ? entry.name + " — " : ""}${entry.address}.onion`;
    row.append(label);
    const privacyLabel = document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "label"
    );
    privacyLabel.className = "remember";
    const privacy = document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "input"
    );
    privacy.type = "checkbox";
    privacy.checked = entry.privateMode;
    const privacyText = document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "span"
    );
    document.l10n.setAttributes(
      privacyText,
      "wildbuzzard-onion-auth-private-mode"
    );
    privacyLabel.append(privacy, privacyText);
    row.append(privacyLabel);
    privacy.addEventListener("change", async () => {
      privacy.disabled = true;
      try {
        await TorRouting.setOnionPrivacy(entry.address, privacy.checked);
        await refreshAuthorizations();
      } catch {
        privacy.checked = entry.privateMode;
        privacy.disabled = false;
        document.l10n.setAttributes(
          document.getElementById("feedback"),
          "wildbuzzard-onion-auth-save-error"
        );
      }
    });
    for (const action of ["edit", "remove"]) {
      const button = document.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "button"
      );
      button.type = "button";
      document.l10n.setAttributes(button, `wildbuzzard-onion-auth-${action}`);
      button.addEventListener("click", async () => {
        if (action == "edit") {
          document.getElementById("onion-address").value =
            entry.address + ".onion";
          document.getElementById("identity-name").value = entry.name;
          document.getElementById("remember-key").checked = entry.remember;
          document.getElementById("private-mode").checked = entry.privateMode;
          updateRememberKey();
          document.getElementById("private-key").value = "";
          document.getElementById("private-key").required = !entry.hasKey;
          document.getElementById("private-key").focus();
        } else {
          try {
            await TorRouting.removeOnionAuthorization(entry.address);
            await refreshAuthorizations();
          } catch {
            document.l10n.setAttributes(
              document.getElementById("feedback"),
              "wildbuzzard-onion-auth-save-error"
            );
          }
        }
      });
      row.append(button);
    }
    list.append(row);
  }
}

window.addEventListener("DOMContentLoaded", async () => {
  document.l10n.setAttributes(
    document.getElementById("onion-auth-dialog").getButton("accept"),
    parameters.manage
      ? "wildbuzzard-onion-auth-save"
      : "wildbuzzard-onion-auth-connect"
  );
  const address = document.getElementById("onion-address");
  address.value = parameters.address ? parameters.address + ".onion" : "";
  address.readOnly = !parameters.manage;
  document.getElementById("private-mode").checked =
    parameters.privateMode !== false;
  document.getElementById("remember-key").checked =
    parameters.remember === true;
  document
    .getElementById("private-mode")
    .addEventListener("change", updateRememberKey);
  updateRememberKey();
  address.addEventListener("input", () => {
    document.getElementById("private-key").required = true;
  });
  if (parameters.failed) {
    document.l10n.setAttributes(
      document.getElementById("explanation"),
      "wildbuzzard-onion-auth-failed"
    );
  }
  if (parameters.manage) {
    document.getElementById("authorizations").hidden = false;
    try {
      await refreshAuthorizations();
    } catch {
      document.l10n.setAttributes(
        document.getElementById("feedback"),
        "wildbuzzard-onion-auth-unlock-error"
      );
    }
  }
  document.subDialogSetDefaultFocus();
});

async function save(event) {
  event.preventDefault();
  if (saving || !document.getElementById("key-form").reportValidity()) {
    return;
  }
  saving = true;
  const button = document
    .getElementById("onion-auth-dialog")
    .getButton("accept");
  button.disabled = true;
  try {
    await TorRouting.setOnionAuthorization(
      document.getElementById("onion-address").value,
      {
        key: document.getElementById("private-key").value,
        name: document.getElementById("identity-name").value,
        remember: document.getElementById("remember-key").checked,
        privateMode: document.getElementById("private-mode").checked,
      }
    );
    document.getElementById("private-key").value = "";
    parameters.accepted = true;
    if (!parameters.manage) {
      window.close();
      return;
    }
    await TorRouting.completeOnionAuthorization(
      document.getElementById("onion-address").value
    );
    await refreshAuthorizations();
    document.l10n.setAttributes(
      document.getElementById("feedback"),
      "wildbuzzard-onion-auth-saved-status"
    );
  } catch {
    document.l10n.setAttributes(
      document.getElementById("feedback"),
      "wildbuzzard-onion-auth-save-error"
    );
  } finally {
    saving = false;
    button.disabled = false;
  }
}

document.addEventListener("dialogaccept", save);
document.addEventListener("submit", save);
window.addEventListener("unload", () => {
  document.getElementById("private-key").value = "";
});
