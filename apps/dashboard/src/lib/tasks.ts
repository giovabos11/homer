// Humanized queue-task labels ("Scoring — Backend Engineer @ Parallel Works")
// shared by the Home current-task strip and the Search queue panel.
import type { Application, Job, QueueTask, TaskType } from '@shared';
import { sourceLabel } from '@/components/common/chips';
import { titleCase } from '@/lib/format';

const TASK_VERB: Partial<Record<TaskType, string>> = {
  discover: 'Discovering jobs',
  score: 'Scoring',
  tailor: 'Tailoring',
  apply: 'Submitting application',
  email_scan: 'Scanning email',
  email_send: 'Sending email',
  followup: 'Drafting follow-up',
  prep_guide: 'Writing prep guide',
  profile_sync: 'Syncing profile',
  ask: 'Answering you',
  feedback: 'Processing feedback',
  setup: 'Profile setup',
  regen_queries: 'Rewriting search queries',
};

export function taskVerb(type: TaskType): string {
  return TASK_VERB[type] ?? titleCase(type);
}

/** "<verb> — <job title> @ <company>" when the task points at a job, else the verb (+ source for discovery). */
export function humanizeTask(task: QueueTask, jobs: Job[], applications: Application[] = []): string {
  const verb = taskVerb(task.type);
  const payload = task.payload as { jobId?: number; applicationId?: number };
  let jobId = payload.jobId;
  if (jobId == null && payload.applicationId != null) {
    jobId = applications.find((a) => a.id === payload.applicationId)?.jobId;
  }
  const job = jobId != null ? jobs.find((j) => j.id === jobId) : undefined;
  if (job) return `${verb} — ${job.title} @ ${job.company}`;
  const source = (task.cursor as { source?: string } | null)?.source;
  if (task.type === 'discover' && source) return `${verb} — ${sourceLabel(source)}`;
  return verb;
}
