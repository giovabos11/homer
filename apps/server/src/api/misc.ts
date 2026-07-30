// Feedback, ask-anything, settings (contract §Feedback, ask, settings, reset — FR-26/27/29).
import crypto from 'node:crypto';
import { Router } from 'express';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { feedback } from '../db/schema';
import { toFeedbackEntry } from '../db/serialize';
import type { AppContext } from '../context';
import { ApiError, idParam, parseBody } from './util';

const settingsPatchSchema = z
  .object({
    gateMode: z.enum(['review', 'auto', 'hybrid']),
    hybridThreshold: z.number().min(0).max(100),
    discoveryIntervalMinutes: z.number().int().min(15).max(1440),
    emailScanIntervalMinutes: z.number().int().min(15).max(1440),
    country: z.string().length(2),
    applyDriver: z.enum(['playwright', 'chrome']),
    perSourceGates: z.record(z.string(), z.enum(['review', 'auto', 'hybrid'])),
    followupAfterDays: z.number().int().min(1).max(60),
    maxFollowups: z.number().int().min(0).max(10),
  })
  .partial()
  .strict();

export function miscRoutes(ctx: AppContext): Router {
  const router = Router();

  router.post('/feedback', (req, res) => {
    const body = parseBody(
      z.object({
        kind: z.enum(['idea', 'concern', 'comment', 'update', 'retro']),
        text: z.string().min(1),
      }),
      req,
    );
    const row = ctx.db
      .insert(feedback)
      .values({ kind: body.kind, inputMd: body.text, createdAt: new Date().toISOString() })
      .returning()
      .get();
    ctx.queue.enqueue('feedback', { payload: { feedbackId: row.id } });
    res.status(201).json(toFeedbackEntry(row));
  });

  router.get('/feedback', (_req, res) => {
    res.json(ctx.db.select().from(feedback).orderBy(desc(feedback.id)).all().map(toFeedbackEntry));
  });

  router.post('/feedback/:id/apply-plan', (req, res) => {
    const id = idParam(req);
    const row = ctx.db.select().from(feedback).where(eq(feedback.id, id)).get();
    if (!row) throw new ApiError(404, 'not_found', `No feedback ${id}`);
    if (!row.planChangeJson) throw new ApiError(409, 'invalid_state', `Feedback ${id} has no proposed plan change`);
    const plan = JSON.parse(row.planChangeJson) as {
      description: string;
      applied: boolean;
      settingsPatch?: Record<string, unknown>;
    };
    if (plan.applied) throw new ApiError(409, 'invalid_state', `Feedback ${id} plan change was already applied`);

    // Config-change intents (FR-26): validate + apply the proposed settings patch.
    if (plan.settingsPatch) {
      const patch = settingsPatchSchema.safeParse(plan.settingsPatch);
      if (!patch.success) {
        throw new ApiError(
          409,
          'invalid_plan',
          `Proposed settings patch is invalid: ${patch.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        );
      }
      ctx.settings.patch(patch.data);
      if (patch.data.discoveryIntervalMinutes != null || patch.data.emailScanIntervalMinutes != null) {
        ctx.scheduler.reschedule();
      }
    }

    plan.applied = true;
    const updated = ctx.db
      .update(feedback)
      .set({ planChangeJson: JSON.stringify(plan) })
      .where(eq(feedback.id, id))
      .returning()
      .get();
    ctx.bus.emit({ type: 'toast', level: 'success', message: `Plan change applied: ${plan.description.slice(0, 120)}` });
    res.json(toFeedbackEntry(updated));
  });

  // FR-29: ask-anything — response streams via ask.delta SSE events.
  router.post('/ask', (req, res) => {
    const body = parseBody(z.object({ prompt: z.string().min(1), sessionId: z.string().optional() }), req);
    const requestId = crypto.randomUUID();
    ctx.queue.enqueue('ask', { payload: { requestId, prompt: body.prompt, sessionId: body.sessionId } });
    res.json({ requestId });
  });

  router.get('/settings', (_req, res) => {
    res.json(ctx.settings.get());
  });

  router.patch('/settings', (req, res) => {
    const patch = parseBody(settingsPatchSchema, req);
    const settings = ctx.settings.patch(patch);
    if (patch.discoveryIntervalMinutes != null || patch.emailScanIntervalMinutes != null) {
      ctx.scheduler.reschedule();
    }
    res.json(settings);
  });

  return router;
}
