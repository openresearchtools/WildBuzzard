/* SPDX-License-Identifier: AGPL-3.0-or-later */

function htmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function pdfFixture() {
  const stream = "BT /F1 18 Tf 20 100 Td (Renderer PDF) Tj ET\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets
    .slice(1)
    .map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf;
}

function handleRequest(request, response) {
  const params = new URLSearchParams(request.queryString);
  const mode = params.get("mode") || "html";
  response.setHeader("Cache-Control", "no-store", false);

  if (mode === "redirect") {
    response.setStatusLine(request.httpVersion, 302, "Found");
    response.setHeader("Location", params.get("target"), false);
    return;
  }
  if (mode === "slow") {
    response.processAsync();
    const timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
    timer.init(
      () => {
        response.setHeader("Content-Type", "text/html", false);
        response.write("<!doctype html><title>slow</title><p>done</p>");
        response.finish();
      },
      Number(params.get("delay") || 1000),
      Ci.nsITimer.TYPE_ONE_SHOT
    );
    return;
  }
  if (mode === "json") {
    response.setHeader(
      "Content-Type",
      "application/json; charset=utf-8",
      false
    );
    response.write(JSON.stringify({ rendered: true, source: "original" }));
    return;
  }
  if (mode === "text") {
    response.setHeader("Content-Type", "text/plain; charset=utf-8", false);
    response.write("plain response body");
    return;
  }
  if (mode === "pdf") {
    response.setHeader("Content-Type", "application/pdf", false);
    response.write(pdfFixture());
    return;
  }
  if (mode === "missing") {
    response.setStatusLine(request.httpVersion, 404, "Not Found");
    response.setHeader("Content-Type", "text/html", false);
    response.write("<!doctype html><title>missing</title><h1>Not Found</h1>");
    return;
  }
  if (mode === "empty") {
    response.setStatusLine(request.httpVersion, 204, "No Content");
    return;
  }
  if (mode === "header") {
    const value = request.hasHeader("X-Requested-With")
      ? request.getHeader("X-Requested-With")
      : "absent";
    response.setHeader("Content-Type", "text/html", false);
    response.write(
      `<!doctype html><title>header</title><p id="header">${htmlEscape(value)}</p>`
    );
    return;
  }
  if (mode === "restricted-apis") {
    response.setHeader("Content-Type", "text/html", false);
    response.write(`<!doctype html><title>restricted APIs</title><p></p><script>
      document.querySelector("p").textContent = [
        "RTCPeerConnection",
        "WebSocket",
        "WebTransport",
      ].map(name => name + "=" + typeof window[name]).join(",");
    </script>`);
    return;
  }
  if (mode === "private-subresource") {
    response.setHeader("Content-Type", "text/html", false);
    const privateUrl = "http://127.0.0.1/private-resource";
    const kind = params.get("kind") || "image";
    const resource = {
      fetch: `<script>fetch(${JSON.stringify(privateUrl)}).catch(() => {})</script>`,
      iframe: `<iframe src=${JSON.stringify(privateUrl)}></iframe>`,
      image: `<img src=${JSON.stringify(privateUrl)}>`,
      script: `<script src=${JSON.stringify(privateUrl)}></script>`,
    }[kind];
    response.write(
      `<!doctype html><title>subresource</title>${resource ?? ""}`
    );
    return;
  }
  if (mode === "worker") {
    response.setHeader("Content-Type", "application/javascript", false);
    response.write('self.addEventListener("fetch", () => {});');
    return;
  }
  if (mode === "storage") {
    response.setHeader("Content-Type", "text/html", false);
    response.setHeader(
      "Set-Cookie",
      "renderer=secret; Secure; SameSite=None",
      false
    );
    response.write(`<!doctype html><title>storage</title><script>
      localStorage.setItem("renderer", "secret");
      sessionStorage.setItem("renderer", "secret");
      caches.open("renderer").then(cache => cache.put("cached", new Response("secret")));
      navigator.serviceWorker?.register("${request.path}?mode=worker").catch(() => {});
    </script><p>stored</p>`);
    return;
  }
  if (mode === "large-dom") {
    response.setHeader("Content-Type", "text/html", false);
    response.write(`<!doctype html><title>large</title><script>
      for (let index = 0; index < 21000; index++) {
        document.documentElement.append(document.createElement("i"));
      }
    </script>`);
    return;
  }
  if (mode === "large-body") {
    response.setHeader("Content-Type", "text/plain", false);
    response.write("x".repeat(4 * 1024 * 1024 + 1));
    return;
  }
  if (mode === "large-output") {
    response.setHeader("Content-Type", "text/html", false);
    response.write(`<!doctype html><title>large output</title><body><script>
      document.body.textContent = "x".repeat(2 * 1024 * 1024 + 1);
    </script></body>`);
    return;
  }

  response.setHeader("Content-Type", "text/html; charset=utf-8", false);
  response.write(`<!doctype html><html><head><title>fixture</title></head>
    <body><h1>Static heading</h1><script>
      setTimeout(() => {
        const ready = document.createElement("p");
        ready.id = "ready";
        ready.textContent = "JavaScript mutated DOM";
        document.body.append(ready);
      }, 50);
    </script></body></html>`);
}
