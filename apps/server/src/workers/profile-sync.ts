// Profile-sync worker (REAL — FR-14).
//
//  - Triggered by the documents/ chokidar watcher (30 s debounce) or manually.
//  - Re-runs the upstream /setup Path A merge semantics through AgentRunner:
//    the agent READS the changed source documents and the current profile files
//    (CLAUDE.md + .claude/skills/job-application-assistant/01–08), applies
//    ADDITIVE changes itself (new skills, new roles, updated dates that extend
//    without contradicting), and reports CONFLICTING changes without applying
//    them. Conflicts land as a feedback entry with a proposed planChange that
//    waits for dashboard approval (POST /api/feedback/:id/apply-plan).
//  - Read-before-write is delegated to the agent's Edit tool semantics; the
//    worker itself never rewrites profile files.
//  - SIMULATE=1 keeps the freshness re-scan stub.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { feedback } from '../db/schema';
import { strictJsonFooter } from '../agent/prompts';
import type { Worker, WorkerArgs } from './registry';

const syncResultSchema = z.object({
  additiveApplied: z.array(z.object({ file: z.string(), summary: z.string() })).default([]),
  conflicts: z
    .array(
      z.object({
        file: z.string().default(''),
        description: z.string().min(1),
        proposal: z.string().default(''),
      }),
    )
    .default([]),
  notes: z.string().optional(),
});

export const profileSyncWorker: Worker = {
  type: 'profile_sync',
  async run({ ctx, task }: WorkerArgs): Promise<void> {
    const payload = JSON.parse(task.payloadJson) as { trigger?: string; changed?: string[] };

    if (ctx.simulate) {
      const docsDir = path.join(ctx.repoRoot, 'documents');
      let count = 0;
      if (fs.existsSync(docsDir)) {
        const stack = [docsDir];
        while (stack.length > 0) {
          const dir = stack.pop()!;
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) stack.push(full);
            else if (!entry.name.startsWith('.')) count += 1;
          }
        }
      }
      ctx.bus.emit({
        type: 'toast',
        level: 'info',
        message: `Profile sync (SIMULATE): ${count} document file(s) scanned`,
      });
      return;
    }

    const changed = payload.changed?.length ? payload.changed : ['documents/ (full re-scan)'];
    const prompt = [
      'You are the profile-sync step of a local job-search pipeline, applying the',
      '/setup "Path A" merge semantics after the personal source documents changed.',
      '',
      'Changed files:',
      ...changed.map((c) => `- ${c}`),
      '',
      'Procedure (READ BEFORE WRITE — always read a file before editing it):',
      '1. Read the changed documents under documents/ and the current profile:',
      '   CLAUDE.md (Candidate Profile section) and',
      '   .claude/skills/job-application-assistant/01-candidate-profile.md,',
      '   02-behavioral-profile.md, 04-job-evaluation.md, 07-interview-prep.md,',
      '   08-application-forms.md.',
      '2. Classify every difference:',
      '   - ADDITIVE: new information that extends the profile without contradicting',
      '     it (a new skill, a new role, an added certification, an extended date',
      '     range). APPLY these yourself with minimal, surgical edits that keep the',
      '     existing structure and personalization comments.',
      '   - CONFLICTING: the documents contradict the current profile (different',
      '     dates, changed titles, removed experience, changed contact info).',
      '     DO NOT apply these — report them for user confirmation.',
      '3. Never invent facts not present in the documents; never delete profile',
      '   content on your own initiative.',
      strictJsonFooter(
        '{ "additiveApplied": [{ "file": string, "summary": string }],' +
          ' "conflicts": [{ "file": string, "description": string, "proposal": string }], "notes": string? }',
      ),
    ].join('\n');

    const result = await ctx.runner.run({
      prompt,
      cwd: ctx.repoRoot,
      allowedTools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'],
      timeoutMs: ctx.config.agent.defaultTimeoutMs,
    });
    const parsed = syncResultSchema.safeParse(result.structured);
    if (!parsed.success) {
      throw new Error(`Profile-sync agent returned unparseable output: ${parsed.error.issues[0]?.message ?? 'no JSON'}`);
    }
    const { additiveApplied, conflicts } = parsed.data;

    // Conflicting changes wait for dashboard approval (FR-14/FR-26 plumbing).
    if (conflicts.length > 0) {
      const lines = conflicts.map((c) => `- **${c.file || 'profile'}**: ${c.description}${c.proposal ? `\n  Proposed: ${c.proposal}` : ''}`);
      ctx.db
        .insert(feedback)
        .values({
          kind: 'update',
          inputMd: `Profile sync detected ${conflicts.length} conflicting change(s) in: ${changed.join(', ')}`,
          responseMd: ['The following changes contradict the current profile and were NOT applied:', '', ...lines].join('\n'),
          planChangeJson: JSON.stringify({
            description: `Apply ${conflicts.length} conflicting profile change(s): ${conflicts.map((c) => c.description).join('; ').slice(0, 400)}`,
            applied: false,
            profileConflicts: conflicts,
          }),
          createdAt: new Date().toISOString(),
        })
        .run();
      ctx.bus.emit({
        type: 'toast',
        level: 'warning',
        message: `Profile sync: ${conflicts.length} conflicting change(s) need your approval (see Feedback)`,
      });
    }

    ctx.bus.emit({
      type: 'toast',
      level: conflicts.length > 0 ? 'warning' : 'info',
      message: `Profile sync: ${additiveApplied.length} additive change(s) applied, ${conflicts.length} conflict(s) queued`,
    });
  },
};
