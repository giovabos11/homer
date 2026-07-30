// Phase B — interactive flows against the real SIMULATE server + real dashboard.
// Covers: kanban seed data, manual search stream (SSE job.discovered), job
// drawer markdown, approve arc (SSE application.updated → applied), queue
// pause/resume, needs_human show+resolve, settings gate persistence, reset
// PREVIEW only, feedback response, prep-task toggle + skill progress.
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { API, apiJson, auditPage, gotoView, record, shoot, startSse, summarize, waitFor } from './helpers.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const DB_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'app.db');

/* Restore the seeded fixture state so this script is re-runnable:
   Nimbus Labs back to ready_for_review, prior sim/QA artifacts cleared. */
{
  const db = new Database(DB_PATH);
  db.exec(`
    UPDATE applications SET status='ready_for_review', approved_at=NULL, submitted_at=NULL
      WHERE job_id IN (SELECT id FROM jobs WHERE company='Nimbus Labs' AND external_id LIKE 'seed-%');
    UPDATE jobs SET status='ready_for_review' WHERE company='Nimbus Labs' AND external_id LIKE 'seed-%';
    DELETE FROM followups WHERE application_id IN
      (SELECT id FROM applications WHERE job_id IN (SELECT id FROM jobs WHERE external_id LIKE 'seed-%')) AND draft_md IS NULL;
    DELETE FROM schedule_events WHERE type='followup_due';
    DELETE FROM jobs WHERE external_id LIKE 'sim-%';
    DELETE FROM task_queue WHERE human_prompt LIKE 'QA synthetic%';
    DELETE FROM feedback WHERE input_md LIKE 'QA:%';
  `);
  db.close();
}

const sse = await startSse();
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
const audit = auditPage(page);

/* ---------------- 1. Kanban seed data ---------------- */
await gotoView(page, '/', 'h1:has-text("Mission Control")');
const nimbusCard = page.locator('div.group', { hasText: 'Nimbus Labs' }).first();
record('kanban: seeded Nimbus Labs card visible', await nimbusCard.isVisible());
record(
  'kanban: ready_for_review card has Review button',
  await page.locator('button:has-text("Review drafts & approve")').first().isVisible(),
);

/* ---------------- 2. Manual search → results stream (SSE job.discovered) ---------------- */
await gotoView(page, '/search', 'h1:has-text("Search")');
const sseCountBefore = sse.events.filter((e) => e.type === 'job.discovered').length;
await page.getByPlaceholder(/Keywords/).fill('react typescript qa-run');
await page.getByRole('button', { name: /Search \d+ source/ }).click();
try {
  await waitFor(
    () => sse.events.filter((e) => e.type === 'job.discovered').length > sseCountBefore,
    { timeout: 20000, label: 'job.discovered SSE' },
  );
  record('search: SSE job.discovered events arrived', true);
} catch (err) {
  record('search: SSE job.discovered events arrived', false, String(err));
}
try {
  await page.waitForSelector('text=Live results', { timeout: 5000 });
  await waitFor(
    async () => (await page.locator('button:has-text("qa-run")').count()) > 0,
    { timeout: 20000, label: 'live results in UI' },
  );
  record('search: results streamed into Live results panel', true);
} catch (err) {
  record('search: results streamed into Live results panel', false, String(err).slice(0, 200));
}
await shoot(page, '10-search-live-results');

/* ---------------- 3. Job drawer with rendered markdown ---------------- */
await page.locator('button:has-text("qa-run")').first().click();
await page.waitForSelector('aside:has-text("Job description")', { timeout: 10000 });
const drawerText = await page.locator('aside').last().innerText();
record(
  'drawer: opens with rendered markdown (no raw ##)',
  drawerText.toLowerCase().includes('job description') && !/^##\s/m.test(drawerText),
  `${drawerText.length} chars`,
);
const drawerHasHeading = (await page.locator('aside .prose h2, aside [class*="markdown"] h2, aside h2').count()) > 0;
record('drawer: markdown heading element rendered', drawerHasHeading);
await shoot(page, '11-job-drawer');
await page.keyboard.press('Escape');
await page.waitForTimeout(600);

/* ---------------- 4. Approve arc → applied (SSE application.updated) ---------------- */
await gotoView(page, '/', 'h1:has-text("Mission Control")');
await page.locator('button:has-text("Review drafts & approve")').first().click();
await page.waitForSelector('text=Review application — Nimbus Labs', { timeout: 10000 });
await page.waitForTimeout(1000); // artifacts load
await shoot(page, '12-review-dialog');
await page.getByRole('button', { name: 'Approve & submit' }).click();
try {
  await waitFor(
    () => sse.has('application.updated', (d) => d.application?.status === 'applied'),
    { timeout: 25000, label: 'application.updated → applied SSE' },
  );
  record('approve: SSE application.updated (applied) arrived', true);
} catch (err) {
  record('approve: SSE application.updated (applied) arrived', false, String(err));
}
// UI: Nimbus Labs card should now be in the Applied column (no Review button on it).
try {
  await waitFor(
    async () => {
      const appliedCol = page
        .locator('div', { has: page.locator('span:text-is("Applied")') })
        .locator('..');
      return (await page.locator('div.group:has-text("Nimbus Labs"):not(:has(button:has-text("Review drafts")))').count()) > 0
        && (await page.locator('button:has-text("Review drafts & approve")').count()) === 0;
    },
    { timeout: 15000, label: 'card moved out of ready_for_review' },
  );
  record('approve: kanban card left Ready for review', true);
} catch (err) {
  record('approve: kanban card left Ready for review', false, String(err).slice(0, 200));
}
const jobsAfter = await apiJson('/api/jobs?q=Nimbus');
const nimbusJob = jobsAfter.body?.jobs?.find((j) => j.company === 'Nimbus Labs' && j.status === 'applied');
record('approve: server shows Nimbus Labs job applied', !!nimbusJob);
await page.waitForTimeout(1500);
await shoot(page, '13-after-approve');

/* ---------------- 5. Queue pause → reflect → resume ---------------- */
await gotoView(page, '/search', 'h1:has-text("Search")');
await page.getByRole('button', { name: 'Pause' }).click();
try {
  await waitFor(async () => (await apiJson('/api/queue')).body?.paused === true, { timeout: 8000, label: 'queue paused' });
  record('queue: pause reflected on server', true);
} catch (err) {
  record('queue: pause reflected on server', false, String(err));
}
await page.waitForSelector('text=Paused — cursors saved', { timeout: 8000 }).then(
  () => record('queue: paused state shown in UI', true),
  () => record('queue: paused state shown in UI', false),
);
await shoot(page, '14-queue-paused');
await page.getByRole('button', { name: 'Resume' }).click();
try {
  await waitFor(async () => (await apiJson('/api/queue')).body?.paused === false, { timeout: 8000, label: 'queue resumed' });
  record('queue: resume reflected on server', true);
} catch (err) {
  record('queue: resume reflected on server', false, String(err));
}

/* ---------------- 6. needs_human card shows and resolves ---------------- */
// SIMULATE never parks tasks (fake-success paths), so synthesize the state the
// runner would leave behind: an apply task parked needs_human. Resolving it
// re-runs the apply worker, which is a no-op for the already-submitted app.
{
  const db = new Database(DB_PATH);
  const app = db.prepare("SELECT id FROM applications WHERE submitted_at IS NOT NULL ORDER BY id LIMIT 1").get();
  const now = new Date().toISOString();
  const info = db
    .prepare(
      "INSERT INTO task_queue (type, payload_json, state, human_prompt, attempts, created_at, updated_at) VALUES ('apply', ?, 'needs_human', ?, 1, ?, ?)",
    )
    .run(JSON.stringify({ applicationId: app?.id ?? 1 }), 'QA synthetic: solve the captcha in the open browser, then resume.', now, now);
  db.close();
  const taskId = Number(info.lastInsertRowid);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('h1:has-text("Search")');
  await page.waitForSelector(`text=Your turn:`, { timeout: 10000 }).then(
    () => record('needs_human: alert card visible in queue panel', true),
    () => record('needs_human: alert card visible in queue panel', false),
  );
  await shoot(page, '15-needs-human');
  await page.getByRole('button', { name: 'I did it — resume' }).first().click();
  try {
    await waitFor(
      async () => {
        const q = await apiJson('/api/queue');
        const t = q.body?.tasks?.find((x) => x.id === taskId);
        return !t || !['needs_human'].includes(t.state);
      },
      { timeout: 10000, label: 'task resolved' },
    );
    record('needs_human: resolve-human clears the parked state', true);
  } catch (err) {
    record('needs_human: resolve-human clears the parked state', false, String(err));
  }
  try {
    await waitFor(
      async () => (await page.locator('text=Your turn:').count()) === 0,
      { timeout: 10000, label: 'alert removed from UI' },
    );
    record('needs_human: alert disappears from UI', true);
  } catch (err) {
    record('needs_human: alert disappears from UI', false, String(err));
  }
}

/* ---------------- 7. Settings gate-mode persists across reload ---------------- */
await gotoView(page, '/settings', 'h1:has-text("Settings")');
await page.locator('button:has-text("Auto-submit when the fit score clears")').first().click();
await waitFor(async () => (await apiJson('/api/settings')).body?.gateMode === 'hybrid', { timeout: 8000, label: 'gateMode hybrid' });
record('settings: gate change hit the server', true);
await page.waitForSelector('text=Auto-submit when fit score', { timeout: 5000 }).then(
  () => record('settings: hybrid threshold slider revealed', true),
  () => record('settings: hybrid threshold slider revealed', false),
);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('h1:has-text("Settings")');
await page.waitForTimeout(1000);
const hybridActive = await page.locator('button.border-accent\\/50', { hasText: 'Hybrid' }).count();
const thresholdVisible = await page.locator('text=Auto-submit when fit score').count();
record('settings: gate change survives reload', hybridActive > 0 || thresholdVisible > 0);
await shoot(page, '16-settings-hybrid');
// restore review mode
await page.locator('button:has-text("Every application waits in")').first().click();
await waitFor(async () => (await apiJson('/api/settings')).body?.gateMode === 'review', { timeout: 8000, label: 'gateMode review restored' });
record('settings: restored to review', true);

/* ---------------- 8. Reset PREVIEW only (never execute) ---------------- */
const jobsBeforeReset = (await apiJson('/api/jobs')).body?.total ?? 0;
await page.getByRole('button', { name: 'Preview what will be deleted' }).click();
await page.waitForSelector('text=This reset will remove:', { timeout: 8000 }).then(
  () => record('reset: preview list shown', true),
  () => record('reset: preview list shown', false),
);
const previewItems = await page.locator('li:has(svg)').filter({ has: page.locator('svg') }).count();
await shoot(page, '17-reset-preview');
await page.getByRole('button', { name: 'Cancel' }).click();
const jobsAfterReset = (await apiJson('/api/jobs')).body?.total ?? 0;
record('reset: nothing deleted (preview only)', jobsAfterReset === jobsBeforeReset && jobsBeforeReset > 0, `${jobsBeforeReset} jobs before/after`);

/* ---------------- 9. Feedback box → SIMULATE response ---------------- */
await gotoView(page, '/assistant', 'h1:has-text("Assistant")');
await page.getByPlaceholder(/Suggest a strategy/).fill('QA: consider searching for Rust roles too.');
await page.getByRole('button', { name: 'Send to agent' }).click();
await page.waitForSelector('text=QA: consider searching for Rust roles too.', { timeout: 8000 }).then(
  () => record('feedback: entry appears after submit', true),
  () => record('feedback: entry appears after submit', false),
);
try {
  await waitFor(
    async () => {
      const fb = await apiJson('/api/feedback');
      return fb.body?.some((f) => f.inputMd?.includes('Rust roles') && f.responseMd);
    },
    { timeout: 20000, label: 'feedback response filled' },
  );
  record('feedback: agent response recorded (SIMULATE)', true);
} catch (err) {
  record('feedback: agent response recorded (SIMULATE)', false, String(err));
}
await waitFor(
  async () => (await page.locator('text=Mock response to').count()) > 0,
  { timeout: 15000, label: 'response visible in UI' },
).then(
  () => record('feedback: response rendered in UI (toast-triggered refetch)', true),
  () => record('feedback: response rendered in UI (toast-triggered refetch)', false),
);
await shoot(page, '18-feedback');

/* ---------------- 10. Prep-task toggle + skill progress ---------------- */
await gotoView(page, '/schedule', 'h1:has-text("Schedule")');
const ringBefore = await page.locator('svg + span, [class*="Ring"]').first().innerText().catch(() => '');
const pctBefore = await page.locator('text=/%$/').first().innerText().catch(() => '?');
const unchecked = page.locator('button[role="checkbox"][data-state="unchecked"]').first();
record('prep: interview card with unchecked tasks present', await unchecked.isVisible());
const skillsBefore = (await apiJson('/api/skills-progress')).body ?? [];
await unchecked.click();
try {
  await waitFor(
    async () => {
      const tasks = (await apiJson('/api/prep-tasks')).body ?? [];
      return tasks.filter((t) => t.doneAt != null).length >= 3;
    },
    { timeout: 8000, label: 'prep task persisted' },
  );
  record('prep: checkbox toggle persisted server-side', true);
} catch (err) {
  record('prep: checkbox toggle persisted server-side', false, String(err));
}
const skillsAfter = (await apiJson('/api/skills-progress')).body ?? [];
const doneBefore = skillsBefore.reduce((n, s) => n + (s.doneTasks ?? 0), 0);
const doneAfter = skillsAfter.reduce((n, s) => n + (s.doneTasks ?? 0), 0);
record('prep: skill progress updated', doneAfter === doneBefore + 1, `${doneBefore} → ${doneAfter}`);
await page.waitForTimeout(800);
const pctAfter = await page.locator('text=/%$/').first().innerText().catch(() => '?');
record('prep: progress ring changed in UI', pctBefore !== pctAfter, `${pctBefore} → ${pctAfter}`);
await shoot(page, '19-schedule-prep');
// revert the toggle to keep state tidy
{
  const tasks = (await apiJson('/api/prep-tasks')).body ?? [];
  const third = tasks.filter((t) => t.doneAt != null).slice(-1)[0];
  if (third) await apiJson(`/api/prep-tasks/${third.id}`, { method: 'PATCH', body: JSON.stringify({ done: false }) });
}

/* ---------------- audit + wrap ---------------- */
record('flows: no page (uncaught) errors', audit.pageErrors.length === 0, audit.pageErrors.slice(0, 3).join(' | '));
record('flows: no console errors', audit.consoleErrors.length === 0, audit.consoleErrors.slice(0, 3).join(' | '));
record('flows: no failed requests', audit.failedRequests.length === 0, audit.failedRequests.slice(0, 3).join(' | '));

await sse.stop();
await browser.close();
process.exit(summarize('flows') ? 0 : 1);
