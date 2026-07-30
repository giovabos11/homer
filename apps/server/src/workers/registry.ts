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
  constructor(public readonly prompt: string) {
    super(`Needs human: ${prompt}`);
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
