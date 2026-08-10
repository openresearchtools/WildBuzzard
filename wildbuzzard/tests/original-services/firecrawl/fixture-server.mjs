/* SPDX-License-Identifier: AGPL-3.0-or-later */
/* eslint-disable @microsoft/sdl/no-insecure-url */

import { Buffer } from "node:buffer";
import http from "node:http";
import process from "node:process";
import { gzipSync } from "node:zlib";

const port = Number.parseInt(process.env.PORT ?? "8080", 10);
const host = process.env.HOST ?? "0.0.0.0";
let activeSlowRequests = 0;

function logRequest(request, url) {
  const headers = Object.fromEntries(
    Object.entries(request.headers).map(([headerName, value]) => [
      headerName,
      ["authorization", "cookie", "proxy-authorization"].includes(headerName)
        ? "<redacted>"
        : value,
    ])
  );
  console.log(
    JSON.stringify({
      event: "request",
      method: request.method,
      path: url.pathname,
      query: url.search,
      headers,
    })
  );
}

function htmlPage(title, body, script = "", head = "") {
  return `<!doctype html><html lang="en" data-fixture-final-url=""><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}<script>document.documentElement.dataset.fixtureFinalUrl=location.href</script>${script}</body></html>`;
}

function send(response, statusCode, contentType, body, headers = {}) {
  response.writeHead(statusCode, {
    ...(contentType ? { "Content-Type": contentType } : {}),
    "Cache-Control": "no-store",
    ...headers,
  });
  response.end(body);
}

function headerValue(request, headerName) {
  const value = request.headers[headerName];
  return Array.isArray(value) ? value.join(", ") : (value ?? "absent");
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  logRequest(request, url);
  switch (url.pathname) {
    case "/health":
      send(response, 200, "application/json; charset=utf-8", '{"ok":true}');
      return;
    case "/activity":
      send(
        response,
        200,
        "application/json; charset=utf-8",
        JSON.stringify({ activeSlowRequests })
      );
      return;
    case "/static":
      send(
        response,
        200,
        "text/html; charset=utf-8",
        htmlPage(
          "WildBuzzard Static Fixture",
          '<main><h1>Static renderer concordance</h1><p>amber birch cobalt delta ember fern granite harbor indigo juniper kelp lantern meadow nectar orchid pebble quartz river saffron timber umber violet willow xenon yarrow zephyr</p><h2>Deterministic link targets</h2><a href="/target/relative?b=2&amp;a=1#fragment">Relative target</a><a href="https://example.test/reference?q=one">External target</a></main>'
        )
      );
      return;
    case "/dynamic":
      send(
        response,
        200,
        "text/html; charset=utf-8",
        htmlPage(
          "Pending Dynamic Fixture",
          '<main id="app"><h1>Pending mutation</h1></main>',
          '<script>setTimeout(()=>{document.title="WildBuzzard Dynamic Fixture";document.querySelector("#app").innerHTML="<h1>JavaScript rendered concordance</h1><p id=ready>apricot beacon cedar dune elm fjord galaxy helix iris jasmine kindle lagoon mosaic nebula opal prairie quasar ridge solar tundra unity velvet wheat xylem yucca zenith</p><h2>Mutated links</h2><a href=/target/dynamic>Dynamic target</a>"},75)</script>'
        )
      );
      return;
    case "/delayed":
      send(
        response,
        200,
        "text/html; charset=utf-8",
        htmlPage(
          "Delayed Selector Fixture",
          '<main><h1>Delayed selector concordance</h1><div id="mount"></div></main>',
          '<script>setTimeout(()=>{document.querySelector("#mount").innerHTML="<h2 id=ready>Selector became ready</h2><p>bounded patient deterministic arrival</p>"},150)</script>'
        )
      );
      return;
    case "/redirect/start":
      send(response, 302, "text/plain; charset=utf-8", "redirect one", {
        Location: "/redirect/middle?hop=one",
      });
      return;
    case "/redirect/middle":
      send(response, 307, "text/plain; charset=utf-8", "redirect two", {
        Location: "/redirect/final?hop=two",
      });
      return;
    case "/redirect/final":
      send(
        response,
        200,
        "text/html; charset=utf-8",
        htmlPage(
          "Redirect Final Fixture",
          '<main><h1>Redirect destination concordance</h1><p>final location marker preserved exactly</p><a href="./sibling">Redirect sibling</a></main>'
        )
      );
      return;
    case "/status/204":
      send(response, 204, "", "");
      return;
    case "/status/404":
      send(
        response,
        404,
        "text/html; charset=utf-8",
        htmlPage(
          "Missing Fixture",
          "<main><h1>Deterministic not found</h1><p>missing resource body retained</p></main>"
        )
      );
      return;
    case "/json":
      send(
        response,
        200,
        "application/json; charset=utf-8",
        '{"fixture":"json","unicode":"café 東京","ordered":[1,2,3]}'
      );
      return;
    case "/plain":
      send(
        response,
        200,
        "text/plain; charset=utf-8",
        "plain fixture alpha beta gamma café 東京"
      );
      return;
    case "/encoding/latin1":
      send(
        response,
        200,
        "text/html; charset=iso-8859-1",
        Buffer.from(
          htmlPage(
            "Latin One Fixture",
            "<main><h1>Encoded concordance</h1><p>café naïve façade jalapeño</p></main>"
          ),
          "latin1"
        )
      );
      return;
    case "/csp": {
      const nonce = "fixture-nonce";
      const body = htmlPage(
        "CSP Fixture",
        '<main><h1>CSP renderer concordance</h1><p id="ready">policy script executed</p></main>',
        `<script nonce="${nonce}">document.body.dataset.csp="enforced";document.documentElement.dataset.fixtureFinalUrl=location.href</script>`,
        ""
      );
      send(response, 200, "text/html; charset=utf-8", body, {
        "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'none'; img-src 'self'; frame-src 'self'`,
      });
      return;
    }
    case "/iframe":
      send(
        response,
        200,
        "text/html; charset=utf-8",
        htmlPage(
          "Iframe Fixture",
          '<main><h1>Outer frame concordance</h1><iframe src="/frame-content" title="Fixture frame"></iframe></main>'
        )
      );
      return;
    case "/frame-content":
      send(
        response,
        200,
        "text/html; charset=utf-8",
        htmlPage(
          "Inner Frame Fixture",
          "<main><h1>Inner frame content</h1><p>subframe loaded</p></main>"
        )
      );
      return;
    case "/headers": {
      const custom = String(headerValue(request, "x-requested-with"));
      const authorization = String(headerValue(request, "authorization"));
      send(
        response,
        200,
        "text/html; charset=utf-8",
        htmlPage(
          "Header Fixture",
          `<main><h1>Header concordance</h1><p id="custom">custom=${custom}</p><p id="authorization">authorization=${authorization === "absent" ? "absent" : "present"}</p></main>`
        )
      );
      return;
    }
    case "/redirect/cross-origin": {
      const target = url.searchParams.get("target");
      if (!target) {
        send(response, 400, "text/plain; charset=utf-8", "target required");
        return;
      }
      send(response, 302, "text/plain; charset=utf-8", "cross origin", {
        Location: target,
      });
      return;
    }
    case "/state/write":
      send(
        response,
        200,
        "text/html; charset=utf-8",
        htmlPage(
          "State Writer Fixture",
          '<main><h1>State writer concordance</h1><p id="ready">pending</p></main>',
          '<script>(async()=>{document.cookie="fixture_cookie=present; SameSite=Strict";localStorage.setItem("fixture_local","present");sessionStorage.setItem("fixture_session","present");let cache="unsupported";try{const c=await caches.open("fixture-cache");await c.put("/cached",new Response("present"));cache="present"}catch{}let worker="blocked";try{await navigator.serviceWorker.register("/sw.js");worker="registered"}catch{}document.querySelector("#ready").textContent=`cookie=${document.cookie.includes("fixture_cookie")};local=${localStorage.getItem("fixture_local")};session=${sessionStorage.getItem("fixture_session")};cache=${cache};worker=${worker}`})()</script>'
        )
      );
      return;
    case "/state/read":
      send(
        response,
        200,
        "text/html; charset=utf-8",
        htmlPage(
          "State Reader Fixture",
          '<main><h1>State reader concordance</h1><p id="ready">pending</p></main>',
          '<script>(async()=>{let cache=false;try{cache=(await caches.keys()).includes("fixture-cache")}catch{}let workers=0;try{workers=(await navigator.serviceWorker.getRegistrations()).length}catch{}document.querySelector("#ready").textContent=`cookie=${document.cookie.includes("fixture_cookie")};local=${localStorage.getItem("fixture_local")};session=${sessionStorage.getItem("fixture_session")};cache=${cache};workers=${workers}`})()</script>'
        )
      );
      return;
    case "/sw.js":
      send(
        response,
        200,
        "text/javascript; charset=utf-8",
        'self.addEventListener("fetch",()=>{})'
      );
      return;
    case "/large-body":
      send(
        response,
        200,
        "text/html; charset=utf-8",
        htmlPage(
          "Large Body Fixture",
          `<main><h1>Large body concordance</h1><p>${"bounded ".repeat(1200000)}</p></main>`
        )
      );
      return;
    case "/large-dom":
      send(
        response,
        200,
        "text/html; charset=utf-8",
        htmlPage(
          "Large DOM Fixture",
          `<main><h1>Large DOM concordance</h1>${"<i>node</i>".repeat(110000)}</main>`
        )
      );
      return;
    case "/gzip-bomb": {
      const body = htmlPage(
        "Gzip Fixture",
        `<main><h1>Compressed response concordance</h1><p>${"compressible ".repeat(220000)}</p></main>`
      );
      send(
        response,
        200,
        "text/html; charset=utf-8",
        gzipSync(Buffer.from(body)),
        { "Content-Encoding": "gzip" }
      );
      return;
    }
    case "/slow": {
      const delay = Math.min(
        10000,
        Math.max(1, Number(url.searchParams.get("ms")) || 1500)
      );
      activeSlowRequests++;
      response.once("close", () => activeSlowRequests--);
      setTimeout(() => {
        if (!response.destroyed) {
          send(
            response,
            200,
            "text/html; charset=utf-8",
            htmlPage(
              "Slow Fixture",
              "<main><h1>Slow response concordance</h1></main>"
            )
          );
        }
      }, delay);
      return;
    }
    default:
      send(response, 404, "text/plain; charset=utf-8", "fixture route missing");
  }
});

server.listen(port, host, () => {
  console.log(JSON.stringify({ event: "listening", host, port }));
});

for (const signalName of ["SIGINT", "SIGTERM"]) {
  process.on(signalName, () => server.close(() => process.exit(0)));
}
