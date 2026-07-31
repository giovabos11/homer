// Cancellation registry: the bridge between "the user clicked cancel" (an API
// request) and "the spawned claude child process dies" (the queue runner slot).
//
// The runner registers an AbortController per in-flight task; the cancel route
// aborts it. The AgentRunner honors the signal by killing its child process
// tree, so a cancelled task frees its slot instead of burning the usage window.
export class CancellationRegistry {
  private controllers = new Map<number, AbortController>();

  register(taskId: number): AbortController {
    const existing = this.controllers.get(taskId);
    if (existing) return existing;
    const controller = new AbortController();
    this.controllers.set(taskId, controller);
    return controller;
  }

  release(taskId: number): void {
    this.controllers.delete(taskId);
  }

  /** True when the task was in flight in THIS process and has been aborted. */
  abort(taskId: number): boolean {
    const controller = this.controllers.get(taskId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  isRunning(taskId: number): boolean {
    return this.controllers.has(taskId);
  }

  runningIds(): number[] {
    return [...this.controllers.keys()];
  }
}
