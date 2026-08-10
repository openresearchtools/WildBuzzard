/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { extractText } from "unpdf";

const PREFIX = "data:application/pdf;base64,";
const MAX_PDF_BYTES = 1_600_000;
const MAX_TEXT = 2_000_000;

export async function extractPdfDataUrl(content: string): Promise<{
  content: string;
  pages: number;
}> {
  if (!content.startsWith(PREFIX)) {
    throw new Error("Gecko returned an invalid PDF payload");
  }
  const encoded = content.slice(PREFIX.length);
  if (!encoded || encoded.length > Math.ceil(MAX_PDF_BYTES / 3) * 4) {
    throw new Error("PDF payload exceeds the extraction limit");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length > MAX_PDF_BYTES || bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error("Gecko returned an invalid PDF payload");
  }
  const result = await extractText(new Uint8Array(bytes), { mergePages: true });
  return {
    content: result.text.replace(/\u0000/g, "").trim().slice(0, MAX_TEXT),
    pages: result.totalPages,
  };
}
