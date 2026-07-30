// Profile-setup chat routes (contract §Profile setup) — the dashboard's
// version of the upstream /setup command. Turns run through the task queue as
// 'setup' tasks (see workers/setup.ts); assistant output streams back as
// setup.delta SSE events. The Claude session id persists in the settings table
// so a conversation survives server restarts.
import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context';
import { ApiError, parseBody } from './util';

export function setupRoutes(ctx: AppContext): Router {
  const router = Router();

  // Start a fresh setup session in the chosen mode. Any previous session is
  // dropped — "Start over" is POST /setup/clear followed by /setup/start.
  router.post('/setup/start', (req, res) => {
    const body = parseBody(z.object({ mode: z.enum(['interview', 'documents']) }), req);
    const requestId = crypto.randomUUID();
    ctx.settings.setInternal('setupSessionId', null);
    ctx.settings.setInternal('setupMode', body.mode);
    ctx.queue.enqueue('setup', { payload: { requestId, phase: 'start', mode: body.mode } });
    res.json({ requestId });
  });

  // Continue the stored session with a user chat message.
  router.post('/setup/message', (req, res) => {
    const body = parseBody(z.object({ text: z.string().min(1) }), req);
    const sessionId = ctx.settings.getInternal<string | null>('setupSessionId', null);
    if (!sessionId) {
      throw new ApiError(409, 'invalid_state', 'No active setup session — call POST /api/setup/start first');
    }
    const requestId = crypto.randomUUID();
    ctx.queue.enqueue('setup', { payload: { requestId, phase: 'message', text: body.text } });
    res.json({ requestId });
  });

  // Whether a resumable session exists (dashboard reload support).
  router.get('/setup/status', (_req, res) => {
    const sessionId = ctx.settings.getInternal<string | null>('setupSessionId', null);
    res.json({
      active: !!sessionId,
      mode: sessionId ? ctx.settings.getInternal<'interview' | 'documents' | null>('setupMode', null) : null,
    });
  });

  // Drop the stored session id — fresh start next time.
  router.post('/setup/clear', (_req, res) => {
    ctx.settings.setInternal('setupSessionId', null);
    ctx.settings.setInternal('setupMode', null);
    res.json({ ok: true });
  });

  return router;
}
