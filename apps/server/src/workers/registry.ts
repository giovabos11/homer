// Worker registry + control-flow signals. Workers signal pause / human-needed /
// waiting-session by throwing these classes; the queue runner translates them
// into task states (never into failures).
import type { TaskType } from '@shared/types';
import type { AppContext } from '../context';
import type { TaskRow } from '../queue/queue';

export class PauseRequested extends Error {
  constructor() {
    super('Pause requested');
  }
}

export class NeedsHuman extends Error {
  constructor(
    public readonly prompt: string,
    /** Merged into the task payload so the dashboard can render rich controls
     *  (e.g. the real select/radio options behind a parked question). */
    public readonly payload?: Record<string, unknown>,
  ) {
    super(`Needs human: ${prompt}`);
  }
}

/** Thrown (or surfaced) when the user cancelled a running task. */
export class TaskCancelled extends Error {
  constructor(public readonly detail = 'Cancelled by user') {
    super(detail);
  }
}

/**
 * A failure that must NOT be retried, because running again cannot change the
 * answer: the posting is gone, or the link is not an application form. The
 * runner marks it failed immediately instead of backing off and trying again,
 * so a dead posting stops burning apply slots.
 */
export class TerminalFailure extends Error {
  constructor(public readonly detail: string) {
    super(detail);
  }
}

export class WaitingSession extends Error {
  constructor(public readonly detail: string) {
    super(`Waiting for session: ${detail}`);
  }
}

export interface WorkerArgs {
  ctx: AppContext;
  task: TaskRow;
  /** Poll between units of work; when true, save your cursor and throw PauseRequested. */
  paused(): boolean;
  saveCursor(cursor: Record<string, unknown> | null): void;
  /** Aborted when the user cancels this task. ctx.runner already honors it. */
  signal?: AbortSignal;
}

export interface Worker {
  type: TaskType;
  run(args: WorkerArgs): Promise<void>;
}

const registry = new Map<TaskType, Worker>();

export function registerWorker(worker: Worker): void {
  registry.set(worker.type, worker);
}

export function getWorker(type: string): Worker | undefined {
  return registry.get(type as TaskType);
}

export function registeredTypes(): TaskType[] {
  return [...registry.keys()];
}
