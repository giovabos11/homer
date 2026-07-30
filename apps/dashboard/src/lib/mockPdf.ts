/**
 * Tiny runtime PDF builder for MOCK MODE ONLY.
 * Produces a valid single-page PDF (Helvetica, US Letter) as a data: URI so the
 * "Ready for review" resume / cover-letter previews are fully demoable without
 * the server's /files route. Offsets are computed, so the xref is always valid.
 */

function esc(s: string): string {
  return s
    .replace(/[^\x20-\x7e]/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

export interface MockPdfLine {
  text: string;
  bold?: boolean;
  size?: number;
  gapBefore?: number;
}

export function makeMockPdf(lines: MockPdfLine[]): string {
  let y = 736;
  const ops: string[] = [];
  for (const line of lines) {
    const size = line.size ?? 10.5;
    y -= (line.gapBefore ?? 0) + size * 1.45;
    if (y < 56) break;
    ops.push(`BT /${line.bold ? 'F1' : 'F2'} ${size} Tf 64 ${y.toFixed(1)} Td (${esc(line.text)}) Tj ET`);
  }
  // subtle header rule
  ops.push('0.65 0.65 0.62 RG 0.8 w 64 706 m 548 706 l S');
  const content = ops.join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`;

  return `data:application/pdf;base64,${btoa(pdf)}`;
}

export function mockResumePdf(company: string, role: string): string {
  return makeMockPdf([
    { text: 'GIOVANNI BOSCAN', bold: true, size: 22 },
    { text: 'Dallas, TX | giovabos11@gmail.com | (832) 970-9338 | gii.ooo', size: 9, gapBefore: 4 },
    { text: `Tailored for: ${role} at ${company}`, size: 9, gapBefore: 2 },
    { text: 'EXPERIENCE', bold: true, size: 12, gapBefore: 18 },
    { text: 'Rigaly - Founder & Full Stack Developer (Aug 2025 - Present)', bold: true, gapBefore: 6 },
    { text: 'Built a 5-app loyalty platform (React Native, Next.js 15, Express/TS) serving 10+' },
    { text: 'businesses and 500+ customers; CI/CD across Expo EAS, Vercel, and Render.' },
    { text: 'Integrated Stripe billing, 2FA auth (JWT + Supabase RLS), Apple/Google Wallet.' },
    { text: 'VIBE (The Social Panacea) - Full Stack Developer, Contract (Jan-May 2025)', bold: true, gapBefore: 8 },
    { text: 'Team-of-6 admin portal: React + Vite, TanStack, Tailwind, FastAPI, Firebase.' },
    { text: 'SMU Physics Dept - Undergraduate Research Assistant (May 2024 - May 2025)', bold: true, gapBefore: 8 },
    { text: 'Python instrumentation for 15,000 optical detectors bound for CERN LHC.' },
    { text: 'EDUCATION', bold: true, size: 12, gapBefore: 18 },
    { text: 'B.S. Computer Science, Southern Methodist University (May 2025)', bold: true, gapBefore: 6 },
    { text: 'GPA 3.983/4.0, Magna Cum Laude.' },
    { text: 'SKILLS', bold: true, size: 12, gapBefore: 18 },
    { text: 'TypeScript, React, React Native, Next.js, Node.js, Express, Python, C++,', gapBefore: 6 },
    { text: 'FastAPI, Supabase, Firebase, SQL, Stripe, AWS, Docker, CI/CD.' },
    { text: '[ MOCK PREVIEW - generated fixture, not a real tailored resume ]', size: 8, gapBefore: 24 },
  ]);
}

export function mockCoverLetterPdf(company: string, role: string): string {
  return makeMockPdf([
    { text: 'GIOVANNI BOSCAN', bold: true, size: 22 },
    { text: 'Dallas, TX | giovabos11@gmail.com | (832) 970-9338', size: 9, gapBefore: 4 },
    { text: 'Dear Hiring Manager,', gapBefore: 26 },
    { text: `I am excited to apply for the ${role} position at ${company}. As the founder of`, gapBefore: 10 },
    { text: 'Rigaly, a customer loyalty platform serving 10+ businesses and 500+ customers,' },
    { text: 'I have shipped production software end to end, from architecture and 2FA' },
    { text: 'authentication to Stripe billing, app store publishing, and live support.' },
    { text: 'My computer science degree from SMU (GPA 3.983, Magna Cum Laude) gave me a', gapBefore: 10 },
    { text: 'rigorous foundation in algorithms, databases, and design patterns, and my' },
    { text: 'contract work on a team of six taught me disciplined, Jira-driven collaboration.' },
    { text: 'I would welcome the chance to bring that builder mindset to your team. I am', gapBefore: 10 },
    { text: 'happy to speak by phone at (832) 970-9338 at your convenience.' },
    { text: 'Sincerely,', gapBefore: 18 },
    { text: 'Giovanni Boscan', bold: true, gapBefore: 6 },
    { text: '[ MOCK PREVIEW - generated fixture, not a real tailored letter ]', size: 8, gapBefore: 30 },
  ]);
}
