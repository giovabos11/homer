// What happened to an application after "Approve & submit" was clicked.
//
// Approval used to be invisible: the dialog closed, the card kept offering
// "Review drafts & approve", and the only evidence was a row in the database.
// This derives one honest phase from the application's `approvedAt` plus the
// live apply task, so the card can say what the pipeline is actually doing —
// including the case where the answer is "nothing, the queue is paused".
import type { Application, QueueTask } from '@shared';

export type ApplyPhase = 'queued' | 'paused' | 'running' | 'needs_you' | 'failed' | 'approved';

export interface ApplyState {
  phase: ApplyPhase;
  /** The apply task carrying this submission, when one is still live. */
  taskId: number | null;
  label: string;
  /** Longer explanation for a tooltip. */
  detail: string;
}

const CANCELLED = 'Cancelled by user';

/** The live apply task for an application, if any (pending/running/parked). */
export function findApplyTask(applicationId: number, tasks: QueueTask[]): QueueTask | null {
  const mine = tasks.filter(
    (t) => t.type === 'apply' && (t.payload as { applicationId?: number }).applicationId === applicationId,
  );
  const live = mine.filter((t) => ['pending', 'running', 'needs_human', 'paused', 'waiting_session'].includes(t.state));
  if (live.length > 0) return live.sort((a, b) => a.id - b.id)[0]!;
  // No live task: a genuine failure still matters (a cancellation does not).
  return mine.find((t) => t.state === 'failed' && t.lastError !== CANCELLED) ?? null;
}

/**
 * null when the application has not been approved yet — that is the only state
 * where the card should still offer the Approve button.
 */
export function applyState(app: Application, tasks: QueueTask[], queuePaused: boolean): ApplyState | null {
  if (app.submittedAt) return null; // it is in Applied now; the column says it
  if (!app.approvedAt) return null;

  const task = findApplyTask(app.id, tasks);
  const taskId = task?.id ?? null;

  if (task?.state === 'running') {
    return { phase: 'running', taskId, label: 'Applying now', detail: 'The apply driver is filling the employer form.' };
  }
  if (task?.state === 'needs_human' || task?.state === 'waiting_session') {
    return {
      phase: 'needs_you',
      taskId,
      label: 'Applying — needs you',
      detail: task.humanPrompt ?? 'The apply driver stopped and is waiting for you. Open the queue to finish it.',
    };
  }
  if (task?.state === 'failed') {
    return {
      phase: 'failed',
      taskId,
      label: 'Apply failed',
      detail: task.lastError ?? 'The apply task failed. Retry it from the queue.',
    };
  }
  if (task && queuePaused) {
    return {
      phase: 'paused',
      taskId,
      label: 'Approved — queue paused',
      detail: 'Approved and queued. Nothing runs until you resume the queue.',
    };
  }
  if (task) {
    return {
      phase: 'queued',
      taskId,
      label: 'Approved — queued to apply',
      detail: 'Approved. The apply driver picks this up when it reaches the front of the queue.',
    };
  }
  return {
    phase: 'approved',
    taskId: null,
    label: 'Approved',
    detail: 'Approved at the submit gate. No apply task is queued right now.',
  };
}

/** Applications approved but not yet submitted — the Home strip's waiting count. */
export function awaitingSubmission(applications: Application[]): Application[] {
  return applications.filter((a) => a.approvedAt != null && a.submittedAt == null && a.status === 'ready_for_review');
}
