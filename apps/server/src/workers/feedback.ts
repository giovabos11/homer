// Feedback worker (REAL — FR-26, FR-27).
//
//  - Free-text feedback (idea / concern / comment / update / retro) is analyzed
//    by AgentRunner with career context (CLAUDE.md) + the current settings.
//  - Config-change intents produce a planChange { description, settingsPatch }
//    that is applied only on user approval via POST /api/feedback/:id/apply-plan.
//  - retro entries additionally feed the recalibration loop: lessons are
//    appended to 07-interview-prep.md inside a guarded marker block
//    (RETRO-LESSONS) — never touching the rest of the file.
//  - SIMULATE / MockRunner still flows through the same path (the mock's reply
//    simply produces no plan change unless scripted).
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { feedback } from '../db/schema';
import { readRepoFile, strictJsonFooter } from '../agent/prompts';
import type { Worker, WorkerArgs } from './registry';
import type { AppContext } from '../context';

const RETRO_BEGIN = '<!-- RETRO-LESSONS:BEGIN (auto-managed by the feedback worker — edits outside this block are never touched) -->';
const RETRO_END = '<!-- RETRO-LESSONS:END -->';

const feedbackResultSchema = z.object({
  response: z.string().min(1),
  planChange: z
    .object({
      description: z.string().min(1),
      settingsPatch: z.record(z.string(), z.unknown()).nullish(),
    })
    .nullish(),
  retroLessons: z.array(z.string()).default([]),
});

/** Append retro lessons inside the guarded block of 07-interview-prep.md. */
export function appendRetroLessons(repoRoot: string, lessons: string[]): boolean {
  if (lessons.length === 0) return false;
  const file = path.join(repoRoot, '.claude', 'skills', 'job-application-assistant', '07-interview-prep.md');
  if (!fs.existsSync(file)) return false;
  let md = fs.readFileSync(file, 'utf8');
  const stamp = new Date().toISOString().slice(0, 10);
  const entries = lessons.map((l) => `- ${stamp}: ${l.replace(/\r?\n/g, ' ').trim()}`).join('\n');
  if (!md.includes(RETRO_BEGIN)) {
    md = `${md.trimEnd()}\n\n## Lessons from Post-Interview Retros\n\n${RETRO_BEGIN}\n${entries}\n${RETRO_END}\n`;
  } else {
    md = md.replace(RETRO_END, `${entries}\n${RETRO_END}`);
  }
  fs.writeFileSync(file, md, 'utf8');
  return true;
}

function buildPrompt(ctx: AppContext, kind: string, inputMd: string): string {
  const claudeMd = readRepoFile(ctx.repoRoot, 'CLAUDE.md', 12000);
  const settings = ctx.settings.get();
  return [
    `You are the feedback analyst of a local job-search automation platform. The`,
    `user left "${kind}" feedback. Respond helpfully and concretely (markdown).`,
    '',
    'If (and only if) the feedback asks for a behavior/configuration change the',
    'platform supports, propose a planChange with a settingsPatch limited to these',
    'settings keys (current values shown):',
    JSON.stringify(settings, null, 2),
    'Valid keys: gateMode (review|auto|hybrid), hybridThreshold (0-100),',
    'discoveryIntervalMinutes (15-1440), emailScanIntervalMinutes (15-1440),',
    'country (ISO-2), applyDriver (playwright|chrome), perSourceGates,',
    'followupAfterDays (1-60), maxFollowups (0-10).',
    'The patch is applied ONLY after the user approves it on the dashboard.',
    '',
    kind === 'retro'
      ? 'This is a POST-INTERVIEW RETRO: also distill 1-3 short, reusable lessons\n(retroLessons) for future interview prep.'
      : '',
    '## Career context (CLAUDE.md excerpt)',
    claudeMd || '(none)',
    '',
    '## User feedback',
    inputMd,
    strictJsonFooter(
      '{ "response": string (markdown),' +
        ' "planChange": { "description": string, "settingsPatch": object? }?,' +
        ' "retroLessons": string[] }',
    ),
  ].join('\n');
}

export const feedbackWorker: Worker = {
  type: 'feedback',
  async run({ ctx, task }: WorkerArgs): Promise<void> {
    const payload = JSON.parse(task.payloadJson) as { feedbackId?: number };
    const entry = payload.feedbackId != null
      ? ctx.db.select().from(feedback).where(eq(feedback.id, payload.feedbackId)).get()
      : null;
    if (!entry) return;

    const result = await ctx.runner.run({
      prompt: buildPrompt(ctx, entry.kind, entry.inputMd),
      cwd: ctx.repoRoot,
      timeoutMs: ctx.config.agent.defaultTimeoutMs,
    });

    const parsed = feedbackResultSchema.safeParse(result.structured);
    const responseMd = parsed.success ? parsed.data.response : result.text || '(no response)';
    const planChange = parsed.success && parsed.data.planChange
      ? {
          description: parsed.data.planChange.description,
          applied: false,
          ...(parsed.data.planChange.settingsPatch ? { settingsPatch: parsed.data.planChange.settingsPatch } : {}),
        }
      : null;

    // Retro recalibration: guarded append to 07-interview-prep.md (FR-27).
    if (entry.kind === 'retro' && parsed.success && parsed.data.retroLessons.length > 0 && !ctx.simulate) {
      const written = appendRetroLessons(ctx.repoRoot, parsed.data.retroLessons);
      if (written) {
        ctx.bus.emit({
          type: 'toast',
          level: 'info',
          message: `Retro recorded: ${parsed.data.retroLessons.length} lesson(s) added to the interview-prep playbook`,
        });
      }
    }

    ctx.db
      .update(feedback)
      .set({ responseMd, planChangeJson: planChange ? JSON.stringify(planChange) : null })
      .where(eq(feedback.id, entry.id))
      .run();
    // NOTE: SseEvent has no feedback.updated variant (contract gap) — a toast
    // nudges the dashboard to refetch.
    ctx.bus.emit({ type: 'toast', level: 'info', message: `Feedback #${entry.id} analyzed — response ready` });
  },
};
