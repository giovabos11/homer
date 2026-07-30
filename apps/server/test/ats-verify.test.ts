// ATS text-layer verification (FR-9/D3): name/email/phone must survive as
// literal text and ≥70% of the drafted keywords must be present in the PDF.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, describe, expect, it } from 'vitest';
import { countPdfPages, verifyAtsPdf } from '../src/docs/render';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ajs-ats-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

async function writePdf(file: string, lines: string[]): Promise<string> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  lines.forEach((line, i) => page.drawText(line, { x: 40, y: 740 - i * 16, size: 10, font }));
  const out = path.join(dir, file);
  fs.writeFileSync(out, await doc.save());
  return out;
}

const who = { name: 'Test Candidate', email: 'test.candidate@example.com', phone: '+1 555-010-0000' };

describe('verifyAtsPdf', () => {
  it('passes when name, email, phone, and enough keywords are in the text layer', async () => {
    const pdf = await writePdf('good.pdf', [
      'Test Candidate',
      'test.candidate@example.com | +1 555-010-0000 | Dallas, TX',
      'Skills: TypeScript, React, Node.js, SQL, Express',
    ]);
    const result = await verifyAtsPdf(pdf, { ...who, keywords: ['TypeScript', 'React', 'Node.js', 'SQL'] });
    expect(result.ok).toBe(true);
    expect(result.namePresent).toBe(true);
    expect(result.emailPresent).toBe(true);
    expect(result.phonePresent).toBe(true);
    expect(result.keywordCoverage).toBe(1);
    expect(await countPdfPages(pdf)).toBe(1);
  });

  it('fails when the email is missing from the text layer', async () => {
    const pdf = await writePdf('no-email.pdf', ['Test Candidate', '+1 555-010-0000', 'TypeScript React']);
    const result = await verifyAtsPdf(pdf, { ...who, keywords: ['TypeScript'] });
    expect(result.ok).toBe(false);
    expect(result.emailPresent).toBe(false);
    expect(result.problems.some((p) => p.includes('email'))).toBe(true);
  });

  it('fails below the 70% keyword-survival threshold and lists the missing keywords', async () => {
    const pdf = await writePdf('half.pdf', [
      'Test Candidate',
      'test.candidate@example.com +1 555-010-0000',
      'TypeScript and React only.',
    ]);
    const result = await verifyAtsPdf(pdf, { ...who, keywords: ['TypeScript', 'React', 'GraphQL', 'Kubernetes'] });
    expect(result.keywordCoverage).toBe(0.5);
    expect(result.ok).toBe(false);
    expect(result.missingKeywords.sort()).toEqual(['GraphQL', 'Kubernetes']);
  });

  it('phone matches on digits regardless of formatting', async () => {
    const pdf = await writePdf('digits.pdf', [
      'Test Candidate',
      'test.candidate@example.com',
      'Phone: (555) 010 0000 +1',
    ]);
    // Digits appear as 1 … 5550100000? Different order — must NOT match.
    const strict = await verifyAtsPdf(pdf, { ...who, keywords: [] });
    expect(strict.phonePresent).toBe(false);

    const pdf2 = await writePdf('digits2.pdf', [
      'Test Candidate',
      'test.candidate@example.com',
      'Phone: +1 (555) 010-0000',
    ]);
    const ok = await verifyAtsPdf(pdf2, { ...who, keywords: [] });
    expect(ok.phonePresent).toBe(true);
  });
});
