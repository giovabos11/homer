// Phase C — API contract audit: every endpoint in apps/CONTRACT.md against the
// SIMULATE server, valid + invalid payloads, {error, detail} shape, plus the
// charter specials (lifecycle PATCH guard, RESET confirmation, reveal logging,
// double-approve idempotency, /files traversal, SSE connect replay).
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { API, apiJson, record, startSse, summarize, waitFor } from './helpers.mjs';

// Re-runnable: restore the seeded outbox draft consumed by earlier runs.
{
  const require = createRequire(import.meta.url);
  const Database = require('better-sqlite3');
  const db = new Database(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'app.db'));
  db.exec("UPDATE emails SET needs_approval=1, approved_at=NULL, sent_at=NULL WHERE direction='outbound' AND thread_key LIKE 'followup-app-%'");
  db.close();
}

const isErrShape = (b) => b && typeof b.error === 'string';
const check = (name, res, wantStatus, extra = () => true, detail = '') =>
  record(name, res.status === wantStatus && extra(res.body), detail || `status=${res.status}${isErrShape(res.body) ? ` error=${res.body.error}` : ''}`);

/* ---------- SSE connect replay ---------- */
const sse = await startSse();
await waitFor(() => sse.has('queue.snapshot'), { timeout: 10000, label: 'queue.snapshot' }).then(
  () => record('SSE: queue.snapshot replayed on connect', sse.has('queue.snapshot', (d) => Array.isArray(d.tasks) && Array.isArray(d.budgets))),
  (err) => record('SSE: queue.snapshot replayed on connect', false, String(err)),
);
await waitFor(() => sse.has('connection.updated'), { timeout: 15000, label: 'connection replay' }).then(
  () => record('SSE: connection list replayed on connect', true),
  (err) => record('SSE: connection list replayed on connect', false, String(err)),
);

/* ---------- Health & connections ---------- */
check('GET /api/health', await apiJson('/api/health'), 200, (b) => b.ok === true && typeof b.version === 'string');
check('GET /api/connections', await apiJson('/api/connections'), 200, (b) => Array.isArray(b) && b.length > 0);
check('POST /api/connections/adzuna/key (valid)', await apiJson('/api/connections/adzuna/key', { method: 'POST', body: JSON.stringify({ key: 'qa-fake-key', appId: 'qa-app' }) }), 200, (b) => b.name === 'adzuna');
check('POST /api/connections/adzuna/key (missing key → 400)', await apiJson('/api/connections/adzuna/key', { method: 'POST', body: JSON.stringify({}) }), 400, isErrShape);
check('POST /api/connections/bogus/key → 4xx', await apiJson('/api/connections/bogus/key', { method: 'POST', body: JSON.stringify({ key: 'x' }) }), 400, isErrShape);
check('POST /api/connections/gmail/check', await apiJson('/api/connections/gmail/check', { method: 'POST' }), 200, (b) => b.name === 'gmail');

/* ---------- Profile & artifacts ---------- */
check('GET /api/profile', await apiJson('/api/profile'), 200, (b) => typeof b.fullName === 'string');
check('GET /api/artifacts (safe path)', await apiJson('/api/artifacts?path=documents/README.md'), 200, (b) => typeof b.markdown === 'string');
check('GET /api/artifacts (traversal → 400)', await apiJson('/api/artifacts?path=../PRD.md'), 400, isErrShape);
{
  const res = await apiJson('/api/artifacts?path=apps/server/package.json');
  record('GET /api/artifacts (outside roots denied)', [400, 403, 404].includes(res.status) && isErrShape(res.body), `status=${res.status}`);
}

/* ---------- Jobs ---------- */
const jobsList = await apiJson('/api/jobs?limit=200');
check('GET /api/jobs', jobsList, 200, (b) => typeof b.total === 'number' && Array.isArray(b.jobs));
check('GET /api/jobs (bad minScore → 400)', await apiJson('/api/jobs?minScore=200'), 400, isErrShape);
check('GET /api/jobs/top (fitWeighted)', await apiJson('/api/jobs/top?by=salary&fitWeighted=true&limit=5'), 200, (b) => Array.isArray(b));
const someJob = jobsList.body.jobs.find((j) => j.status === 'screened' || j.status === 'discovered');
check('GET /api/jobs/:id', await apiJson(`/api/jobs/${someJob.id}`), 200, (b) => b.id === someJob.id && 'descriptionMd' in b);
check('GET /api/jobs/999999 → 404', await apiJson('/api/jobs/999999'), 404, isErrShape);
check('GET /api/jobs/abc → 400', await apiJson('/api/jobs/abc'), 400, isErrShape);
const created = await apiJson('/api/jobs', { method: 'POST', body: JSON.stringify({ company: 'QA Contract Co', title: 'QA Engineer', status: 'applied' }) });
check('POST /api/jobs (manual record)', created, 201, (b) => b.managed === 'manual' && b.company === 'QA Contract Co');
check('POST /api/jobs (missing company → 400)', await apiJson('/api/jobs', { method: 'POST', body: JSON.stringify({ title: 'X' }) }), 400, isErrShape);
const fromUrl = await apiJson('/api/jobs/from-url', { method: 'POST', body: JSON.stringify({ url: 'https://example.com/careers/qa-contract-role' }) });
check('POST /api/jobs/from-url', fromUrl, 201, (b) => b.job?.id != null && b.taskId != null);
check('POST /api/jobs/from-url (bad url → 400)', await apiJson('/api/jobs/from-url', { method: 'POST', body: JSON.stringify({ url: 'not-a-url' }) }), 400, isErrShape);
check('POST /api/jobs/:id/skip', await apiJson(`/api/jobs/${created.body.id}/skip`, { method: 'POST' }), 200, (b) => b.status === 'skipped');
check('POST /api/jobs/999999/skip → 404', await apiJson('/api/jobs/999999/skip', { method: 'POST' }), 404, isErrShape);

/* PATCH /api/jobs/:id — lifecycle guard (charter special) */
check('PATCH job → lifecycle status rejected (applied)', await apiJson(`/api/jobs/${someJob.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'applied' }) }), 400, isErrShape);
check('PATCH job → lifecycle status rejected (tailoring)', await apiJson(`/api/jobs/${someJob.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'tailoring' }) }), 400, isErrShape);
check('PATCH job → pre-application status allowed', await apiJson(`/api/jobs/${someJob.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'screened' }) }), 200, (b) => b.status === 'screened');
const appliedJob = jobsList.body.jobs.find((j) => j.status === 'applied');
if (appliedJob) {
  check('PATCH job in-flight → 409', await apiJson(`/api/jobs/${appliedJob.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'screened' }) }), 409, isErrShape);
}

/* ---------- Applications ---------- */
const apps = await apiJson('/api/applications');
check('GET /api/applications', apps, 200, (b) => typeof b.total === 'number' && Array.isArray(b.applications) && b.applications.length > 0);
check('GET /api/applications?q filter', await apiJson('/api/applications?q=Bluegrid'), 200, (b) => Array.isArray(b.applications));
check('GET /api/applications?limit=1', await apiJson('/api/applications?limit=1'), 200, (b) => b.applications.length <= 1 && b.total >= b.applications.length);
const anyApp = apps.body.applications[0];
check('PATCH /api/applications/:id (note)', await apiJson(`/api/applications/${anyApp.id}`, { method: 'PATCH', body: JSON.stringify({ notes: 'QA contract note' }) }), 200, (b) => b.id === anyApp.id);
check('PATCH /api/applications/:id (bad status → 400)', await apiJson(`/api/applications/${anyApp.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'bogus' }) }), 400, isErrShape);
check('PATCH /api/applications/999999 → 404', await apiJson('/api/applications/999999', { method: 'PATCH', body: JSON.stringify({ notes: 'x' }) }), 404, isErrShape);
check('GET /api/applications/:id/artifacts', await apiJson(`/api/applications/${anyApp.id}/artifacts`), 200, (b) => 'resumeUrl' in b && Array.isArray(b.screenshots));
check('POST reject (missing reason → 400)', await apiJson(`/api/applications/${anyApp.id}/reject`, { method: 'POST', body: JSON.stringify({}) }), 400, isErrShape);

/* Double-approve (charter robustness): approve a ready_for_review app twice. */
{
  // stage: run the apply pipeline on a screened job to produce ready_for_review (SIMULATE tailor).
  const stageJob = jobsList.body.jobs.find((j) => j.status === 'screened' && j.legitVerdict !== 'scam');
  const applyRes = await apiJson(`/api/jobs/${stageJob.id}/apply`, { method: 'POST' });
  check('POST /api/jobs/:id/apply', applyRes, 200, (b) => b.taskId != null);
  let stagedApp = null;
  await waitFor(async () => {
    const list = (await apiJson('/api/applications?status=ready_for_review')).body?.applications ?? [];
    stagedApp = list.find((a) => a.jobId === stageJob.id) ?? null;
    return !!stagedApp;
  }, { timeout: 30000, label: 'tailor → ready_for_review' });
  const approve1 = await apiJson(`/api/applications/${stagedApp.id}/approve`, { method: 'POST' });
  check('POST approve (1st)', approve1, 200, (b) => b.taskId != null);
  await waitFor(async () => {
    const a = (await apiJson('/api/applications')).body.applications.find((x) => x.id === stagedApp.id);
    return a?.status === 'applied' && a?.submittedAt;
  }, { timeout: 30000, label: 'apply arc → applied' });
  const approve2 = await apiJson(`/api/applications/${stagedApp.id}/approve`, { method: 'POST' });
  check('POST approve (2nd) → 409, no double submit', approve2, 409, isErrShape);
  const finalApp = (await apiJson('/api/applications')).body.applications.find((x) => x.id === stagedApp.id);
  const audit = finalApp ? await apiJson(`/api/applications/${stagedApp.id}/artifacts`) : null;
  record('double-approve: still exactly one submission', finalApp?.status === 'applied', `status=${finalApp?.status}`);
}

/* ---------- Search & queue ---------- */
check('POST /api/search (valid)', await apiJson('/api/search', { method: 'POST', body: JSON.stringify({ keywords: 'qa contract search', sources: ['freehire'] }) }), 200, (b) => typeof b.searchId === 'string');
check('POST /api/search (no keywords → 400)', await apiJson('/api/search', { method: 'POST', body: JSON.stringify({}) }), 400, isErrShape);
const queue = await apiJson('/api/queue');
check('GET /api/queue', queue, 200, (b) => Array.isArray(b.tasks) && Array.isArray(b.budgets) && typeof b.paused === 'boolean');
check('POST /api/queue/pause', await apiJson('/api/queue/pause', { method: 'POST' }), 200, (b) => b.paused === true);
/* cancel a pending task while paused */
const pendingSearch = await apiJson('/api/search', { method: 'POST', body: JSON.stringify({ keywords: 'qa cancel me', sources: ['freehire'] }) });
const pendingTask = (await apiJson('/api/queue')).body.tasks.find((t) => t.state === 'pending' && t.type === 'discover');
if (pendingTask) {
  check('POST /api/queue/tasks/:id/cancel', await apiJson(`/api/queue/tasks/${pendingTask.id}/cancel`, { method: 'POST' }), 200, (b) => b.state === 'failed' || b.state === 'done' || b.lastError === 'Cancelled by user');
  check('POST /api/queue/tasks/:id/retry', await apiJson(`/api/queue/tasks/${pendingTask.id}/retry`, { method: 'POST' }), 200, (b) => b.state === 'pending');
  check('POST cancel again (cleanup)', await apiJson(`/api/queue/tasks/${pendingTask.id}/cancel`, { method: 'POST' }), 200, () => true);
} else {
  record('queue cancel/retry', false, 'no pending task found while paused');
}
check('POST resolve-human on non-parked task → 409', await apiJson(`/api/queue/tasks/${pendingTask?.id ?? 1}/resolve-human`, { method: 'POST' }), 409, isErrShape);
check('POST resolve-human unknown → 404', await apiJson('/api/queue/tasks/999999/resolve-human', { method: 'POST' }), 404, isErrShape);
check('POST /api/queue/resume', await apiJson('/api/queue/resume', { method: 'POST' }), 200, (b) => b.paused === false);
check('POST /api/queue/rate (valid)', await apiJson('/api/queue/rate', { method: 'POST', body: JSON.stringify({ discoveryIntervalMinutes: 360 }) }), 200, (b) => b.discoveryIntervalMinutes === 360);
check('POST /api/queue/rate (5 min → 400)', await apiJson('/api/queue/rate', { method: 'POST', body: JSON.stringify({ discoveryIntervalMinutes: 5 }) }), 400, isErrShape);

/* ---------- Emails & outbox ---------- */
check('GET /api/emails', await apiJson('/api/emails'), 200, (b) => typeof b.total === 'number' && Array.isArray(b.emails));
check('GET /api/emails?direction=inbound', await apiJson('/api/emails?direction=inbound'), 200, (b) => b.emails.every((e) => e.direction === 'inbound'));
check('GET /api/emails (bad direction → 400)', await apiJson('/api/emails?direction=sideways'), 400, isErrShape);
const outbox = await apiJson('/api/outbox');
check('GET /api/outbox', outbox, 200, (b) => Array.isArray(b));
const draft = outbox.body.find((e) => e.needsApproval);
if (draft) {
  check('POST /api/outbox/:id/approve', await apiJson(`/api/outbox/${draft.id}/approve`, { method: 'POST' }), 200, (b) => b.approvedAt != null);
} else {
  record('POST /api/outbox/:id/approve', false, 'no draft awaiting approval in outbox');
}
check('POST /api/outbox/999999/reject → 404', await apiJson('/api/outbox/999999/reject', { method: 'POST', body: JSON.stringify({ reason: 'x' }) }), 404, isErrShape);
check('POST /api/emails/scan', await apiJson('/api/emails/scan', { method: 'POST' }), 200, (b) => b.taskId != null);

/* ---------- Schedule, prep, skills ---------- */
check('GET /api/schedule', await apiJson('/api/schedule'), 200, (b) => Array.isArray(b) && b.length > 0);
const evCreated = await apiJson('/api/schedule', { method: 'POST', body: JSON.stringify({ type: 'other', title: 'QA contract event', startsAt: new Date(Date.now() + 86400000).toISOString() }) });
check('POST /api/schedule', evCreated, 201, (b) => b.id != null && b.title === 'QA contract event');
check('POST /api/schedule (missing title → 400)', await apiJson('/api/schedule', { method: 'POST', body: JSON.stringify({ type: 'other' }) }), 400, isErrShape);
const interviewEv = (await apiJson('/api/schedule')).body.find((e) => e.type === 'interview');
check('POST /api/schedule/:id/prep', await apiJson(`/api/schedule/${interviewEv.id}/prep`, { method: 'POST' }), 200, (b) => b.taskId != null);
check('POST /api/schedule/999999/prep → 404', await apiJson('/api/schedule/999999/prep', { method: 'POST' }), 404, isErrShape);
const prep = await apiJson(`/api/prep-tasks?eventId=${interviewEv.id}`);
check('GET /api/prep-tasks?eventId', prep, 200, (b) => Array.isArray(b));
if (prep.body[0]) {
  const t = prep.body[0];
  const flip = await apiJson(`/api/prep-tasks/${t.id}`, { method: 'PATCH', body: JSON.stringify({ done: t.doneAt == null }) });
  check('PATCH /api/prep-tasks/:id', flip, 200, (b) => (t.doneAt == null) === (b.doneAt != null));
  await apiJson(`/api/prep-tasks/${t.id}`, { method: 'PATCH', body: JSON.stringify({ done: t.doneAt != null }) }); // revert
}
check('PATCH /api/prep-tasks/:id (bad body → 400)', await apiJson(`/api/prep-tasks/${prep.body[0]?.id ?? 1}`, { method: 'PATCH', body: JSON.stringify({ done: 'yes' }) }), 400, isErrShape);
check('GET /api/skills-progress', await apiJson('/api/skills-progress'), 200, (b) => Array.isArray(b) && b.length > 0);

/* ---------- Credentials (+ security spot-check hooks) ---------- */
const VAULT_PW = 'QA-Sup3r-Secret-e2e-9315';
check('GET /api/credentials', await apiJson('/api/credentials'), 200, (b) => Array.isArray(b));
check('POST /api/credentials', await apiJson('/api/credentials', { method: 'POST', body: JSON.stringify({ site: 'qa-vault.example', username: 'giovanni-qa', password: VAULT_PW, notes: 'QA contract test' }) }), 201, (b) => b.site === 'qa-vault.example' && !JSON.stringify(b).includes(VAULT_PW));
check('POST /api/credentials (no password → 400)', await apiJson('/api/credentials', { method: 'POST', body: JSON.stringify({ site: 'x.example', username: 'u' }) }), 400, isErrShape);
const reveal = await apiJson('/api/credentials/qa-vault.example/reveal', { method: 'POST' });
check('POST /api/credentials/:site/reveal', reveal, 200, (b) => b.password === VAULT_PW);
check('POST reveal unknown site → 404', await apiJson('/api/credentials/nope.example/reveal', { method: 'POST' }), 404, isErrShape);
const masked = await apiJson('/api/credentials');
record('credentials list stays masked', !JSON.stringify(masked.body).includes(VAULT_PW));

/* ---------- Feedback, ask, settings, reset ---------- */
const fb = await apiJson('/api/feedback', { method: 'POST', body: JSON.stringify({ kind: 'comment', text: 'QA contract feedback entry' }) });
check('POST /api/feedback', fb, 201, (b) => b.id != null && b.kind === 'comment');
check('POST /api/feedback (bad kind → 400)', await apiJson('/api/feedback', { method: 'POST', body: JSON.stringify({ kind: 'rant', text: 'x' }) }), 400, isErrShape);
check('GET /api/feedback', await apiJson('/api/feedback'), 200, (b) => Array.isArray(b));
check('POST /api/feedback/:id/apply-plan (no plan → 4xx)', await apiJson(`/api/feedback/${fb.body.id}/apply-plan`, { method: 'POST' }), 409, isErrShape);
check('POST /api/feedback/999999/apply-plan → 404', await apiJson('/api/feedback/999999/apply-plan', { method: 'POST' }), 404, isErrShape);

const ask = await apiJson('/api/ask', { method: 'POST', body: JSON.stringify({ prompt: 'QA: summarize my pipeline in one line.' }) });
check('POST /api/ask', ask, 200, (b) => typeof b.requestId === 'string');
check('POST /api/ask (empty → 400)', await apiJson('/api/ask', { method: 'POST', body: JSON.stringify({ prompt: '' }) }), 400, isErrShape);
try {
  await waitFor(() => sse.has('ask.delta', (d) => d.requestId === ask.body.requestId && d.done === true), { timeout: 20000, label: 'ask.delta done' });
  record('SSE: ask.delta stream completes', true);
} catch (err) {
  record('SSE: ask.delta stream completes', false, String(err));
}

const settings = await apiJson('/api/settings');
check('GET /api/settings', settings, 200, (b) => typeof b.gateMode === 'string');
check('PATCH /api/settings (valid)', await apiJson('/api/settings', { method: 'PATCH', body: JSON.stringify({ hybridThreshold: 80 }) }), 200, (b) => b.hybridThreshold === 80);
await apiJson('/api/settings', { method: 'PATCH', body: JSON.stringify({ hybridThreshold: settings.body.hybridThreshold }) }); // restore
check('PATCH /api/settings (bad gateMode → 400)', await apiJson('/api/settings', { method: 'PATCH', body: JSON.stringify({ gateMode: 'yolo' }) }), 400, isErrShape);

check('POST /api/reset preview', await apiJson('/api/reset', { method: 'POST', body: JSON.stringify({ preview: true, scopes: ['db', 'artifacts'] }) }), 200, (b) => Array.isArray(b.preview) && b.preview.length > 0);
check('POST /api/reset wrong confirmation → 400', await apiJson('/api/reset', { method: 'POST', body: JSON.stringify({ confirmation: 'WRONG', scopes: ['db'] }) }), 400, isErrShape);
check('POST /api/reset no confirmation → 400', await apiJson('/api/reset', { method: 'POST', body: JSON.stringify({ scopes: ['db'] }) }), 400, isErrShape);
record('reset NOT executed (jobs intact)', ((await apiJson('/api/jobs')).body.total ?? 0) > 0);

/* ---------- Static /files + traversal ---------- */
const art = await apiJson(`/api/applications/${anyApp.id}/artifacts`);
if (art.body?.resumeUrl) {
  const pdf = await fetch(`${API}${art.body.resumeUrl}`);
  record('GET /files/<resume.pdf>', pdf.status === 200, `status=${pdf.status} type=${pdf.headers.get('content-type')}`);
} else {
  record('GET /files/<resume.pdf>', false, 'no resumeUrl on application');
}
for (const evil of ['/files/..%2f..%2f..%2fpackage.json', '/files/../../package.json', '/files/..%5c..%5cpackage.json']) {
  const res = await fetch(`${API}${evil}`);
  const text = await res.text();
  record(`traversal blocked: ${evil}`, res.status !== 200 || !text.includes('"name"'), `status=${res.status}`);
}

await sse.stop();
process.exit(summarize('contract') ? 0 : 1);
