// Application archives (upstream layout, PRD §7 "files remain first-class"):
// documents/applications/<company>_<role>/ with job_posting.md, the tailored
// drafts, and an outcome.md skeleton the upstream /outcome + /gmail-sync
// commands can keep filling in.
import fs from 'node:fs';
import path from 'node:path';

/** "<Company>_<Role>" folder name — lowercase, underscores (upstream convention). */
export function archiveFolderName(company: string, role: string): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 60) || 'unknown';
  return `${slug(company)}_${slug(role)}`;
}

export interface ArchiveInput {
  company: string;
  role: string;
  postingMd: string | null;
  canonicalUrl: string;
  source: string;
  fitScore: number | null;
  coverLetterMd?: string;
  resumeMd?: string;
  resumePdfPath?: string;
  coverLetterPdfPath?: string;
}

/**
 * Create/refresh the archive folder. Returns the repo-relative archive dir
 * (forward slashes). outcome.md is only written when absent — it is the user's
 * permanent record and must never be clobbered.
 */
export function writeApplicationArchive(repoRoot: string, input: ArchiveInput): string {
  const rel = path.posix.join('documents', 'applications', archiveFolderName(input.company, input.role));
  const dir = path.join(repoRoot, rel);
  fs.mkdirSync(dir, { recursive: true });

  const posting = [
    `# ${input.role} — ${input.company}`,
    '',
    `- **Source:** ${input.source}`,
    `- **URL:** ${input.canonicalUrl || '(none)'}`,
    `- **Fit score:** ${input.fitScore ?? 'unscored'}`,
    `- **Archived:** ${new Date().toISOString()}`,
    '',
    '---',
    '',
    input.postingMd ?? '_No description captured._',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'job_posting.md'), posting, 'utf8');

  if (input.resumeMd) fs.writeFileSync(path.join(dir, 'resume_draft.md'), input.resumeMd, 'utf8');
  if (input.coverLetterMd) fs.writeFileSync(path.join(dir, 'cover_letter.md'), input.coverLetterMd, 'utf8');
  if (input.resumePdfPath && fs.existsSync(input.resumePdfPath)) {
    fs.copyFileSync(input.resumePdfPath, path.join(dir, 'resume.pdf'));
  }
  if (input.coverLetterPdfPath && fs.existsSync(input.coverLetterPdfPath)) {
    fs.copyFileSync(input.coverLetterPdfPath, path.join(dir, 'cover_letter.pdf'));
  }

  const outcomePath = path.join(dir, 'outcome.md');
  if (!fs.existsSync(outcomePath)) {
    fs.writeFileSync(
      outcomePath,
      [
        `# Outcome — ${input.role} at ${input.company}`,
        '',
        'Status: pending',
        'Date applied: ',
        'Date resolved: ',
        '',
        '## Stages',
        '- [ ] Application submitted',
        '- [ ] Recruiter screen',
        '- [ ] Technical interview',
        '- [ ] Onsite / final round',
        '- [ ] Offer received',
        '',
        '## Notes',
        '',
      ].join('\n'),
      'utf8',
    );
  }
  return rel;
}

/** Append a dated line to the archive's outcome.md Notes section (append-only). */
export function appendOutcomeNote(repoRoot: string, archiveRel: string, note: string): void {
  const outcomePath = path.join(repoRoot, archiveRel, 'outcome.md');
  if (!fs.existsSync(outcomePath)) return;
  fs.appendFileSync(outcomePath, `\n${new Date().toISOString().slice(0, 10)}: ${note}\n`, 'utf8');
}
