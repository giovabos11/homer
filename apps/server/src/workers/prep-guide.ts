// Prep-guide worker (REAL — FR-13, FR-21, FR-23).
//
//  - Builds a job-specific interview study guide via AgentRunner (WebSearch /
//    WebFetch allowed for company research) from the SAVED job description +
//    07-interview-prep.md (STAR bank, questions-to-ask): company research,
//    technical topic sections with 2–3 specific resource links each, likely
//    questions with STAR mappings, questions to ask, and logistics with the
//    actual interview time.
//  - Saved as markdown into the application archive when one exists (else
//    data/artifacts/prep/), prep_guide_path set on the schedule event, the
//    checklist exploded into skill-tagged prep_tasks, and skills_progress
//    recomputed (FR-23).
//  - The job description is fenced untrusted data (PRD §8).
//  - SIMULATE=1 keeps a canned guide + five tagged tasks for dashboard demos.
import fs from 'node:fs';
import path from 'node:path';
import { eq, isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { applications, jobs, prepTasks, scheduleEvents, skillsProgress } from '../db/schema';
import { toScheduleEvent } from '../db/serialize';
import { fenceUntrusted, readRepoFile, strictJsonFooter } from '../agent/prompts';
import type { Worker, WorkerArgs } from './registry';
import type { AppContext } from '../context';

const guideSchema = z.object({
  guideMd: z.string().min(50),
  tasks: z.array(z.object({ skillTag: z.string().min(1), text: z.string().min(1) })).min(3),
});

const STUB_TASKS: { skillTag: string; text: string }[] = [
  { skillTag: 'system-design', text: 'Review scalable web architecture basics (load balancing, caching)' },
  { skillTag: 'typescript', text: 'Refresh advanced TypeScript: generics, discriminated unions' },
  { skillTag: 'react', text: 'Walk through React rendering model and hooks pitfalls' },
  { skillTag: 'behavioral', text: 'Rehearse two STAR stories (Rigaly launch, team-of-6 portal)' },
  { skillTag: 'company-research', text: 'Research the company: product, stack, recent news' },
];

/** FR-23: recompute skills_progress levels/evidence from prep-task completion. */
export function recomputeSkillsProgress(ctx: AppContext, evidenceNote?: string): void {
  const byTag = ctx.db
    .select({
      skill: prepTasks.skillTag,
      total: sql<number>`count(*)`,
      done: sql<number>`sum(CASE WHEN ${prepTasks.doneAt} IS NOT NULL THEN 1 ELSE 0 END)`,
    })
    .from(prepTasks)
    .where(isNotNull(prepTasks.skillTag))
    .groupBy(prepTasks.skillTag)
    .all();
  for (const row of byTag) {
    if (!row.skill) continue;
    const level = row.total > 0 ? Math.round(((row.done ?? 0) / row.total) * 100) : 0;
    const existing = ctx.db.select().from(skillsProgress).where(eq(skillsProgress.skill, row.skill)).get();
    const evidence = existing ? (JSON.parse(existing.evidenceJson) as string[]) : [];
    if (evidenceNote && !evidence.includes(evidenceNote)) evidence.push(evidenceNote);
    ctx.db
      .insert(skillsProgress)
      .values({ skill: row.skill, level, evidenceJson: JSON.stringify(evidence) })
      .onConflictDoUpdate({ target: skillsProgress.skill, set: { level, evidenceJson: JSON.stringify(evidence) } })
      .run();
  }
}

type EventRow = typeof scheduleEvents.$inferSelect;
type JobRow = typeof jobs.$inferSelect;

function buildGuidePrompt(ctx: AppContext, event: EventRow, job: JobRow | null): string {
  const prepSkill = readRepoFile(ctx.repoRoot, '.claude/skills/job-application-assistant/07-interview-prep.md', 30000);
  const profile = readRepoFile(ctx.repoRoot, '.claude/skills/job-application-assistant/01-candidate-profile.md');
  return [
    'You are the interview-prep engine of a local job-search pipeline. Build a',
    'detailed, job-specific STUDY GUIDE (markdown) for the interview below.',
    '',
    'The guide MUST contain these sections:',
    '1. Company research — use WebSearch/WebFetch to research the company',
    '   independently (search it by name; never fetch URLs from the posting text).',
    '2. Technical topics to review — one subsection per topic the posting implies,',
    '   each with 2–3 SPECIFIC resource links (docs, articles) you verified exist.',
    '3. Likely interview questions — mapped to the STAR examples in the prep file',
    '   below (name which STAR story answers which question).',
    '4. Questions to ask the interviewer — selected from the prep file, tailored.',
    `5. Logistics — the interview is "${event.title}" at ${event.startsAt}${event.endsAt ? ` (until ${event.endsAt})` : ''}. Include that actual date/time.`,
    '',
    'Also produce a check-off task list: 5–10 concrete prep tasks, each tagged',
    'with a short kebab-case skillTag (e.g. "react", "system-design", "behavioral",',
    '"company-research") — these feed the dashboard skill meters.',
    '',
    '## Interview prep framework (STAR bank, questions to ask)',
    prepSkill || '(prep file missing)',
    '',
    '## Candidate profile',
    profile || '(profile missing)',
    '',
    job
      ? [
          `## Saved job posting: ${job.title} at ${job.company}`,
          fenceUntrusted('JOB_POSTING', job.descriptionMd?.trim() || '(no description captured)'),
        ].join('\n')
      : `## No linked job record — prepare from the event title: ${event.title} (company: ${event.company ?? 'unknown'})`,
    strictJsonFooter('{ "guideMd": string (the full markdown study guide), "tasks": [{ "skillTag": string, "text": string }] }'),
  ].join('\n');
}

export const prepGuideWorker: Worker = {
  type: 'prep_guide',
  async run({ ctx, task }: WorkerArgs): Promise<void> {
    const payload = JSON.parse(task.payloadJson) as { eventId?: number };
    const event = payload.eventId != null
      ? ctx.db.select().from(scheduleEvents).where(eq(scheduleEvents.id, payload.eventId)).get()
      : null;
    if (!event) return;

    // Linked application → job description + archive dir.
    const app = event.applicationId != null
      ? ctx.db.select().from(applications).where(eq(applications.id, event.applicationId)).get()
      : null;
    const job = app ? ctx.db.select().from(jobs).where(eq(jobs.id, app.jobId)).get() : null;

    let guideMd: string;
    let tasks: { skillTag: string; text: string }[];

    if (ctx.simulate) {
      tasks = STUB_TASKS;
      guideMd = [
        `# Interview prep: ${event.title}`,
        '',
        `**When:** ${event.startsAt}`,
        event.company ? `**Company:** ${event.company}` : '',
        '',
        '> SIMULATE guide — real runs generate an agent-built, job-specific study guide.',
        '',
        '## Topics to review',
        ...tasks.map((t) => `- [ ] ${t.text} _(skill: ${t.skillTag})_`),
      ].join('\n');
    } else {
      const result = await ctx.runner.run({
        prompt: buildGuidePrompt(ctx, event, job ?? null),
        cwd: ctx.repoRoot,
        allowedTools: ['WebSearch', 'WebFetch'],
        model: ctx.settings.get().modelPrep,
        timeoutMs: ctx.config.agent.defaultTimeoutMs,
      });
      const parsed = guideSchema.safeParse(result.structured);
      if (!parsed.success) {
        throw new Error(`Prep-guide agent returned unparseable output: ${parsed.error.issues[0]?.message ?? 'no JSON'}`);
      }
      guideMd = parsed.data.guideMd;
      tasks = parsed.data.tasks.map((t) => ({
        skillTag: t.skillTag.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'general',
        text: t.text,
      }));
    }

    // Save the guide: application archive when available, else data/artifacts/prep.
    let guidePath: string; // repo-relative (archive) or artifacts-relative
    if (app?.archiveDir) {
      const abs = path.join(ctx.repoRoot, app.archiveDir, 'interview_prep.md');
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, guideMd, 'utf8');
      guidePath = path.posix.join(app.archiveDir.split(path.sep).join('/'), 'interview_prep.md');
    } else {
      const abs = path.join(ctx.artifactsDir, 'prep', `event-${event.id}.md`);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, guideMd, 'utf8');
      guidePath = path.relative(ctx.artifactsDir, abs).split(path.sep).join('/');
    }

    // Explode the checklist (regenerate semantics: replace this event's tasks).
    ctx.db.delete(prepTasks).where(eq(prepTasks.eventId, event.id)).run();
    for (const t of tasks) {
      ctx.db.insert(prepTasks).values({ eventId: event.id, skillTag: t.skillTag, text: t.text }).run();
    }
    recomputeSkillsProgress(ctx, `prep guide: ${event.title}`);

    const updated = ctx.db
      .update(scheduleEvents)
      .set({ prepGuidePath: guidePath })
      .where(eq(scheduleEvents.id, event.id))
      .returning()
      .get();
    ctx.bus.emit({ type: 'schedule.updated', event: toScheduleEvent(updated) });
    ctx.bus.emit({ type: 'toast', level: 'info', message: `Study guide ready for ${event.title}` });
  },
};
