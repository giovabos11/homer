import { create } from 'zustand';
import type {
  Application, Connection, EmailRecord, FeedbackEntry, Job, PrepTask, QueueTask,
  ScheduleEvent, ScheduleNextRuns, Settings, SkillProgress, SourceBudget, SseEvent, UserProfile,
} from '@shared';
import { api } from '@/api/client';

export interface Toast {
  id: number;
  level: 'info' | 'success' | 'warning' | 'error';
  message: string;
  celebrate?: boolean;
}

export interface AskSession {
  requestId: string;
  prompt: string;
  response: string;
  done: boolean;
  startedAt: number;
}

export interface SetupTurn {
  requestId: string;
  /** The user's message ('' for the opening turn started by a mode choice). */
  prompt: string;
  response: string;
  done: boolean;
  startedAt: number;
}

let toastSeq = 1;

function upsert<T>(list: T[], item: T, key: (x: T) => unknown, front = false): T[] {
  const k = key(item);
  const idx = list.findIndex((x) => key(x) === k);
  if (idx === -1) return front ? [item, ...list] : [...list, item];
  const next = [...list];
  next[idx] = item;
  return next;
}

interface StoreState {
  ready: boolean;
  loadError: string | null;
  sseConnected: boolean;

  jobs: Job[];
  applications: Application[];
  applicationsTotal: number;
  tasks: QueueTask[];
  budgets: SourceBudget[];
  queuePaused: boolean;
  nextRuns: ScheduleNextRuns | null;
  emails: EmailRecord[];
  emailsTotal: number;
  emailsLoadingMore: boolean;
  schedule: ScheduleEvent[];
  prepTasks: PrepTask[];
  skills: SkillProgress[];
  connections: Connection[];
  settings: Settings | null;
  profile: UserProfile | null;
  feedback: FeedbackEntry[];
  toasts: Toast[];
  asks: AskSession[];
  setup: { active: boolean; mode: 'interview' | 'documents' | null; turns: SetupTurn[] };
  searchSession: { id: string; startedAt: number; jobIds: number[] } | null;

  loadAll(): Promise<void>;
  refreshEmails(): Promise<void>;
  loadMoreEmails(): Promise<void>;
  refreshFeedback(): Promise<void>;
  refreshPrep(): Promise<void>;
  refreshQueue(): Promise<void>;
  setSseConnected(v: boolean): void;
  applyEvent(e: SseEvent): void;
  pushToast(level: Toast['level'], message: string, celebrate?: boolean): void;
  dismissToast(id: number): void;
  beginSearch(id: string): void;
  endSearch(): void;
  beginAsk(requestId: string, prompt: string): void;
  clearAsks(): void;
  beginSetup(requestId: string, prompt: string, mode?: 'interview' | 'documents'): void;
  setSetupSession(active: boolean, mode: 'interview' | 'documents' | null): void;
  clearSetup(): void;
  setSettings(s: Settings): void;
  setProfile(p: UserProfile): void;
  setJobs(jobs: Job[]): void;
  upsertJob(job: Job): void;
  upsertApplication(a: Application): void;
  setPrepTask(t: PrepTask): void;
}

export const useStore = create<StoreState>((set, get) => ({
  ready: false,
  loadError: null,
  sseConnected: false,

  jobs: [],
  applications: [],
  applicationsTotal: 0,
  tasks: [],
  budgets: [],
  queuePaused: false,
  nextRuns: null,
  emails: [],
  emailsTotal: 0,
  emailsLoadingMore: false,
  schedule: [],
  prepTasks: [],
  skills: [],
  connections: [],
  settings: null,
  profile: null,
  feedback: [],
  toasts: [],
  asks: [],
  setup: { active: false, mode: null, turns: [] },
  searchSession: null,

  async loadAll() {
    try {
      const [jobsRes, appsRes, queue, emailsRes, schedule, prepTasks, skills, connections, settings, profile, feedback] =
        await Promise.all([
          api.getJobs({ limit: 500 }),
          // The kanban needs the full board; the server caps a page at 500.
          api.getApplications({ limit: 500 }),
          api.getQueue(),
          api.getEmails({ limit: 50 }),
          api.getSchedule(),
          api.getPrepTasks(),
          api.getSkillsProgress(),
          api.getConnections(),
          api.getSettings(),
          api.getProfile(),
          api.getFeedback(),
        ]);
      set({
        jobs: jobsRes.jobs,
        applications: appsRes.applications,
        applicationsTotal: appsRes.total,
        tasks: queue.tasks,
        budgets: queue.budgets,
        queuePaused: queue.paused,
        nextRuns: queue.nextRuns ?? null,
        emails: emailsRes.emails,
        emailsTotal: emailsRes.total,
        schedule,
        prepTasks,
        skills,
        connections,
        settings,
        profile,
        feedback,
        ready: true,
        loadError: null,
      });
    } catch (err) {
      set({ loadError: err instanceof Error ? err.message : String(err), ready: true });
    }
  },

  async refreshEmails() {
    // Refresh at least as many as are already on screen so nothing disappears.
    const count = Math.max(50, get().emails.length);
    const res = await api.getEmails({ limit: Math.min(500, count) });
    set({ emails: res.emails, emailsTotal: res.total });
  },

  async loadMoreEmails() {
    const st = get();
    if (st.emailsLoadingMore || st.emails.length >= st.emailsTotal) return;
    set({ emailsLoadingMore: true });
    try {
      const res = await api.getEmails({ limit: 50, offset: st.emails.length });
      set((prev) => {
        const seen = new Set(prev.emails.map((e) => e.id));
        return {
          emails: [...prev.emails, ...res.emails.filter((e) => !seen.has(e.id))],
          emailsTotal: res.total,
        };
      });
    } finally {
      set({ emailsLoadingMore: false });
    }
  },
  async refreshFeedback() {
    set({ feedback: await api.getFeedback() });
  },
  async refreshPrep() {
    const [prepTasks, skills] = await Promise.all([api.getPrepTasks(), api.getSkillsProgress()]);
    set({ prepTasks, skills });
  },
  async refreshQueue() {
    const q = await api.getQueue();
    set({ tasks: q.tasks, budgets: q.budgets, queuePaused: q.paused, nextRuns: q.nextRuns ?? null });
  },

  setSseConnected(v) {
    set({ sseConnected: v });
  },

  applyEvent(e) {
    const st = get();
    switch (e.type) {
      case 'job.discovered': {
        set({ jobs: upsert(st.jobs, e.job, (j) => j.id, true) });
        const s = st.searchSession;
        if (s && !s.jobIds.includes(e.job.id)) {
          set({ searchSession: { ...s, jobIds: [...s.jobIds, e.job.id] } });
        }
        break;
      }
      case 'job.scored':
        set({ jobs: upsert(st.jobs, e.job, (j) => j.id) });
        break;
      case 'application.updated': {
        const a = e.application;
        set({ applications: upsert(st.applications, a, (x) => x.id) });
        if (a.job) {
          set((prev) => ({ jobs: upsert(prev.jobs, a.job as Job, (j) => j.id) }));
        } else {
          set((prev) => ({
            jobs: prev.jobs.map((j) => (j.id === a.jobId ? { ...j, status: a.status } : j)),
          }));
        }
        break;
      }
      case 'queue.updated':
        set({ tasks: upsert(st.tasks, e.task, (t) => t.id, true) });
        break;
      case 'queue.snapshot':
        set({ tasks: e.tasks, budgets: e.budgets, queuePaused: e.paused, nextRuns: e.nextRuns ?? st.nextRuns });
        break;
      case 'task.needs_human':
        set({ tasks: upsert(st.tasks, e.task, (t) => t.id, true) });
        st.pushToast('warning', e.task.humanPrompt ?? 'A task needs your help');
        break;
      case 'email.received':
        set({ emails: upsert(st.emails, e.email, (x) => x.id, true) });
        break;
      case 'outbox.updated':
        set({ emails: upsert(st.emails, e.email, (x) => x.id) });
        break;
      case 'connection.updated':
        set({ connections: upsert(st.connections, e.connection, (c) => c.name) });
        break;
      case 'schedule.updated':
        set({ schedule: upsert(st.schedule, e.event, (x) => x.id) });
        break;
      case 'ask.delta': {
        set((prev) => ({
          asks: prev.asks.map((a) =>
            a.requestId === e.requestId
              ? { ...a, response: a.response + e.delta, done: e.done }
              : a,
          ),
        }));
        break;
      }
      case 'setup.delta': {
        set((prev) => ({
          setup: {
            ...prev.setup,
            active: true,
            turns: prev.setup.turns.some((t) => t.requestId === e.requestId)
              ? prev.setup.turns.map((t) =>
                  t.requestId === e.requestId ? { ...t, response: t.response + e.delta, done: e.done } : t,
                )
              : [
                  ...prev.setup.turns,
                  { requestId: e.requestId, prompt: '', response: e.delta, done: e.done, startedAt: Date.now() },
                ],
          },
        }));
        // A finished turn may have written profile files — refetch profileReady.
        if (e.done) {
          void api.getProfile().then((p) => set({ profile: p })).catch(() => undefined);
        }
        break;
      }
      case 'toast':
        st.pushToast(e.level, e.message, e.celebrate);
        // feedback responses arrive via toast in the contract — refresh lazily
        if (/feedback/i.test(e.message)) void st.refreshFeedback();
        break;
    }
  },

  pushToast(level, message, celebrate) {
    const id = toastSeq++;
    set((prev) => ({ toasts: [...prev.toasts.slice(-4), { id, level, message, celebrate }] }));
  },
  dismissToast(id) {
    set((prev) => ({ toasts: prev.toasts.filter((t) => t.id !== id) }));
  },

  beginSearch(id) {
    set({ searchSession: { id, startedAt: Date.now(), jobIds: [] } });
  },
  endSearch() {
    set({ searchSession: null });
  },

  beginAsk(requestId, prompt) {
    set((prev) => ({
      asks: [...prev.asks, { requestId, prompt, response: '', done: false, startedAt: Date.now() }],
    }));
  },
  clearAsks() {
    set({ asks: [] });
  },

  beginSetup(requestId, prompt, mode) {
    set((prev) => ({
      setup: {
        active: true,
        mode: mode ?? prev.setup.mode,
        turns: [...prev.setup.turns, { requestId, prompt, response: '', done: false, startedAt: Date.now() }],
      },
    }));
  },
  setSetupSession(active, mode) {
    set((prev) => ({ setup: { ...prev.setup, active, mode } }));
  },
  clearSetup() {
    set({ setup: { active: false, mode: null, turns: [] } });
  },

  setSettings(s) {
    set({ settings: s });
  },
  setProfile(p) {
    set({ profile: p });
  },
  setJobs(jobs) {
    set({ jobs });
  },
  upsertJob(job) {
    set((prev) => ({ jobs: upsert(prev.jobs, job, (j) => j.id) }));
  },
  upsertApplication(a) {
    set((prev) => ({ applications: upsert(prev.applications, a, (x) => x.id) }));
  },
  setPrepTask(t) {
    set((prev) => ({ prepTasks: upsert(prev.prepTasks, t, (x) => x.id) }));
  },
}));
