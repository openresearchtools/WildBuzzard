/* SPDX-License-Identifier: AGPL-3.0-or-later */

"use strict";

{
  const sandbox =
    "allow-downloads allow-forms allow-modals allow-same-origin allow-scripts";
  const restrict = frame => {
    if (frame.getAttribute("sandbox") !== sandbox) {
      frame.setAttribute("sandbox", sandbox);
    }
  };
  for (const frame of document.querySelectorAll("iframe")) {
    restrict(frame);
  }
  new MutationObserver(records => {
    for (const record of records) {
      if (record.type === "attributes") {
        restrict(record.target);
        continue;
      }
      for (const node of record.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) {
          continue;
        }
        if (node.localName === "iframe") {
          restrict(node);
        }
        for (const frame of node.querySelectorAll?.("iframe") ?? []) {
          restrict(frame);
        }
      }
    }
  }).observe(document, {
    attributeFilter: ["sandbox"],
    attributes: true,
    childList: true,
    subtree: true,
  });
}
