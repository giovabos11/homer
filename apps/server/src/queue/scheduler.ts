// Croner-driven scheduler: enqueues discover / email_scan on the intervals in
// settings, and a daily follow-up sweep. Reschedule() is called after PATCH
// /api/settings or POST /api/queue/rate.
import { Cron } from 'croner';
import type { SettingsStore } from '../settings';
import type { TaskQueue } from './queue';
import type { ServerConfig } from '../config';

export class Scheduler {
  private jobs: Cron[] = [];

  constructor(
    private queue: TaskQueue,
    private settings: SettingsStore,
    private config: ServerConfig,
  ) {}

  start(): void {
    this.stop();
    const s = this.settings.get();
    this.jobs.push(
      this.every(s.discoveryIntervalMinutes, () => {
        this.queue.enqueue('discover', { dedupe: true, payload: { trigger: 'schedule' } });
      }),
      this.every(s.emailScanIntervalMinutes, () => {
        this.queue.enqueue('email_scan', { dedupe: true, payload: { trigger: 'schedule' } });
      }),
      new Cron(this.config.queue.followupSweepCron, { protect: true }, () => {
        this.queue.enqueue('followup', { dedupe: true, payload: { trigger: 'schedule' } });
      }),
    );
  }

  /** Croner every-N-minutes: clean cron pattern when it divides evenly, else second-gated interval. */
  private every(minutes: number, fn: () => void): Cron {
    const m = Math.max(1, Math.round(minutes));
    if (m < 60 && 60 % m === 0) return new Cron(`*/${m} * * * *`, { protect: true }, fn);
    if (m % 60 === 0) {
      const h = m / 60;
      if (h <= 23 && 24 % h === 0) return new Cron(`0 */${h} * * *`, { protect: true }, fn);
    }
    // Arbitrary interval: fire at most once per m*60 seconds.
    return new Cron('* * * * * *', { protect: true, interval: m * 60 }, fn);
  }

  /** Next scheduled run times (for the queue view). */
  nextRuns(): { discover: string | null; emailScan: string | null; followup: string | null } {
    const iso = (c?: Cron) => c?.nextRun()?.toISOString() ?? null;
    return { discover: iso(this.jobs[0]), emailScan: iso(this.jobs[1]), followup: iso(this.jobs[2]) };
  }

  reschedule(): void {
    this.start();
  }

  stop(): void {
    for (const job of this.jobs) job.stop();
    this.jobs = [];
  }
}
