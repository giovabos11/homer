// Email-send worker (REAL — FR-11, PRD D4, §8).
//
//  - Only sends emails that carry a recorded user approval (approved_at set via
//    POST /api/outbox/:id/approve) — no email ever sends without one.
//  - Attempts the send through AgentRunner with the claude.ai Gmail MCP tools.
//    Headless runs normally have no Gmail tools → the task parks as
//    waiting_session; the interactive /email-bridge command performs the send
//    during a Claude session and POSTs back to /api/internal/email-bridge/sent.
//  - SIMULATE=1 marks the approved draft as sent after a short delay.
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { emails } from '../db/schema';
import { toEmail } from '../db/serialize';
import { strictJsonFooter } from '../agent/prompts';
import { appendOutcomeNote } from '../docs/archive';
import { getApplication, sleep } from './helpers';
import { WaitingSession, type Worker, type WorkerArgs } from './registry';
import type { AppContext } from '../context';

const sendResultSchema = z.object({
  gmailAvailable: z.boolean(),
  sent: z.boolean().default(false),
  messageId: z.string().nullish(),
  error: z.string().nullish(),
});

type EmailRow = typeof emails.$inferSelect;

export function markEmailSent(ctx: AppContext, email: EmailRow): void {
  const row = ctx.db
    .update(emails)
    .set({ sentAt: new Date().toISOString(), needsApproval: 0 })
    .where(eq(emails.id, email.id))
    .returning()
    .get();
  ctx.bus.emit({ type: 'outbox.updated', email: toEmail(row) });
  if (email.applicationId != null) {
    const app = getApplication(ctx, email.applicationId);
    if (app?.archiveDir) appendOutcomeNote(ctx.repoRoot, app.archiveDir, `Sent approved email: "${email.subject}".`);
  }
}

export const emailSendWorker: Worker = {
  type: 'email_send',
  async run({ ctx, task }: WorkerArgs): Promise<void> {
    const payload = JSON.parse(task.payloadJson) as { emailId?: number };
    const email = payload.emailId != null
      ? ctx.db.select().from(emails).where(eq(emails.id, payload.emailId)).get()
      : null;
    if (!email) return;
    if (!email.approvedAt) {
      throw new Error(`Email ${email.id} has no approval record — approval is required before sending (FR-11)`);
    }
    if (email.sentAt) return; // idempotent

    if (ctx.simulate) {
      await sleep(300);
      markEmailSent(ctx, email);
      return;
    }

    const prompt = [
      'You are the email-send step of a local job-search pipeline.',
      'FIRST check whether Gmail MCP tools (mcp__claude_ai_Gmail__*) are available.',
      'If NOT, reply immediately with {"gmailAvailable": false, "sent": false}.',
      '',
      'If Gmail tools ARE available: send the following APPROVED email exactly as',
      'written (it already carries the user approval recorded on ' + email.approvedAt + ').',
      'Do not edit the body. Reply to the existing thread when threadKey matches a',
      'real Gmail thread id; otherwise send a new message.',
      '',
      `Thread key: ${email.threadKey}`,
      `Subject: ${email.subject}`,
      '',
      '--- BODY (send verbatim) ---',
      email.bodyMd ?? '',
      '--- END BODY ---',
      strictJsonFooter('{ "gmailAvailable": boolean, "sent": boolean, "messageId": string?, "error": string? }'),
    ].join('\n');

    let structured: unknown;
    try {
      const result = await ctx.runner.run({
        prompt,
        cwd: ctx.repoRoot,
        allowedTools: ['mcp__claude_ai_Gmail__*'],
        model: ctx.settings.get().modelEmail,
        timeoutMs: ctx.config.agent.defaultTimeoutMs,
      });
      structured = result.structured;
    } catch {
      throw new WaitingSession('Gmail connector is session-only (D4) — run /email-bridge in a Claude session to send this approved email');
    }

    const parsed = sendResultSchema.safeParse(structured);
    if (!parsed.success || !parsed.data.gmailAvailable) {
      ctx.bus.emit({
        type: 'connection.updated',
        connection: { name: 'gmail', status: 'waiting_session', detail: 'Approved email queued — run /email-bridge in a Claude session', lastOk: null },
      });
      throw new WaitingSession('Gmail connector is session-only (D4) — run /email-bridge in a Claude session to send this approved email');
    }
    if (!parsed.data.sent) {
      throw new Error(`Gmail send failed: ${parsed.data.error ?? 'unknown error'}`);
    }
    markEmailSent(ctx, email);
  },
};
