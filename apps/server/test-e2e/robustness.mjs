// Phase D — robustness: kill the server while the dashboard is open (graceful
// degradation, no white screen), restart it (recovery + queue/pause/cursor
// persistence across restart). Assumes port 4750 is FREE (this script owns the
// server lifecycle) and the Vite dev server is running on 5173.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { apiJson, auditPage, gotoView, record, shoot, summarize, waitFor } from './helpers.mjs';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function startServer() {
  const child = spawn(process.execPath, ['dist/server/src/index.js'], {
    cwd: serverDir,
    env: { ...process.env, SIMULATE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  return child;
}

const up = async () => (await apiJson('/api/health').catch(() => ({ status: 0 }))).status === 200;

let server = startServer();
await waitFor(up, { timeout: 20000, label: 'server up' });
record('robustness: standalone server started', true);

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
const audit = auditPage(page);
await gotoView(page, '/', 'h1:has-text("Mission Control")');
await page.waitForSelector('text=Live events connected', { timeout: 15000 });
record('robustness: dashboard connected (live events)', true);

/* Persistence fixtures: pause the queue + park a pending task. */
await apiJson('/api/queue/pause', { method: 'POST' });
await apiJson('/api/search', { method: 'POST', body: JSON.stringify({ keywords: 'robustness persist probe', sources: ['freehire'] }) });
const beforeTasks = (await apiJson('/api/queue')).body;
const parked = beforeTasks.tasks.find((t) => t.state === 'pending' && t.type === 'discover');
record('robustness: pending task parked while paused', !!parked, `task #${parked?.id}`);

/* Kill the server hard. */
server.kill('SIGKILL');
await waitFor(async () => !(await up()), { timeout: 10000, label: 'server down' });
record('robustness: server killed', true);

/* Dashboard should degrade gracefully: reconnecting state, content intact.
   Worst case for the stall watchdog: 40 s silence threshold + 5 s sweep. */
try {
  await page.waitForSelector('text=Reconnecting…', { timeout: 70000 });
  record('robustness: UI shows reconnecting state', true);
} catch {
  record('robustness: UI shows reconnecting state', false);
}
const bodyText = await page.evaluate(() => document.body.innerText);
record('robustness: no white screen while down', bodyText.length > 300 && bodyText.toLowerCase().includes('mission control'), `${bodyText.length} chars`);
await shoot(page, '20-server-down');

/* Poke the UI while down: a store refresh (route change) must not crash the app. */
await page.click('a[href="#/search"], a[href="#search"], text=Search', { timeout: 5000 }).catch(() => {});
await page.waitForTimeout(1500);
const stillAlive = (await page.evaluate(() => document.body.innerText)).length > 200;
record('robustness: navigation while down does not crash', stillAlive);

/* Restart → dashboard recovers; queue paused + task survive. */
server = startServer();
await waitFor(up, { timeout: 20000, label: 'server back up' });
try {
  await page.waitForSelector('text=Live events connected', { timeout: 30000 });
  record('robustness: SSE reconnects after restart', true);
} catch {
  record('robustness: SSE reconnects after restart', false);
}
const afterQueue = (await apiJson('/api/queue')).body;
record('robustness: queue paused state survives restart', afterQueue.paused === true);
const survivor = afterQueue.tasks.find((t) => t.id === parked?.id);
record('robustness: pending task survives restart', survivor?.state === 'pending', `task #${parked?.id} state=${survivor?.state}`);

/* Resume → the survivor task actually runs to completion. */
await apiJson('/api/queue/resume', { method: 'POST' });
try {
  await waitFor(async () => {
    const q = (await apiJson('/api/queue')).body;
    const t = q.tasks.find((x) => x.id === parked?.id);
    return t?.state === 'done';
  }, { timeout: 20000, label: 'survivor task completes' });
  record('robustness: parked task completes after resume', true);
} catch (err) {
  record('robustness: parked task completes after resume', false, String(err));
}
await page.waitForTimeout(2000);
await shoot(page, '21-server-recovered');

record('robustness: no uncaught page errors', audit.pageErrors.length === 0, audit.pageErrors.slice(0, 3).join(' | '));

await browser.close();
server.kill('SIGKILL');
process.exit(summarize('robustness') ? 0 : 1);
