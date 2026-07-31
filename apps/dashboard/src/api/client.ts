import type {
  Application, Connection, ConnectionName, CredentialMeta, EmailRecord, FeedbackEntry,
  FeedbackKind, Job, JobStatus, PrepTask, QueueTask, ScheduleEvent, Settings, SkillProgress, UserProfile,
} from '@shared';
import type { Api, ApplicationArtifacts, GmailProbeResult, JobsQuery, QueueSnapshot, SearchBody, SetupStatus } from './types';
import { mockApi } from './mock/mockApi';

export const IS_MOCK = import.meta.env.VITE_MOCK === '1';

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { error?: string; detail?: string };
      detail = body.error ?? detail;
      if (body.detail) detail += ` — ${body.detail}`;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(`${res.status}: ${detail}`);
  }
  return (await res.json()) as T;
}

const get = <T>(path: string) => http<T>(path);
const post = <T>(path: string, body?: unknown) =>
  http<T>(path, { method: 'POST', body: body !== undefined ? JSON.stringify(body) : undefined });
const patch = <T>(path: string, body: unknown) =>
  http<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
const put = <T>(path: string, body: unknown) =>
  http<T>(path, { method: 'PUT', body: JSON.stringify(body) });
const del = <T>(path: string) => http<T>(path, { method: 'DELETE' });

function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

const realApi: Api = {
  health: () => get('/api/health'),

  getConnections: () => get<Connection[]>('/api/connections'),
  setConnectionKey: (name: ConnectionName, key: string, appId?: string) =>
    post<Connection>(`/api/connections/${name}/key`, { key, ...(appId ? { appId } : {}) }),
  checkConnection: (name: ConnectionName) => post<Connection>(`/api/connections/${name}/check`),
  probeGmail: () => post<GmailProbeResult>('/api/connections/gmail/probe'),

  getProfile: () => get<UserProfile>('/api/profile'),
  patchProfile: (body) => patch<UserProfile>('/api/profile', body),
  getProfileFile: (path: string) => get<{ path: string; content: string }>(`/api/profile/files${qs({ path })}`),
  putProfileFile: (path: string, content: string) => put<{ ok: boolean }>('/api/profile/files', { path, content }),
  regenerateQueries: () => post<{ requestId: string }>('/api/profile/regenerate-queries'),
  getArtifact: (path: string) => get<{ path: string; markdown: string }>(`/api/artifacts${qs({ path })}`),

  setupStart: (mode) => post<{ requestId: string }>('/api/setup/start', { mode }),
  setupMessage: (text: string) => post<{ requestId: string }>('/api/setup/message', { text }),
  setupStatus: () => get<SetupStatus>('/api/setup/status'),
  setupClear: () => post<{ ok: boolean }>('/api/setup/clear'),

  getJobs: (params: JobsQuery = {}) =>
    get<{ total: number; jobs: Job[] }>(
      `/api/jobs${qs({
        q: params.q,
        status: Array.isArray(params.status) ? params.status.join(',') : params.status,
        source: params.source,
        remote: params.remote,
        minScore: params.minScore,
        legit: params.legit,
        sort: params.sort,
        order: params.order,
        limit: params.limit,
        offset: params.offset,
      })}`,
    ),
  getJob: (id: number) => get<Job>(`/api/jobs/${id}`),
  getTopJobs: (by: 'opportunity' | 'salary', limit = 10) =>
    get<Job[]>(`/api/jobs/top${qs({ by, limit })}`),
  createJob: (body: Partial<Job>) => post<Job>('/api/jobs', body),
  applyFromUrl: (url: string) =>
    post<{ job: Job; taskId: number; queuePosition?: number }>('/api/jobs/from-url', { url }),
  applyJob: (id: number) => post<{ taskId: number; queuePosition?: number }>(`/api/jobs/${id}/apply`),
  fetchJobDetails: (id: number) => post<{ job: Job }>(`/api/jobs/${id}/fetch-details`),
  skipJob: (id: number) => post<Job>(`/api/jobs/${id}/skip`),
  overrideLegit: (id: number, note: string) =>
    post<{ job: Job; taskId: number | null }>(`/api/jobs/${id}/override-legit`, { verdict: 'legit', note }),

  getApplications: (params) =>
    get<{ total: number; applications: Application[] }>(
      `/api/applications${qs({ status: params?.status, q: params?.q, limit: params?.limit, offset: params?.offset })}`,
    ),
  patchApplication: (id: number, body: { status?: JobStatus; notes?: string }) =>
    patch<Application>(`/api/applications/${id}`, body),
  approveApplication: (id: number) => post<{ taskId: number }>(`/api/applications/${id}/approve`),
  rejectApplication: (id: number, reason: string) =>
    post<Application>(`/api/applications/${id}/reject`, { reason }),
  getApplicationArtifacts: (id: number) => get<ApplicationArtifacts>(`/api/applications/${id}/artifacts`),

  search: (body: SearchBody) => post<{ searchId: string }>('/api/search', body),
  getQueue: () => get<QueueSnapshot>('/api/queue'),
  runDiscovery: () => post<{ taskId: number }>('/api/queue/run-discovery'),
  pauseQueue: () => post<QueueSnapshot>('/api/queue/pause'),
  resumeQueue: () => post<QueueSnapshot>('/api/queue/resume'),
  setQueueRate: (discoveryIntervalMinutes: number) =>
    post<Settings>('/api/queue/rate', { discoveryIntervalMinutes }),
  resolveHuman: (taskId: number) => post<QueueTask>(`/api/queue/tasks/${taskId}/resolve-human`),
  retryTask: (taskId: number) => post<QueueTask>(`/api/queue/tasks/${taskId}/retry`),
  cancelTask: (taskId: number) => post<QueueTask>(`/api/queue/tasks/${taskId}/cancel`),
  retryFailed: (type) => post<{ requeued: number }>('/api/queue/retry-failed', type ? { type } : {}),

  getEmails: (params) =>
    get<{ total: number; emails: EmailRecord[] }>(
      `/api/emails${qs({
        direction: params?.direction,
        classification: params?.classification,
        limit: params?.limit,
        offset: params?.offset,
      })}`,
    ),
  getOutbox: () => get<EmailRecord[]>('/api/outbox'),
  approveOutbox: (id: number) => post<EmailRecord>(`/api/outbox/${id}/approve`),
  rejectOutbox: (id: number, reason?: string) => post<EmailRecord>(`/api/outbox/${id}/reject`, { reason }),
  triggerEmailScan: () => post<{ taskId: number }>('/api/emails/scan'),

  getSchedule: (from?: string, to?: string) => get<ScheduleEvent[]>(`/api/schedule${qs({ from, to })}`),
  createScheduleEvent: (body: Partial<ScheduleEvent>) => post<ScheduleEvent>('/api/schedule', body),
  regenPrep: (eventId: number) => post<{ taskId: number }>(`/api/schedule/${eventId}/prep`),
  getPrepTasks: (eventId?: number) => get<PrepTask[]>(`/api/prep-tasks${qs({ eventId })}`),
  patchPrepTask: (id: number, done: boolean) => patch<PrepTask>(`/api/prep-tasks/${id}`, { done }),
  getSkillsProgress: () => get<SkillProgress[]>('/api/skills-progress'),

  getCredentials: () => get<CredentialMeta[]>('/api/credentials'),
  addCredential: (body) => post<CredentialMeta>('/api/credentials', body),
  revealCredential: (site: string) => post<{ password: string }>(`/api/credentials/${encodeURIComponent(site)}/reveal`),
  deleteCredential: (site: string) => del<{ ok: boolean }>(`/api/credentials/${encodeURIComponent(site)}`),

  postFeedback: (kind: FeedbackKind, text: string) => post<FeedbackEntry>('/api/feedback', { kind, text }),
  getFeedback: () => get<FeedbackEntry[]>('/api/feedback'),
  applyPlanChange: (id: number) => post<FeedbackEntry>(`/api/feedback/${id}/apply-plan`),
  ask: (prompt: string) => post<{ requestId: string }>('/api/ask', { prompt }),
  askClear: () => post<{ ok: boolean }>('/api/ask/clear'),

  getSettings: () => get<Settings>('/api/settings'),
  patchSettings: (body: Partial<Settings>) => patch<Settings>('/api/settings', body),
  resetPreview: (scopes: string[]) => post<{ preview: string[] }>('/api/reset', { preview: true, scopes }),
  reset: (scopes: string[]) =>
    post<{ ok: boolean }>('/api/reset', { confirmation: 'RESET', scopes }),
};

export const api: Api = IS_MOCK ? mockApi : realApi;
