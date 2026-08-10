/* SPDX-License-Identifier: AGPL-3.0-or-later */

import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import {
  appendDeclaredWebLinks,
  discoverDeclaredWebLinks,
} from "../declared-web-links.ts";
import { readableHTML } from "../extract.ts";
import { extractPdfDataUrl } from "../pdf-extract.ts";
import { extractRSCContent } from "../rsc-extract.ts";

function makePdf(text: string): Buffer {
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let source = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(source));
    source += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(source);
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  source += offsets
    .slice(1)
    .map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(source, "ascii");
}

test("declared links retain only bounded HTTP documentation relations", () => {
  const { document } = parseHTML(`
    <html><head><base href="https://example.test/docs/"></head><body>
      <a rel="service-doc nofollow" href="api.html" type="text/html">API</a>
      <a rel="service-doc" href="javascript:alert(1)">Unsafe</a>
      <a rel="nofollow" href="ignored.html">Ignored</a>
    </body></html>
  `);
  const links = discoverDeclaredWebLinks(
    document as unknown as Document,
    "https://example.test/start",
    '<https://example.test/schema.json>; rel="describedby"; type="application/schema+json"'
  );
  assert.deepEqual(links, [
    {
      url: "https://example.test/schema.json",
      relations: ["describedby"],
      type: "application/schema+json",
    },
    {
      url: "https://example.test/docs/api.html",
      relations: ["service-doc"],
      type: "text/html",
    },
  ]);
  assert.match(appendDeclaredWebLinks("Body", links), /## Declared links/);
});

test("RSC extraction resolves content and readable HTML surfaces declared links", () => {
  const paragraph =
    "WildBuzzard extracts the server component payload without executing page scripts. ".repeat(3);
  const chunk = JSON.stringify([
    "$",
    "main",
    null,
    {
      children: [
        ["$", "h1", null, { children: "RSC fixture" }],
        ["$", "p", null, { children: paragraph }],
      ],
    },
  ]);
  const flight = JSON.stringify([1, `23:${chunk}\n`]);
  const html = `<html><head><title>RSC fixture | Site</title><link rel="service-doc" href="/api"></head><body><script>self.__next_f.push(${flight})</script></body></html>`;
  const direct = extractRSCContent(html);
  assert.equal(direct?.title, "RSC fixture");
  assert.match(direct?.content ?? "", /^# RSC fixture/m);
  assert.match(readableHTML(html, "https://example.test/page").content, /<https:\/\/example\.test\/api>/);
});

test("local unpdf extraction accepts Gecko's bounded original-byte data URL", async () => {
  const pdf = makePdf("WildBuzzard PDF extraction");
  const result = await extractPdfDataUrl(
    `data:application/pdf;base64,${pdf.toString("base64")}`
  );
  assert.equal(result.pages, 1);
  assert.match(result.content, /WildBuzzard PDF extraction/);
  await assert.rejects(
    extractPdfDataUrl("data:application/pdf;base64,bm90IGEgcGRm"),
    /invalid PDF payload/
  );
});
