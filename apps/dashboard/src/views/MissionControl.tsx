import { useMemo } from 'react';
import { motion } from 'motion/react';
import { Award, CalendarClock, Flame, MailCheck, Rocket, Send, Trophy } from 'lucide-react';
import { useStore } from '@/store/useStore';
import { computeStreak, computeXp } from '@/lib/xp';
import { PageHeader, StatTile } from '@/components/common/layout';
import { Tip } from '@/components/ui/controls';
import { KanbanBoard } from '@/components/kanban/KanbanBoard';

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
        title="Mission Control"
        subtitle="Your entire pipeline, live — drag cards to move them through the funnel"
      />
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
