// Server entrypoint: build context, start API on 127.0.0.1:4750 (localhost
// only — PRD §8), start the croner scheduler + queue runner, wire shutdown.
import { createApp } from './app';
import { createContext } from './context';
import { QueueRunner } from './queue/runner';
import { startDocumentsWatcher, type DocumentsWatcher } from './docs/watcher';

function main(): void {
  const ctx = createContext();
  const app = createApp(ctx);
  const runner = new QueueRunner(ctx);
  let watcher: DocumentsWatcher | null = null;

  const server = app.listen(ctx.config.port, ctx.config.host, () => {
    console.log(`[server] ai-job-search server v${ctx.version} listening on http://${ctx.config.host}:${ctx.config.port}`);
    console.log(`[server] data dir: ${ctx.dataDir}`);
    console.log(`[server] vault backend: ${ctx.vault.backend}${ctx.simulate ? ' · SIMULATE mode ON' : ''}`);
    ctx.scheduler.start();
    runner.start();
    watcher = startDocumentsWatcher(ctx); // FR-14: documents/ edits queue a profile re-merge
  });

  const shutdown = (signal: string) => {
    console.log(`[server] ${signal} — shutting down`);
    runner.stop();
    void watcher?.stop().catch(() => undefined);
    ctx.scheduler.stop();
    server.close(() => {
      ctx.close();
      process.exit(0);
    });
    // Hard exit if close hangs (open SSE sockets).
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
