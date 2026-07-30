// Shared helpers for workers: job/application CRUD with SSE emission, audit
// trail entries, and placeholder artifact generation for SIMULATE demos.
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { applications, jobs } from '../db/schema';
import { toApplication, toJob } from '../db/serialize';
import type { AppContext } from '../context';

export type JobRow = typeof jobs.$inferSelect;
export type ApplicationRow = typeof applications.$inferSelect;

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function getJob(ctx: AppContext, id: number): JobRow | null {
  return ctx.db.select().from(jobs).where(eq(jobs.id, id)).get() ?? null;
}

export function updateJob(ctx: AppContext, id: number, patch: Partial<JobRow>, emit: 'job.discovered' | 'job.scored' | null = null): JobRow {
  const row = ctx.db.update(jobs).set(patch).where(eq(jobs.id, id)).returning().get();
  if (emit) ctx.bus.emit({ type: emit, job: toJob(row) });
  return row;
}

export function getApplication(ctx: AppContext, id: number): ApplicationRow | null {
  return ctx.db.select().from(applications).where(eq(applications.id, id)).get() ?? null;
}

export function emitApplication(ctx: AppContext, row: ApplicationRow): void {
  const job = getJob(ctx, row.jobId);
  ctx.bus.emit({ type: 'application.updated', application: toApplication(row, job) });
}

export function updateApplication(ctx: AppContext, id: number, patch: Partial<ApplicationRow>, emit = true): ApplicationRow {
  const row = ctx.db
    .update(applications)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(eq(applications.id, id))
    .returning()
    .get();
  if (emit) emitApplication(ctx, row);
  return row;
}

/** Find or create the application record for a job (status starts at tailoring). */
export function ensureApplication(ctx: AppContext, jobId: number, gate: string): ApplicationRow {
  const existing = ctx.db.select().from(applications).where(eq(applications.jobId, jobId)).get();
  if (existing) return existing;
  const now = new Date().toISOString();
  const row = ctx.db
    .insert(applications)
    .values({ jobId, status: 'tailoring', gate, createdAt: now, updatedAt: now })
    .returning()
    .get();
  emitApplication(ctx, row);
  return row;
}

/** Append an entry to the application's audit trail (PRD §8: every automated action is logged). */
export function addAudit(ctx: AppContext, applicationId: number, action: string, detail: Record<string, unknown> = {}): void {
  const row = getApplication(ctx, applicationId);
  if (!row) return;
  const audit = JSON.parse(row.auditJson) as unknown[];
  audit.push({ at: new Date().toISOString(), action, ...detail });
  ctx.db
    .update(applications)
    .set({ auditJson: JSON.stringify(audit), updatedAt: new Date().toISOString() })
    .where(eq(applications.id, applicationId))
    .run();
}

/** Write a tiny but valid one-page PDF placeholder (SIMULATE artifacts). */
export function writePlaceholderPdf(filePath: string, title: string): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const text = title.replace(/[()\\]/g, ' ');
  const content = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  fs.writeFileSync(filePath, pdf, 'latin1');
  return filePath;
}

/** Relative artifact path → /files URL. */
export function fileUrl(ctx: AppContext, absPath: string): string {
  const rel = path.relative(ctx.artifactsDir, absPath).split(path.sep).join('/');
  return `/files/${rel}`;
}
