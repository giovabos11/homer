// FakeRenderer — deterministic PdfRenderer for tests. Strips the HTML to its
// text, then writes a REAL pdf-lib PDF whose page count is a pure function of
// the text length (charsPerPage). Because the text is actually drawn, pdf-lib
// page counting AND pdf-parse text extraction (ATS verify) work end to end
// without launching Chromium.
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { PdfRenderer } from '../src/docs/render';

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Helvetica is WinAnsi-encoded; replace anything outside printable Latin-1. */
function winAnsiSafe(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa1 && code <= 0xff)) out += ch;
    else if (code === 0x2014 || code === 0x2013) out += '-';
    else if (code === 0x2018 || code === 0x2019) out += "'";
    else if (code === 0x201c || code === 0x201d) out += '"';
    else if (code === 0x2022) out += '*';
    else out += '?';
  }
  return out;
}

export class FakeRenderer implements PdfRenderer {
  public renders = 0;

  constructor(private charsPerPage = 1800) {}

  async render(html: string, outPath: string): Promise<void> {
    this.renders += 1;
    const text = winAnsiSafe(htmlToText(html));
    const pages = Math.max(1, Math.ceil(text.length / this.charsPerPage));
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let p = 0; p < pages; p += 1) {
      const page = doc.addPage([612, 792]); // US letter
      const slice = text.slice(p * this.charsPerPage, (p + 1) * this.charsPerPage);
      // Draw in 90-char lines so every character lands in the text layer.
      let y = 760;
      for (let i = 0; i < slice.length && y > 24; i += 90) {
        page.drawText(slice.slice(i, i + 90), { x: 24, y, size: 8, font });
        y -= 12;
      }
    }
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, await doc.save());
  }

  async dispose(): Promise<void> {
    /* nothing to dispose */
  }
}
