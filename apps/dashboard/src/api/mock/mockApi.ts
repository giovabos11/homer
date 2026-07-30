import type {
  Application, Connection, ConnectionName, CredentialMeta, EmailRecord, FeedbackEntry,
  FeedbackKind, Job, JobStatus, PrepTask, QueueTask, ScheduleEvent, Settings, SseEvent,
} from '@shared';
import type { Api, ApplicationArtifacts, JobsQuery, QueueSnapshot, SearchBody } from '../types';
import {
  APPLICATIONS, ARTIFACTS, BUDGETS, CONNECTIONS, CREDENTIALS, EMAILS, FEEDBACK,
  JOBS, PREP_TASKS, PROFILE, QUEUE_TASKS, RESET_PREVIEW, SCHEDULE, SETTINGS, SKILLS,
} from './data';
import { mockCoverLetterPdf, mockResumePdf } from '@/lib/mockPdf';

// ---------------------------------------------------------------------------
// Event bus — stands in for the SSE stream in mock mode
// ---------------------------------------------------------------------------
type Listener = (e: SseEvent) => void;

class MockBus {
  private listeners = new Set<Listener>();
  on(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  emit(e: SseEvent) {
    for (const l of [...this.listeners]) l(e);
  }
  get size() {
    return this.listeners.size;
  }
}

export const mockBus = new MockBus();

// ---------------------------------------------------------------------------
// Mutable state (cloned fixtures)
// ---------------------------------------------------------------------------
const S = {
  jobs: structuredClone(JOBS) as Job[],
  applications: structuredClone(APPLICATIONS) as Application[],
  tasks: structuredClone(QUEUE_TASKS) as QueueTask[],
  budgets: structuredClone(BUDGETS),
  emails: structuredClone(EMAILS) as EmailRecord[],
  schedule: structuredClone(SCHEDULE) as ScheduleEvent[],
  prepTasks: structuredClone(PREP_TASKS) as PrepTask[],
  skills: structuredClone(SKILLS),
  connections: structuredClone(CONNECTIONS) as Connection[],
  credentials: structuredClone(CREDENTIALS) as CredentialMeta[],
  feedback: structuredClone(FEEDBACK) as FeedbackEntry[],
  profile: structuredClone(PROFILE),
  settings: structuredClone(SETTINGS) as Settings,
  paused: false,
};

let nextId = 5000;
const now = () => new Date().toISOString();
const delay = (ms = 140 + Math.random() * 180) => new Promise<void>((r) => setTimeout(r, ms));

function withJob(a: Application): Application {
  return { ...a, job: S.jobs.find((j) => j.id === a.jobId) };
}

function setJobStatus(jobId: number, status: JobStatus) {
  const j = S.jobs.find((x) => x.id === jobId);
  if (j) j.status = status;
}

function emitApp(a: Application) {
  mockBus.emit({ type: 'application.updated', application: withJob(a) });
}

function toast(level: 'info' | 'success' | 'warning' | 'error', message: string, celebrate?: boolean) {
  mockBus.emit({ type: 'toast', level, message, ...(celebrate ? { celebrate } : {}) });
}

function snapshot(): QueueSnapshot {
  return { tasks: structuredClone(S.tasks), budgets: structuredClone(S.budgets), paused: S.paused };
}

// ---------------------------------------------------------------------------
// Ambient simulation — makes the demo feel alive
// ---------------------------------------------------------------------------
let simStarted = false;
export function startSimulation() {
  if (simStarted) return;
  simStarted = true;

  // discovery worker "ticks"
  setInterval(() => {
    if (S.paused) return;
    const t = S.tasks.find((x) => x.id === 101 && x.state === 'running');
    if (t && t.cursor) {
      const c = t.cursor as { source: string; page: number; item: number };
      c.item = (c.item + 1) % 25;
      if (c.item === 0) c.page += 1;
      t.updatedAt = now();
      mockBus.emit({ type: 'queue.updated', task: structuredClone(t) });
    }
  }, 9000);

  // score the still-unscored discovered jobs, one at a time
  const unscored = () => S.jobs.filter((j) => j.status === 'discovered' && j.fitScore == null);
  setInterval(() => {
    if (S.paused) return;
    const j = unscored()[0];
    if (!j) return;
    j.fitScore = 62 + Math.round(Math.random() * 33);
    j.fitBreakdown = {
      technical: Math.min(100, j.fitScore + 5),
      experience: Math.max(0, j.fitScore - 7),
      behavioral: Math.min(100, j.fitScore + 2),
      career: j.fitScore,
      locationVeto: false,
    };
    j.legitVerdict = 'legit';
    j.legitReasons = ['Careers-page listing verified', 'Salary within market band'];
    j.status = 'screened';
    mockBus.emit({ type: 'job.scored', job: structuredClone(j) });
    toast('info', `Fit check: ${j.company} scored ${j.fitScore} — moved to Screened`);
  }, 26000);

  // heartbeat-ish connection refresh
  setInterval(() => {
    const c = S.connections.find((x) => x.name === 'server');
    if (c) {
      c.lastOk = now();
      mockBus.emit({ type: 'connection.updated', connection: structuredClone(c) });
    }
  }, 30000);
}

// ---------------------------------------------------------------------------
// Canned generators
// ---------------------------------------------------------------------------
const SEARCH_POOL = [
  { company: 'Vanta', title: 'Full Stack Engineer, Trust Platform', min: 148000, max: 195000, source: 'greenhouse' },
  { company: 'Rippling', title: 'Software Engineer, Frontend Platform', min: 152000, max: 208000, source: 'greenhouse' },
  { company: 'Modern Treasury', title: 'Product Engineer', min: 150000, max: 200000, source: 'lever' },
  { company: 'Watershed', title: 'Software Engineer, Product', min: 155000, max: 205000, source: 'ashby' },
  { company: 'Pilot', title: 'Full Stack Engineer', min: 140000, max: 180000, source: 'lever' },
  { company: 'Density', title: 'Senior Frontend Engineer', min: 145000, max: 190000, source: 'remoteok' },
  { company: 'Column', title: 'Software Engineer, Bank Infrastructure', min: 160000, max: 215000, source: 'ashby' },
  { company: 'Mux', title: 'Software Engineer, Dashboard', min: 142000, max: 186000, source: 'greenhouse' },
];

function makeSearchJob(pool: (typeof SEARCH_POOL)[number], body: SearchBody): Job {
  const id = nextId++;
  return {
    id,
    source: body.sources?.length ? body.sources[Math.floor(Math.random() * body.sources.length)]! : pool.source,
    externalId: `search-${id}`,
    canonicalUrl: `https://jobs.example.com/${pool.company.toLowerCase()}/${id}`,
    company: pool.company,
    title: pool.title,
    location: body.remote === 'onsite' ? (body.location ?? 'Dallas, TX') : 'Remote (US)',
    remoteType: body.remote ?? 'remote',
    salaryMin: pool.min,
    salaryMax: pool.max,
    salaryCurrency: 'USD',
    salaryPredicted: Math.random() < 0.3,
    descriptionMd: `## ${pool.title}\n\n${pool.company} matched your live search for **"${body.keywords}"**.\n\n## Pay & benefits\n\n**$${pool.min.toLocaleString()} – $${pool.max.toLocaleString()}** + equity`,
    postedAt: now(),
    firstSeen: now(),
    status: 'discovered',
    fitScore: null,
    fitBreakdown: null,
    legitVerdict: 'unchecked',
    legitReasons: [],
    managed: 'auto',
  };
}

const ASK_ANSWER = `### Here's my read

Based on your pipeline right now, the highest-leverage move is preparing for the **Datadog technical interview tomorrow at 2:00 PM CT**. Your prep checklist is 50% done; the two open items that matter most are the systems-discussion sketch and the TypeScript generics review.

**Three quick wins today:**

1. Finish the metrics-pipeline sketch (30 min). It covers the most likely systems question.
2. Approve or reject the two drafts sitting in your Outbox; the Figma follow-up loses value every day it waits.
3. The Airtable apply is paused on a captcha. Solving it takes two minutes and moves a 78-fit application to Applied.

**On your Notion offer:** the response deadline is in 5 days. If Datadog goes well tomorrow, you will have real leverage; I can draft a polite timeline-extension email for your review whenever you want.

Want me to draft that extension email now?`;

const FEEDBACK_RESPONSES: Record<FeedbackKind, string> = {
  idea: '### Interesting idea\n\nI analyzed how this interacts with the current plan. It looks feasible and low-risk.\n\n**Proposal:** roll it into the scoring config behind a review gate so you can watch the first week of results before committing.\n\nApprove the plan change to activate it.',
  concern: '### Taking this seriously\n\nI checked the pipeline history and current config against your concern. Summary of findings below; no destructive change will happen without your approval.\n\n- Current behavior is within the configured safety gates\n- I added a monitor so you will get a toast if the pattern you described appears\n\nNo config change is required right now.',
  comment: 'Noted and logged. I will factor this into future runs and prep-guide generation.',
  update: '### Profile update queued\n\nI queued a profile re-merge (upstream /setup Path A semantics). Additive changes apply automatically; anything conflicting will surface here for confirmation before CLAUDE.md is touched.',
  retro: '### Retro captured\n\nThank you — honest retros are what make the recalibration loop work.\n\nI mapped what happened onto your prep plan and adjusted future study guides. Watch the Skill Progress meters for the new track.',
};

// ---------------------------------------------------------------------------
// The mock API
// ---------------------------------------------------------------------------
export const mockApi: Api = {
  async health() {
    await delay(60);
    return { ok: true, version: '0.4.2-mock' };
  },

  async getConnections() {
    await delay();
    return structuredClone(S.connections);
  },

  async setConnectionKey(name: ConnectionName, _key: string) {
    await delay(500);
    const c = S.connections.find((x) => x.name === name);
    if (!c) throw new Error(`unknown connection ${name}`);
    c.status = 'ok';
    c.detail = 'Key stored in vault · probe succeeded';
    c.lastOk = now();
    const b = S.budgets.find((x) => x.source === name);
    if (b) {
      b.enabled = true;
      b.remainingTokens = 25;
      b.refillPerHour = 25;
    }
    mockBus.emit({ type: 'connection.updated', connection: structuredClone(c) });
    toast('success', `${name === 'adzuna' ? 'Adzuna' : 'USAJobs'} connected — salary-annotated coverage unlocked`);
    return structuredClone(c);
  },

  async checkConnection(name: ConnectionName) {
    await delay(600);
    const c = S.connections.find((x) => x.name === name);
    if (!c) throw new Error(`unknown connection ${name}`);
    if (c.status !== 'needs_key' && c.status !== 'disabled') {
      c.lastOk = now();
      if (c.status === 'down' && Math.random() < 0.4) c.status = 'degraded';
    }
    mockBus.emit({ type: 'connection.updated', connection: structuredClone(c) });
    return structuredClone(c);
  },

  async getProfile() {
    await delay();
    return structuredClone(S.profile);
  },

  async getArtifact(path: string) {
    await delay();
    const markdown =
      ARTIFACTS[path] ??
      `# ${path.split('/').pop()}\n\n_Mock mode: no fixture exists for this artifact path._\n\n\`${path}\``;
    return { path, markdown };
  },

  async getJobs(params: JobsQuery = {}) {
    await delay();
    let jobs = [...S.jobs];
    if (params.q) {
      const q = params.q.toLowerCase();
      jobs = jobs.filter((j) => `${j.company} ${j.title} ${j.location}`.toLowerCase().includes(q));
    }
    if (params.status) {
      const set = new Set(Array.isArray(params.status) ? params.status : [params.status]);
      jobs = jobs.filter((j) => set.has(j.status));
    }
    if (params.source) jobs = jobs.filter((j) => j.source === params.source);
    if (params.remote) jobs = jobs.filter((j) => j.remoteType === params.remote);
    if (params.minScore != null) jobs = jobs.filter((j) => (j.fitScore ?? 0) >= params.minScore!);
    const dir = params.order === 'asc' ? 1 : -1;
    if (params.sort === 'salary') jobs.sort((a, b) => dir * ((a.salaryMax ?? 0) - (b.salaryMax ?? 0)));
    else if (params.sort === 'score') jobs.sort((a, b) => dir * ((a.fitScore ?? -1) - (b.fitScore ?? -1)));
    else jobs.sort((a, b) => dir * (new Date(a.firstSeen).getTime() - new Date(b.firstSeen).getTime()));
    const total = jobs.length;
    if (params.offset) jobs = jobs.slice(params.offset);
    if (params.limit) jobs = jobs.slice(0, params.limit);
    return { total, jobs: structuredClone(jobs) };
  },

  async getJob(id: number) {
    await delay();
    const j = S.jobs.find((x) => x.id === id);
    if (!j) throw new Error('job not found');
    return structuredClone(j);
  },

  async getTopJobs(fitWeighted: boolean, limit = 10) {
    await delay();
    const ranked = S.jobs
      .filter((j) => j.salaryMax != null && j.status !== 'quarantined' && j.status !== 'skipped')
      .sort((a, b) => {
        const va = (a.salaryMax ?? 0) * (fitWeighted ? (a.fitScore ?? 50) / 100 : 1);
        const vb = (b.salaryMax ?? 0) * (fitWeighted ? (b.fitScore ?? 50) / 100 : 1);
        return vb - va;
      });
    return structuredClone(ranked.slice(0, limit));
  },

  async createJob(body: Partial<Job>) {
    await delay();
    const id = nextId++;
    const job: Job = {
      id,
      source: 'manual',
      externalId: null,
      canonicalUrl: body.canonicalUrl ?? '',
      company: body.company ?? 'Unknown',
      title: body.title ?? 'Untitled role',
      location: body.location ?? null,
      remoteType: body.remoteType ?? 'unknown',
      salaryMin: body.salaryMin ?? null,
      salaryMax: body.salaryMax ?? null,
      salaryCurrency: body.salaryMax != null ? 'USD' : null,
      salaryPredicted: false,
      descriptionMd: body.descriptionMd ?? null,
      postedAt: now(),
      firstSeen: now(),
      status: body.status ?? 'discovered',
      fitScore: null,
      fitBreakdown: null,
      legitVerdict: 'unchecked',
      legitReasons: [],
      managed: 'manual',
    };
    S.jobs.unshift(job);
    mockBus.emit({ type: 'job.discovered', job: structuredClone(job) });
    toast('success', `Added ${job.company} — ${job.title} (manual record)`);
    return structuredClone(job);
  },

  async applyFromUrl(url: string) {
    await delay(700);
    let host = 'company';
    try {
      host = new URL(url).hostname.replace(/^(www|jobs|boards|careers)\./, '').split('.')[0] ?? 'company';
    } catch {
      /* keep default */
    }
    const company = host.charAt(0).toUpperCase() + host.slice(1);
    const id = nextId++;
    const job: Job = {
      id,
      source: 'url',
      externalId: null,
      canonicalUrl: url,
      company,
      title: 'Software Engineer (parsed from URL)',
      location: 'Remote (US)',
      remoteType: 'remote',
      salaryMin: 140000,
      salaryMax: 185000,
      salaryCurrency: 'USD',
      salaryPredicted: true,
      descriptionMd: `## Parsed posting\n\nFetched from \`${url}\` and treated as **untrusted input** per the security rules.\n\n## Pay & benefits\n\n**$140,000 – $185,000** _(predicted from market data)_`,
      postedAt: now(),
      firstSeen: now(),
      status: 'discovered',
      fitScore: null,
      fitBreakdown: null,
      legitVerdict: 'unchecked',
      legitReasons: [],
      managed: 'auto',
    };
    S.jobs.unshift(job);
    mockBus.emit({ type: 'job.discovered', job: structuredClone(job) });
    toast('info', `Parsed posting from ${company} — running fit + legitimacy checks`);
    setTimeout(() => {
      job.fitScore = 84;
      job.fitBreakdown = { technical: 88, experience: 78, behavioral: 86, career: 84, locationVeto: false };
      job.legitVerdict = 'legit';
      job.legitReasons = ['Domain matches a registered company', 'Posting text is unique (no mass-posting match)'];
      job.status = 'screened';
      mockBus.emit({ type: 'job.scored', job: structuredClone(job) });
      toast('success', `${company} scored 84 — entering tailoring pipeline`);
      setTimeout(() => {
        job.status = 'tailoring';
        const app: Application = {
          id: nextId++, jobId: job.id, status: 'tailoring', gate: S.settings.gateMode,
          approvedAt: null, submittedAt: null, resumePath: null, coverLetterPath: null,
          answers: null, archiveDir: null, notes: [],
        };
        S.applications.push(app);
        emitApp(app);
      }, 2500);
    }, 2200);
    const task: QueueTask = {
      id: nextId++, type: 'score', state: 'running', payload: { url },
      cursor: null, runAfter: null, attempts: 1, lastError: null, humanPrompt: null,
      createdAt: now(), updatedAt: now(),
    };
    S.tasks.unshift(task);
    mockBus.emit({ type: 'queue.updated', task: structuredClone(task) });
    return { job: structuredClone(job), taskId: task.id };
  },

  async applyJob(id: number) {
    await delay();
    const j = S.jobs.find((x) => x.id === id);
    if (!j) throw new Error('job not found');
    j.status = 'tailoring';
    let app = S.applications.find((a) => a.jobId === id);
    if (!app) {
      app = {
        id: nextId++, jobId: id, status: 'tailoring', gate: S.settings.gateMode,
        approvedAt: null, submittedAt: null, resumePath: null, coverLetterPath: null,
        answers: null, archiveDir: null, notes: [],
      };
      S.applications.push(app);
    } else {
      app.status = 'tailoring';
    }
    const task: QueueTask = {
      id: nextId++, type: 'tailor', state: 'pending', payload: { company: j.company, jobId: id },
      cursor: null, runAfter: null, attempts: 0, lastError: null, humanPrompt: null,
      createdAt: now(), updatedAt: now(),
    };
    S.tasks.unshift(task);
    emitApp(app);
    mockBus.emit({ type: 'queue.updated', task: structuredClone(task) });
    toast('info', `Tailoring started for ${j.company} — ${j.title}`);
    return { taskId: task.id };
  },

  async skipJob(id: number) {
    await delay();
    const j = S.jobs.find((x) => x.id === id);
    if (!j) throw new Error('job not found');
    j.status = 'skipped';
    toast('info', `Skipped ${j.company}`);
    return structuredClone(j);
  },

  async getApplications(params) {
    await delay();
    let apps = S.applications.map(withJob);
    if (params?.status) apps = apps.filter((a) => a.status === params.status);
    if (params?.q) {
      const q = params.q.toLowerCase();
      apps = apps.filter((a) => `${a.job?.company} ${a.job?.title}`.toLowerCase().includes(q));
    }
    return structuredClone(apps);
  },

  async patchApplication(id: number, body) {
    await delay();
    const a = S.applications.find((x) => x.id === id);
    if (!a) throw new Error('application not found');
    if (body.status) {
      a.status = body.status;
      setJobStatus(a.jobId, body.status);
      if (body.status === 'applied' && !a.submittedAt) a.submittedAt = now();
    }
    if (body.notes) a.notes.push({ date: now(), text: body.notes });
    emitApp(a);
    return structuredClone(withJob(a));
  },

  async approveApplication(id: number) {
    await delay();
    const a = S.applications.find((x) => x.id === id);
    if (!a) throw new Error('application not found');
    const j = S.jobs.find((x) => x.id === a.jobId);
    a.approvedAt = now();
    toast('info', `Approved — apply driver filling the ${j?.company} form…`);
    setTimeout(() => {
      a.status = 'applied';
      a.submittedAt = now();
      if (j) j.status = 'applied';
      a.notes.push({ date: now(), text: 'Submitted by Playwright driver. Confirmation screenshot archived.' });
      emitApp(a);
      mockBus.emit({ type: 'toast', level: 'success', message: `Application submitted to ${j?.company ?? 'company'} 🎉`, celebrate: true });
    }, 2000);
    return { taskId: nextId++ };
  },

  async rejectApplication(id: number, reason: string) {
    await delay();
    const a = S.applications.find((x) => x.id === id);
    if (!a) throw new Error('application not found');
    a.status = 'tailoring';
    setJobStatus(a.jobId, 'tailoring');
    a.notes.push({ date: now(), text: `Draft rejected: ${reason}. Re-tailoring queued.` });
    emitApp(a);
    toast('info', 'Draft rejected — the tailoring worker will produce a new version');
    return structuredClone(withJob(a));
  },

  async getApplicationArtifacts(id: number) {
    await delay(300);
    const a = S.applications.find((x) => x.id === id);
    const j = a && S.jobs.find((x) => x.id === a.jobId);
    if (!a || !j) throw new Error('application not found');
    const out: ApplicationArtifacts = {
      resumeUrl: mockResumePdf(j.company, j.title),
      coverLetterUrl: mockCoverLetterPdf(j.company, j.title),
      screenshots: [],
      answers: a.answers,
    };
    return out;
  },

  async search(body: SearchBody) {
    await delay(300);
    const searchId = `search-${nextId++}`;
    const picks = [...SEARCH_POOL].sort(() => Math.random() - 0.5).slice(0, 5 + Math.floor(Math.random() * 3));
    toast('info', `Searching ${body.sources?.length || 'all'} sources for "${body.keywords}"…`);
    picks.forEach((p, i) => {
      setTimeout(() => {
        const job = makeSearchJob(p, body);
        S.jobs.unshift(job);
        mockBus.emit({ type: 'job.discovered', job: structuredClone(job) });
        if (i === picks.length - 1) toast('success', `Search complete — ${picks.length} new matches`);
      }, 700 + i * 750);
    });
    return { searchId };
  },

  async getQueue() {
    await delay();
    return snapshot();
  },

  async pauseQueue() {
    await delay();
    S.paused = true;
    for (const t of S.tasks) if (t.state === 'running') t.state = 'paused';
    mockBus.emit({ type: 'queue.snapshot', ...snapshot() });
    toast('info', 'Queue paused — cursors saved, resume any time');
    return snapshot();
  },

  async resumeQueue() {
    await delay();
    S.paused = false;
    for (const t of S.tasks) if (t.state === 'paused') t.state = 'running';
    mockBus.emit({ type: 'queue.snapshot', ...snapshot() });
    toast('success', 'Queue resumed from saved cursors');
    return snapshot();
  },

  async setQueueRate(discoveryIntervalMinutes: number) {
    await delay();
    S.settings.discoveryIntervalMinutes = discoveryIntervalMinutes;
    return structuredClone(S.settings);
  },

  async resolveHuman(taskId: number) {
    await delay();
    const t = S.tasks.find((x) => x.id === taskId);
    if (!t) throw new Error('task not found');
    t.state = 'running';
    t.humanPrompt = null;
    t.updatedAt = now();
    mockBus.emit({ type: 'queue.updated', task: structuredClone(t) });
    toast('info', 'Resuming apply worker…');
    setTimeout(() => {
      t.state = 'done';
      t.updatedAt = now();
      mockBus.emit({ type: 'queue.updated', task: structuredClone(t) });
      const jobId = (t.payload as { jobId?: number }).jobId;
      const a = S.applications.find((x) => x.jobId === jobId);
      if (a) {
        a.status = 'applied';
        a.approvedAt = a.approvedAt ?? now();
        a.submittedAt = now();
        setJobStatus(a.jobId, 'applied');
        emitApp(a);
        const j = S.jobs.find((x) => x.id === a.jobId);
        mockBus.emit({ type: 'toast', level: 'success', message: `Captcha solved — application submitted to ${j?.company} 🎉`, celebrate: true });
      }
    }, 2600);
    return structuredClone(t);
  },

  async retryTask(taskId: number) {
    await delay();
    const t = S.tasks.find((x) => x.id === taskId);
    if (!t) throw new Error('task not found');
    t.state = 'pending';
    t.attempts += 1;
    t.lastError = null;
    t.updatedAt = now();
    mockBus.emit({ type: 'queue.updated', task: structuredClone(t) });
    toast('info', `Task #${taskId} requeued`);
    return structuredClone(t);
  },

  async cancelTask(taskId: number) {
    await delay();
    const t = S.tasks.find((x) => x.id === taskId);
    if (!t) throw new Error('task not found');
    t.state = 'failed';
    t.lastError = 'Cancelled by user';
    t.updatedAt = now();
    mockBus.emit({ type: 'queue.updated', task: structuredClone(t) });
    return structuredClone(t);
  },

  async getEmails(params) {
    await delay();
    let emails = [...S.emails];
    if (params?.direction) emails = emails.filter((e) => e.direction === params.direction);
    if (params?.classification) emails = emails.filter((e) => e.classification === params.classification);
    return structuredClone(emails);
  },

  async getOutbox() {
    await delay();
    return structuredClone(S.emails.filter((e) => e.direction === 'outbound' && e.needsApproval));
  },

  async approveOutbox(id: number) {
    await delay();
    const e = S.emails.find((x) => x.id === id);
    if (!e) throw new Error('email not found');
    e.needsApproval = false;
    e.approvedAt = now();
    mockBus.emit({ type: 'outbox.updated', email: structuredClone(e) });
    toast('success', 'Approved — will send in the next Claude session (Gmail connector)');
    return structuredClone(e);
  },

  async rejectOutbox(id: number, reason?: string) {
    await delay();
    const e = S.emails.find((x) => x.id === id);
    if (!e) throw new Error('email not found');
    e.needsApproval = false;
    e.summary = `[Rejected${reason ? `: ${reason}` : ''}] ${e.summary}`;
    mockBus.emit({ type: 'outbox.updated', email: structuredClone(e) });
    toast('info', 'Draft rejected — it will not be sent');
    return structuredClone(e);
  },

  async triggerEmailScan() {
    await delay();
    toast('info', 'Email scan queued — waiting for an active Claude session (Gmail connector)');
    return { taskId: 104 };
  },

  async getSchedule(from?: string, to?: string) {
    await delay();
    let ev = [...S.schedule];
    if (from) ev = ev.filter((e) => e.startsAt >= from);
    if (to) ev = ev.filter((e) => e.startsAt <= to);
    return structuredClone(ev.sort((a, b) => a.startsAt.localeCompare(b.startsAt)));
  },

  async createScheduleEvent(body: Partial<ScheduleEvent>) {
    await delay();
    const e: ScheduleEvent = {
      id: nextId++,
      type: body.type ?? 'other',
      applicationId: body.applicationId ?? null,
      title: body.title ?? 'Untitled event',
      startsAt: body.startsAt ?? now(),
      endsAt: body.endsAt ?? null,
      prepGuidePath: body.prepGuidePath ?? null,
      company: body.company ?? null,
    };
    S.schedule.push(e);
    mockBus.emit({ type: 'schedule.updated', event: structuredClone(e) });
    toast('success', `Added to schedule: ${e.title}`);
    return structuredClone(e);
  },

  async regenPrep(eventId: number) {
    await delay();
    toast('info', 'Study-guide regeneration queued (prep worker)');
    return { taskId: nextId++, ...(eventId ? {} : {}) } as { taskId: number };
  },

  async getPrepTasks(eventId?: number) {
    await delay();
    const tasks = eventId ? S.prepTasks.filter((t) => t.eventId === eventId) : [...S.prepTasks];
    return structuredClone(tasks);
  },

  async patchPrepTask(id: number, done: boolean) {
    await delay(100);
    const t = S.prepTasks.find((x) => x.id === id);
    if (!t) throw new Error('prep task not found');
    t.doneAt = done ? now() : null;
    const siblings = S.prepTasks.filter((x) => x.eventId === t.eventId);
    if (done && siblings.every((x) => x.doneAt != null)) {
      const ev = S.schedule.find((e) => e.id === t.eventId);
      mockBus.emit({ type: 'toast', level: 'success', message: `Prep complete for ${ev?.company ?? 'interview'} — you're ready 🎉`, celebrate: true });
    }
    return structuredClone(t);
  },

  async getSkillsProgress() {
    await delay();
    // reflect live prep completion in the first skills
    return structuredClone(S.skills);
  },

  async getCredentials() {
    await delay();
    return structuredClone(S.credentials);
  },

  async addCredential(body) {
    await delay(300);
    const existing = S.credentials.find((c) => c.site === body.site);
    const meta: CredentialMeta = {
      site: body.site,
      username: body.username,
      maskedPassword: '•'.repeat(Math.max(8, Math.min(16, body.password.length))),
      hasCaptcha: body.hasCaptcha ?? false,
      notes: body.notes ?? null,
      createdAt: existing?.createdAt ?? now(),
    };
    if (existing) Object.assign(existing, meta);
    else S.credentials.push(meta);
    toast('success', `Credentials for ${body.site} stored in Windows Credential Manager`);
    return structuredClone(meta);
  },

  async revealCredential(site: string) {
    await delay(250);
    void site;
    return { password: 'xK9$mock-Vault2026!' };
  },

  async deleteCredential(site: string) {
    await delay();
    S.credentials = S.credentials.filter((c) => c.site !== site);
    toast('info', `Removed credentials for ${site}`);
    return { ok: true };
  },

  async postFeedback(kind: FeedbackKind, text: string) {
    await delay(300);
    const entry: FeedbackEntry = {
      id: nextId++,
      kind,
      inputMd: text,
      responseMd: null,
      planChange: null,
      createdAt: now(),
    };
    S.feedback.unshift(entry);
    setTimeout(() => {
      entry.responseMd = FEEDBACK_RESPONSES[kind];
      if (kind === 'idea' || kind === 'update') {
        entry.planChange = { description: kind === 'idea' ? 'Apply proposed scoring/config adjustment' : 'Queue profile re-merge from updated documents', applied: false };
      }
      toast('success', 'The assistant responded to your feedback');
    }, 2600);
    return structuredClone(entry);
  },

  async getFeedback() {
    await delay();
    return structuredClone(S.feedback);
  },

  async applyPlanChange(id: number) {
    await delay(400);
    const f = S.feedback.find((x) => x.id === id);
    if (!f) throw new Error('feedback not found');
    if (f.planChange) f.planChange.applied = true;
    toast('success', 'Plan change applied — config updated');
    return structuredClone(f);
  },

  async ask(prompt: string) {
    await delay(200);
    const requestId = `ask-${nextId++}`;
    void prompt;
    const words = ASK_ANSWER.split(/(?<=\s)/);
    let i = 0;
    const tick = () => {
      if (i >= words.length) {
        mockBus.emit({ type: 'ask.delta', requestId, delta: '', done: true });
        return;
      }
      const chunk = words.slice(i, i + 3).join('');
      i += 3;
      mockBus.emit({ type: 'ask.delta', requestId, delta: chunk, done: false });
      setTimeout(tick, 45 + Math.random() * 70);
    };
    setTimeout(tick, 500);
    return { requestId };
  },

  async getSettings() {
    await delay();
    return structuredClone(S.settings);
  },

  async patchSettings(body: Partial<Settings>) {
    await delay();
    Object.assign(S.settings, body);
    if (body.country) toast('success', `Job market switched to ${body.country} — portal set updated`);
    return structuredClone(S.settings);
  },

  async resetPreview(scopes: string[]) {
    await delay(400);
    void scopes;
    return { preview: [...RESET_PREVIEW] };
  },

  async reset(scopes: string[]) {
    await delay(1200);
    void scopes;
    toast('warning', 'Reset complete (mock) — nothing was actually deleted in mock mode');
    return { ok: true };
  },
};
