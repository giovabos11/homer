// Tailored-document content model (FR-9, PRD D3). The drafter agent produces
// strict-JSON content blocks; this module validates them, renders them through
// the HTML templates, and enforces the 1-page limit with relevance-weighted
// trimming (lowest-relevance bullets dropped first).
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { countPdfPages, type PdfRenderer } from './render';
import { serverRoot } from '../util/paths';

// ---------- schemas (drafter/reviewer strict-JSON contract) ----------

const bulletSchema = z.object({
  text: z.string().min(1),
  /** 0–100 relevance to THIS posting; used by the 1-page trim loop. */
  relevance: z.number().min(0).max(100).default(50),
});

const experienceSchema = z.object({
  company: z.string().min(1),
  role: z.string().min(1),
  dates: z.string().default(''),
  location: z.string().default(''),
  bullets: z.array(bulletSchema).default([]),
});

const projectSchema = z.object({
  name: z.string().min(1),
  dates: z.string().default(''),
  bullets: z.array(bulletSchema).default([]),
});

const educationSchema = z.object({
  school: z.string().min(1),
  degree: z.string().min(1),
  dates: z.string().default(''),
  details: z.array(z.string()).default([]),
});

export const resumeContentSchema = z.object({
  summary: z.string().min(1),
  skills: z.array(z.object({ category: z.string().min(1), items: z.array(z.string().min(1)).min(1) })).default([]),
  experience: z.array(experienceSchema).min(1),
  projects: z.array(projectSchema).default([]),
  education: z.array(educationSchema).min(1),
});

export const coverLetterContentSchema = z.object({
  addressee: z.string().default('Dear Hiring Manager,'),
  paragraphs: z.array(z.string().min(1)).min(2),
  closing: z.string().default('I look forward to hearing from you.'),
});

export const tailorDraftSchema = z.object({
  resume: resumeContentSchema,
  coverLetter: coverLetterContentSchema,
  /** Posting keywords the draft intentionally covers (ATS verification set). */
  keywords: z.array(z.string().min(1)).default([]),
  /** Questions/claims only Giovanni can answer — surfaced, never invented. */
  flags: z.array(z.string()).default([]),
});

export type ResumeContent = z.infer<typeof resumeContentSchema>;
export type CoverLetterContent = z.infer<typeof coverLetterContentSchema>;
export type TailorDraft = z.infer<typeof tailorDraftSchema>;

export interface RenderIdentity {
  name: string;
  email: string;
  phone: string;
  location: string;
  links: { label: string; url: string }[];
}

// ---------- HTML rendering ----------

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function loadTemplate(name: 'resume.html' | 'cover-letter.html'): string {
  return fs.readFileSync(path.join(serverRoot(), 'templates', name), 'utf8');
}

function fillTemplate(template: string, slots: Record<string, string>): string {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key: string) => slots[key] ?? '');
}

function contactLine(id: RenderIdentity): string {
  const parts = [id.location, id.email, id.phone, ...id.links.map((l) => `${escapeHtml(l.url.replace(/^https?:\/\//, ''))}`)];
  return parts
    .filter(Boolean)
    .map((p) => `<span>${escapeHtml(p)}</span>`)
    .join('');
}

export function buildResumeHtml(id: RenderIdentity, content: ResumeContent): string {
  const sections: string[] = [];
  sections.push(`<section class="summary"><h2>Summary</h2><p>${escapeHtml(content.summary)}</p></section>`);

  if (content.skills.length > 0) {
    const rows = content.skills
      .map((s) => `<p class="skills-row"><span class="cat">${escapeHtml(s.category)}:</span> ${escapeHtml(s.items.join(', '))}</p>`)
      .join('');
    sections.push(`<section><h2>Skills</h2>${rows}</section>`);
  }

  const entryHtml = (title: string, sub: string, dates: string, bullets: { text: string }[]): string => {
    const lis = bullets.map((b) => `<li>${escapeHtml(b.text)}</li>`).join('');
    return `<div class="entry"><div class="entry-head"><span class="entry-title">${title}</span><span class="entry-dates">${escapeHtml(dates)}</span></div>${sub ? `<div class="entry-sub">${sub}</div>` : ''}${lis ? `<ul>${lis}</ul>` : ''}</div>`;
  };

  if (content.experience.length > 0) {
    const entries = content.experience
      .map((e) =>
        entryHtml(
          `${escapeHtml(e.role)} <span class="company">— ${escapeHtml(e.company)}</span>`,
          escapeHtml(e.location),
          e.dates,
          e.bullets,
        ),
      )
      .join('');
    sections.push(`<section><h2>Experience</h2>${entries}</section>`);
  }

  if (content.projects.length > 0) {
    const entries = content.projects.map((p) => entryHtml(escapeHtml(p.name), '', p.dates, p.bullets)).join('');
    sections.push(`<section><h2>Projects</h2>${entries}</section>`);
  }

  if (content.education.length > 0) {
    const entries = content.education
      .map((e) =>
        entryHtml(
          `${escapeHtml(e.degree)} <span class="company">— ${escapeHtml(e.school)}</span>`,
          '',
          e.dates,
          e.details.map((d) => ({ text: d })),
        ),
      )
      .join('');
    sections.push(`<section><h2>Education</h2>${entries}</section>`);
  }

  return fillTemplate(loadTemplate('resume.html'), {
    TITLE: `${id.name} — Resume`,
    NAME: escapeHtml(id.name),
    CONTACT: contactLine(id),
    BODY: sections.join('\n'),
  });
}

export function buildCoverLetterHtml(id: RenderIdentity, content: CoverLetterContent, date = new Date()): string {
  const body = content.paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('\n');
  return fillTemplate(loadTemplate('cover-letter.html'), {
    TITLE: `${id.name} — Cover Letter`,
    NAME: escapeHtml(id.name),
    CONTACT: contactLine(id),
    DATE: escapeHtml(date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })),
    ADDRESSEE: escapeHtml(content.addressee),
    BODY: body,
    CLOSING: escapeHtml(content.closing),
  });
}

// ---------- 1-page enforcement (relevance-weighted trimming) ----------

export interface TrimResult<T> {
  content: T;
  pages: number;
  dropped: string[];
}

/** Deep-clone helper (content is plain JSON). */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Drop the single lowest-relevance bullet across experience + projects.
 * Projects lose whole entries once they run out of bullets. Returns the
 * dropped bullet text, or null when nothing further can be dropped.
 */
export function dropLowestRelevanceBullet(content: ResumeContent): string | null {
  let lowest: { list: { text: string; relevance: number }[]; index: number } | null = null;
  const consider = (list: { text: string; relevance: number }[], minKeep: number) => {
    if (list.length <= minKeep) return;
    for (let i = 0; i < list.length; i += 1) {
      if (!lowest || list[i]!.relevance < lowest.list[lowest.index]!.relevance) {
        lowest = { list, index: i };
      }
    }
  };
  // Experience entries keep at least 1 bullet each; projects may go to zero.
  for (const e of content.experience) consider(e.bullets, 1);
  for (const p of content.projects) consider(p.bullets, 0);

  if (lowest) {
    const l = lowest as { list: { text: string; relevance: number }[]; index: number };
    const [removed] = l.list.splice(l.index, 1);
    // Remove now-empty projects entirely.
    content.projects = content.projects.filter((p) => p.bullets.length > 0);
    return removed?.text ?? null;
  }
  // Nothing bullet-shaped left: drop the last whole project, then education details.
  if (content.projects.length > 0) {
    const removed = content.projects.pop()!;
    return `project: ${removed.name}`;
  }
  for (const e of content.education) {
    if (e.details.length > 0) return `education detail: ${e.details.pop()!}`;
  }
  return null;
}

/**
 * Render the resume, then trim lowest-relevance bullets until it fits one page.
 * Throws when the content cannot be reduced to a single page.
 */
export async function renderResumeOnePage(
  renderer: PdfRenderer,
  id: RenderIdentity,
  content: ResumeContent,
  outPath: string,
  maxIterations = 30,
): Promise<TrimResult<ResumeContent>> {
  let current = clone(content);
  const dropped: string[] = [];
  for (let i = 0; i <= maxIterations; i += 1) {
    await renderer.render(buildResumeHtml(id, current), outPath);
    const pages = await countPdfPages(outPath);
    if (pages <= 1) return { content: current, pages, dropped };
    const removed = dropLowestRelevanceBullet(current);
    if (removed == null) {
      throw new Error(`Resume cannot be trimmed to one page (still ${pages} pages with minimal content)`);
    }
    dropped.push(removed);
  }
  throw new Error(`Resume 1-page trim did not converge after ${maxIterations} iterations`);
}

/**
 * Render the cover letter, dropping body paragraphs from the end (never the
 * opening or the final paragraph) until it fits one page.
 */
export async function renderCoverLetterOnePage(
  renderer: PdfRenderer,
  id: RenderIdentity,
  content: CoverLetterContent,
  outPath: string,
  maxIterations = 10,
): Promise<TrimResult<CoverLetterContent>> {
  let current = clone(content);
  const dropped: string[] = [];
  for (let i = 0; i <= maxIterations; i += 1) {
    await renderer.render(buildCoverLetterHtml(id, current), outPath);
    const pages = await countPdfPages(outPath);
    if (pages <= 1) return { content: current, pages, dropped };
    if (current.paragraphs.length <= 2) {
      throw new Error(`Cover letter cannot be trimmed to one page (still ${pages} pages with 2 paragraphs)`);
    }
    // Drop the second-to-last paragraph: openings and closings carry the frame.
    const [removed] = current.paragraphs.splice(current.paragraphs.length - 2, 1);
    dropped.push(removed ?? '');
  }
  throw new Error(`Cover letter 1-page trim did not converge after ${maxIterations} iterations`);
}
