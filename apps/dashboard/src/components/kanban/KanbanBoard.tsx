import { forwardRef, useMemo, useState } from 'react';
import {
  DndContext, DragOverlay, PointerSensor, useDraggable, useDroppable, useSensor, useSensors,
  type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertTriangle, CheckCircle2, Clock, Eye, GripVertical, Inbox, Loader2, PauseCircle, XCircle, Zap,
  type LucideIcon,
} from 'lucide-react';
import type { Application, Job, JobStatus } from '@shared';
import { api } from '@/api/client';
import { useStore } from '@/store/useStore';
import { applyState, type ApplyPhase, type ApplyState } from '@/lib/applyState';
import { celebrate } from '@/lib/celebrate';
import { salaryLabel, STATUS_LABEL } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/controls';
import { FitRing, FitScoreTip } from '@/components/common/rings';
import { LegitBadge, SourceIcon } from '@/components/common/chips';
import { useJobDrawer } from '@/components/common/JobDrawer';
import { ReviewDialog } from './ReviewDialog';

interface Column {
  key: string;
  label: string;
  statuses: JobStatus[];
  drop: (job: Job) => JobStatus;
  accent?: string;
}

const COLUMNS: Column[] = [
  { key: 'discovered', label: 'Discovered', statuses: ['discovered'], drop: () => 'discovered' },
  { key: 'screened', label: 'Screened', statuses: ['screened'], drop: () => 'screened' },
  { key: 'tailoring', label: 'Tailoring', statuses: ['tailoring'], drop: () => 'tailoring' },
  { key: 'ready', label: 'Ready for review', statuses: ['ready_for_review'], drop: () => 'ready_for_review', accent: 'var(--warn-raw)' },
  { key: 'applied', label: 'Applied', statuses: ['applied'], drop: () => 'applied', accent: 'var(--accent)' },
  { key: 'interview', label: 'Interview', statuses: ['interview'], drop: () => 'interview', accent: 'var(--series-3)' },
  { key: 'offer', label: 'Offer', statuses: ['offer', 'hired'], drop: () => 'offer', accent: 'var(--good)' },
  {
    key: 'closed',
    label: 'Closed',
    statuses: ['rejected', 'no_response', 'withdrawn', 'quarantined', 'skipped'],
    drop: (job) => (['applied', 'interview', 'offer', 'hired'].includes(job.status) ? 'withdrawn' : 'skipped'),
  },
];

const CELEBRATE_ON: JobStatus[] = ['applied', 'offer'];

/**
 * What an approved application shows in place of the Approve button. It is
 * deliberately not a button: the decision is made, and the only honest thing
 * left to do is report where the submission is — including "paused", which is
 * the one phase that needs a way out, so it carries a Resume queue control.
 */
function ApprovedIndicator({ state, onResume, resuming }: { state: ApplyState; onResume: () => void; resuming: boolean }) {
  const TONE: Record<ApplyPhase, { icon: LucideIcon; className: string }> = {
    running: { icon: Loader2, className: 'border-good/30 bg-good/10 text-good-text' },
    queued: { icon: CheckCircle2, className: 'border-accent/25 bg-accent/10 text-accent' },
    approved: { icon: CheckCircle2, className: 'border-accent/25 bg-accent/10 text-accent' },
    paused: { icon: PauseCircle, className: 'border-warn-raw/30 bg-warn-raw/10 text-warn' },
    needs_you: { icon: AlertTriangle, className: 'border-warn-raw/30 bg-warn-raw/10 text-warn' },
    failed: { icon: XCircle, className: 'border-critical/30 bg-critical/10 text-critical' },
  };
  const { icon: Icon, className } = TONE[state.phase];
  return (
    <div className={cn('rounded-md border px-2 py-1.5', className)}>
      <Tip label={state.detail}>
        <span className="flex items-center gap-1.5 text-[11px] font-medium leading-4">
          <Icon className={cn('h-3.5 w-3.5 shrink-0', state.phase === 'running' && 'animate-spin')} />
          {state.label}
        </span>
      </Tip>
      {state.phase === 'paused' && (
        <button
          type="button"
          disabled={resuming}
          onClick={onResume}
          className="mt-1.5 w-full rounded border border-warn-raw/40 bg-raised/60 px-2 py-1 text-[11px] font-medium text-ink hover:border-warn-raw/70 transition-colors cursor-pointer disabled:opacity-60"
        >
          {resuming ? 'Resuming…' : 'Resume queue'}
        </button>
      )}
    </div>
  );
}

function KanbanCard({ job, app, dragging, queued }: { job: Job; app?: Application; dragging?: boolean; queued?: boolean }) {
  const openDrawer = useJobDrawer((s) => s.open);
  const tasks = useStore((s) => s.tasks);
  const queuePaused = useStore((s) => s.queuePaused);
  const pushToast = useStore((s) => s.pushToast);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [resuming, setResuming] = useState(false);
  const salary = salaryLabel(job);
  // Approval is the fork: before it, the card offers review; after it, the card
  // reports. It never shows both, and it never silently shows neither.
  const submission = app ? applyState(app, tasks, queuePaused) : null;
  const isReview = job.status === 'ready_for_review' && app && !submission;

  const resumeQueue = async () => {
    setResuming(true);
    try {
      await api.resumeQueue();
      pushToast('success', 'Queue resumed — approved applications start submitting');
    } catch (err) {
      pushToast('error', `Could not resume the queue: ${err instanceof Error ? err.message : 'unknown error'}`);
    } finally {
      setResuming(false);
    }
  };

  return (
    <div
      className={cn(
        'group rounded-lg border border-line bg-raised px-3 py-2.5 cursor-pointer transition-shadow hover:shadow-[var(--shadow-card)] hover:border-line-strong',
        dragging && 'shadow-[var(--shadow-pop)] rotate-[1.5deg] border-accent/50',
        job.legitVerdict === 'scam' && 'opacity-70 border-critical/40',
      )}
      onClick={() => openDrawer(job.id)}
    >
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-medium text-ink leading-snug truncate">{job.title}</p>
          <p className="text-xs text-ink-3 truncate mt-0.5">{job.company}</p>
        </div>
        <FitScoreTip>
          <FitRing score={job.fitScore} size={30} />
        </FitScoreTip>
      </div>
      <div className="flex items-center gap-1.5 mt-2 flex-wrap">
        {salary && (
          <Badge variant="accent" className="tabular">
            {salary}
            {job.salaryPredicted && <span className="opacity-70">est.</span>}
          </Badge>
        )}
        <LegitBadge verdict={job.legitVerdict} reasons={job.legitReasons} compact />
        <SourceIcon source={job.source} />
        {queued && (
          <Badge variant="violet">
            <Clock className="h-3 w-3" /> Queued for tailoring
          </Badge>
        )}
        {app?.autoSubmitted && (
          <Tip label="Every screening question resolved from your profile and standing answers, so Homer submitted it without a review card. Full audit trail on the card.">
            <Badge variant="violet">
              <Zap className="h-3 w-3" /> Submitted automatically
            </Badge>
          </Tip>
        )}
        {job.status === 'hired' && <Badge variant="good">Hired</Badge>}
        <span className="ml-auto opacity-0 group-hover:opacity-100 transition-opacity text-ink-3">
          <GripVertical className="h-3.5 w-3.5" />
        </span>
      </div>
      {isReview && app && (
        <div className="mt-2 pt-2 border-t border-line/70" onClick={(e) => e.stopPropagation()}>
          <Button size="sm" className="w-full" onClick={() => setReviewOpen(true)}>
            <Eye className="h-3.5 w-3.5" /> Review drafts & approve
          </Button>
          <ReviewDialog app={app} job={job} open={reviewOpen} onOpenChange={setReviewOpen} />
        </div>
      )}
      {submission && (
        <div className="mt-2 pt-2 border-t border-line/70" onClick={(e) => e.stopPropagation()}>
          <ApprovedIndicator state={submission} onResume={() => void resumeQueue()} resuming={resuming} />
        </div>
      )}
    </div>
  );
}

// forwardRef: AnimatePresence mode="popLayout" measures exiting children via a
// ref on the direct child, so this must compose that ref with dnd-kit's.
const DraggableCard = forwardRef<HTMLDivElement, { job: Job; app?: Application; queued?: boolean }>(function DraggableCard(
  { job, app, queued },
  ref,
) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `job-${job.id}`,
    data: { job },
  });
  return (
    <motion.div
      ref={(node: HTMLDivElement | null) => {
        setNodeRef(node);
        if (typeof ref === 'function') ref(node);
        else if (ref) ref.current = node;
      }}
      layout
      initial={{ opacity: 0, y: 12, scale: 0.97 }}
      animate={{ opacity: isDragging ? 0.35 : 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ type: 'spring', stiffness: 420, damping: 34 }}
      {...attributes}
      {...listeners}
    >
      <KanbanCard job={job} app={app} queued={queued} />
    </motion.div>
  );
});

/** Render cap per column — heavy columns collapse behind a "Show all" expander. */
const COLUMN_CARD_CAP = 30;

function BoardColumn({
  column, jobs, appsByJob, queuedJobIds,
}: {
  column: Column;
  jobs: Job[];
  appsByJob: Map<number, Application>;
  queuedJobIds: Set<number>;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: column.key });
  const [showAll, setShowAll] = useState(false);
  const capped = !showAll && jobs.length > COLUMN_CARD_CAP;
  const visible = capped ? jobs.slice(0, COLUMN_CARD_CAP) : jobs;
  return (
    <div className="flex flex-col w-[264px] shrink-0 max-h-full">
      <div className="flex items-center gap-2 px-1.5 pb-2">
        <span
          className="h-2 w-2 rounded-full"
          style={{ background: column.accent ?? 'var(--line-strong)' }}
        />
        <span className="text-xs font-semibold text-ink-2 uppercase tracking-wide">{column.label}</span>
        <span className="text-[11px] text-ink-3 tabular ml-auto bg-overlay border border-line rounded-md px-1.5">
          {jobs.length}
        </span>
      </div>
      <div
        ref={setNodeRef}
        className={cn(
          'flex-1 min-h-24 overflow-y-auto rounded-xl border border-dashed p-1.5 space-y-1.5 transition-colors',
          isOver ? 'border-accent bg-accent/6' : 'border-line/80 bg-surface/45',
        )}
      >
        <AnimatePresence mode="popLayout">
          {visible.map((j) => (
            <DraggableCard
              key={j.id}
              job={j}
              app={appsByJob.get(j.id)}
              queued={queuedJobIds.has(j.id) && ['discovered', 'screened'].includes(j.status)}
            />
          ))}
        </AnimatePresence>
        {capped && (
          <button
            onClick={() => setShowAll(true)}
            className="w-full rounded-lg border border-dashed border-line-strong/70 px-2 py-2 text-[11px] font-medium text-ink-3 hover:text-ink hover:bg-overlay/60 transition-colors cursor-pointer"
          >
            Show all {jobs.length}
          </button>
        )}
        {jobs.length === 0 && (
          <div className="flex flex-col items-center justify-center py-6 text-ink-3/70">
            <Inbox className="h-4 w-4 mb-1" />
            <span className="text-[11px]">Nothing here yet</span>
          </div>
        )}
      </div>
    </div>
  );
}

export function KanbanBoard() {
  const jobs = useStore((s) => s.jobs);
  const applications = useStore((s) => s.applications);
  const tasks = useStore((s) => s.tasks);
  const pushToast = useStore((s) => s.pushToast);
  const upsertJob = useStore((s) => s.upsertJob);
  const [activeJob, setActiveJob] = useState<Job | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const appsByJob = useMemo(() => {
    const m = new Map<number, Application>();
    for (const a of applications) m.set(a.jobId, a);
    return m;
  }, [applications]);

  // Jobs with a live tailor task — their cards wear the "Queued for tailoring"
  // badge until the worker actually picks them up (SSE keeps tasks fresh).
  const queuedJobIds = useMemo(() => {
    const s = new Set<number>();
    for (const t of tasks) {
      if (t.type === 'tailor' && (t.state === 'pending' || t.state === 'running')) {
        const jobId = t.payload.jobId;
        if (typeof jobId === 'number') s.add(jobId);
      }
    }
    return s;
  }, [tasks]);

  const byColumn = useMemo(() => {
    const m = new Map<string, Job[]>();
    for (const c of COLUMNS) m.set(c.key, []);
    for (const j of jobs) {
      const col = COLUMNS.find((c) => c.statuses.includes(j.status));
      if (col) m.get(col.key)!.push(j);
    }
    for (const [, list] of m) list.sort((a, b) => (b.fitScore ?? -1) - (a.fitScore ?? -1));
    return m;
  }, [jobs]);

  const onDragStart = (e: DragStartEvent) => {
    const job = (e.active.data.current as { job?: Job } | undefined)?.job;
    setActiveJob(job ?? null);
  };

  const onDragEnd = async (e: DragEndEvent) => {
    const job = activeJob;
    setActiveJob(null);
    if (!job || !e.over) return;
    const col = COLUMNS.find((c) => c.key === e.over!.id);
    if (!col || col.statuses.includes(job.status)) return;
    const target = col.drop(job);

    // optimistic move
    upsertJob({ ...job, status: target });
    if (CELEBRATE_ON.includes(target)) celebrate();

    try {
      const app = appsByJob.get(job.id);
      if (app) {
        await api.patchApplication(app.id, { status: target });
      } else if (target === 'tailoring' || target === 'ready_for_review') {
        const res = await api.applyJob(job.id);
        const n = res.queuePosition ?? 0;
        pushToast(
          'info',
          n > 0
            ? `Queued — starts after ${n} running/queued task${n === 1 ? '' : 's'}`
            : 'Queued — starting now',
        );
      } else if (target === 'skipped' || target === 'withdrawn') {
        await api.skipJob(job.id);
      } else {
        // No application record yet (pre-pipeline lane change) — keep the local
        // move; the server owns these transitions once a worker picks the job up.
        pushToast('info', `${job.company} moved to ${STATUS_LABEL[target]}`);
      }
    } catch (err) {
      upsertJob(job); // roll back
      pushToast('error', `Move failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    }
  };

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
      <div className="flex gap-3 overflow-x-auto pb-3 h-full items-stretch">
        {COLUMNS.map((c) => (
          <BoardColumn key={c.key} column={c} jobs={byColumn.get(c.key) ?? []} appsByJob={appsByJob} queuedJobIds={queuedJobIds} />
        ))}
      </div>
      <DragOverlay dropAnimation={{ duration: 180 }}>
        {activeJob && (
          <div className="w-[250px]">
            <KanbanCard job={activeJob} dragging />
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
