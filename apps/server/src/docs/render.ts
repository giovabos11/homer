// HTML → PDF rendering seam (PRD D3). The default renderer drives headless
// Chromium via the playwright npm package; tests inject a mock. Page counting
// uses pdf-lib; ATS verification extracts the PDF text layer with pdf-parse.
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { PDFParse } from 'pdf-parse';

export interface PdfRenderer {
  /** Render an HTML document to a PDF file at outPath. */
  render(html: string, outPath: string): Promise<void>;
  dispose(): Promise<void>;
}

type PlaywrightBrowser = import('playwright').Browser;

/** Real renderer: headless Chromium page.pdf() honoring the template's @page CSS. */
export class PlaywrightPdfRenderer implements PdfRenderer {
  private browserPromise: Promise<PlaywrightBrowser> | null = null;

  private async browser(): Promise<PlaywrightBrowser> {
    if (!this.browserPromise) {
      this.browserPromise = import('playwright').then(({ chromium }) => chromium.launch({ headless: true }));
    }
    return this.browserPromise;
  }

  async render(html: string, outPath: string): Promise<void> {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const browser = await this.browser();
    const page = await browser.newPage();
    try {
      await page.setContent(html, { waitUntil: 'load' });
      await page.pdf({ path: outPath, preferCSSPageSize: true, printBackground: true });
    } finally {
      await page.close();
    }
  }

  async dispose(): Promise<void> {
    if (this.browserPromise) {
      const browser = await this.browserPromise.catch(() => null);
      this.browserPromise = null;
      await browser?.close().catch(() => undefined);
    }
  }
}

export async function countPdfPages(pdfPath: string): Promise<number> {
  const bytes = fs.readFileSync(pdfPath);
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return doc.getPageCount();
}

export async function extractPdfText(pdfPath: string): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(fs.readFileSync(pdfPath)) });
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy?.().catch(() => undefined);
  }
}

export interface AtsVerifyInput {
  name: string;
  email: string;
  phone: string;
  keywords: string[];
  /** Minimum surviving keyword fraction (default 0.7). */
  keywordThreshold?: number;
}

export interface AtsVerifyResult {
  ok: boolean;
  namePresent: boolean;
  emailPresent: boolean;
  phonePresent: boolean;
  keywordCoverage: number; // 0..1 (1 when no keywords supplied)
  missingKeywords: string[];
  problems: string[];
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ');
}

function digitsOnly(text: string): string {
  return text.replace(/\D/g, '');
}

/**
 * ATS check (FR-9/D3): what a parser sees is the PDF text layer, not the
 * rendered page. Name, email, and phone must survive as literal text and at
 * least `keywordThreshold` of the drafted keywords must be present.
 */
export async function verifyAtsPdf(pdfPath: string, input: AtsVerifyInput): Promise<AtsVerifyResult> {
  const raw = await extractPdfText(pdfPath);
  const text = normalize(raw);
  const problems: string[] = [];

  const namePresent = normalize(input.name)
    .split(' ')
    .filter(Boolean)
    .every((part) => text.includes(part));
  if (!namePresent) problems.push(`name "${input.name}" not found in text layer`);

  const emailPresent = text.includes(input.email.toLowerCase());
  if (!emailPresent) problems.push(`email ${input.email} not found in text layer`);

  const phoneDigits = digitsOnly(input.phone);
  const phonePresent = phoneDigits.length > 0 && digitsOnly(raw).includes(phoneDigits);
  if (!phonePresent) problems.push(`phone ${input.phone} not found in text layer`);

  const missingKeywords = input.keywords.filter((k) => !text.includes(k.toLowerCase()));
  const keywordCoverage = input.keywords.length === 0 ? 1 : (input.keywords.length - missingKeywords.length) / input.keywords.length;
  const threshold = input.keywordThreshold ?? 0.7;
  if (keywordCoverage < threshold) {
    problems.push(`keyword coverage ${(keywordCoverage * 100).toFixed(0)}% below ${(threshold * 100).toFixed(0)}% (missing: ${missingKeywords.join(', ')})`);
  }

  return {
    ok: namePresent && emailPresent && phonePresent && keywordCoverage >= threshold,
    namePresent,
    emailPresent,
    phonePresent,
    keywordCoverage,
    missingKeywords,
    problems,
  };
}
