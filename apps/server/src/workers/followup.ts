// Follow-up sweep worker (FR-10/FR-11). Finds quiet applications (submitted ≥
// followupAfterDays ago, no inbound reply, fewer than maxFollowups drafted) and
// creates an approval-gated outbox draft (nothing ever sends without approval).
//
// Drafting goes through AgentRunner in the application's own voice: the
// archived cover letter (documents/applications/<c>_<r>/cover_letter.md) is the
// voice reference, 60–120 words, and the no-dashes ghostwriting rule applies
// (stripDashes as the belt-and-suspenders pass). If the agent reply is
// unusable, a plain template keeps the sweep working.
import fs from 'node:fs';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { applications, emails, followups, jobs } from '../db/schema';
import { toEmail } from '../db/serialize';
import { readRepoFile, stripDashes, strictJsonFooter } from '../agent/prompts';
import type { Worker, WorkerArgs } from './registry';
import type { AppContext } from '../context';

type AppRow = typeof applications.$inferSelect;
type JobRow = typeof jobs.$inferSelect;

const draftSchema = z.object({
  subject: z.string().min(1),
  body: z.string().min(1),
});

function fallbackDraft(job: JobRow, app: AppRow): { subject: string; body: string } {
  return {
    subject: `Following up: ${job.title} application`,
    body: [
      `Hi ${job.company} team,`,
      '',
      `I applied for the ${job.title} position on ${(app.submittedAt ?? '').slice(0, 10)} and wanted to follow up. ` +
        'I remain very interested in the role and would welcome the chance to talk about how I can contribute.',
      '',
      'Thank you for your time and consideration.',
    ].join('\n'),
  };
}

async function draftFollowup(
  ctx: AppContext,
  job: JobRow,
  app: AppRow,
  followupNumber: number,
): Promise<{ subject: string; body: string }> {
  if (ctx.simulate) return fallbackDraft(job, app);

  let letterVoice = '';
  if (app.archiveDir) {
    const md = path.join(ctx.repoRoot, app.archiveDir, 'cover_letter.md');
    try {
      if (fs.existsSync(md)) letterVoice = fs.readFileSync(md, 'utf8').slice(0, 6000);
    } catch {
      /* optional */
    }
  }
  const style = readRepoFile(ctx.repoRoot, '.claude/skills/job-application-assistant/03-writing-style.md', 8000);

  try {
    const result = await ctx.runner.run({
      prompt: [
        'Draft a short follow-up email for a job application, in the candidate\'s',
        'own voice (ghostwritten — first person).',
        '',
        'HARD RULES:',
        '- 60 to 120 words in the body. No more.',
        '- No em dashes, no en dashes, no hyphen-style asides (use commas,',
        '  parentheses, semicolons, or separate sentences).',
        '- Polite, specific, confident; no clichés ("hit the ground running"), no',
        '  new factual claims that are not in the cover letter below.',
        `- This is follow-up #${followupNumber} for this application${followupNumber > 1 ? ' (acknowledge the earlier note briefly, without pressure)' : ''}.`,
        '',
        `Application: ${job.title} at ${job.company}, submitted ${(app.submittedAt ?? '').slice(0, 10)}. No reply so far.`,
        '',
        '## Voice reference — the cover letter this application was sent with',
        letterVoice || '(no archived letter — use the style guide below)',
        '',
        '## Style guide',
        style || '(none)',
        strictJsonFooter('{ "subject": string, "body": string (the email body, 60-120 words) }'),
      ].join('\n'),
      cwd: ctx.repoRoot,
      model: ctx.settings.get().modelFollowup,
      timeoutMs: ctx.config.agent.defaultTimeoutMs,
    });
    const parsed = draftSchema.safeParse(result.structured);
    if (!parsed.success) return fallbackDraft(job, app);
    const body = stripDashes(parsed.data.body).trim();
    const words = body.split(/\s+/).filter(Boolean).length;
    if (words < 30 || words > 160) return fallbackDraft(job, app); // out-of-band → safe template
    return { subject: stripDashes(parsed.data.subject).trim(), body };
  } catch {
    return fallbackDraft(job, app);
  }
}

export const followupWorker: Worker = {
  type: 'followup',
  async run({ ctx }: WorkerArgs): Promise<void> {
    const settings = ctx.settings.get();
    const cutoff = new Date(Date.now() - settings.followupAfterDays * 86400000).toISOString();

    const candidates = ctx.db
      .select({ app: applications, job: jobs })
      .from(applications)
      .innerJoin(jobs, eq(jobs.id, applications.jobId))
      .where(and(eq(applications.status, 'applied')))
      .all();

    for (const { app, job } of candidates) {
      if (!app.submittedAt || app.submittedAt > cutoff) continue;

      // Skip if the employer already replied.
      const inbound = ctx.db
        .select({ n: sql<number>`count(*)` })
        .from(emails)
        .where(and(eq(emails.applicationId, app.id), eq(emails.direction, 'inbound')))
        .get();
      if ((inbound?.n ?? 0) > 0) continue;

      // Cap: at most maxFollowups drafted per application (PRD: max 2).
      const drafted = ctx.db
        .select({ n: sql<number>`count(*)` })
        .from(followups)
        .where(and(eq(followups.applicationId, app.id), eq(followups.status, 'drafted')))
        .get();
      if ((drafted?.n ?? 0) >= settings.maxFollowups) continue;

      // Only one open (unapproved) draft at a time.
      const openDraft = ctx.db
        .select({ n: sql<number>`count(*)` })
        .from(emails)
        .where(and(eq(emails.applicationId, app.id), eq(emails.needsApproval, 1)))
        .get();
      if ((openDraft?.n ?? 0) > 0) continue;

      const followupNumber = (drafted?.n ?? 0) + 1;
      const draft = await draftFollowup(ctx, job, app, followupNumber);

      ctx.db
        .insert(followups)
        .values({
          applicationId: app.id,
          dueAt: new Date().toISOString(),
          draftMd: draft.body,
          status: 'drafted',
        })
        .run();
      const outbox = ctx.db
        .insert(emails)
        .values({
          threadKey: `followup-app-${app.id}-${followupNumber}`,
          direction: 'outbound',
          classification: 'followup',
          applicationId: app.id,
          subject: draft.subject,
          summary: `Follow-up #${followupNumber} draft for ${job.company} — awaiting your approval`,
          bodyMd: draft.body,
          needsApproval: 1,
        })
        .returning()
        .get();
      ctx.bus.emit({ type: 'outbox.updated', email: toEmail(outbox) });
    }
  },
};
