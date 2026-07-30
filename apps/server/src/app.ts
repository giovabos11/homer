// Express app assembly — every route in apps/CONTRACT.md, /files static
// serving, and the global {error, detail} error handler. Exported as a factory
// so supertest can build an app around a test context.
import express, { type Express } from 'express';
import type { AppContext } from './context';
import { coreRoutes } from './api/core';
import { jobRoutes } from './api/jobs';
import { applicationRoutes } from './api/applications';
import { queueRoutes } from './api/queue';
import { emailRoutes } from './api/emails';
import { scheduleRoutes } from './api/schedule';
import { credentialRoutes } from './api/credentials';
import { miscRoutes } from './api/misc';
import { setupRoutes } from './api/setup';
import { resetRoutes } from './api/reset';
import { internalRoutes } from './api/internal';
import { eventRoutes } from './api/events';
import { errorHandler } from './api/util';
import { registerAllWorkers } from './workers';

export function createApp(ctx: AppContext): Express {
  registerAllWorkers();

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  app.use('/api', eventRoutes(ctx));
  app.use('/api', coreRoutes(ctx));
  app.use('/api', jobRoutes(ctx));
  app.use('/api', applicationRoutes(ctx));
  app.use('/api', queueRoutes(ctx));
  app.use('/api', emailRoutes(ctx));
  app.use('/api', scheduleRoutes(ctx));
  app.use('/api', credentialRoutes(ctx));
  app.use('/api', miscRoutes(ctx));
  app.use('/api', setupRoutes(ctx));
  app.use('/api', resetRoutes(ctx));
  app.use('/api', internalRoutes(ctx));

  // Generated artifacts (PDFs, screenshots, prep guides) — read-only.
  app.use(
    '/files',
    express.static(ctx.artifactsDir, {
      fallthrough: false,
      dotfiles: 'deny',
      index: false,
    }),
  );

  // 404 for unknown API paths in the contract error shape.
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not_found', detail: 'Unknown API route' });
  });

  app.use(errorHandler);
  return app;
}
