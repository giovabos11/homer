// SSE stream (contract §Events): GET /api/events → text/event-stream of
// SseEvent frames. Heartbeat comment every 15 s (EventBus); on connect the
// client gets a queue.snapshot plus the full connection list so reconnects are
// lossless enough to re-render.
import { Router } from 'express';
import type { AppContext } from '../context';
import { queueSnapshot } from './queue';

export function eventRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get('/events', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write(': connected\n\n');

    ctx.bus.addClient(res);

    // Snapshot on connect (reconnect-safe): queue state + full connection list.
    ctx.bus.sendTo(res, { type: 'queue.snapshot', ...queueSnapshot(ctx) });
    try {
      const connections = await ctx.monitor.list();
      for (const connection of connections) {
        ctx.bus.sendTo(res, { type: 'connection.updated', connection });
      }
    } catch {
      /* probes failing must not kill the stream */
    }

    req.on('close', () => res.end());
  });

  return router;
}
