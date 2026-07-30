import { create } from 'zustand';
import type {
  Application, Connection, EmailRecord, FeedbackEntry, Job, PrepTask, QueueTask,
  ScheduleEvent, Settings, SkillProgress, SourceBudget, SseEvent, UserProfile,
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
  tasks: QueueTask[];
  budgets: SourceBudget[];
  queuePaused: boolean;
  emails: EmailRecord[];
  schedule: ScheduleEvent[];
  prepTasks: PrepTask[];
  skills: SkillProgress[];
  connections: Connection[];
  settings: Settings | null;
  profile: UserProfile | null;
  feedback: FeedbackEntry[];
  toasts: Toast[];
  asks: AskSession[];
  searchSession: { id: string; startedAt: number; jobIds: number[] } | null;

  loadAll(): Promise<void>;
  refreshEmails(): Promise<void>;
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
  setSettings(s: Settings): void;
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
  tasks: [],
  budgets: [],
  queuePaused: false,
  emails: [],
  schedule: [],
  prepTasks: [],
  skills: [],
  connections: [],
  settings: null,
  profile: null,
  feedback: [],
  toasts: [],
  asks: [],
  searchSession: null,

  async loadAll() {
    try {
      const [jobsRes, applications, queue, emails, schedule, prepTasks, skills, connections, settings, profile, feedback] =
        await Promise.all([
          api.getJobs({ limit: 500 }),
          api.getApplications(),
          api.getQueue(),
          api.getEmails(),
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
        applications,
        tasks: queue.tasks,
        budgets: queue.budgets,
        queuePaused: queue.paused,
        emails,
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
    set({ emails: await api.getEmails() });
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
    set({ tasks: q.tasks, budgets: q.budgets, queuePaused: q.paused });
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
        set({ tasks: e.tasks, budgets: e.budgets, queuePaused: e.paused });
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

  setSettings(s) {
    set({ settings: s });
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
