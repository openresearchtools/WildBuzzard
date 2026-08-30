/* SPDX-License-Identifier: AGPL-3.0-or-later */

"use strict";

window.Browser.exec = source => {
  if (!source) {
    return source;
  }
  const script = document.createElement("script");
  script.type = "text/javascript";
  script.text = source.endsWith("\n") ? source.slice(0, -1) : source;
  document.head.appendChild(script);
  script.remove();
  return source;
};
