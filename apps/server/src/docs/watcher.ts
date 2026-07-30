// documents/ file watcher (FR-14): edits to the personal source documents
// enqueue a profile_sync task after a 30 s debounce, so a burst of saves
// produces one merge run. Started by src/index.ts only (never in tests).
import path from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import type { AppContext } from '../context';

export interface DocumentsWatcher {
  stop(): Promise<void>;
}

export function startDocumentsWatcher(ctx: AppContext, debounceMs = 30000): DocumentsWatcher {
  const docsDir = path.join(ctx.repoRoot, 'documents');
  let timer: NodeJS.Timeout | null = null;
  let pendingPaths = new Set<string>();

  const watcher: FSWatcher = watch(docsDir, {
    ignoreInitial: true,
    ignored: (p: string) => /node_modules|\.git/.test(p),
    awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 250 },
  });

  const schedule = (changedPath: string) => {
    pendingPaths.add(path.relative(ctx.repoRoot, changedPath).split(path.sep).join('/'));
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const changed = [...pendingPaths];
      pendingPaths = new Set();
      timer = null;
      ctx.queue.enqueue('profile_sync', {
        dedupe: true,
        payload: { trigger: 'documents_watcher', changed },
      });
      ctx.bus.emit({
        type: 'toast',
        level: 'info',
        message: `Documents changed (${changed.length} file${changed.length === 1 ? '' : 's'}) — profile sync queued`,
      });
    }, debounceMs);
    timer.unref?.();
  };

  watcher.on('add', schedule);
  watcher.on('change', schedule);
  watcher.on('unlink', schedule);
  watcher.on('error', (err) => console.warn('[watcher] documents watcher error:', err));

  return {
    async stop() {
      if (timer) clearTimeout(timer);
      await watcher.close();
    },
  };
}
