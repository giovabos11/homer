import { useMemo, useState } from 'react';
import { motion } from 'motion/react';
import {
  AlarmClock, BookOpen, CalendarDays, ChevronLeft, ChevronRight, Flame, GraduationCap,
  ListTodo, Loader2, Mic2, RefreshCw, TrendingUp,
} from 'lucide-react';
import type { ScheduleEvent } from '@shared';
import { api } from '@/api/client';
import { useStore } from '@/store/useStore';
import { fmtDateTime, fmtRelative, fmtTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Card, CardHeader, EmptyState, PageHeader } from '@/components/common/layout';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox, Progress, Tip } from '@/components/ui/controls';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Markdown } from '@/components/common/Markdown';
import { ProgressRing } from '@/components/common/rings';

const TYPE_META: Record<ScheduleEvent['type'], { color: string; icon: typeof Mic2; label: string }> = {
  interview: { color: 'var(--series-3)', icon: Mic2, label: 'Interview' },
  deadline: { color: 'var(--serious)', icon: Flame, label: 'Deadline' },
  followup_due: { color: 'var(--accent)', icon: AlarmClock, label: 'Follow-up due' },
  prep: { color: 'var(--series-7)', icon: GraduationCap, label: 'Prep block' },
  other: { color: 'var(--ink-3)', icon: CalendarDays, label: 'Event' },
};

/* ------------------------------ Study guide dialog ------------------------------ */
function StudyGuideDialog({ path, open, onOpenChange }: { path: string; open: boolean; onOpenChange: (v: boolean) => void }) {
  const [md, setMd] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.getArtifact(path);
      setMd(res.markdown);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (v && md == null) void load();
      }}
    >
      <DialogContent wide>
        <DialogTitle className="flex items-center gap-2 pr-8">
          <BookOpen className="h-4.5 w-4.5 text-accent" /> Study guide
        </DialogTitle>
        <div className="mt-3">
          {loading || md == null ? (
            <div className="h-48 flex items-center justify-center text-ink-3 gap-2 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading guide…
            </div>
          ) : (
            <Markdown className="max-h-[62vh] overflow-y-auto pr-2">{md}</Markdown>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------- Interview card -------------------------------- */
function InterviewCard({ event, index }: { event: ScheduleEvent; index: number }) {
  // NOTE: select the stable array and filter in useMemo — a selector that
  // returns a fresh array every call makes useSyncExternalStore loop forever.
  const allPrepTasks = useStore((s) => s.prepTasks);
  const prepTasks = useMemo(() => allPrepTasks.filter((t) => t.eventId === event.id), [allPrepTasks, event.id]);
  const setPrepTask = useStore((s) => s.setPrepTask);
  const refreshPrep = useStore((s) => s.refreshPrep);
  const [guideOpen, setGuideOpen] = useState(false);
  const done = prepTasks.filter((t) => t.doneAt != null).length;
  const progress = prepTasks.length > 0 ? done / prepTasks.length : 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 380, damping: 30, delay: index * 0.06 }}
    >
      <Card className="overflow-hidden">
        <div className="px-4 py-3 flex items-center gap-3 border-b border-line" style={{ background: 'color-mix(in oklab, var(--series-3) 7%, transparent)' }}>
          <ProgressRing value={progress} size={44} color="var(--series-3)" label={`${Math.round(progress * 100)}%`} />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-ink truncate">{event.title}</p>
            <p className="text-xs text-ink-3 mt-0.5">
              {fmtDateTime(event.startsAt)} · {fmtRelative(event.startsAt)}
            </p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {event.prepGuidePath && (
              <>
                <Button size="sm" variant="secondary" onClick={() => setGuideOpen(true)}>
                  <BookOpen className="h-3.5 w-3.5" /> Study guide
                </Button>
                <Tip label="Regenerate the study guide from the saved job description">
                  <Button size="icon-sm" variant="ghost" onClick={() => void api.regenPrep(event.id)}>
                    <RefreshCw className="h-3.5 w-3.5" />
                  </Button>
                </Tip>
                <StudyGuideDialog path={event.prepGuidePath} open={guideOpen} onOpenChange={setGuideOpen} />
              </>
            )}
          </div>
        </div>
        <div className="px-4 py-3">
          {prepTasks.length === 0 ? (
            <p className="text-xs text-ink-3">No prep tasks generated yet — regenerate the study guide to build the checklist.</p>
          ) : (
            <ul className="space-y-1.5">
              {prepTasks.map((t) => (
                <li key={t.id} className="flex items-start gap-2.5">
                  <Checkbox
                    checked={t.doneAt != null}
                    className="mt-0.5"
                    onCheckedChange={async (v) => {
                      const updated = await api.patchPrepTask(t.id, v === true);
                      setPrepTask(updated);
                      void refreshPrep();
                    }}
                  />
                  <div className="min-w-0">
                    <p className={cn('text-[13px] leading-snug', t.doneAt ? 'text-ink-3 line-through' : 'text-ink-2')}>{t.text}</p>
                    {t.skillTag && <Badge variant="outline" className="mt-0.5">{t.skillTag.replace(/_/g, ' ')}</Badge>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
    </motion.div>
  );
}

/* --------------------------------- Week calendar --------------------------------- */
const DAY_MS = 86400000;
const HOUR_START = 8;
const HOUR_END = 21;
const ROW_H = 38;

function WeekCalendar() {
  const schedule = useStore((s) => s.schedule);
  const [offset, setOffset] = useState(0);

  const weekStart = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - d.getDay() + offset * 7);
    return d;
  }, [offset]);

  const days = Array.from({ length: 7 }, (_, i) => new Date(weekStart.getTime() + i * DAY_MS));
  const todayKey = new Date().toDateString();

  return (
    <Card>
      <CardHeader
        title="Week"
        hint={`${days[0]!.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${days[6]!.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`}
        right={
          <div className="flex items-center gap-1">
            <Button size="icon-sm" variant="ghost" onClick={() => setOffset((o) => o - 1)} aria-label="Previous week">
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOffset(0)}>
              Today
            </Button>
            <Button size="icon-sm" variant="ghost" onClick={() => setOffset((o) => o + 1)} aria-label="Next week">
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        }
      />
      <div className="px-3 pb-3 overflow-x-auto">
        <div className="grid grid-cols-[44px_repeat(7,1fr)] min-w-[760px]">
          {/* header row */}
          <div />
          {days.map((d) => (
            <div key={d.toISOString()} className={cn('text-center pb-1.5', d.toDateString() === todayKey && 'text-accent')}>
              <p className="text-[11px] uppercase tracking-wide text-ink-3">{d.toLocaleDateString('en-US', { weekday: 'short' })}</p>
              <p className={cn('text-sm font-semibold tabular', d.toDateString() === todayKey ? 'text-accent' : 'text-ink')}>{d.getDate()}</p>
            </div>
          ))}
          {/* grid */}
          <div className="relative" style={{ height: (HOUR_END - HOUR_START) * ROW_H }}>
            {Array.from({ length: HOUR_END - HOUR_START }, (_, i) => (
              <div key={i} className="absolute right-1 text-[10px] text-ink-3 tabular -translate-y-1/2" style={{ top: i * ROW_H }}>
                {((HOUR_START + i - 1) % 12) + 1}{HOUR_START + i < 12 ? 'a' : 'p'}
              </div>
            ))}
          </div>
          {days.map((d) => {
            const dayEvents = schedule.filter((e) => new Date(e.startsAt).toDateString() === d.toDateString());
            return (
              <div
                key={d.toISOString()}
                className={cn('relative border-l border-line/70', d.toDateString() === todayKey && 'bg-accent/4')}
                style={{ height: (HOUR_END - HOUR_START) * ROW_H }}
              >
                {Array.from({ length: HOUR_END - HOUR_START }, (_, i) => (
                  <div key={i} className="absolute inset-x-0 border-t border-line/50" style={{ top: i * ROW_H }} />
                ))}
                {dayEvents.map((e) => {
                  const start = new Date(e.startsAt);
                  const end = e.endsAt ? new Date(e.endsAt) : new Date(start.getTime() + 45 * 60000);
                  const startH = Math.min(HOUR_END - 0.75, Math.max(HOUR_START, start.getHours() + start.getMinutes() / 60));
                  const endH = Math.min(HOUR_END, Math.max(startH + 0.6, end.getHours() + end.getMinutes() / 60));
                  const meta = TYPE_META[e.type];
                  return (
                    <Tip key={e.id} label={`${e.title} · ${fmtTime(e.startsAt)}`}>
                      <div
                        className="absolute inset-x-0.5 rounded-md px-1.5 py-1 overflow-hidden border cursor-default"
                        style={{
                          top: (startH - HOUR_START) * ROW_H + 1,
                          height: (endH - startH) * ROW_H - 2,
                          background: `color-mix(in oklab, ${meta.color} 14%, var(--surface))`,
                          borderColor: `color-mix(in oklab, ${meta.color} 45%, transparent)`,
                        }}
                      >
                        <p className="text-[10px] font-semibold leading-tight truncate" style={{ color: meta.color }}>
                          {fmtTime(e.startsAt)}
                        </p>
                        <p className="text-[11px] text-ink leading-tight truncate">{e.company ?? e.title}</p>
                      </div>
                    </Tip>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </Card>
  );
}

/* ------------------------------------ Agenda ------------------------------------ */
function Agenda() {
  const schedule = useStore((s) => s.schedule);
  const upcoming = useMemo(
    () =>
      [...schedule]
        .filter((e) => new Date(e.startsAt).getTime() > Date.now() - 3600000)
        .sort((a, b) => a.startsAt.localeCompare(b.startsAt)),
    [schedule],
  );

  return (
    <Card>
      <CardHeader title="Agenda" hint="Everything with a date, soonest first" />
      {upcoming.length === 0 ? (
        <EmptyState
          icon={CalendarDays}
          title="Nothing scheduled"
          hint="Interview invites found in email land here automatically, complete with a prep guide and checklist."
        />
      ) : (
        <div className="px-2 pb-2">
          {upcoming.map((e) => {
            const meta = TYPE_META[e.type];
            const Icon = meta.icon;
            const soon = e.type === 'deadline' && new Date(e.startsAt).getTime() - Date.now() < 7 * DAY_MS;
            return (
              <div key={e.id} className="flex items-center gap-2.5 rounded-lg px-2 py-2 hover:bg-overlay/50">
                <div
                  className="h-7.5 w-7.5 rounded-lg flex items-center justify-center shrink-0"
                  style={{ background: `color-mix(in oklab, ${meta.color} 13%, transparent)` }}
                >
                  <Icon className={cn('h-3.5 w-3.5', soon && 'flame')} style={{ color: meta.color }} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-medium text-ink truncate">{e.title}</p>
                  <p className="text-[11px] text-ink-3">{fmtDateTime(e.startsAt)}</p>
                </div>
                <Badge variant={soon ? 'serious' : 'default'} className="shrink-0">{fmtRelative(e.startsAt)}</Badge>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

/* --------------------------------- Skill progress --------------------------------- */
function SkillProgressCard() {
  const skills = useStore((s) => s.skills);
  return (
    <Card>
      <CardHeader
        title={
          <span className="inline-flex items-center gap-1.5">
            <TrendingUp className="h-4 w-4 text-accent" /> Skill progress
          </span>
        }
        hint="Gaps closed through prep tasks and upskill reports"
      />
      {skills.length === 0 ? (
        <EmptyState icon={GraduationCap} title="No skill tracks yet" hint="Completed prep tasks and upskill reports build your skill meters over time." />
      ) : (
        <div className="px-4 pb-4 space-y-3">
          {skills.map((s, i) => {
            const pct = s.totalTasks > 0 ? s.doneTasks / s.totalTasks : 0;
            return (
              <motion.div key={s.skill} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.05 }}>
                <div className="flex items-center justify-between mb-1">
                  <Tip
                    label={
                      s.evidence.length ? (
                        <ul className="list-disc pl-4 space-y-0.5">
                          {s.evidence.map((e, j) => (
                            <li key={j}>{e}</li>
                          ))}
                        </ul>
                      ) : (
                        'No evidence recorded yet'
                      )
                    }
                  >
                    <span className="text-[13px] text-ink-2 cursor-default">{s.skill}</span>
                  </Tip>
                  <span className="text-xs text-ink-3 tabular">
                    {s.doneTasks}/{s.totalTasks}
                  </span>
                </div>
                <Progress value={pct} />
              </motion.div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

/* ------------------------------------- View ------------------------------------- */
export default function Schedule() {
  const schedule = useStore((s) => s.schedule);
  const interviews = schedule
    .filter((e) => e.type === 'interview' && new Date(e.startsAt).getTime() > Date.now() - 2 * 3600000)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));

  return (
    <div className="space-y-4">
      <PageHeader title="Schedule" subtitle="Interviews, deadlines, and prep — each interview carries its own study guide and checklist" />
      {interviews.length > 0 && (
        <div className="grid grid-cols-2 gap-4 max-[1420px]:grid-cols-1">
          {interviews.map((e, i) => (
            <InterviewCard key={e.id} event={e} index={i} />
          ))}
        </div>
      )}
      {interviews.length === 0 && (
        <Card>
          <EmptyState
            icon={ListTodo}
            title="No upcoming interviews"
            hint="When an interview is scheduled (spotted in email or added manually), a study guide and prep checklist are generated automatically and show up right here."
          />
        </Card>
      )}
      <div className="grid grid-cols-[1.7fr_1fr] gap-4 max-[1420px]:grid-cols-1 items-start">
        <WeekCalendar />
        <div className="space-y-4">
          <Agenda />
          <SkillProgressCard />
        </div>
      </div>
    </div>
  );
}
