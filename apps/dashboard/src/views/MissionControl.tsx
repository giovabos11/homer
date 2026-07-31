import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'motion/react';
import {
  ArrowRight, Award, Ban, CalendarClock, ClipboardList, Flame, Loader2, MailCheck, Pause, Play,
  Rocket, RotateCcw, Send, Trophy,
} from 'lucide-react';
import type { QueueTask } from '@shared';
import { api } from '@/api/client';
import { useStore } from '@/store/useStore';
import { computeStreak, computeXp } from '@/lib/xp';
import { humanizeTask } from '@/lib/tasks';
import { fmtRelative, fmtTime, titleCase } from '@/lib/format';
import { PageHeader, StatTile } from '@/components/common/layout';
import { OnboardingCard } from '@/components/common/OnboardingCard';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/controls';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { KanbanBoard } from '@/components/kanban/KanbanBoard';

/* --------------------------- Current-task strip --------------------------- */
function TaskDetailRow({ t }: { t: QueueTask }) {
  const jobs = useStore((s) => s.jobs);
  const applications = useStore((s) => s.applications);
  const cancelled = t.state === 'failed' && t.lastError === 'Cancelled by user';
  const stateTone =
    t.state === 'running' ? 'var(--good)'
      : t.state === 'needs_human' ? 'var(--warn-raw)'
        : cancelled ? 'var(--ink-3)'
          : t.state === 'failed' ? 'var(--critical)'
            : t.state === 'done' ? 'var(--accent)' : 'var(--ink-3)';
  return (
    <div className="flex items-center gap-2 text-xs rounded-md px-2 py-1.5 bg-overlay/50 border border-line/60">
      <span
        className={`h-1.5 w-1.5 rounded-full shrink-0 ${t.state === 'running' ? 'status-pulse' : ''}`}
        style={{ background: stateTone, ['--pulse-color' as string]: stateTone }}
      />
      <span className="text-ink-2 truncate flex-1">{humanizeTask(t, jobs, applications)}</span>
      <span className="text-[10px] text-ink-3 tabular shrink-0">{fmtRelative(t.updatedAt)}</span>
      <Badge variant={cancelled ? 'default' : t.state === 'failed' ? 'critical' : t.state === 'needs_human' ? 'warn' : 'default'}>
        {cancelled ? 'Stopped' : titleCase(t.state)}
      </Badge>
      {t.state === 'running' && (
        <Tip label="Stop this task">
          <Button size="icon-sm" variant="ghost" aria-label="Stop task" onClick={() => void api.cancelTask(t.id)}>
            <Ban className="h-3.5 w-3.5" />
          </Button>
        </Tip>
      )}
      {cancelled && (
        <Tip label="Run it again">
          <Button size="icon-sm" variant="ghost" aria-label="Retry task" onClick={() => void api.retryTask(t.id)}>
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>
        </Tip>
      )}
    </div>
  );
}

/**
 * Slim live-activity bar: what the pipeline is doing right now, pause/play,
 * and the needs-attention/failed counts. Click for the full task detail.
 */
function CurrentTaskStrip() {
  const tasks = useStore((s) => s.tasks);
  const jobs = useStore((s) => s.jobs);
  const applications = useStore((s) => s.applications);
  const paused = useStore((s) => s.queuePaused);
  const nextRuns = useStore((s) => s.nextRuns);
  const pushToast = useStore((s) => s.pushToast);
  const [open, setOpen] = useState(false);
  const [toggleBusy, setToggleBusy] = useState(false);
  const [retryBusy, setRetryBusy] = useState(false);
  const [stopBusy, setStopBusy] = useState(false);

  const running = tasks.filter((t) => t.state === 'running');
  const needsHuman = tasks.filter((t) => t.state === 'needs_human').length;
  const failed = tasks.filter((t) => t.state === 'failed' && t.lastError !== 'Cancelled by user');
  const pending = tasks.filter((t) => t.state === 'pending').length;
  const current = running[0];
  const recent = [...tasks]
    .filter((t) => t.state !== 'running')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 8);

  const label = paused
    ? 'Queue paused — nothing will run'
    : current
      ? humanizeTask(current, jobs, applications)
      : `Queue idle${nextRuns?.discover ? ` — next discovery at ${fmtTime(nextRuns.discover)}` : ''}`;
  const dotColor = paused ? 'var(--warn-raw)' : current ? 'var(--good)' : 'var(--line-strong)';

  const togglePause = async () => {
    setToggleBusy(true);
    try {
      if (paused) await api.resumeQueue();
      else await api.pauseQueue();
    } finally {
      setToggleBusy(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 380, damping: 30 }}
      className="rounded-xl border border-line bg-surface pl-3.5 pr-2 py-1.5 flex items-center gap-2"
    >
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2.5 flex-1 min-w-0 text-left cursor-pointer group py-0.5"
        aria-label="Open queue activity"
      >
        <span
          className={`h-2 w-2 rounded-full shrink-0 ${current && !paused ? 'status-pulse' : ''}`}
          style={{ background: dotColor, ['--pulse-color' as string]: dotColor }}
        />
        <span className="text-[13px] font-medium text-ink truncate group-hover:text-accent transition-colors">
          {label}
        </span>
        {running.length > 1 && (
          <span className="text-[11px] text-ink-3 shrink-0">+{running.length - 1} more running</span>
        )}
      </button>
      {needsHuman > 0 && <Badge variant="warn">{needsHuman} need{needsHuman === 1 ? 's' : ''} you</Badge>}
      {failed.length > 0 && <Badge variant="critical">{failed.length} failed</Badge>}
      {pending > 0 && <Badge>{pending} queued</Badge>}
      <Tip label={paused ? 'Resume the queue' : 'Pause the queue'}>
        <Button size="icon-sm" variant="ghost" disabled={toggleBusy} onClick={() => void togglePause()} aria-label={paused ? 'Resume queue' : 'Pause queue'}>
          {toggleBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : paused ? <Play className="h-4 w-4 text-good" /> : <Pause className="h-4 w-4" />}
        </Button>
      </Tip>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>Queue activity</DialogTitle>
          <DialogDescription>
            {running.length} running · {pending} pending · {needsHuman} need attention · {failed.length} failed
          </DialogDescription>
          <div className="mt-3 space-y-4">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-2 mb-1.5">Running now</p>
              {running.length > 0 ? (
                <div className="space-y-1">{running.slice(0, 8).map((t) => <TaskDetailRow key={t.id} t={t} />)}</div>
              ) : (
                <p className="text-xs text-ink-3">
                  Nothing running{paused ? ' — the queue is paused' : nextRuns?.discover ? ` — next discovery at ${fmtTime(nextRuns.discover)}` : ''}.
                </p>
              )}
            </div>
            {recent.length > 0 && (
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-2 mb-1.5">Recent</p>
                <div className="space-y-1 max-h-56 overflow-y-auto pr-1">
                  {recent.map((t) => <TaskDetailRow key={t.id} t={t} />)}
                </div>
              </div>
            )}
            <div className="flex items-center gap-2 pt-1">
              {(running.length > 0 || pending > 0) && (
                <Button
                  size="sm"
                  variant="destructive-outline"
                  disabled={stopBusy}
                  onClick={async () => {
                    if (!window.confirm(`Stop ${running.length} running and ${pending} queued task${pending === 1 ? '' : 's'}? You can retry any of them afterwards.`)) return;
                    setStopBusy(true);
                    try {
                      const { cancelled } = await api.cancelAll('all');
                      pushToast('warning', `${cancelled} task${cancelled === 1 ? '' : 's'} stopped`);
                    } catch (err) {
                      pushToast('error', `Stop failed: ${err instanceof Error ? err.message : 'unknown error'}`);
                    } finally {
                      setStopBusy(false);
                    }
                  }}
                >
                  {stopBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Ban className="h-3.5 w-3.5" />}
                  Stop all
                </Button>
              )}
              {failed.length > 0 && (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={retryBusy}
                  onClick={async () => {
                    setRetryBusy(true);
                    try {
                      const { requeued } = await api.retryFailed();
                      pushToast('success', `${requeued} failed task${requeued === 1 ? '' : 's'} requeued`);
                    } catch (err) {
                      pushToast('error', `Retry failed: ${err instanceof Error ? err.message : 'unknown error'}`);
                    } finally {
                      setRetryBusy(false);
                    }
                  }}
                >
                  {retryBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                  Retry all failed
                </Button>
              )}
              <Link
                to="/search"
                onClick={() => setOpen(false)}
                className="ml-auto text-xs text-accent hover:underline inline-flex items-center gap-1"
              >
                Open queue panel <ArrowRight className="h-3 w-3" />
              </Link>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </motion.div>
  );
}

/**
 * Quiet nudge: without a salary, start date, or work-authorization answer,
 * every application stops at the review gate. One click opens the form.
 */
const STANDING_LABEL: Record<string, string> = {
  salaryExpectation: 'salary expectations',
  earliestStartDate: 'earliest start date',
  citizenshipStatus: 'work authorization',
};

function StandingAnswersNudge() {
  const missing = useStore((s) => s.missingStanding);
  const openProfile = useStore((s) => s.openProfileModal);
  if (missing.length === 0) return null;
  const names = missing.map((k) => STANDING_LABEL[k] ?? k);
  return (
    <motion.button
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      onClick={openProfile}
      className="w-full rounded-xl border border-warn-raw/40 bg-warn-raw/8 px-3.5 py-2 flex items-center gap-2.5 text-left cursor-pointer hover:border-warn-raw/60 transition-colors"
    >
      <ClipboardList className="h-4 w-4 text-warn shrink-0" />
      <span className="text-[13px] text-ink flex-1 min-w-0">
        Answer your {names.join(', ')} once and applications stop waiting on you.
      </span>
      <span className="text-xs text-accent shrink-0 inline-flex items-center gap-1">
        Fill them in <ArrowRight className="h-3 w-3" />
      </span>
    </motion.button>
  );
}

function XpHeader() {
  const applications = useStore((s) => s.applications);
  const prepTasks = useStore((s) => s.prepTasks);
  const emails = useStore((s) => s.emails);
  const schedule = useStore((s) => s.schedule);

  const xp = useMemo(() => computeXp(applications, prepTasks, emails), [applications, prepTasks, emails]);
  const streak = useMemo(
    () =>
      computeStreak([
        ...applications.map((a) => a.submittedAt),
        ...applications.flatMap((a) => a.notes.map((n) => n.date)),
        ...prepTasks.map((t) => t.doneAt),
        ...emails.map((e) => e.approvedAt),
      ]),
    [applications, prepTasks, emails],
  );

  const activeApps = applications.filter((a) => ['applied', 'interview', 'offer'].includes(a.status)).length;
  const upcomingInterviews = schedule.filter((e) => e.type === 'interview' && new Date(e.startsAt).getTime() > Date.now()).length;
  const offers = applications.filter((a) => ['offer', 'hired'].includes(a.status)).length;
  const submitted = applications.filter((a) => a.submittedAt != null).length;
  const inboundReplies = emails.filter((e) => e.direction === 'inbound' && e.applicationId != null).length;
  const responseRate = submitted > 0 ? Math.round((Math.min(inboundReplies, submitted) / submitted) * 100) : 0;

  return (
    <div className="grid grid-cols-[minmax(280px,1.15fr)_repeat(4,minmax(150px,1fr))] gap-3 max-[1420px]:grid-cols-2 max-[1420px]:grid-rows-none">
      {/* Level / XP card */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 380, damping: 30 }}
        className="rounded-xl border border-line bg-surface px-4 py-3 flex items-center gap-3.5 max-[1420px]:col-span-2"
      >
        <div className="relative shrink-0">
          <div className="h-11 w-11 rounded-xl bg-violet/15 border border-violet/30 flex items-center justify-center">
            <span className="text-lg font-bold text-violet tabular">{xp.level}</span>
          </div>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm font-semibold text-ink truncate">
              Level {xp.level} — {xp.title}
            </span>
            <span className="text-[11px] text-ink-3 tabular shrink-0">
              {xp.xp - xp.levelFloor} / {xp.levelCeil - xp.levelFloor} XP
            </span>
          </div>
          <div className="mt-1.5 h-2 rounded-full bg-overlay border border-line overflow-hidden">
            <motion.div
              className="h-full rounded-full"
              style={{ background: 'linear-gradient(90deg, var(--accent), var(--violet))' }}
              initial={{ width: 0 }}
              animate={{ width: `${Math.round(xp.progress * 100)}%` }}
              transition={{ type: 'spring', stiffness: 120, damping: 24, delay: 0.15 }}
            />
          </div>
          <p className="text-[11px] text-ink-3 mt-1 truncate">
            {xp.applicationsSent} sent · {xp.interviewsEarned} interviews · {xp.prepDone} prep tasks done
          </p>
        </div>
        <Tip
          label={
            streak > 0
              ? `${streak}-day activity streak — applications, approvals, or prep every day`
              : 'Do one pipeline action today to start a streak'
          }
        >
          <div className="flex flex-col items-center shrink-0 cursor-default">
            <Flame
              className={`h-6 w-6 ${streak > 0 ? 'text-serious flame' : 'text-ink-3/50'}`}
              fill={streak > 0 ? 'var(--warn-raw)' : 'none'}
            />
            <span className="text-xs font-bold text-ink tabular">{streak}d</span>
          </div>
        </Tip>
      </motion.div>

      <StatTile index={1} label="Active applications" value={activeApps} icon={Send} />
      <StatTile index={2} label="Upcoming interviews" value={upcomingInterviews} icon={CalendarClock} accent="var(--series-3)" />
      <StatTile index={3} label="Offers" value={offers} icon={Trophy} accent="var(--good)" />
      <StatTile index={4} label="Response rate" value={`${responseRate}%`} sub={`${submitted} sent`} icon={MailCheck} accent="var(--violet)" />
    </div>
  );
}

export default function MissionControl() {
  const ready = useStore((s) => s.ready);
  const jobs = useStore((s) => s.jobs);

  return (
    <div className="flex flex-col h-full gap-4">
      <PageHeader
        title="Home"
        subtitle="Your entire pipeline, live — drag cards to move them through the funnel"
      />
      <OnboardingCard />
      <StandingAnswersNudge />
      <CurrentTaskStrip />
      <XpHeader />
      <div className="flex-1 min-h-0">
        {ready && jobs.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <div className="text-center max-w-md">
              <div className="mx-auto h-12 w-12 rounded-xl bg-accent/10 border border-accent/25 flex items-center justify-center mb-3">
                <Rocket className="h-5 w-5 text-accent" />
              </div>
              <p className="text-sm font-medium text-ink">No jobs in the pipeline yet</p>
              <p className="text-xs text-ink-3 mt-1 leading-relaxed">
                The discovery worker will fill this board on its next run, or head to{' '}
                <span className="text-accent">Search</span> to run a manual search, paste a job URL, or add a
                record by hand. Every new job lands in Discovered and moves right as the pipeline works.
              </p>
            </div>
          </div>
        ) : (
          <KanbanBoard />
        )}
      </div>
      {ready && jobs.length > 0 && (
        <p className="text-[11px] text-ink-3 flex items-center gap-1.5 -mt-2">
          <Award className="h-3 w-3" />
          Cards in “Ready for review” hold tailored PDFs waiting for your approval. Drops into Applied and Offer celebrate.
        </p>
      )}
    </div>
  );
}
